# Wefeasto CMS

Commerce backend for the Wefeasto storefront: **Payload CMS 3.90.2** on **Next.js 16.3.6** (React 19.2),
Postgres, SMTP email. It owns the catalog, customers, orders, payments (Razorpay, or a mock gateway in
dev and tests) and the retention flows. The storefront (the SvelteKit app in the repo root) stays a
static site. It reads the catalog at build time and calls `/api/*` in the browser.

The project-wide docs are in the repo root: [README](../README.md) (quickstart for both apps),
[ARCHITECTURE](../docs/ARCHITECTURE.md), [DEPLOY](../docs/DEPLOY.md), [TESTING](../docs/TESTING.md),
[SECURITY](../docs/SECURITY.md), [OWNER-DECISIONS](../docs/OWNER-DECISIONS.md) and
[RAZORPAY-TEST-MODE](../docs/RAZORPAY-TEST-MODE.md).

## Quickstart

```bash
# from the repo root: Postgres 16 (127.0.0.1:54329) + Mailpit (SMTP 54325, UI http://127.0.0.1:54326)
docker compose up -d

cd cms
cp .env.example .env        # dev values already point at the docker services, PAYMENTS_MODE=mock
npm install
npm run seed                # catalog snapshot, 3 unpublished policy drafts, dev admin (password printed once)
npm run dev                 # http://localhost:3000 → /admin
```

Sign in at <http://localhost:3000/admin> as `admin@wefeasto.local` with the password the seed printed
(`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` choose them). Without a seeded admin (`npm run seed -- --no-admin`),
`/admin` asks you to create the first user, and the first account is always an **admin**.
Emails (account verification, password reset, order mail) go to Mailpit at <http://127.0.0.1:54326>.
If `SMTP_HOST` is empty they are written to the server log, links included.

## Scripts

