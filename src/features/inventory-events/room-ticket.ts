import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const roomTicketPayloadSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
  audience: z.literal("inventory"),
  expiresAt: z.number().int().positive(),
});

export type RealtimeRoomTicketPayload = z.infer<typeof roomTicketPayloadSchema>;

function signatureFor(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createRealtimeRoomTicket(input: {
  sessionId: string;
  secret: string;
  now?: Date;
  lifetimeSeconds?: number;
}) {
  if (input.secret.length < 32) throw new Error("Realtime ticket secret is too short.");
  const now = input.now ?? new Date();
  const payload = roomTicketPayloadSchema.parse({
    version: 1,
    sessionId: input.sessionId,
    audience: "inventory",
    expiresAt: Math.floor(now.getTime() / 1_000) + (input.lifetimeSeconds ?? 3_600),
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${signatureFor(encodedPayload, input.secret)}`;
}

export function verifyRealtimeRoomTicket(input: {
  ticket: string;
  secret: string;
  now?: Date;
}): RealtimeRoomTicketPayload | null {
  if (input.ticket.length > 1_024 || input.secret.length < 32) return null;
  const [encodedPayload, providedSignature, extra] = input.ticket.split(".");
  if (!encodedPayload || !providedSignature || extra) return null;

  const expectedSignature = signatureFor(encodedPayload, input.secret);
  const expected = Buffer.from(expectedSignature);
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  try {
    const payload = roomTicketPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
    return payload.expiresAt > nowSeconds ? payload : null;
  } catch {
    return null;
  }
}
