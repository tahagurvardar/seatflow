import { describe, expect, it } from "vitest";

import {
  classifyJobFailure,
  isServerlessJobName,
  jobIdempotencyKey,
  jobOutcomeHttpStatus,
  jobRejectionHttpStatus,
  SERVERLESS_JOB_NAMES,
  serverlessJobPayloadSchema,
  summarizeJobError,
} from "../src/features/jobs/job-contract";
import { readServerlessJobEnvironment } from "../src/env/schema";
import { expectedWorkerTypes } from "../src/features/operations/health";

/**
 * The serverless job contract.
 *
 * Signature verification and the Redis transports live in the Node-environment
 * suite (`tests/server/`), because those modules import `server-only`. What is
 * covered here is the pure contract: what a payload may say, how an outcome
 * maps onto an HTTP status QStash will interpret correctly, and how a failure
 * is classified.
 */

const CURRENT_KEY = "sig_current_signing_key_for_tests_0000000";
const NEXT_KEY = "sig_next_signing_key_for_tests_1111111111";

describe("job payload contract", () => {
  it("accepts a minimal well-formed payload", () => {
    expect(serverlessJobPayloadSchema.parse({ job: "hold-expiry-sweep" })).toEqual({
      job: "hold-expiry-sweep",
    });
  });

  it("rejects an unknown job name", () => {
    expect(() => serverlessJobPayloadSchema.parse({ job: "drop-everything" })).toThrow();
    expect(isServerlessJobName("drop-everything")).toBe(false);
  });

  it("rejects any attempt to smuggle business state", () => {
    // This is the property the whole design rests on: a forged payload must
    // never be able to assert a payment, a booking, or an actor.
    for (const extra of [
      { bookingId: "bkg_1" },
      { actorUserId: "usr_1" },
      { amountMinor: 5_000 },
      { paymentStatus: "SUCCEEDED" },
      { organizationId: "org_1" },
    ]) {
      expect(() =>
        serverlessJobPayloadSchema.parse({ job: "ticket-issuance-dispatch", ...extra }),
      ).toThrow();
    }
  });

  it("bounds the batch-size override", () => {
    expect(() =>
      serverlessJobPayloadSchema.parse({ job: "hold-expiry-sweep", batchSize: 10_000 }),
    ).toThrow();
    expect(() =>
      serverlessJobPayloadSchema.parse({ job: "hold-expiry-sweep", batchSize: 0 }),
    ).toThrow();
    expect(() =>
      serverlessJobPayloadSchema.parse({ job: "hold-expiry-sweep", batchSize: 1.5 }),
    ).toThrow();
  });

  it("produces a stable idempotency key", () => {
    expect(jobIdempotencyKey("hold-expiry-sweep", "msg_1")).toBe("hold-expiry-sweep:msg_1");
    expect(jobIdempotencyKey("hold-expiry-sweep", "msg_1")).toBe(
      jobIdempotencyKey("hold-expiry-sweep", "msg_1"),
    );
  });
});

describe("job outcome mapping", () => {
  it("answers 2xx for a permanent failure so QStash stops retrying", () => {
    // A permanent failure answered with 5xx would be redelivered until the
    // attempt budget ran out, burying the real fault under retry noise.
    expect(jobOutcomeHttpStatus({ status: "permanent", safeErrorCode: "PERMANENT_X" })).toBe(200);
    expect(jobOutcomeHttpStatus({ status: "completed", metrics: {} })).toBe(200);
    expect(jobOutcomeHttpStatus({ status: "duplicate" })).toBe(200);
  });

  it("answers 503 for a retryable failure so QStash delivers again", () => {
    expect(jobOutcomeHttpStatus({ status: "retryable", safeErrorCode: "X" })).toBe(503);
  });

  it("answers 401 for a signature problem", () => {
    expect(jobRejectionHttpStatus("SIGNATURE_MISSING")).toBe(401);
    expect(jobRejectionHttpStatus("SIGNATURE_INVALID")).toBe(401);
  });

  it("answers 413 for an oversized payload and 400 for a malformed one", () => {
    expect(jobRejectionHttpStatus("PAYLOAD_TOO_LARGE")).toBe(413);
    expect(jobRejectionHttpStatus("PAYLOAD_INVALID")).toBe(400);
    expect(jobRejectionHttpStatus("JOB_UNKNOWN")).toBe(400);
  });

  it("answers 503 when the deployment is not in serverless mode", () => {
    // Retryable, not permanent: the deployment may simply not be switched over
    // yet, and discarding the message would lose the tick.
    expect(jobRejectionHttpStatus("JOB_MODE_DISABLED")).toBe(503);
    expect(jobRejectionHttpStatus("CONFIGURATION_UNAVAILABLE")).toBe(503);
  });
});