| script | what it does |
|---|---|
| `npm run dev` | `next dev` on port 3000. The DB schema is pushed automatically in dev (never onto a database that migrations manage; see Migrations). |
| `npm run build` / `npm start` | Production build, then serve it on port 3000. |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` over `src/` and `tests/` (run it in CI: `next build` does not check tests). |
| `npm run typecheck:build` | `tsc -p tsconfig.build.json --noEmit`: the program `next build` type-checks (`next.config.ts` `typescript.tsconfigPath`), i.e. everything except `tests/**` and `vitest.config.mts`, so a test's type error cannot fail a deploy. |
| `npm run test:unit` | Pure unit tests in `tests/unit/**`. No DB needed. |
| `npm run test:int` | Integration tests in `tests/int/**` against Postgres `wefeasto_test` (wiped at the start of every run; override with `TEST_DATABASE_URI=…/<name>_test`) and Mailpit. |
| `npm test` | Unit tests, then integration tests. |
| `npm run test:prod-smoke` | Production-build smoke guard (`scripts/prod-smoke.mjs`): reuses or makes a `next build` in `.next-prod-smoke` (`PROD_SMOKE_DIST_DIR=.next-<name>` for a parallel run), seeds a disposable `*_test` DB (`PROD_SMOKE_DATABASE_URI`, default `wefeasto_prodsmoke_test`), runs `next start` with rate limits on, and probes the minified error paths over HTTP (webhook redelivery, idempotent checkout races, duplicate signup, newsletter race, security headers (`/api/**` Referrer-Policy `no-referrer`), withErrors mapping, auth limits, resend-verification, password policy, stock guard) plus a server-log grep for `INTERNAL`/`Unhandled`. Exits 1 on any failure. `-- --rebuild` forces a build. |
| `npm run generate:types` | Regenerates `src/payload-types.ts`. Run it after any collection or global change. |
| `npm run generate:importmap` | Regenerates the admin import map. Run it after adding admin components or plugins. |
| `npm run migrate:create -- <name>` / `npm run migrate` / `npm run migrate:status` | Create a migration after a schema change / apply pending migrations / list them (see Migrations). |
| `npm run check:migrations` | Drift guard: applies `src/migrations` to a temporary database and fails if the config has schema changes no migration covers (see Migrations). Run it in CI. |
| `npm run build:deploy` | `payload migrate && next build`: the production build command (see Migrations). |
| `npm run seed` | Imports the catalog snapshot (`-- --help` for options). |
| `npm run smoke:razorpay` | Checks the real Razorpay **test-mode** integration (`scripts/razorpay-live-smoke.mjs`; `-- --checkout` adds a ₹1 test payment). Exits 2 with setup steps until test keys are in `.env`. See `docs/RAZORPAY-TEST-MODE.md`. |
| `npm run payload -- <cmd>` | The Payload CLI. |

## Layout

```
src/payload.config.ts        config: postgres, email, CORS/CSRF, collections, globals, endpoints, jobs
src/env.ts                   typed env reader + boot assertions (refuses unsafe payment/secret setups)
src/access/                  isAdmin, isAdminOrEditor, isSelf/isAdminOrSelf, publishedOrAdmin, hardenInternals
src/auth/                    customer auth hardening: password policy, auth rate limits, verify override,
                             resend-verification
src/collections/             users, customers, media, orders, payment-events, coupons, coupon-redemptions,
                             subscribers, message-log, counters, products/recipes/pages
src/globals/StoreSettings.ts store-settings (public keys + admin-only server keys)
src/commerce/                order numbers (WF-10001…), guest order tokens, settings, order events (events.ts)
src/commerce/checkout/       checkout domain: placeOrder, quote, markPaid, verify, webhook, retry, refunds, expire,
                             reconcile, stock, coupons, supersede, DTOs
src/commerce/shared/         pure JS rules shared with the storefront ($shared); another owner maintains it
src/payments/                gateway interface, RazorpayGateway (razorpay@2.9.8), MockGateway + mock endpoints, signatures
src/retention/               newsletter double opt-in, welcome offer, refill reminders, checkout consent, erasure
src/hooks/deployHook.ts      debounced storefront rebuild (VERCEL_DEPLOY_HOOK_URL) on catalog changes
src/seed/                    npm run seed (snapshot import, policy drafts, dev admin)
src/email/                   branded layout, customer auth emails, sendOnce (exactly-once), console adapter
src/lib/http.ts              JSON error body { error: { code, message, details? } }, body readers
src/lib/rateLimit.ts         in-memory sliding-window limiter (per IP + route)
src/lib/productStock.ts      stock-safe product saves (row lock, ±N adjust, no stale overwrites)
src/endpoints/index.ts       root endpoint registry → ./catalog, ./checkout, ./retention, ./account, ./csp (CSP reports)
src/jobs/index.ts            jobs registry → ./system, ./checkout, ./retention
scripts/prod-smoke.mjs       production-build smoke guard (npm run test:prod-smoke)
scripts/check-migrations.mjs migration drift guard (npm run check:migrations)
scripts/razorpay-live-smoke.mjs Razorpay test-mode smoke (npm run smoke:razorpay)
src/migrations/              generated SQL migrations + .json snapshots; index.ts = the prodMigrations list
next.config.ts               security headers (/api/** Referrer-Policy no-referrer), typescript.tsconfigPath
tsconfig.build.json          what `next build` type-checks: extends tsconfig.json minus tests/** (Next rewrites neither)
tests/unit, tests/int        vitest projects (see tests/int/helpers for the REST/Mailpit harness)
```

## Environment

See `.env.example`. Every variable, and what production needs:

| variable | production | notes |
|---|---|---|
| `DATABASE_URI` | required | Postgres. Use the provider's pooled URL on Vercel. |
| `DATABASE_POOL_MAX` | optional | pg pool size (default 10). |
| `PAYLOAD_SECRET` | required, ≥ 32 chars | Signs sessions and keys the guest order tokens: rotating it invalidates every session and every order link. |
| `PAYLOAD_PUBLIC_SERVER_URL` | required | Public CMS URL (admin, Razorpay webhook + callback). Added to CORS/CSRF. |
| `STOREFRONT_URL` | required | Email links (verify, reset password, order status) point here. |
| `STOREFRONT_ORIGINS` | required | Comma-separated origins allowed for credentialed CORS + CSRF (cookie auth). |
| `PAYMENTS_MODE` | `razorpay` | `mock` is refused with `NODE_ENV=production` unless `ALLOW_MOCK_PAYMENTS=1` (e2e / prod smoke only), and always when `APP_ENV`/`VERCEL_ENV=production`. |
| `ALLOW_MOCK_PAYMENTS` | unset | See above. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | required | `rzp_live_…` needs `NODE_ENV=production`; `APP_ENV`/`VERCEL_ENV=production` needs `rzp_live_…`. |
| `RAZORPAY_WEBHOOK_SECRET` / `_OLD` | required / during rotation | The dashboard webhook secret; `_OLD` is still accepted while rotating. |
| `APP_ENV` | `production` on the live shop | Defaults to `VERCEL_ENV`. Drives the key-prefix check. |
| `CRON_SECRET` | required | Vercel Cron sends `Authorization: Bearer $CRON_SECRET` (see Crons). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | required | Empty `SMTP_HOST` logs emails instead of sending (dev only). |
| `EMAIL_FROM` | required | e.g. `"Wefeasto <hello@wefeasto.com>"`; the domain needs SPF/DKIM. |
| `VERCEL_DEPLOY_HOOK_URL` | recommended | Storefront rebuild hook, called on catalog publishes. Empty = no-op. |
| `DEPLOY_HOOK_DEBOUNCE_MS` | optional | Delay after the last catalog save before the hook fires (default 10000). |
| `BLOB_READ_WRITE_TOKEN` | required on Vercel | Media uploads in Vercel Blob (the filesystem is read-only there). |
| `RATE_LIMIT_DISABLED` | **unset** | `1` turns every rate limit off (tests only). |
| `PAYLOAD_LOG_LEVEL` | optional | e.g. `warn`. |
| `PAYLOAD_DB_PUSH` | ignored in production | `false` disables the dev schema push (e.g. a seed on top of `payload migrate`). Push never runs with `NODE_ENV=production` or on a database with applied migrations. |
| `MOCK_WEBHOOK_DELAY_MS` / `MOCK_LATE_AUTH_DELAY_MS` / `MOCK_WEBHOOK_URL` | unset | Mock gateway tuning (dev/e2e). |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ALLOW_RESET` | seed only | See `npm run seed -- --help`. |

At boot the server refuses to start when:

- `PAYMENTS_MODE=mock` is used with `NODE_ENV=production`, unless `ALLOW_MOCK_PAYMENTS=1` is set (for e2e only);
- `PAYMENTS_MODE=mock` is used when `APP_ENV` (or `VERCEL_ENV`) is `production`, whatever `ALLOW_MOCK_PAYMENTS` says;
- razorpay mode is missing a key or secret;
- the key prefix doesn't fit the environment (`rzp_live_` outside production, or `rzp_test_` when `APP_ENV`/`VERCEL_ENV=production`);
- `PAYLOAD_SECRET` is shorter than 32 characters in production.

During `next build` these problems are reported as warnings instead.

## Auth model and security notes

- **Staff** (`users`): `admin` or `editor`. Editors manage catalog, recipes and pages only.
- **Customers** (`customers`): signup at `POST /api/customers`. The email must be verified before login;
  the link goes to `STOREFRONT_URL/login?verify=<token>`. `POST /api/store/account/resend-verification
  {email}` sends a fresh link (always `200 {ok:true}`: no account oracle). The session lives in the HttpOnly
  `payload-token` cookie (SameSite=Lax, Secure in production, 30 days). Password reset links go to
  `STOREFRONT_URL/reset-password?token=<token>`. The account locks for 10 minutes after 5 bad passwords.
  Customers can't open `/admin`. Guests can always check out.
- **No JWT in JSON** (`auth.removeTokenFromResponses` on customers): login, `/me`, `refresh-token` and
  `reset-password` never return the token in the body, so page scripts (or an XSS) can't read it. Only the
  HttpOnly cookie carries it. Server-to-server callers that need a bearer token read it from `Set-Cookie`.
  Staff (`users`) responses are unchanged.
- **Password policy:** customer passwords must be 8–128 characters on signup, change and reset (Payload's
  own minimum is 3). Violations are `400` ValidationErrors on path `password`, for REST, admin and Local API.
- **Rate limits** (per server instance, in memory; `RATE_LIMIT_DISABLED=1` turns them off):

  | action | limit | over it |
  |---|---|---|
  | signup `POST /api/customers` | 5 / 10 min / IP | 429 |
  | login | 10 / min / IP (+ Payload's 5-bad-passwords lockout) | 429 |
  | forgot-password | 5 / 10 min / IP and 3 / hour / email | 429 |
  | reset-password | 10 / 10 min / IP | 429 |
  | verify `/api/customers/verify/:token` | 10 / 10 min / IP | 429 |
  | resend-verification | 5 / min / IP; 1 / 10 min / email | 429 per IP; the per-email limit answers the same 200 and sends nothing |

  The built-in routes answer Payload's error shape `{errors:[{message, data:{code:'RATE_LIMITED',
  retryAfterSeconds}}]}` with a `Retry-After` header. Signed-in staff (admin UI) and the Local API are never
  limited. The client IP comes from `x-real-ip` / the first `x-forwarded-for` hop (set by Vercel).
- Cookie auth is honoured only for Origins listed in `STOREFRONT_ORIGINS` (plus the CMS itself). For
  server-to-server calls, send `Authorization: JWT <token>`.
- Payload internals (`payload-locked-documents`, `payload-preferences`) are staff-only; `payload-jobs` is
  closed to customers and guests (guard test `tests/int/hardening-jobs.int.spec.ts`). Don't enable
  Payload's jobs `schedule`: its `payload-jobs-stats` global is writable by any signed-in user by default.

## Stock

`stock` is operational state that orders reserve and release concurrently, so it is never saved as a number
from a form: the product page shows **Stock (packs)** read-only and has **Adjust stock by (±N)** (`+20`
for a delivery, `-3` for damaged packs). The adjustment is applied atomically when you save (also when
saving a draft) and can never take stock below 0 (error on the field). A save locks the product row, so a
reservation made while the form was open is never undone. Over the API, send `stockAdjust: ±N`; an absolute
`stock` that differs from the live value is refused with 400 (only on create, or with
`context.allowStockSet` in server code such as the seed, may it be set directly).

## Crons

Vercel Cron (`cms/vercel.json`) calls two endpoints with `Authorization: Bearer $CRON_SECRET`:

| endpoint | what it does |
|---|---|
| `GET /api/payments/reconcile` | Reconciles pending online orders with Razorpay: marks late/missed payments paid, expires unpaid orders past their reservation (stock + coupon released), retries unsent confirmations and queued refunds. |
| `GET /api/payload-jobs/run?queue=default&limit=50` | Runs queued Payload jobs (`refillReminder`, `sendEmail`, and `reconcilePendingOrders` when queued). `autoRun` is not used. |

`vercel.json` schedules both every 5 minutes, which needs **Vercel Pro**. On the **Hobby** plan cron jobs
run at most once a day, so expiry of unpaid orders (stock held up to a day) and the missed-webhook sweep
would lag by up to 24 hours. On Hobby, point an external scheduler (GitHub Actions, cron-job.org, an
uptime pinger) at both URLs every 5 minutes with the same `Authorization: Bearer $CRON_SECRET` header.
The storefront's order page also reconciles an order on its own when a customer checks its status.

## Migrations

The database schema is described twice, and the two must agree: by the Payload config (collections, globals,
fields, indexes) and by the SQL in `src/migrations/`. Production only ever gets the second.

| where | how the schema is made |
|---|---|
| `npm run dev`, `npm run seed`, `npm run test:int` | **Dev push**: at boot Payload diffs the config against the database and alters tables. It runs only when `NODE_ENV` isn't `production` and `PAYLOAD_DB_PUSH` isn't `false`, and never on a database that has applied migrations (`payload.config.ts` checks `payload_migrations` first and logs a warning instead). |
| production, `npm run test:prod-smoke`, the e2e stacks | **Migrations only**: `payload migrate` applies `src/migrations/*` in name order and records each one in `payload_migrations`. On its first DB connection a production server (`NODE_ENV=production`) also applies any still pending (`prodMigrations`: the list in `src/migrations/index.ts`). Push never runs. |

**Never mix them on one database.** A dev push leaves a `dev` row (batch −1) in `payload_migrations`. After that,
`payload migrate` asks "It looks like you've run Payload in dev mode … Would you like to proceed?", and a
production server waits forever on the same prompt (every request hangs). Keep the dev database (`wefeasto`,
pushed) and the production database separate. To try the production path locally, use a fresh database:
`payload migrate`, then `PAYLOAD_DB_PUSH=false npm run seed`, then `npm run build && npm start`.

### After a schema change

1. Change the collection, global or field, check it in `npm run dev` (the push applies it to your dev
   database), and run `npm run generate:types`.
2. `npm run migrate:create -- <short_name>` (e.g. `add_orders_gift_note`). Payload diffs the config against the
   latest snapshot in `src/migrations/*.json`, not against a database. It writes `<timestamp>_<name>.ts` (the
   SQL, `up` and `down`) and a new `.json` snapshot, and it rewrites `src/migrations/index.ts`. Any reachable
   `DATABASE_URI` will do: the command connects to it but doesn't change it.
3. When a field or table was renamed, drizzle-kit asks "Is x column … created or renamed from another
   column?". Choose rename to keep the data, so run the command in a terminal: without one it waits
   forever. Then read the SQL. A new required column on a table that has rows needs a default or a backfill
   in `up`. Keep `down` the exact reverse.
4. `npm run check:migrations` must print `OK`. Commit the `.ts`, the `.json` and `index.ts` together.
   Never edit or delete a migration that has already run in production: add a new one.

### `npm run check:migrations`

Takes about 6 s and needs Postgres (`CHECK_MIGRATIONS_PG_URI` points at any database on the server; the
default is the docker compose one). It creates `wefeasto_mig_check_<id>_test`, applies `src/migrations` with
`payload migrate`, then boots Payload on it with push off. It fails when:

- a dev push would still change the migrated database;
- `migrate:create` would write a non-empty migration;
- drizzle-kit would have to ask whether a field or table was renamed (reported at once, without waiting for an answer);
- `index.ts` and the migration files list different migrations;
- `payload_migrations` doesn't record every migration.

It then drops the database and prints the missing SQL. drizzle-kit 0.31 always re-emits `SET DEFAULT <n>` for
numeric columns; the check ignores those when the live default already has that value.
`tests/int/migrations.int.spec.ts` runs the same check inside `npm run test:int`. It applies the migrations to
`<test db>_mig_test`, compares that schema with the pushed test schema column by column, and checks that a
seed there never pushes.

### Deploying (Vercel)

- **Build command: `npm run build:deploy`** (`payload migrate && next build`), with the production
  `DATABASE_URI` available at build time. Migrations run once, before the new code takes traffic. Each one
  runs in a transaction, so a failing migration rolls back, fails the deploy, and leaves the previous
  deployment serving. Run it only for the production environment: preview deployments need their own
  database, or a preview build would migrate production.
- **`prodMigrations` is the fallback**, for a host whose build can't reach the database. Each production
  server instance applies the pending migrations on its first DB connection. After `build:deploy` that costs
  one `SELECT` per cold start. On serverless, don't rely on it alone. It runs inside a cold-start request,
  which makes that request slow, and it takes no lock. If two instances cold-start together while a migration
  is pending, both run it, and the loser fails ("already exists") and exits.
- Keep migrations backward compatible with the code that is still running during a deploy: add columns
  nullable or with a default, and drop columns in a later release.
- `npm run migrate:status` lists what has been applied. `npm run payload -- migrate:down` rolls back the last
  batch with its `down`. In production, prefer a new forward migration.

## Production deploy

The full walkthrough for both Vercel projects (storefront and CMS), with the environment tables, the first-deploy
checklist and rollback, is in [docs/DEPLOY.md](../docs/DEPLOY.md). The CMS side in short:

1. Create a Postgres database (Neon/Supabase/RDS) and a Vercel project with root directory `cms/`.
2. Set every variable marked *required* above (Production environment), with `PAYMENTS_MODE=razorpay`,
   live keys, `APP_ENV=production`, a fresh 32+ character `PAYLOAD_SECRET` and `CRON_SECRET`, and
   `RATE_LIMIT_DISABLED` unset.
3. Build command `npm run build:deploy` (`payload migrate && next build`) with the production `DATABASE_URI`
   available at build time: the first deploy creates every table from `src/migrations`, later deploys apply
   only the new migrations (see Migrations). Preview deployments must use a separate database.
4. Seed: `PAYLOAD_DB_PUSH=false SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… npm run seed -- --stock=0` against the
   production database (after step 3 created the schema), then set real stock with **Adjust stock by** in the admin.
5. Razorpay dashboard: webhook URL `https://<cms>/api/payments/razorpay/webhook` with the events
   `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`,
   `refund.failed`, `payment.dispute.created` (optional, also handled: `refund.created`, the other
   `payment.dispute.*`), and the secret in `RAZORPAY_WEBHOOK_SECRET`. Test mode first: `docs/RAZORPAY-TEST-MODE.md`.
6. Point the storefront's `/api/:path*` rewrite at the CMS so cookies stay first-party; set
   `STOREFRONT_URL`/`STOREFRONT_ORIGINS` to the storefront's origin.
7. Crons: Vercel Pro, or an external scheduler on Hobby (see Crons).
8. Before shipping a change, run `npm run check:migrations` and `npm run test:prod-smoke` (production build + HTTP probes).

## Other production notes

- **Media:** set `BLOB_READ_WRITE_TOKEN` to store uploads in Vercel Blob. Without it, uploads go to the
  local `media/` folder. Uploads are capped at 4 MB (`MEDIA_MAX_UPLOAD_BYTES`): a Vercel Function refuses any
  request body over 4.5 MB before Payload runs, and every photo has to pass through it (it is re-encoded
  server-side to strip EXIF/GPS), so a bigger photo gets Payload's own "file size limit" message instead.
- **Rate limits are per instance:** a serverless deployment runs several instances, so the limits blunt
  bursts from one client; they are not a global quota. Put a WAF / Vercel Firewall rule in front of
  `/api/customers/*` and `/api/store/*` for stronger guarantees.
