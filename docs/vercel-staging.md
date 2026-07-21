# Vercel staging deployment

Free Hobby deployment of the SeatFlow staging demo. Nothing here costs money and
nothing here serves real customers.

## Prerequisites

- `.env.staging.local` populated and passing `npm run staging:secrets -- check`
- Neon migrations applied (see [neon-staging.md](./neon-staging.md))
- The Vercel CLI available and authenticated

## Project settings

| Setting | Value |
|---|---|
| Project name | `seatflow-staging` |
| Framework preset | Next.js |
| Root directory | `./` |
| Node version | 20.x or later |
| Region | `fra1` (Frankfurt) — closest to Neon and Upstash eu-central-1 |
| Domain | the assigned `*.vercel.app` subdomain |
| Plan | Hobby |

Region matters more than it looks: every job invocation and page render makes
several database round trips, and putting the function in a different continent
from Neon adds latency to all of them. `vercel.json` pins `fra1`.

## Authentication

The CLI is not installed in this repository and must be authenticated by you:

```bash
npx vercel login
npx vercel link      # select or create seatflow-staging
```

Do not paste a Vercel token into a chat, an issue, or a file in this repository.
`vercel login` writes its credential to your own machine, which is where it
belongs.

## Importing environment variables

```bash
npm run staging:secrets -- check                       # validate first
npm run staging:secrets -- list                        # names only
npm run staging:secrets -- import --target=production  # requires typed "yes"
```

The importer:

- **refuses to run** unless validation passes
- passes each value to the CLI over **stdin**, never as an argument — arguments
  are visible in the OS process table
- skips local-only variables (`TEST_DATABASE_URL`, `SEATFLOW_E2E_TEST_MODE`,
  `LOCAL_EMAIL_CAPTURE_DIR`, the seed passwords, …)
- prints **variable names only**, never values
- requires an explicit typed confirmation
- deploys nothing

A Hobby project's production environment is the `*.vercel.app` domain, so
`--target=production` is correct for this deployment. Preview deployments would
each get a different URL, which breaks the staging-origin guard and the
BetterAuth trusted origin — so use `production`, not `preview`.

## Runtime configuration

Routes needing Prisma, `node:crypto`, PDF generation, or QStash verification
declare the Node runtime explicitly:

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = ["fra1"];
```

The Edge runtime is not usable for these: Prisma with `@prisma/adapter-pg` needs
Node APIs, and so does the PDF pipeline.

## Deploying

```bash
npx vercel --prod
```

Then verify, in this order:

```bash
curl -s https://<project>.vercel.app/api/health/live
curl -s https://<project>.vercel.app/api/health/ready
```

`live` should return 200 immediately. `ready` should return 200; sign in as the
platform admin to see the per-check breakdown, which reports `profile`,
`jobMode`, and each dependency.

Expect `ready` to report **degraded** until the first QStash deliveries land —
worker heartbeats start absent and only appear once each job has run once. That
is correct behaviour, not a fault.

## After the first deployment

1. Register schedules: `npm run staging:schedule -- apply`
2. Wait for one cycle (~5 minutes)
3. Re-check `/api/health/ready` — worker checks should turn healthy
4. Optionally seed demo content: `npm run staging:seed`
5. Optionally verify email: `npm run staging:verify:email`

## Hobby limitations

| Limitation | Effect here |
|---|---|
| No resident process | No BullMQ worker, no Socket.IO gateway |
| 60s function ceiling | Jobs bound their own batches well inside it |
| Cold starts | First request after idle is slow |
| No cron on Hobby | QStash provides scheduling instead |
| Shared build minutes | Deploy deliberately, not on every push |

## What must never be set

`STRIPE_*` (no account exists), `TEST_DATABASE_URL`, `SHADOW_DATABASE_URL`,
`LOCAL_EMAIL_CAPTURE_DIR`, `SEATFLOW_E2E_TEST_MODE`, `SEATFLOW_PRODUCTION_LAUNCH`.

Each is rejected by `npm run staging:secrets -- check`, and several also
disqualify the staging-demo profile at runtime — which would leave the
deployment refusing to start rather than quietly behaving like production.
