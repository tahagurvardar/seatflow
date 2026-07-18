import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { Currency } from "@/generated/prisma/enums";
import {
  getHoldConfiguration,
  type HoldConfiguration,
} from "@/features/holds/config";
import { evaluateSessionSalesEligibility } from "@/features/holds/eligibility";
import { seatSelectionsMatch } from "@/features/holds/idempotency";
import { holdCreateInputSchema, holdReleaseInputSchema } from "@/features/holds/schema";
import {
  toCustomerHoldView,
  type CustomerHoldView,
  type HoldViewInput,
} from "@/features/holds/view-models";
import { runInTransaction } from "@/server/database/run-in-transaction";
import {
  HoldAuthenticationError,
  HoldAuthorizationError,
  HoldConflictError,
  HoldEligibilityError,
  HoldValidationError,
  isUniqueConstraintError,
} from "@/server/holds/errors";
import { releaseExpiredHoldsForSession } from "@/server/holds/expiry-service";
import { enqueueInventoryEvent } from "@/server/inventory-events/outbox-service";
import { recordHoldConflict } from "@/server/operations/inventory-metrics";

export interface HoldActor {
  userId: string;
}

interface AcquireOptions {
  now?: Date;
  config?: HoldConfiguration;
}

export interface AcquiredHold {
  hold: CustomerHoldView;
  replayed: boolean;
}

export interface ReleasedHold {
  hold: CustomerHoldView;
  released: boolean;
}

/** 32 bytes of CSPRNG entropy as URL-safe base64 (43 chars, unguessable). */
function generateHoldToken() {
  return randomBytes(32).toString("base64url");
}

export const holdViewInclude = {
  session: {
    include: {
      event: { select: { title: true, publicSlug: true } },
      venue: { select: { name: true, city: true, timeZone: true } },
      space: { select: { name: true } },
    },
  },
  items: {
    include: {
      inventory: {
        include: {
          section: { select: { name: true, code: true } },
          seat: { select: { label: true, type: true, row: { select: { label: true } } } },
        },
      },
    },
  },
} satisfies Prisma.SeatHoldInclude;

export type HoldWithView = Prisma.SeatHoldGetPayload<{ include: typeof holdViewInclude }>;

function toHoldViewInput(hold: HoldWithView, now: Date): HoldViewInput {
  return {
    publicToken: hold.publicToken,
    status: hold.status,
    expiresAt: hold.expiresAt,
    createdAt: hold.createdAt,
    releasedAt: hold.releasedAt,
    expiredAt: hold.expiredAt,
    event: {
      title: hold.session.event.title,
      publicSlug: hold.session.event.publicSlug,
    },
    session: {
      id: hold.session.id,
      startAt: hold.session.startAt,
      timeZone: hold.session.venue.timeZone,
      venueName: hold.session.venue.name,
      spaceName: hold.session.space.name,
      city: hold.session.venue.city,
    },
    items: hold.items.map((item) => ({
      sectionName: item.inventory.section.name,
      sectionCode: item.inventory.section.code,
      rowLabel: item.inventory.seat.row.label,
      seatLabel: item.inventory.seat.label,
      seatType: item.inventory.seat.type,
      priceMinor: item.priceMinor,
      currency: item.currency,
    })),
    now,
  };
}

export function mapHoldToView(hold: HoldWithView, now: Date): CustomerHoldView {
  return toCustomerHoldView(toHoldViewInput(hold, now));
}

export async function loadCustomerHoldView(
  client: PrismaClient | Prisma.TransactionClient,
  holdId: string,
  now: Date,
): Promise<CustomerHoldView | null> {
  const hold = await client.seatHold.findUnique({
    where: { id: holdId },
    include: holdViewInclude,
  });
  return hold ? mapHoldToView(hold, now) : null;
}

/**
 * Return an existing hold for the exact idempotent request, or throw if the same
 * key was reused with a different seat selection. Returns null when there is no
 * prior hold for the key.
 */
