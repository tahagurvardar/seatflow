# SeatFlow Phase 4B operations

## Authority and process topology

PostgreSQL remains the sole authority for seat availability, hold ownership, allocation, release, expiry, cancellation, and immutable prices. Redis contains only disposable invalidation delivery, BullMQ coordination, event deduplication markers, and ephemeral realtime client gauges. Losing every Redis key cannot make a seat available or transfer a hold.

Run these as independent long-lived processes in production:

1. Next.js web application
2. Inventory outbox dispatcher (`npm run inventory:dispatcher`)
3. BullMQ expiry worker (`npm run holds:worker`)
4. Socket.IO gateway (`npm run realtime:gateway`)

Run `npm run holds:schedule` once during rollout and whenever repeat configuration changes. Registration is idempotent. The existing `npm run holds:sweep -- --batch-size 100 --max-batches 10` command remains a safe manual recovery tool.

The standalone gateway requires a Node-compatible host that supports long-lived WebSocket connections. A serverless-only Next.js deployment is insufficient unless the dispatcher, BullMQ worker, and gateway run on separate persistent worker infrastructure. Every gateway instance consumes the Redis Stream for its own connected clients; a browser reconnect always performs a full PostgreSQL refresh, including after a gateway restart.

## Required environment

- `REDIS_URL`: `redis://` or TLS `rediss://` endpoint supplied by a secret manager
- `REDIS_STREAM_PREFIX`: environment-specific key namespace; never derive it from public input
- `REDIS_WORKER_ID`: non-secret worker/gateway identifier
- `NEXT_PUBLIC_REALTIME_URL`: browser-visible Socket.IO gateway origin
- `BETTER_AUTH_SECRET`: also signs short-lived inventory room tickets; keep identical across web and gateway instances

Optional bounded tuning is documented in `.env.example`. Never print `REDIS_URL`, database URLs, signed tickets, or raw stack traces. Use distinct prefixes such as `seatflow:staging` and `seatflow:production`; Redis integration tests force `seatflow:test:phase4b`.

Keys are server-constructed only:

- `<prefix>:inventory-events`
- `<prefix>:inventory-event-dedup:<event-id>`
- `<prefix>:bullmq:*`
- `<prefix>:realtime-clients:<worker-id>`

Public session identifiers are used only in validated Socket.IO room names, never as Redis key fragments.

## Transactional outbox and dispatcher

Every materialization, hold creation, manual release, expiry, and session cancellation inserts an `InventoryEventOutbox` row inside the same PostgreSQL transaction. A rollback removes the event with the mutation. Payloads contain only event ID, event type, session ID, and server timestamp; database checks require an object of at most 8 KiB, while the application emits at most 2 KiB.

`npm run inventory:dispatch` is the safe bounded operations command. It claims due rows with `FOR UPDATE SKIP LOCKED`, publishes through an atomic Redis Lua operation that combines event deduplication and `XADD`, then marks PostgreSQL processed. A crash after Redis accepts an event but before PostgreSQL commits causes a retry; the Lua dedup marker prevents a duplicate Stream entry. Multiple dispatchers safely partition work.

Failures increment `attemptCount`, store a redacted 500-character summary, and schedule bounded exponential backoff. The default eighth failure moves the row to `deadLetterAt`. Redis failure never participates in, or rolls back, the already committed inventory transaction.

## Expiry scheduling

BullMQ does not expire holds and Redis TTLs are never consulted. Each job calls `sweepExpiredHolds`, which claims bounded PostgreSQL batches with `FOR UPDATE SKIP LOCKED`, changes `ACTIVE` holds to `EXPIRED`, releases inventory, and writes `HOLD_EXPIRED` outbox rows in each transaction. Repeated jobs and multiple workers are safe and idempotent. Job attempts use bounded exponential retry; inspect failed BullMQ jobs and PostgreSQL expiry lag during incidents.

## Realtime and fallback behavior

Web pages receive a short-lived HMAC-signed ticket for exactly one validated session. Organizer tickets are created only after fresh tenant membership authorization. The gateway rejects invalid/expired tickets, enforces same-origin browser handshakes and per-IP connection bounds, joins exactly one server-derived room, accepts no client availability mutation, and validates every Redis event before broadcasting.

Invalidations contain only session ID, event ID, event type, and server timestamp. Browsers ignore duplicate/stale delivery and always fetch the no-store PostgreSQL snapshot. Reconnect and Redis recovery force a full refresh. While disconnected they refresh on window focus and at most every 30 seconds; PostgreSQL hold creation remains the final confirmation.

## Health and incidents

Platform administrators can request `GET /api/operations/inventory/health`. It returns no connection strings or customer data and reports:

- Redis configured/connectivity state
- unprocessed outbox backlog, oldest age, and dead letters
- last dispatcher duration and cumulative delivery failures
- overdue hold count, expiry lag, and last sweep duration
- hold conflict and transaction retry counters
- ephemeral realtime connected-client total when Redis is reachable

During Redis outage:

1. Leave the web application and PostgreSQL hold path running.
2. Expect clients to show refresh fallback and outbox backlog to grow.
3. Continue the manual PostgreSQL sweeper if BullMQ is unavailable.
4. Restore Redis, start dispatcher/worker/gateway, and confirm backlog drains.
5. Verify clients reconnect and refresh; do not reconstruct availability from Redis.

## Non-destructive rollout and verification

```bash
npx prisma format --check
npx prisma validate
npm run db:generate
npm run db:migrate:deploy
npx prisma migrate status
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:redis
npm run build
```

Apply `20260718050000_phase_4b_inventory_events` with deploy semantics; never reset the development database. The Redis suite requires a real endpoint and fails when `REDIS_URL` is missing. It never substitutes a mock.

Phase 5 remains excluded. Do not interpret holds as bookings or sales, and do not add payments, orders, tickets, QR codes, refunds, coupons, email, waitlists, dynamic pricing, or sales analytics to Phase 4B operations.
