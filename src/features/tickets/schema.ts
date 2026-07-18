import { z } from "zod";

export const ticketReferenceSchema = z.string().min(24).max(80).regex(/^[A-Za-z0-9_-]+$/);
export const ticketCredentialSchema = z.string().max(64).regex(/^SFT1\.[A-Za-z0-9_-]{43}$/);
export const sessionIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const ticketScanRequestSchema = z
  .object({
    credential: z.string().min(1).max(64),
    sessionId: sessionIdentifierSchema,
    idempotencyKey: z.string().min(16).max(191).regex(/^[A-Za-z0-9_-]+$/).optional(),
    scannerIdentifier: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  })
  .strict();

export const ticketRevocationReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/[\r\n\t]/.test(value));