async function tryIdempotentReplay(
  database: PrismaClient,
  input: { sessionId: string; userId: string; idempotencyKey: string; seatIds: string[] },
  now: Date,
): Promise<AcquiredHold | null> {
  const existing = await database.seatHold.findUnique({
    where: {
      sessionId_userId_idempotencyKey: {
        sessionId: input.sessionId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: holdViewInclude,
  });
  if (!existing) return null;

  const existingSeatIds = existing.items.map((item) => item.inventory.seatId);
  if (!seatSelectionsMatch(existingSeatIds, input.seatIds)) {
    throw new HoldConflictError(
      "This idempotency key was already used for a different seat selection.",
    );
  }

  return { hold: toCustomerHoldView(toHoldViewInput(existing, now)), replayed: true };
}

interface LockedInventoryRow {
  id: string;
  seatId: string;
  state: string;
  priceMinor: number;
  currency: string;
  currentHoldId: string | null;
}

/**
 * Acquire an all-or-nothing hold over the requested seats. Concurrency safety
 * comes from PostgreSQL: overdue holds are lazily expired, the target inventory
 * rows are locked with `SELECT ... FOR UPDATE` in a deterministic seat order,
 * and the flip to HELD is a conditional update guarded on `state = 'AVAILABLE'`.
 * If any selected seat cannot be secured, the whole transaction rolls back — no
 * partial holds, ever. Price, currency, ownership, and expiry are server-owned.
 */
export async function acquireSeatHold(
  database: PrismaClient,
  actor: HoldActor,
  rawInput: unknown,
  options: AcquireOptions = {},
): Promise<AcquiredHold> {
  if (!actor?.userId) throw new HoldAuthenticationError();
  const config = options.config ?? getHoldConfiguration();
  const now = options.now ?? new Date();

  const parsed = holdCreateInputSchema(config.maxSeatsPerHold).safeParse(rawInput);
  if (!parsed.success) {
    throw new HoldValidationError(parsed.error.issues.map((issue) => issue.message));
  }
  const { sessionId, seatIds, idempotencyKey } = parsed.data;

  const replay = await tryIdempotentReplay(
    database,
    { sessionId, userId: actor.userId, idempotencyKey, seatIds },
    now,
  );
  if (replay) return replay;

  let holdId: string;
  try {
    holdId = await runInTransaction(
      database,
      async (transaction) => {
        // Lazy cleanup so an unavailable sweeper never traps seats permanently.
        await releaseExpiredHoldsForSession(transaction, sessionId, now);

        // Lock the exact target rows in a deterministic order to avoid deadlocks.
        // Locking before the eligibility read serializes this request against a
        // concurrent cancellation (which locks all of the session's inventory),
        // so a hold can never be created onto a session cancelled underneath it.
        const locked = await transaction.$queryRaw<LockedInventoryRow[]>(Prisma.sql`
          SELECT "id", "seatId", "state", "priceMinor", "currency", "currentHoldId"
          FROM "SessionSeatInventory"
          WHERE "sessionId" = ${sessionId} AND "seatId" IN (${Prisma.join(seatIds)})
          ORDER BY "seatId" ASC
          FOR UPDATE
        `);

        const session = await transaction.eventSession.findUnique({
          where: { id: sessionId },
          select: {
            status: true,
            startAt: true,
            salesStartAt: true,
            salesEndAt: true,
            event: { select: { status: true } },
            _count: { select: { seatInventory: true } },
          },
        });
        if (!session) {
          throw new HoldValidationError(["That session is not available."]);
        }

        const eligibility = evaluateSessionSalesEligibility({
          eventStatus: session.event.status,
          sessionStatus: session.status,
          sessionStartAt: session.startAt,
          salesStartAt: session.salesStartAt,
          salesEndAt: session.salesEndAt,
          hasInventory: session._count.seatInventory > 0,
          now,
        });
        if (!eligibility.sellable) {
          throw new HoldEligibilityError(eligibility.reason, eligibility.message);
        }

        if (locked.length !== seatIds.length) {
          throw new HoldValidationError([
            "One or more selected seats are not available for this session.",
          ]);
        }
        if (locked.some((row) => row.state !== "AVAILABLE")) {
          throw new HoldConflictError(
            "One or more selected seats are no longer available.",
          );
        }

        const hold = await transaction.seatHold.create({
          data: {
            publicToken: generateHoldToken(),
            sessionId,
            userId: actor.userId,
            idempotencyKey,
            status: "ACTIVE",
            expiresAt: new Date(now.getTime() + config.holdDurationMs),
          },
          select: { id: true, expiresAt: true },
        });

        const rowIds = locked.map((row) => row.id);
        const claimed = await transaction.sessionSeatInventory.updateMany({
          where: { id: { in: rowIds }, state: "AVAILABLE" },
          data: {
            state: "HELD",
            currentHoldId: hold.id,
            holdExpiresAt: hold.expiresAt,
            updatedAt: now,
          },
        });
        if (claimed.count !== rowIds.length) {
          // Another writer slipped between lock and update; roll everything back.
          throw new HoldConflictError(
            "One or more selected seats are no longer available.",
          );
        }

        await transaction.seatHoldItem.createMany({
          data: locked.map((row) => ({
            holdId: hold.id,
            inventoryId: row.id,
            priceMinor: row.priceMinor,
            currency: row.currency as Currency,
          })),
        });

        await enqueueInventoryEvent(transaction, {
          eventType: "HOLD_CREATED",
          sessionId,
          aggregateId: hold.id,
          deduplicationKey: `hold-created:${hold.id}`,
          now,
        });

        return hold.id;
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    if (isUniqueConstraintError(error, "idempotencyKey")) {
      const replayed = await tryIdempotentReplay(
        database,
        { sessionId, userId: actor.userId, idempotencyKey, seatIds },
        now,
      );
      if (replayed) return replayed;
      await recordHoldConflict(database);
      throw new HoldConflictError(
        "This idempotency key was already used for a different seat selection.",
      );
    }
    if (isUniqueConstraintError(error, "one_active_per_user_session")) {
      await recordHoldConflict(database);
      throw new HoldConflictError(
        "You already have an active hold for this session. Release it before selecting new seats.",
      );
    }
    if (error instanceof HoldConflictError) {
      await recordHoldConflict(database);
    }
    throw error;
  }

  const view = await loadCustomerHoldView(database, holdId, now);
  if (!view) throw new HoldConflictError("The hold could not be loaded after creation.");
  return { hold: view, replayed: false };
}

interface ReleaseOptions {
  now?: Date;
}

/**
 * Release the caller's own active hold. Ownership is verified strictly by user
 * id — a guessed public token belonging to another customer is rejected, and no
 * organizer or venue membership grants release rights. Release is idempotent and
 * race-safe against the expiry sweeper via a status-guarded conditional update;
 * historical hold items are preserved.
 */
export async function releaseSeatHold(
  database: PrismaClient,
  actor: HoldActor,
  rawInput: unknown,
  options: ReleaseOptions = {},
): Promise<ReleasedHold> {
  if (!actor?.userId) throw new HoldAuthenticationError();
  const now = options.now ?? new Date();

  const parsed = holdReleaseInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HoldValidationError(parsed.error.issues.map((issue) => issue.message));
  }

  const hold = await database.seatHold.findUnique({
    where: { publicToken: parsed.data.publicToken },
    select: { id: true, sessionId: true, userId: true, status: true },
  });
  if (!hold || hold.userId !== actor.userId) {
    throw new HoldAuthorizationError();
  }

  let released = false;
  if (hold.status === "ACTIVE") {
    await runInTransaction(database, async (transaction) => {
      const updated = await transaction.seatHold.updateMany({
        where: { id: hold.id, status: "ACTIVE" },
        data: { status: "RELEASED", releasedAt: now },
      });
      if (updated.count === 1) {
        released = true;
        await transaction.sessionSeatInventory.updateMany({
          where: { currentHoldId: hold.id },
          data: {
            state: "AVAILABLE",
            currentHoldId: null,
            holdExpiresAt: null,
            updatedAt: now,
          },
        });
        await enqueueInventoryEvent(transaction, {
          eventType: "HOLD_RELEASED",
          sessionId: hold.sessionId,
          aggregateId: hold.id,
          deduplicationKey: `hold-released:${hold.id}`,
          now,
        });
      }
    });
  }

  const view = await loadCustomerHoldView(database, hold.id, now);
  if (!view) throw new HoldAuthorizationError();
  return { hold: view, released };
}
