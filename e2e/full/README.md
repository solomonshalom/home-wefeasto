# Full-stack e2e (`e2e/full/**`)

Real browser → storefront (`vite preview` of a production build) → `/api` proxy → Payload CMS
(**production** `next build` + `next start`, mock Razorpay) → Postgres + Mailpit. Nothing is stubbed.

## Slots

Every run owns one isolated **slot** (`E2E_SLOT=0..4`, default 0), so several agents/shells can run at once:

| slot N | |
|---|---|
| CMS | `http://localhost:370N` (`PAYMENTS_MODE=mock ALLOW_MOCK_PAYMENTS=1`, `NODE_ENV=production`, dist `cms/.next-e2e-N`) |
| storefront | `http://localhost:470N` (mirror `.e2e/slot-N/site`, `/api` → the slot CMS) |
| database | `postgres://wefeasto:wefeasto@127.0.0.1:54329/wefeasto_e2e_N` (emptied, migrated with `payload migrate` and seeded on every start) |
| admin | `e2e-admin@wefeasto.test` / `e2e-admin-password-0123456789` |
| cron secret | `e2e-cron-secret` |
| state / logs | `.e2e/slot-N/state.json`, `.e2e/slot-N/logs/*.log` (previous run in `logs.prev/`) |

Mailpit (SMTP 54325, API/UI http://127.0.0.1:54326) is **shared by every slot**: tests scope mail by a unique
recipient and delete only their own messages. Docker services must be up (`docker compose up -d`).

The seed gives every product stock 1000 (`E2E_SEED_STOCK`), publishes the committed catalog snapshot and the policy
drafts, and creates the admin. Mock webhooks follow 300 ms after a payment (`E2E_MOCK_WEBHOOK_DELAY_MS`); a `late`
payment is authorised 10 s later (`E2E_MOCK_LATE_AUTH_DELAY_MS`). Rate limits are off (`RATE_LIMIT_DISABLED=1`).

## Running

```sh
E2E_SLOT=0 npx playwright test --project=full                          # whole suite: start stack → specs → stop stack
E2E_SLOT=0 npx playwright test --project=full e2e/full/smoke.spec.js   # one file (same lifecycle)
npm run test:e2e:full                                                   # = playwright test --project=full (slot $E2E_SLOT)
npm run test:e2e:harness                                                # harness unit tests (node --test, no stack)

npm run e2e:stack -- start --slot 1                                     # keep a stack up while iterating …
E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/checkout   # … and reuse it (seconds per run)
npm run e2e:stack -- status --all                                       # health of every slot
npm run e2e:stack -- stop --slot 1                                      # ALWAYS stop what you started
```

A cold start (no build cache) takes ~20–40 s here (Turbopack); a warm one ~8 s (DB reset + seed + `next start` +
preview). The `ui` project (`npx playwright test --project=ui`, the default) is unaffected: the full-stack projects only
exist when `--project` names them (`full`, `full-stack*`) or `E2E_FULL=1`, and the ui `webServer` only starts when the
ui project is selected.

| env | effect |
|---|---|
| `E2E_SLOT=N` | which slot (0..4) |
| `E2E_REUSE=1` | adopt a **healthy** running stack as is (no reset, not stopped afterwards); starts one if none is healthy |
| `E2E_KEEP=1` | don't stop the stack this run started (stop it yourself later) |
| `E2E_REBUILD=1` | ignore the CMS / storefront build caches |
| `E2E_WORKERS` | workers for the `full` project (default 1: specs share the slot DB — stock, settings) |
| `E2E_RETRIES` | retries for the `full` project (default 0) |
| `E2E_KEEP_MAIL=1` | don't delete the test's Mailpit messages afterwards |
| `E2E_SEED_STOCK` | stock per product at seed (default 1000; one full run buys ~100 of the busiest products) |
| `E2E_SCHEMA=migrate\|push` | how the schema is created: `migrate` (default) = `cms/src/migrations` via `payload migrate`, then the seed without push, exactly what production runs; `push` = Payload's dev push from the config, the migrations then recorded as applied (only to try a schema change before its migration exists) |
| `E2E_MOCK_WEBHOOK_DELAY_MS`, `E2E_MOCK_LATE_AUTH_DELAY_MS` | mock gateway timings (300 / 10000) |

Build caches: the CMS build (`cms/.next-e2e-N`) is keyed on `cms/src`, `next.config.ts`, package files, every
normalised `cms/tsconfig*.json` (`tsconfig.json` and `tsconfig.build.json`), the Next version and the slot URLs; the
storefront build (`.e2e/slot-N/site/build`) on the mirrored `src`, `static`, `cms/src/commerce/shared` and configs.
`next build` type-checks the `cms/tsconfig.build.json` program (`next.config.ts` `typescript.tsconfigPath`: it
`extends` `tsconfig.json` and excludes `tests/`), so an edit there — un-excluding tests, a strictness change — rebuilds
instead of reusing a build that never ran that check. Tests are not type-checked by the build: run `npm run typecheck`
in `cms/` (`npm run typecheck:build` = the build's program). `next build` is serialised across slots by a lock
(`.e2e/locks/cms-build`), and `cms/tsconfig*.json` + `cms/next-env.d.ts` (which Next may rewrite for a custom distDir;
16.x leaves them alone because `tsconfig.build.json` extends `tsconfig.json`) are restored byte-for-byte after every
build (also on Ctrl-C). Harness unit tests for the key and that guard: `scripts/e2e/files.test.mjs`.

## Writing specs

```js
// e2e/full/<domain>/<topic>.spec.js — e.g. e2e/full/checkout/supersede.spec.js
import { test, expect } from '../fixtures.js';
import { placeDismissedOrder } from './helpers.js';        // domain helpers live next to the specs

test('dismissed online → Pay on delivery supersedes it', async ({ page, shop, admin, mailpit }) => {
	const online = await placeDismissedOrder(page, { items: { muesli: 1 } });
	await page.locator('.wf-co-note [data-wf-action="pay-on-delivery"]').click();
	const { number } = await shop.placeCodOrder({ form: online.form });   // same phone → supersede
	expect(await admin.findOrder(online.number)).toMatchObject({ status: 'cancelled' });
	await mailpit.waitForMessage({ to: online.form.email, subjectIncludes: `Order ${number} placed` });
});
```

Rules:
- Put domain specs in `e2e/full/<domain>/` with their own `helpers.js` (import `test`/`expect` and the page helpers
  from `../fixtures.js`). Don't edit `fixtures.js`/`support/**` for one domain; ask the harness owner.
- **Unique data only**: `unique.email()`, `unique.phone()`, `unique.code()`; `checkoutForm()`/`fillCheckout()`
  already use fresh ones. Supersede, the open-COD cap and first-order checks key on phone/email.
- Change shared state only through `admin` (products, settings, coupons): it restores them after the test.
  Stock moved by orders you place is **not** restored and the whole suite shares the seed stock, so a flow that
  must be able to buy pins the products first with `admin.setStock()` (restored afterwards), like `smoke.spec.js`.
- Never wipe Mailpit; always wait on a recipient (`mailpit.waitForMessage({ to })`).
- Don't sleep: `expect.poll`, `mailpit.waitForMessage`, `waitOrderView`, `mock.waitForEvent`.
- Server work that runs after the response (newsletter rows, emails, webhooks) needs polling.
- No `test.only` (CI `forbidOnly`), and keep specs independent (one worker, but any order via `-g`).
- The first time a spec hits an unexpected console error it fails: fix the product or allow it narrowly
  (`consoleErrors.allow(/…/)`), never blanket-disable.
- Don't match on `err.name` / class names anywhere (the CMS bundle is minified: `"name":"u"`).

## Fixture reference (`e2e/full/fixtures.js`)

| fixture | scope | what |
|---|---|---|
| `stack` | worker | `state.json`: `{ slot, cmsUrl, sfUrl, dbUri, admin:{email,password}, cronSecret, mailpitUrl, mock:{webhookDelayMs, lateAuthDelayMs}, pids, durations }` |
| `admin` | test | JWT REST client as the seeded admin; **restores** products/settings/coupons after the test (`restoreAll`) |
| `adminSession` | worker | the raw session: `request(method, path, {body, query})` → `{status, json, text}`, `ok(…)` (throws unless 2xx) |
| `db` | worker | `pg` pool on the slot DB for time travel |
| `cron` | worker | the two cron endpoints with `Authorization: Bearer $CRON_SECRET` |
| `mailpit` | worker | Mailpit client; mail to every address the test created is deleted after it (auto) |
| `mock` | worker | mock Razorpay: browser automation + `POST /api/payments/mock/pay` |
| `api` | worker | the storefront's public `/api/store/*` (through the preview proxy) for fast setup |
| `shop` | test | page helpers bound to `page` |
| `unique` | test | `{ email(tag), phone({e164}), pin(), code(prefix), form(overrides), track(email) }` |
| `consoleErrors` | test | the collector; `allow(pattern)`, `list()`, `clear()`; fails a passing test on unexpected errors |
| `newContext` | test | `await newContext({ variant?, …contextOptions })` → a prepared extra context (closed after) |
| `variant` | option | `'normal'` \| `'nofx'` \| `'storage-throws'` \| `'storage-blocked'` — `test.use({ variant: 'storage-throws' })` |
| `failOnConsoleErrors` | option | default `true` |

### admin
```js
const p = await admin.getProduct('muesli');                 // depth 0, server-only fields (stock, lowStockThreshold)
await admin.setStock('muesli', 2);                          // absolute target → CMS `stockAdjust` ±N (re-read + retry)
await admin.adjustStock('muesli', -1);                      // ±N packs
await admin.setPrice('muesli', 29900);                      // paise
await admin.updateProduct('muesli', { inStock: false });    // any product fields
await admin.restoreProduct('muesli');                       // now (otherwise after the test)
const o = await admin.findOrder('WF-10003');                // doc | null (items, razorpay.{attempts,payments}, refunds…)
await admin.ordersByEmail(email);                           // newest first
await admin.updateOrder(no, { fulfilmentStatus: 'shipped' });   // → { status, doc, error } (400 on an invalid transition)
await admin.shipOrder(no); await admin.deliverOrder(no);    // COD is confirmed first
await admin.cancelOrder(no);                                // → { status, doc, error }; releases stock + coupon
const c = await admin.createCoupon({ type: 'fixed', value: 5000, firstOrderOnly: true });  // unique code; deleted after
await admin.getCoupon(code);
const s = await admin.getSettings();
await admin.updateSettings({ codEnabled: false, reservationMinutes: 1 });   // top-level keys; restored after
await admin.listSubscribers({ email }); await admin.findSubscriber(email);   // rows are written AFTER the 200: poll
await admin.findCustomer(email);
await admin.messageLog({ order: 'WF-10003' });              // message-log rows (exactly-once email keys) naming that order as a
                                                            // whole `:` segment (confirm:/ship:/refill:/refill-queue:), oldest first;
                                                            // server-side filtered + every page read, so new orders are found on a busy slot
await admin.messageLog({ keyPrefix: 'refill:', order: no });   // keyPrefix is a real prefix; both together are and-ed
```

### db (time travel; parameterised SQL, Payload snake_case columns)
```js
await db.expireReservation(no, { minutesAgo: 5 });          // orders.reserved_until into the past
await db.backdateOrder(no, { minutes: 40 });                // orders.created_at back (supersede window, age filters)
await db.order(no);                                         // raw row
await db.stock('muesli');                                   // exact stock
await db.jobs({ orderNumber, task });                       // payload_jobs rows
await db.makeJobsDue({ orderNumber, task });                // wait_until = now − 1 min → ids
await db.query('select …', [params]);
```

### cron
```js
const r = await cron.runReconcile({ order: no });           // GET /api/payments/reconcile → { status, json:{ok, checked, paid, expired, …} }
await cron.runReconcile();                                  // the normal sweep (age / throttle filters apply)
await cron.runJobs();                                       // GET /api/payload-jobs/run?queue=default&limit=50
```

### mailpit
```js
const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: `Order ${no} confirmed`, timeout: 20_000 }); // string | RegExp
const all = await mailpit.waitForMessages({ to: email, count: 2 });
const quiet = await mailpit.settle(email, { quietMs: 3000 });   // "exactly one email": nothing else arrives
mailpit.extractLinks(msg);                                  // hrefs (&amp; decoded) + text URLs
await mailpit.headers(msg.ID);                              // { 'List-Unsubscribe': [...], … }
await mailpit.messages(email); await mailpit.cleanup(email);
```

### mock (payments-gateway.md §6)
```js
await mock.setAuto(page, { auto: 'success' });   // before open(): success | fail | fail_then_success | dismiss | lost | silent | late
await mock.setAuto(page, { auto: 'fail', reason: 'card_declined', delayMs: 100, webhook: false });
await mock.clearAuto(page);                      // click the modal yourself: mock.modal(page).getByRole('button', { name: /^Pay/ })
const inst = await mock.waitForEvent(page, 'payment.failed');  // instance record: { options, events, silent, … } (read before navigating)
await mock.instances(page);
const r = await mock.pay(razorpayOrderId, 'success', { method: 'upi', webhook: true });  // server-side; also fail | late | authorize_only
await mock.failNext('createOrder', 'server');   // arm a gateway fault in the running CMS (POST /api/payments/mock/fault)
await mock.faultsAvailable();                    // true when that endpoint exists (mock mode only)
```
What the storefront does per mode: `success`/`fail_then_success` → /order confirmed; `fail` → note `FAILED`;
`dismiss` → `DISMISSED` (order stays `pending_payment`); `lost` → no handler, the webhook pays it, the page reaches
/order confirmed; `silent` → `OPEN_FAILED` after the 15 s watchdog; `late` → `FAILED` with the "money unsure" copy,
then /order turns confirmed ~10 s later without a reload.

### api (fast setup through the storefront proxy)
```js
const o = await api.placeOrder({ items: { muesli: 2 }, method: 'upi', form: { phone }, couponCode, consent: true });
// → { number, token, status, totalPaise, payment: { razorpayOrderId, … } | null, form, idempotencyKey }
await api.status(o.number, o.token); await api.quote({ items: [{ slug, qty }] }); await api.newsletter(email);
await api.checkout(body, { idempotencyKey }); await api.get('store/catalog'); await api.post('store/…', body);
```

### shop / page helpers (also exported from `fixtures.js` as `fn(page, …)`)
```js
await shop.visit('/shop');                      // goto + waitHydrated (client-side nav in the storage variants)
await shop.addToCart('muesli', 2);              // through the PDP UI; waits for the bag count
await shop.setCart({ muesli: 1, cornflakes: 2 });   // before the next navigation (storage variants: /cart?add=)
await shop.readCart(); await shop.cartCount();
await shop.gotoCheckout(); const form = await shop.fillCheckout({ method: 'cod', consent: true });
const { number, token, form, view } = await shop.placeOnlineOrder({ items, auto: 'success', method: 'upi' });
await shop.placeOnlineOrder({ items, auto: 'dismiss', expect: null });   // don't wait for /order
const cod = await shop.placeCodOrder({ items: { cornflakes: 2 }, form: { phone } });
await shop.waitOrderView(['confirmed', 'failed'], { timeout: 30_000 });
```
Variants: `nofx` adds `?nofx=1` to every storefront `page.goto`; `storage-throws` makes every `Storage` method throw
(quota); `storage-blocked` makes the `localStorage`/`sessionStorage` getters throw. In the storage variants the bag
lives in memory, so the helpers navigate client-side after the first load — a `page.goto` there empties the bag.

## Debugging

- `npm run e2e:stack -- status --slot N`; logs in `.e2e/slot-N/logs/` (`stack.log`, `seed.log`, `cms-build.log`,
  `cms.log` = `next start` output incl. server errors, `preview.log`, `sf-build.log`, `sf-sync.log`).
- Failed tests keep a trace (`npx playwright show-trace test-results/full-slot-N/…/trace.zip`), a screenshot, the
  Mailpit subjects received and the console errors seen.
- Keep the stack up (`E2E_KEEP=1` or `e2e:stack start`), then open the storefront/CMS admin in a browser, or
  `psql postgres://wefeasto:wefeasto@127.0.0.1:54329/wefeasto_e2e_N`; Mailpit UI at http://127.0.0.1:54326.
- A port is busy → `status --all`; `stop --slot N` only kills processes that belong to that slot.

## Known gaps

- Redirect mode (iPhone / Instagram UA + `callback_url`) and refunds have specs (`payments/redirect-mode.spec.js`,
  `orders/webhooks.spec.js`, `orders/reconcile.spec.js`) but no shared fixture helpers; the user agents live in
  `payments/helpers.js`.
- Everything runs against the mock gateway. The real Razorpay path is covered by `npm run smoke:razorpay` in `cms/`
  once test keys exist (docs/RAZORPAY-TEST-MODE.md).
