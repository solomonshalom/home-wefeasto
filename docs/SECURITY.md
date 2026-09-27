# Security

A summary of what the shop protects, the controls in place (with the files that implement them), and the risks that
remain. Architecture background is in [ARCHITECTURE.md](ARCHITECTURE.md). The adversarial hunts during Phase 2
found and fixed 91 bugs over four rounds. The last round still found two blockers, so treat this list as
current, not complete.

## Threat model in brief

**What matters most:**

1. Goods ship only for real, full payments. Nobody can pay less, pay twice by accident, or get an order confirmed
   without money arriving.
2. Customer data (names, emails, phone numbers, addresses, order history, marketing consent) stays private.
3. The admin (orders, refunds, stock, prices) stays with staff.
4. Secrets: Razorpay keys, the webhook secret, `PAYLOAD_SECRET` and `CRON_SECRET`.

**Who might attack:** anonymous visitors and bots (price and quantity tampering, enumeration, credential stuffing,
scraping), someone holding a forwarded order link, a signed-in customer reaching beyond their own data, forged
"Razorpay" requests to the webhook or callback, cross-site pages driving a shopper's browser (CSRF, login CSRF,
clickjacking), a compromised editor account, and third-party scripts (Razorpay's `checkout.js`).

**Out of scope for the app itself:** Razorpay's and Vercel's own security, the email provider, the customer's device.

## Controls in place

### Payments and money

| Control | Where |
|---|---|
| Server-side pricing only: client prices, totals and currency are ignored, a stale total gets `PRICE_CHANGED`, and quantities are parsed strictly (no `1e3`, `0x10`, floats or booleans) | `cms/src/commerce/checkout/checkout.ts`, `quote.ts`, `cms/src/commerce/shared/qty.js`, `pricing.js` |
| Payment signature verified with a timing-safe HMAC over the Razorpay order id **from our database**, then `fetchPayment` confirms order, amount and status before `markPaid` | `cms/src/payments/signatures.ts`, `cms/src/commerce/checkout/verify.ts` |
| Webhook: HMAC over the exact raw bytes (current or `_OLD` secret), a body cap of 256 KB, dedupe on the event id, and a PII-free stored extract | `cms/src/endpoints/checkout/payments.ts`, `cms/src/commerce/checkout/webhook.ts` |
| An amount or currency mismatch is never paid: the order goes to `needs_review` with an ALERT log line. A second payment on a paid order, or money on a cancelled order, is refunded automatically | `cms/src/commerce/checkout/payments.ts` (`markPaid`), `refunds.ts` |
| The redirect callback's unsigned `error[…]` fields are only recorded after `fetchPayment` confirms the failure | `cms/src/endpoints/checkout/payments.ts` |
| Idempotency keys: one order per key, and a changed payload with the same key is refused | `cms/src/commerce/checkout/checkout.ts` |
| Atomic stock decrements and row locks in a fixed order (orders → products → coupons → counters), so parallel checkouts can't oversell | `cms/src/commerce/checkout/stock.ts`, `db.ts` |
| Coupon limits are counted under a row lock. Identity-based checks run only at checkout, so the quote endpoint doesn't reveal who has ordered before. `usedCount` is server-owned | `cms/src/commerce/checkout/coupons.ts`, `cms/src/collections/Coupons.ts` |
| Mock payments can't reach production: the `/api/payments/mock/*` endpoints answer 404 outside mock mode, and boot refuses mock mode when `NODE_ENV=production` (unless `ALLOW_MOCK_PAYMENTS=1`) and always when `APP_ENV`/`VERCEL_ENV=production`. Live keys are refused outside production, and test keys in production | `cms/src/env.ts`, `cms/src/payments/mockEndpoints.ts` |
| Supersede only cancels an order the customer proves is theirs (the guest token or their session), never one matched by phone or email alone | `cms/src/commerce/checkout/supersede.ts` |

### Customer data and access

| Control | Where |
|---|---|
| Guest order links use `HMAC(PAYLOAD_SECRET, order id + random nonce)`. Only a hash is stored, the comparison is constant-time, and an unknown order and a wrong token get the same 404 | `cms/src/commerce/orderToken.ts`, `cms/src/commerce/checkout/orders.ts` |
| The order status answer masks contact details (first name, masked email and phone, city and state only). It has no street address, PIN, payment ids or token | `cms/src/commerce/checkout/dto.ts` |
| Token-bearing URLs don't leak through `Referer`: `Referrer-Policy: no-referrer` on every `/api/**` answer, and a no-referrer meta on `/order`, `/login` and `/reset-password`. CSP reports keep only origin and path | `cms/next.config.ts`, `src/routes/order/+page.svelte`, `cms/src/endpoints/csp/report.ts` |
| Collection access: orders, payment events, coupons, redemptions, subscribers and the message log are admin-only. Customers see only themselves. Editors get catalog, content and media only. Draft versions and Payload internals are staff-only. GraphQL is off, and `maxDepth` is 2 | `cms/src/access/`, `cms/src/collections/*.ts`, `cms/src/access/hardenInternals.ts`, `cms/src/payload.config.ts` |
| Admins can edit only an order's status fields, and only along the allowed transitions. Stale admin form saves can't overwrite concurrent changes to customers, subscribers or stock | `cms/src/commerce/shared/order-status.js`, `cms/src/auth/customerEdits.ts`, `cms/src/retention/subscriberWrites.ts`, `cms/src/lib/productStock.ts` |
| No membership oracles: newsletter sign-up and resend-verification always answer 200. Stock depth above `maxPerOrder` is never revealed | `cms/src/endpoints/retention/index.ts`, `cms/src/auth/resendVerification.ts`, `cms/src/commerce/checkout/quote.ts` |
| Marketing needs double opt-in unless the address is proven (a signed-in, verified customer). Unsubscribes and erasures always win. `List-Unsubscribe` is one-click | `cms/src/retention/subscribers.ts`, `erasure.ts`, `cms/src/email/retention/` |
| Uploads are re-encoded to strip EXIF and GPS data, capped at 4 MB and staff-only. SVGs go through Payload's own SVG inspection | `cms/src/lib/imageMetadata.ts`, `cms/src/collections/Media.ts` |

### Accounts and sessions

| Control | Where |
|---|---|
| The customer session is an HttpOnly `payload-token` cookie (SameSite=Lax, Secure in production) and never appears in JSON (`removeTokenFromResponses`) | `cms/src/collections/Customers.ts` |
| Email verification before login, passwords of 8–128 characters, a 10-minute lockout after 5 wrong passwords | `cms/src/collections/Customers.ts` (`verify`, `maxLoginAttempts`, `lockTime`), `cms/src/auth/passwordPolicy.ts` |
| Rate limits on signup, login, forgot, reset, verify and resend (per IP, and per email where it matters), and on every public store endpoint | `cms/src/auth/rateLimits.ts`, `cms/src/lib/rateLimit.ts`, `cms/src/endpoints/checkout/respond.ts` |
| Login CSRF guard: a sign-in, signup or reset from a foreign origin is refused (403). Cookies are trusted only for `STOREFRONT_ORIGINS` and the CMS | `cms/src/auth/crossSite.ts`, `cms/src/payload.config.ts` (`cors`, `csrf`) |
| Login and account writes are serialised, so a password reset can't be undone by a login that raced it, and concurrent logins don't drop each other's sessions | `cms/src/auth/loginSessions.ts`, `accountWrites.ts` |
| The last admin can't be deleted or demoted, which would re-open first-user registration | `cms/src/auth/lastAdmin.ts` |
| `?next=` redirects after login are sanitised to same-site paths | `src/lib/session.js` (`safeNext`) |

### Platform

| Control | Where |
|---|---|
| Malformed REST input (bad ids, operators, `where`, NUL bytes, non-JSON bodies) gets a 4xx before it reaches Postgres, with no SQL or stack in the logs | `cms/src/lib/restGuards.ts`, `restInput.ts`, `cms/src/lib/http.ts` |
| Custom endpoints accept JSON only (415 otherwise) and cap body sizes, so a plain cross-site form can't post to them | `cms/src/lib/http.ts` (`readJsonBody`) |
| Policy page and recipe HTML is refused on publish if it contains `<script>`, `<style>`, frames, forms, `on…=` handlers or `javascript:` links. The storefront sync validates it again | `cms/src/endpoints/catalog/rules.ts`, `src/lib/data/snapshot-schema.js` |
| Cron endpoints need `Bearer CRON_SECRET` (timing-safe; an empty secret never matches) or an admin. Payload's jobs `schedule` isn't used | `cms/src/jobs/access.ts`, `cms/src/endpoints/checkout/payments.ts` |
| Security headers. Storefront: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Permissions-Policy`, and a report-only full CSP that reports to `/api/store/csp-report`. CMS: `nosniff`, `X-Frame-Options: SAMEORIGIN`, strict referrer | `vercel.json`, `cms/next.config.ts`, `cms/src/endpoints/csp/` |
| Secrets only in environment variables (`.env` is gitignored). The Razorpay gateway keeps them in private fields, and the smoke script redacts every line it prints | `cms/src/payments/razorpay.ts`, `cms/scripts/razorpay-live-smoke.mjs` |
| Minification-safe error handling: nothing matches on `err.name`, and a production build is exercised by prod smoke and e2e | `cms/src/commerce/checkout/db.ts` (`isUniqueViolation`), `cms/scripts/prod-smoke.mjs` |

## Residual risks and recommendations

In rough order of importance.

1. **Client IP behind the storefront rewrite (verify after the first deploy).** Rate limits key on `x-real-ip`, then
   the first `x-forwarded-for` hop (`getClientIp`, `cms/src/lib/http.ts`). Requests reach the CMS through the
   storefront's Vercel rewrite, and it hasn't been checked which IP the CMS then sees. If it's a handful of Vercel
   addresses, every customer shares one bucket: 20 checkouts per minute for the whole shop, and bursts would lock
   real customers out. If the header can be set by the client (a host that doesn't overwrite it), the per-IP limits
   can be dodged. Check the CMS logs (DEPLOY.md §8) and adjust `getClientIp` to the header Vercel actually provides.
2. **Rate limits are per instance and in memory.** Serverless instances each keep their own counters, so the limits
   blunt bursts but aren't a global quota. Add Vercel Firewall (or WAF) rules for `/api/customers/*` and `/api/store/*`,
   and consider a shared store (Redis/Upstash) if abuse appears.
3. **The storefront CSP is report-only.** Only `frame-ancestors`, `object-src` and `base-uri` are enforced. The full
   policy allows `'unsafe-inline'` scripts, which the pre-paint inline scripts in `src/app.html` need. Review the
   `csp violation` logs after real traffic, then enforce (RAZORPAY-TEST-MODE.md §7). Later, move the inline scripts to
   hashes so `'unsafe-inline'` can go.
4. **Catalog HTML is filtered with a denylist.** Recipe and policy-page HTML is checked with a regex
   (`UNSAFE_HTML_RE`), not sanitised with an allowlist, and the storefront renders it with `{@html}` on prerendered
   pages. Only staff can write it, but a compromised editor account could try markup the regex doesn't list. Consider
   an allowlist sanitiser at save time, and enforce the CSP (item 3).
5. **The admin has no second factor and no CSP.** Payload's admin offers password login only. Keep few staff
   accounts with long unique passwords, prefer `editor` over `admin`, and remove accounts that are no longer needed.
   The CMS sends `X-Frame-Options: SAMEORIGIN` but no Content-Security-Policy.
6. **Guest order links are long-lived bearer links.** Anyone holding an order email can see that order (masked
   contact details, city and state) and retry its payment. They don't expire. Rotating `PAYLOAD_SECRET` kills them
   all, and every session and unsubscribe link with them.
7. **The mock gateway on a reachable deployment is a free-goods switch.** `POST /api/payments/mock/pay` marks orders
   paid. Boot refuses it in production, but `ALLOW_MOCK_PAYMENTS=1` on a preview makes that preview's orders payable
   for free. Only use it on e2e or preview stacks with their own database, and never put it on a preview that shares
   production data.
8. **Storefront preview deployments talk to the production CMS** (the rewrite is fixed in `vercel.json`). Orders
   placed there are real. Turn storefront previews off, or treat them as production (DEPLOY.md §6).
9. **Payment edge cases rely on Razorpay settings and on reconcile.** Authorised payments count as paid, and
   automatic capture is assumed. Nothing sweeps orders whose payment stays authorised but is never captured, and
   nothing sweeps payments made on Razorpay orders the CMS doesn't know. Keep auto-capture on and the reconcile cron
   running. On Vercel Hobby, reconcile runs daily unless an external scheduler calls it.
10. **Email links act on GET.** Newsletter confirm and unsubscribe links change state on GET, so a mail scanner that
    pre-fetches links could confirm or unsubscribe an address. The one-click unsubscribe POST is scanner-safe. A
    click-to-confirm page would close this.
11. **`checkout.js` is loaded without SRI**, because Razorpay serves an unversioned script. The storefront only
    accepts `https://checkout.razorpay.com/…` or the mock path as the script URL (`src/lib/checkout/razorpay.js`),
    and the CSP limits script origins once it's enforced.
12. **Saved checkout details stay in the browser.** "Save my details" keeps name, phone and address in
    `localStorage` (`wefeasto_checkout`) until "Not you? Forget me". This is opt-in, but be aware of it on shared
    devices.
13. **Operations.** ALERT log lines (amount mismatches, disputes, failed refunds, bad signatures) only help if someone
    sees them. Add a Vercel log drain or alert on `ALERT` and `SECURITY`. Turn on point-in-time backups. Keep
    Payload, Next.js and `razorpay` patched: run `npm audit` in both packages before each release, and rerun
    `check:migrations`, prod smoke and the e2e suite after upgrades. `noDevPushOnMigratedDb` in
    `cms/src/payload.config.ts` depends on adapter internals, so recheck it on Payload upgrades.
14. **First-user registration on a fresh deploy.** While the `users` table is empty, Payload lets anyone create the
    first admin at `/admin`. Seed the admin immediately after the first deploy (DEPLOY.md §12, step 3). After that,
    the last-admin guard keeps the table from emptying again.
15. **`prodMigrations` has no lock.** Use `npm run build:deploy`, so migrations run once at build time rather than in
    racing cold starts (cms/README.md "Migrations").
16. **Razorpay integration not yet run against the real API**, apart from the key-rejection path. Run the test-mode
    checklist before going live.

## Reporting a vulnerability

There is no dedicated security address yet. Until there is:

- Email the shop at `hello@wefeasto.com` (the contact address in the Terms) with **"Security"** in the subject. Don't
  open a public issue or post details anywhere public.
- Include what you found, the steps or request that show it, and what an attacker could do with it. Don't access
  other customers' data beyond what you need to show the issue, and don't place real orders you won't pay for.
- If the report involves payments, also check whether Razorpay itself is affected, and report that to Razorpay.

For the owner: consider publishing a `/.well-known/security.txt` on the storefront (a file in `static/.well-known/`)
with a monitored address. Rotate `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (using `_OLD` during the switch)
and `CRON_SECRET` immediately if any of them leaks. Rotate `PAYLOAD_SECRET` only if it leaks, since that breaks every
order link.
