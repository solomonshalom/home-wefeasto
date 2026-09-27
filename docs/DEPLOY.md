# Deploying Wefeasto

Production is two Vercel projects built from this one repo, plus a Postgres database, a Vercel Blob store, an SMTP
provider and a Razorpay account. **None of this has been deployed yet**, so nothing here that needs a real Vercel
project, domain, database provider, SMTP account or Razorpay key has been tried. The riskiest of those steps are
marked **(not verified: needs deploy)**. The local equivalents have been run: production builds, migrations, prod
smoke, the storefront sync, and e2e against `next start` (see [TESTING.md](TESTING.md)).

The domains used below are the placeholders already in the code: `wefeasto.com` for the storefront and
`cms.wefeasto.com` for the CMS. Replace them everywhere if yours differ (§6 and §8).

## 1. The two projects

| | Storefront | CMS |
|---|---|---|
| Vercel project root | repo root | `cms/` |
| Framework | static output (`vercel.json`: `outputDirectory: build`, `cleanUrls: true`) | Next.js |
| Build command | `npm run build` (the default). It runs `scripts/sync-cms.mjs`, then `vite build`. | `npm run build:deploy` (`payload migrate && next build`) |
| Output | static files in `build/` (every page prerendered, `404.html` for anything else) | a Next.js app: `/admin`, `/api/*` |
| Config files | `vercel.json` (rewrite, security headers) | `cms/vercel.json` (crons), `cms/next.config.ts` (headers) |
| Domain | `wefeasto.com` (+ `www`) | `cms.wefeasto.com` |

Node: pick 22.x on both projects. Vite 7 needs `^20.19 || >=22.12`, and the CMS allows `^18.20.2 || >=20.9`.
Development used Node 25.4.

The storefront needs `cms/src/commerce/shared/` at build time (the `$shared` alias), which it gets because its root
is the repo root. The CMS build uses nothing outside `cms/`. Only `npm run seed` reads `../src/lib/data/`, and you
run that from a checkout, not on Vercel.

## 2. Environment variables

### CMS (Vercel → CMS project → Settings → Environment Variables)

Set these for **Production**. Give **Preview** its own database and test keys (§11).

| Variable | Production value | Notes |
|---|---|---|
| `DATABASE_URI` | the provider's **pooled** Postgres URL | Also used at build time by `payload migrate`. |
| `DATABASE_POOL_MAX` | optional (default 10) | Per server instance. Keep instances × pool below the provider's connection limit. |
| `PAYLOAD_SECRET` | 32+ random characters | Signs sessions and derives guest order tokens and unsubscribe tokens. Changing it signs everyone out and breaks every order and unsubscribe link already emailed. |
| `PAYLOAD_PUBLIC_SERVER_URL` | `https://cms.wefeasto.com` | Used for admin URLs, the Razorpay `callback_url`, and newsletter confirm/unsubscribe links. Added to CORS/CSRF. |
| `STOREFRONT_URL` | `https://wefeasto.com` | Where email links and the callback redirect send customers. |
| `STOREFRONT_ORIGINS` | `https://wefeasto.com,https://www.wefeasto.com` | Origins whose cookie sign-ins are accepted (CORS + CSRF). |
| `APP_ENV` | `production` | Refuses test keys and mock payments. Vercel's `VERCEL_ENV=production` has the same effect when `APP_ENV` is unset. |
| `PAYMENTS_MODE` | `razorpay` | `mock` is refused in production. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | `rzp_live_…` / secret | [RAZORPAY-TEST-MODE.md](RAZORPAY-TEST-MODE.md) §7. |
| `RAZORPAY_WEBHOOK_SECRET` | the live webhook's secret | `RAZORPAY_WEBHOOK_SECRET_OLD` only while rotating. |
| `CRON_SECRET` | 16+ random characters | Vercel Cron sends it as `Authorization: Bearer …`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | your SMTP provider | See "Email". With `SMTP_HOST` empty, emails only go to the log. |
| `EMAIL_FROM` | e.g. `Wefeasto <hello@wefeasto.com>` | The domain needs SPF and DKIM. |
| `VERCEL_DEPLOY_HOOK_URL` | the storefront's deploy hook URL | See "Deploy hook". Empty means catalog edits never reach the site until someone deploys it. |
| `BLOB_READ_WRITE_TOKEN` | set automatically when you connect a Blob store | Without it, uploads go to the read-only filesystem and fail. |
| `RATE_LIMIT_DISABLED`, `ALLOW_MOCK_PAYMENTS`, `PAYLOAD_DB_PUSH`, `MOCK_*` | **unset** | Test knobs. |

