import { readServerlessJobEnvironment } from "@/env/schema";
import {
  classifyJobFailure,
  isServerlessJobName,
  jobOutcomeHttpStatus,
  jobRejectionHttpStatus,
  serverlessJobPayloadSchema,
  type JobOutcome,
  type JobRejection,
} from "@/features/jobs/job-contract";
import {
  correlationIdFromHeaders,
  CORRELATION_HEADER,
} from "@/features/observability/correlation";
import { getDatabase } from "@/lib/database";
import {
  claimJobDelivery,
  recordJobDeliveryOutcome,
} from "@/server/jobs/delivery-receipt";
import { getJobDefinition } from "@/server/jobs/job-registry";
import {
  createQStashVerifierOptions,
  normalizeMessageId,
  normalizeRetryCount,
  QSTASH_MESSAGE_ID_HEADER,
  QSTASH_RETRY_HEADER,
  QSTASH_SIGNATURE_HEADER,
  verifyQStashSignature,
} from "@/server/jobs/qstash-verification";
import { getLogger } from "@/server/observability/logger";
import { recordWorkerHeartbeat } from "@/server/operations/worker-heartbeat";

/**
 * Internal job ingress.
 *
 * This is the serverless replacement for a resident worker's schedule tick. It
 * is reachable from the public internet, so it is treated as hostile input
 * throughout and the verification order is deliberate:
 *
 *   1. bound the declared length before reading a byte
 *   2. confirm serverless mode is actually enabled
 *   3. verify the signature over the **exact raw bytes**, before parsing
 *   4. only then parse, and only against a strict schema
 *
 * Verifying before parsing is the part that matters: a parser is a far larger
 * attack surface than a MAC comparison, and running it on unverified bytes
 * would expose it to anyone who can reach this URL.
 *
 * The payload names an operation and, at most, a batch size. It never carries
 * an actor, organization, payment, refund, booking, or ticket fact — every one
 * of those is read from PostgreSQL inside the handler. A forged payload can
 * therefore ask for work to happen sooner, which the scheduler may do anyway,
 * but can never assert anything about money or admission.
 *
 * Nothing here logs the signature, the signing keys, the raw body, or any
 * identifier the job touched.
 */

// Prisma, node:crypto, and the QStash verifier all require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bounded well inside the Vercel Hobby ceiling. Handlers stop themselves by
// batch size; this is the backstop, not the mechanism.
export const maxDuration = 60;
export const preferredRegion = ["fra1"];

function reject(rejection: JobRejection, headers: Record<string, string>) {
  // A fixed, non-descriptive body. An attacker probing this endpoint learns
  // only that it refused, never which key rotated or which job exists.
  return Response.json(
    { accepted: false },
    { status: jobRejectionHttpStatus(rejection), headers },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ job: string }> },
) {
  const correlationId = correlationIdFromHeaders(request.headers);
  const logger = getLogger().child({ operation: "job.dispatch", correlationId });
  const headers = { [CORRELATION_HEADER]: correlationId };
  const startedAt = Date.now();

  let environment;
  try {
    environment = readServerlessJobEnvironment();
  } catch {
    return reject("CONFIGURATION_UNAVAILABLE", headers);
  }

  // A worker-mode deployment has resident processes doing this work. Leaving
  // the endpoint live there would mean two schedulers driving the same queues.
  if (environment.SEATFLOW_JOB_MODE !== "serverless") {
    return reject("JOB_MODE_DISABLED", headers);
  }

  const { job: jobParameter } = await context.params;
  if (!isServerlessJobName(jobParameter)) {
    return reject("JOB_UNKNOWN", headers);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > environment.JOB_REQUEST_MAX_BYTES) {
    return reject("PAYLOAD_TOO_LARGE", headers);
  }

  const verifierOptions = createQStashVerifierOptions(environment);
  if (!verifierOptions) return reject("CONFIGURATION_UNAVAILABLE", headers);

  // Read as text so the signature is checked against the bytes as sent. A
  // declared length can lie, so the actual size is bounded again here.
  const rawBody = await request.text();
  if (rawBody.length > environment.JOB_REQUEST_MAX_BYTES) {
    return reject("PAYLOAD_TOO_LARGE", headers);
  }

  const verdict = await verifyQStashSignature(
    {
      signature: request.headers.get(QSTASH_SIGNATURE_HEADER),
      body: rawBody,
      url: request.url,
    },
    verifierOptions,
  );
  if (!verdict.verified) {
    logger.warn("job delivery rejected", {
      outcome: verdict.reason === "MISSING" ? "signature_missing" : "signature_invalid",
      metadata: { job: jobParameter },
    });
    return reject(
      verdict.reason === "MISSING" ? "SIGNATURE_MISSING" : "SIGNATURE_INVALID",
      headers,
    );
  }

  let payload;
  try {
    payload = serverlessJobPayloadSchema.parse(JSON.parse(rawBody));
  } catch {
    return reject("PAYLOAD_INVALID", headers);
  }
  // The path and the body must agree. A mismatch means the signed body was
  // replayed against a different endpoint.
  if (payload.job !== jobParameter) {
    return reject("PAYLOAD_INVALID", headers);
  }

  const database = getDatabase();
  const definition = getJobDefinition(payload.job);
  const messageId = normalizeMessageId(request.headers.get(QSTASH_MESSAGE_ID_HEADER));
  const retryCount = normalizeRetryCount(request.headers.get(QSTASH_RETRY_HEADER));

  // A delivery with no usable message id still runs — the operations are
  // idempotent — it just cannot be deduplicated.
  if (messageId) {
    const claim = await claimJobDelivery(database, {
      messageId,
      job: payload.job,
      retryCount,
    });
    if (!claim.claimed) {
      logger.info("job delivery already completed", {
        outcome: "duplicate",
        metadata: { job: payload.job },
      });
      return Response.json({ accepted: true, duplicate: true }, { status: 200, headers });
    }
  }

  let outcome: JobOutcome;
  try {
    const metrics = await definition.run({
      database,
      environment,
      batchSize: payload.batchSize,
    });
    outcome = { status: "completed", metrics };
  } catch (error) {
    outcome = classifyJobFailure(error);
    logger.error("job failed", {
      outcome: outcome.status,
      durationMs: Date.now() - startedAt,
      metadata: { job: payload.job },
      error,
    });
  }

  const durationMs = Date.now() - startedAt;
  if (messageId) {
    await recordJobDeliveryOutcome(database, { messageId, outcome, durationMs });
  }

  // A serverless job reports liveness exactly as its worker counterpart does,
  // so a scheduler that silently stops delivering becomes a stale heartbeat in
  // readiness rather than an invisible gap.
  await recordWorkerHeartbeat(database, {
    workerType: definition.workerType,
    status: outcome.status === "completed" ? "HEALTHY" : "DEGRADED",
    lastRunDurationMs: durationMs,
    consecutiveFailures: outcome.status === "completed" ? 0 : 1,
  });

  if (outcome.status === "completed") {
    logger.info("job completed", {
      outcome: "completed",
      durationMs,
      // Safe counters only.
      metadata: { job: payload.job, ...outcome.metrics },
    });
  }

  return Response.json(
    outcome.status === "completed"
      ? { accepted: true, metrics: outcome.metrics }
      : { accepted: outcome.status !== "retryable" },
    { status: jobOutcomeHttpStatus(outcome), headers },
  );
}