describe("job failure classification", () => {
  it("defaults to retryable", () => {
    // A transient blip misread as permanent silently stops the work; the
    // reverse costs a bounded number of retries and stays visible.
    expect(classifyJobFailure(new Error("connection reset"))).toMatchObject({
      status: "retryable",
    });
  });

  it("honours an explicit permanent marker", () => {
    expect(classifyJobFailure(new Error("PERMANENT_NOTIFICATION_ORIGIN_MISSING"))).toMatchObject({
      status: "permanent",
    });
  });

  it("redacts endpoints from an error summary", () => {
    // Job errors reach a scheduler log this platform does not control.
    const summary = summarizeJobError(
      new Error("failed to connect to postgresql://user:pw@db.internal:5432/seatflow"),
    );
    expect(summary).not.toMatch(/db\.internal/);
    expect(summary).not.toMatch(/pw/);
    expect(summarizeJobError(new Error("GET https://api.example.com/v1 failed"))).not.toMatch(
      /api\.example\.com/,
    );
  });

  it("bounds the summary length", () => {
    expect(summarizeJobError(new Error("x".repeat(1_000))).length).toBeLessThanOrEqual(80);
  });
});

describe("serverless job environment", () => {
  it("defaults to worker mode", () => {
    expect(readServerlessJobEnvironment({}).SEATFLOW_JOB_MODE).toBe("worker");
  });

  it("requires both signing keys in serverless mode", () => {
    // There is deliberately no "enabled but unsigned" configuration.
    expect(() =>
      readServerlessJobEnvironment({ SEATFLOW_JOB_MODE: "serverless" }),
    ).toThrow(/QSTASH_CURRENT_SIGNING_KEY/);
    expect(() =>
      readServerlessJobEnvironment({
        SEATFLOW_JOB_MODE: "serverless",
        QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY,
      }),
    ).toThrow(/QSTASH_NEXT_SIGNING_KEY/);
  });

  it("rejects identical signing keys", () => {
    expect(() =>
      readServerlessJobEnvironment({
        SEATFLOW_JOB_MODE: "serverless",
        QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY,
        QSTASH_NEXT_SIGNING_KEY: CURRENT_KEY,
      }),
    ).toThrow(/must differ/);
  });

  it("accepts a complete serverless configuration", () => {
    const environment = readServerlessJobEnvironment({
      SEATFLOW_JOB_MODE: "serverless",
      QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY,
      QSTASH_NEXT_SIGNING_KEY: NEXT_KEY,
    });
    expect(environment.SEATFLOW_JOB_MODE).toBe("serverless");
    expect(environment.JOB_REQUEST_MAX_BYTES).toBe(8_192);
    expect(environment.JOB_MAX_DURATION_SECONDS).toBeLessThanOrEqual(60);
  });
});

describe("every declared job is routable", () => {
  it("recognizes each name", () => {
    for (const job of SERVERLESS_JOB_NAMES) {
      expect(isServerlessJobName(job)).toBe(true);
      expect(() => serverlessJobPayloadSchema.parse({ job })).not.toThrow();
    }
  });
});

describe("expected worker set by job mode", () => {
  it("omits the realtime gateway in serverless mode", () => {
    // A serverless deployment has no gateway process, so reporting it missing
    // would leave readiness permanently degraded for a non-fault.
    const serverless = expectedWorkerTypes({ jobMode: "serverless" });
    expect(serverless).not.toContain("REALTIME_GATEWAY");
    expect(serverless).toContain("HOLD_EXPIRY_WORKER");
    expect(serverless).toContain("NOTIFICATION_DISPATCHER");
  });

  it("still expects every resident process in worker mode", () => {
    const worker = expectedWorkerTypes({ jobMode: "worker" });
    expect(worker).toContain("REALTIME_GATEWAY");
    expect(worker).toContain("INVENTORY_OUTBOX_DISPATCHER");
  });
});