The full list with dev defaults is `cms/.env.example`. `cms/src/env.ts` checks it at boot and refuses to start when
`PAYLOAD_SECRET` is short, a Razorpay value is missing, the key prefix doesn't fit the environment, or mock payments
are asked for in production. During `next build` those problems are only warnings.

### Storefront (build time only; nothing secret)

| Variable | Value | Effect |
|---|---|---|
| `CMS_SYNC` | `1` | Fetch `https://…/api/store/snapshot` before building. |
| `CMS_REQUIRED` | `1` | Fail the build if the sync fails. Without it, a CMS outage silently builds from the committed snapshot. |
| `CMS_URL` | `https://cms.wefeasto.com` | Where the sync fetches from. It doesn't affect the browser's `/api` calls; those follow the `vercel.json` rewrite. |

Verified locally: `CMS_SYNC=1 CMS_REQUIRED=1 CMS_URL=http://localhost:<port> npm run build` syncs and builds, a CMS
that is down fails that build with exit 1, and without `CMS_REQUIRED` it warns and builds from the committed file.

## 3. Database (Postgres)

- Use Neon or Supabase (or any Postgres 16) and give the CMS the **pooled** connection string. Everything the CMS
  does in the database uses transaction-scoped locks and settings (`pg_advisory_xact_lock`,
  `set_config(…, true)`), so a transaction-mode pooler is fine. **(Not verified against Neon or Supabase: needs
  deploy.)**
- The schema comes only from `cms/src/migrations/`. `npm run build:deploy` runs `payload migrate` before
  `next build`, so the first deploy creates every table. Later deploys apply only the new migrations. Each migration
  runs in a transaction: a failing one fails the deploy, and the previous deployment keeps serving. Details, and the
  `prodMigrations` fallback, are in [cms/README.md](../cms/README.md) "Migrations".
- **Never point `npm run dev` or a dev-pushed seed at the production database.** A dev push leaves a marker that makes
  `payload migrate` and production boots hang on a prompt. `payload.config.ts` now skips the push on any database that
  has applied migrations, but keep the databases apart anyway.
- Seed production once, from a checkout, after the first deploy has created the schema:

  ```bash
  cd cms
  DATABASE_URI='<production URL>' PAYLOAD_DB_PUSH=false \
  SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='<long password>' \
  npm run seed -- --stock=0
  ```

  Then set real stock in the admin with **Adjust stock by**. Pass `--stock=0` explicitly: on a laptop the seed
  doesn't know it's production, so its default of 100 packs would apply.
- Backups: turn on the provider's point-in-time restore. Orders, payments and consent records exist only in this
  database.

## 4. Media (Vercel Blob)

