import { readOptionalInventoryEventEnvironment } from "@/env/schema";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { createRedisConnection, ensureRedisConnected } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const authSession = await getCurrentSession();
  if (!authSession) {
    return Response.json({ error: "Authentication is required." }, { status: 401 });
  }
  const database = getDatabase();
  const user = await database.user.findUnique({
    where: { id: authSession.user.id },
    select: { platformRole: true },
  });
  if (user?.platformRole !== "ADMIN") {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }

  const now = new Date();
  const [backlog, oldest, deadLetters, overdueHolds, oldestOverdue, metrics] =
    await Promise.all([
      database.inventoryEventOutbox.count({
        where: { processedAt: null, deadLetterAt: null },
      }),
      database.inventoryEventOutbox.findFirst({
        where: { processedAt: null, deadLetterAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      database.inventoryEventOutbox.count({ where: { deadLetterAt: { not: null } } }),
      database.seatHold.count({
        where: { status: "ACTIVE", expiresAt: { lte: now } },
      }),
      database.seatHold.findFirst({
        where: { status: "ACTIVE", expiresAt: { lte: now } },
        orderBy: { expiresAt: "asc" },
        select: { expiresAt: true },
      }),
      database.inventoryOperationsMetric.findUnique({ where: { id: "inventory" } }),
    ]);

  const redisEnvironment = readOptionalInventoryEventEnvironment();
  let redisConnected = false;
  let realtimeConnectedClients: number | null = null;
  if (redisEnvironment) {
    const redis = createRedisConnection({
      environment: redisEnvironment,
      connectionName: "seatflow-health",
    });
    try {
      await Promise.race([
        (async () => {
          await ensureRedisConnected(redis);
          redisConnected = (await redis.ping()) === "PONG";
          let cursor = "0";
          let total = 0;
          do {
            const [nextCursor, keys] = await redis.scan(
              cursor,
              "MATCH",
              `${redisEnvironment.REDIS_STREAM_PREFIX}:realtime-clients:*`,
              "COUNT",
              100,
            );
            cursor = nextCursor;
            if (keys.length > 0) {
              const values = await redis.mget(keys);
              total += values.reduce((sum, value) => sum + (Number(value) || 0), 0);
            }
          } while (cursor !== "0");
          realtimeConnectedClients = total;
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redis health timeout.")), 2_000),
        ),
      ]);
    } catch {
      redisConnected = false;
    } finally {
      redis.disconnect();
    }
  }

  return Response.json(
    {
      status: backlog > 0 || overdueHolds > 0 || !redisConnected ? "degraded" : "healthy",
      checkedAt: now.toISOString(),
      redis: { configured: redisEnvironment !== null, connected: redisConnected },
      outbox: {
        backlog,
        deadLetters,
        oldestUnprocessedAgeSeconds: oldest
          ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1_000))
          : 0,
      },
      dispatcher: {
        lastBatchDurationMs: metrics?.lastDispatcherDurationMs ?? null,
        lastRunAt: metrics?.lastDispatcherAt?.toISOString() ?? null,
        failureCount: metrics?.dispatcherFailureCount.toString() ?? "0",
      },
      expiry: {
        overdueHolds,
        lagSeconds: oldestOverdue
          ? Math.max(0, Math.floor((now.getTime() - oldestOverdue.expiresAt.getTime()) / 1_000))
          : 0,
        lastSweepDurationMs: metrics?.lastExpirySweepDurationMs ?? null,
        lastSweepAt: metrics?.lastExpirySweepAt?.toISOString() ?? null,
      },
      holds: { conflictCount: metrics?.holdConflictCount.toString() ?? "0" },
      transactions: { retryCount: metrics?.transactionRetryCount.toString() ?? "0" },
      realtime: { connectedClients: realtimeConnectedClients },
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