Create a Blob store and connect it to the CMS project, which sets `BLOB_READ_WRITE_TOKEN`. Uploads are capped at
4 MB (`MEDIA_MAX_UPLOAD_BYTES`, below Vercel's 4.5 MB request limit) and re-encoded to strip EXIF and GPS data.
Product images from the snapshot are static files in the storefront (`static/images/…`). A product only uses Blob
when an editor uploads a new image for it.

## 5. Crons

`cms/vercel.json` schedules two endpoints every 5 minutes. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
by itself once `CRON_SECRET` is set on the project.

| Endpoint | Job |
|---|---|
| `GET /api/payments/reconcile` | Confirms payments whose webhook was missed, expires unpaid orders past their 30-minute reservation (stock and coupon go back), re-sends missing confirmations, retries queued refunds. |
| `GET /api/payload-jobs/run?queue=default&limit=50` | Runs queued jobs: refill reminders, email retries. |

A 5-minute schedule needs **Vercel Pro**. On **Hobby**, Vercel runs cron jobs at most once a day (check its current
limits), so unpaid orders would hold their stock for up to a day, and missed webhooks would be picked up once a
day. On Hobby, call both URLs every 5 minutes from an external scheduler
(cron-job.org, an uptime monitor, a GitHub Actions `schedule`) with the same header:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://cms.wefeasto.com/api/payments/reconcile
curl -fsS -H "Authorization: Bearer $CRON_SECRET" 'https://cms.wefeasto.com/api/payload-jobs/run?queue=default&limit=50'
```

Both answer `401` without the secret. (Verified against a local production build on an e2e slot.) While a customer
has the order page open, it confirms payments on its own, so even a daily cron doesn't leave a paying customer
waiting.

## 6. The storefront's `/api` rewrite

`vercel.json` forwards `/api/:path*` to `https://cms.wefeasto.com/api/:path*`. That keeps the customer's session cookie
first-party and lets the storefront call the CMS with no CORS. **If the CMS lives elsewhere, change two places in
`vercel.json`:** the rewrite `destination`, and the CMS origin in `form-action` of `Content-Security-Policy-Report-Only`.
`tests/unit/security-headers.test.js` checks that the two agree. The browser never uses `CMS_URL`.

The same file sets the storefront's security headers: `X-Frame-Options: DENY`, `nosniff`, a `Permissions-Policy`, an
enforced CSP (`frame-ancestors 'none'; object-src 'none'; base-uri 'self'`), and a **report-only** full CSP whose
reports go to `/api/store/csp-report`. RAZORPAY-TEST-MODE.md §7 explains how to switch it to enforced after the first
real orders.

**Preview deployments of the storefront use the same rewrite**, so they talk to the *production* CMS: an order placed
on a preview URL is a real order. Cookie sign-in from a preview origin is refused, because it isn't in
`STOREFRONT_ORIGINS`. Turn off storefront previews, or treat them as production.

## 7. Deploy hook (catalog edits → rebuild)

1. Storefront project → Settings → Git → **Deploy Hooks** → create one for the production branch.
2. Put its URL in the CMS's `VERCEL_DEPLOY_HOOK_URL` and redeploy the CMS (environment changes need a redeploy).

After that, publishing or unpublishing a product, recipe or policy page, or saving public store settings, triggers one
rebuild about 10 seconds after the last save (`cms/src/hooks/deployHook.ts`). With `CMS_SYNC=1` and
`CMS_REQUIRED=1` the rebuild pulls the new snapshot. Prices and stock don't need a rebuild; the live overlay reads
them from `/api/store/catalog`. **(Not verified: needs deploy.)**

## 8. Domains, cookies, CORS and CSRF

| Setting | Value |
|---|---|
| Storefront domain | `wefeasto.com`, with `www` redirecting to it (or the other way round; list both in `STOREFRONT_ORIGINS`) |
| CMS domain | `cms.wefeasto.com`. Admins use `https://cms.wefeasto.com/admin`, and `/` redirects there. |
| `PAYLOAD_PUBLIC_SERVER_URL` | `https://cms.wefeasto.com` |
| `STOREFRONT_URL` / `STOREFRONT_ORIGINS` | `https://wefeasto.com` / `https://wefeasto.com,https://www.wefeasto.com` |

- The customer cookie `payload-token` is set on the **storefront** origin through the rewrite (HttpOnly,
  SameSite=Lax, Secure in production). Staff sign in on the CMS origin with their own cookie.
- A cookie is only trusted for the origins in `STOREFRONT_ORIGINS` plus the CMS itself. Sign-in, signup and password
  reset from any other site are refused (`cms/src/auth/crossSite.ts`).
- Razorpay's webhook and redirect callback go straight to the CMS domain and use no cookies.
- **After the first deploy, check which client IP the CMS sees** for requests coming through the rewrite (Vercel → CMS
  project → Logs). The rate limits are per IP. If every request shows one of a few Vercel addresses, all customers
  share one bucket (for example 20 checkouts per minute for the whole shop). See SECURITY.md. **(Not verified: needs
  deploy.)**

## 9. Razorpay

Follow [RAZORPAY-TEST-MODE.md](RAZORPAY-TEST-MODE.md): test mode first (§1–6), then going live (§7). In short: KYC,
live keys in the CMS Production environment with `APP_ENV=production`, a live webhook to
`https://cms.wefeasto.com/api/payments/razorpay/webhook` with its own secret and the seven events, automatic capture
on, and one real order refunded end to end. Razorpay checks the policy pages on the site before approving the
account; they are unpublished drafts today (OWNER-DECISIONS.md).

## 10. Email

- Any SMTP provider works (`@payloadcms/email-nodemailer`). With Resend's SMTP relay, their documented settings are
  host `smtp.resend.com`, port 465 with `SMTP_SECURE=1` (or 587), user `resend`, and an API key as the password.
  **(Not verified: needs an account.)**
- Verify the sending domain with the provider and publish the SPF and DKIM records it gives you, plus a DMARC record
  (start with `p=none`). Without them, order confirmations land in spam.
- `EMAIL_FROM` must use that domain. Test with a real order and check Gmail's "Show original" for SPF/DKIM/DMARC =
  PASS.
- Replies go to the `EMAIL_FROM` address. Make sure someone reads it: refund and "didn't get my order" emails will
  arrive there.

## 11. Preview deployments (CMS)

Environment variables in Vercel are per environment. For the CMS's **Preview** environment, set a separate
`DATABASE_URI` (a Neon branch or a second database), `PAYMENTS_MODE=razorpay` with **test** keys, a test webhook
secret, and the preview URLs for `PAYLOAD_PUBLIC_SERVER_URL` / `STOREFRONT_URL` / `STOREFRONT_ORIGINS`. With a
separate database, `npm run build:deploy` migrates only that preview database. **Never let a preview share the
production `DATABASE_URI`**: its build would migrate production. Vercel's Deployment Protection answers Razorpay's
webhooks with 401, so turn it off or add the bypass parameter (RAZORPAY-TEST-MODE.md §5.1).

## 12. First deploy, in order

1. [ ] Create the production Postgres database. Turn on point-in-time restore.
2. [ ] Create the CMS project (root `cms/`, build command `npm run build:deploy`, Node 22). Connect a Blob store. Set
   every Production variable in §2 **except** `VERCEL_DEPLOY_HOOK_URL`. Deploy. The build log should show
   `payload migrate` applying `20260926_221514_init` and every later migration.
3. [ ] **Right away**, seed from a checkout (§3) with `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`. Until a user exists,
   Payload's `/admin` offers "create first user" (who becomes an admin) to anyone who finds the URL. Then check
   Admin → Settings → Users lists only you.
4. [ ] Add the CMS domain (`cms.wefeasto.com`), sign in at `/admin`, and set stock with **Adjust stock by** for
   every product.
5. [ ] Go through [OWNER-DECISIONS.md](OWNER-DECISIONS.md) in the admin: store settings (legal details, WhatsApp
   number, delivery fee), product facts, policy pages (review, then publish with "Show on the storefront").
6. [ ] If your domains differ from the placeholders, change `vercel.json` (§6) and commit.
7. [ ] Create the storefront project (repo root) with `CMS_SYNC=1`, `CMS_REQUIRED=1`, `CMS_URL=https://cms.wefeasto.com`.
   Deploy, then add `wefeasto.com` and `www`.
8. [ ] Create the storefront deploy hook, set `VERCEL_DEPLOY_HOOK_URL` on the CMS, and redeploy the CMS. Publish a
   harmless edit and check that the storefront rebuilds within a minute.
9. [ ] Crons: Vercel Pro, or an external scheduler (§5). Check that the CMS logs show both endpoints answering 200.
10. [ ] Email: domain verified, SPF, DKIM and DMARC published (§10).
11. [ ] Razorpay: KYC approved, live keys, live webhook, automatic capture (RAZORPAY-TEST-MODE.md §7).
12. [ ] Smoke on the live site: browse, add to bag, check the live price and stock, sign up (verification email),
    place a COD order (email, admin), place a small UPI or card order with your own money, check the webhook
    deliveries show 200 in the Razorpay Dashboard, then refund it from the Dashboard.
13. [ ] Check the client IP the CMS logs for rewritten requests (§8), and `curl -I https://wefeasto.com` shows the
    security headers from `vercel.json`.
14. [ ] After a week or two of real traffic, review the `csp violation` logs and enforce the CSP.

## 13. Rollback

- **Storefront:** Vercel → Deployments → pick the previous good one → **Instant Rollback** (or Promote). It is static
  and stateless. Prices and stock stay current through the live overlay, while names, copy and images revert to that
  build's snapshot.
- **CMS code:** the same Instant Rollback. It **does not roll back the database**. This is safe as long as migrations
  stay backward compatible: add columns as nullable or with a default, and drop them only in a later release
  (cms/README.md "Migrations").
- **A bad migration:** a migration that fails rolls itself back and fails the deploy, so the old deployment keeps
  serving. For one that succeeded but is wrong, prefer a new forward migration. `npm run payload -- migrate:down`
  (run against the production URL from a checkout) reverts the last batch with its `down`, but only after you've
  rolled the code back to match.
- **Data:** restore from the provider's point-in-time backup into a new branch or database, then point
  `DATABASE_URI` at it. Orders placed after the restore point exist only in Razorpay; reconcile them from the
  Dashboard.
- **Payments emergency:** no setting turns off online payment while keeping COD. If payments misbehave, roll the
  CMS back. As a last resort, an invalid `PAYMENTS_MODE` makes the CMS refuse to boot. The static pages keep loading,
  but checkout, accounts, the newsletter and the live overlay stop.
