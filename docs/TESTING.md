# Testing

Every suite, what it needs, and how to run it. The counts are from runs on 2026-09-27 on this branch. "Services" in
the Needs column means the Docker Postgres (127.0.0.1:54329) and Mailpit (SMTP 54325, API/UI 54326) from
`docker compose up -d`.

## The pyramid

| Layer | Command | Size | Needs |
|---|---|---|---|
| Storefront unit | `npm run test:unit` (repo root) | 86 files, about 3,180 tests, about 15 s | nothing |
| CMS unit | `cd cms && npm run test:unit` | 55 files, 800 tests, about 6 s | nothing |
| CMS types | `cd cms && npm run typecheck` (src + tests) and `npm run typecheck:build` (what `next build` checks) | | nothing |
| CMS integration | `cd cms && TEST_DATABASE_URI=postgres://wefeasto:wefeasto@127.0.0.1:54329/<name>_test npm run test:int` | 60 files, 645 tests, about 3 min | services |
| Migration drift | `cd cms && npm run check:migrations` | about 6 s | Postgres |
| Production smoke | `cd cms && npm run test:prod-smoke` | 14 HTTP probes against `next build` + `next start` | services |
| Harness unit | `npm run test:e2e:harness` | 18 tests (`node --test`) | nothing |
| UI e2e | `npm run test:e2e:ui` | 24 files, 577 tests (2 opt-in skips) | Chromium; `/api` is stubbed, no CMS |
| Full-stack e2e | `E2E_SLOT=N npx playwright test --project=full [paths]` | 161 spec files, 539 tests incl. setup/teardown | services, Chromium |
| Regression | `npm run test:regression` | 6 phases, about 4 min | Chromium, git history (commit `2f60a63`) |
| Razorpay test mode | `cd cms && npm run smoke:razorpay [-- --checkout]` | steps 0–8 and a summary | Razorpay **test** keys in `cms/.env` |
| Mock Checkout harness | `npx playwright test -c cms/tests/browser/playwright.config.ts` | the mock `checkout.js` in a real browser | Chromium |

The shared rules in `cms/src/commerce/shared/` (`$shared`) are covered from both sides: `tests/unit/shared/` in the
storefront (property tests included) and the CMS unit and integration suites that price real orders.

## Storefront unit (`tests/unit/**`)

```bash
npm run test:unit                       # vitest run
npx vitest run tests/unit/checkout      # one folder
```

Node environment (jsdom where a test asks for it). `$lib` and `$shared` resolve as in the app. These check that the
snapshot adapters deep-equal frozen copies of the Phase 1 exports, plus cart hardening, the live overlay, the Vite
proxy, the sync script, the checkout flow state machine, the snapshot split, security headers in `vercel.json`,
PeepWalk's bublr walk parameters (all 105 peeps, 10s walk at 0.5–1.5x, 10px bob) and more.

## CMS unit and integration (`cms/tests/**`)

```bash
cd cms
npm run test:unit
TEST_DATABASE_URI=postgres://wefeasto:wefeasto@127.0.0.1:54329/wefeasto_test npm run test:int
TEST_DATABASE_URI=… npm run test:int -- tests/int/checkout-quote.int.spec.ts     # one or more files
PAYLOAD_LOG_LEVEL=info npm run test:int                                         # see Payload's logs
```

- The integration suite **drops and recreates the `public` schema** of its database at the start of every run and
  refuses any database whose name doesn't end in `_test`. Give every concurrent runner its own database, created
  once with `CREATE DATABASE <name>_test OWNER wefeasto` (`docker exec home-wefeasto-db-1 psql -U wefeasto -d
  wefeasto -c "…"`). A dev server pointed at a test database needs re-seeding afterwards.
- Its environment comes from `cms/tests/int/env.ts`, never from `cms/.env`: mock payments, rate limits off,
  `PAYLOAD_LOG_LEVEL=fatal`, SMTP to Mailpit.
- Tests call the real REST handlers in-process, with the mock gateway injected. `cms/tests/int/checkout-helpers.ts`
  delivers the mock's exact signed webhook bytes to the real receiver. `cms/tests/int/migrations.int.spec.ts` applies
  the migrations to `<test db>_mig_test` and compares that schema with the pushed one.
- `checkout-minified.int.spec.ts` renames Payload's error classes the way `next build` does. Code must never
  recognise errors by `err.name` or `constructor.name`.

## Migrations and production smoke

```bash
cd cms
npm run check:migrations      # temp DB, payload migrate, then fails on any schema drift
npm run test:prod-smoke       # production build + next start + HTTP probes
PROD_SMOKE_DIST_DIR=.next-mine PROD_SMOKE_DATABASE_URI=postgres://…/mine_prodsmoke_test npm run test:prod-smoke
```

`check:migrations` prints `OK … build exactly the configured schema` or the missing SQL. `test:prod-smoke` reuses
its build while `src/`, config and the lockfile are unchanged (`-- --rebuild` forces one). It seeds a disposable
`*_test` database and runs `next start` with rate limits **on**. It then probes webhook redelivery, idempotent
checkout races, newsletter races, security headers, error mapping, auth limits, the password policy, admin stock,
coupons and subscribers, and finally greps the server log for `INTERNAL`/`Unhandled`. It restores
`cms/tsconfig*.json` and `next-env.d.ts` byte for byte after building.

## UI e2e (`e2e/ui/**`, Playwright project `ui`)

```bash
npm run test:e2e:ui                                   # builds, then vite preview on :4173
npx playwright test --project=ui e2e/ui/order.spec.js
PW_PORT=4795 npx playwright test --project=ui …        # another port if 4173 is taken
```

The web server runs `npm run build && npm run preview` **in the current directory**, so it rebuilds `build/` and
`.svelte-kit/`. Don't run it while someone else previews the same tree; use a copy of the repo, as described below.
Every spec stubs `/api` (`stubApi` in `e2e/ui/helpers.js`, or `mockBackend()` in `e2e/ui/checkout-fixtures.js`,
which applies the real `$shared` rules). The UI suite never needs a CMS.

## Full-stack e2e (`e2e/full/**`, Playwright project `full`)

A real browser → the storefront (`vite preview` of a production build) → the `/api` proxy → the CMS (**production**
`next build` + `next start`, mock Razorpay) → Postgres and Mailpit. Nothing is stubbed. Each run owns a **slot**
(0–4) with its own ports (CMS 370N, storefront 470N), database `wefeasto_e2e_N` and build directory.

```bash
E2E_SLOT=0 npx playwright test --project=full                           # start stack → all specs → stop
E2E_SLOT=0 npx playwright test --project=full e2e/full/smoke.spec.js    # one file, same lifecycle
npm run e2e:stack -- start --slot 1                                      # keep a stack up while iterating…
E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments
npm run e2e:stack -- status --all
npm run e2e:stack -- stop --slot 1                                       # always stop what you started
```

The database is emptied, migrated with `payload migrate` and seeded on every start. Specs are grouped by domain:
`payments/`, `orders/`, `checkout/`, `accounts/`, `experience/` (including an axe accessibility scan) and `hunt/` (the
regression specs from the adversarial hunts). Fixtures, the mock controls (including fault injection through
`POST /api/payments/mock/fault`) and the rules for writing specs are in
[e2e/full/README.md](../e2e/full/README.md).

## Regression against the pre-Phase-2 site

```bash
npm run test:regression                          # dom, visual, visualjs, interact, nofx, smoke
npm run test:regression -- --only dom,smoke      # a subset (about 1 min)
node tools/regression.mjs --help
```

This builds commit `2f60a63` (the Phase 1 Svelte port) in a temporary git worktree and builds the working tree in a
private mirror. It serves both with no CMS and fails on any difference that `tools/regression-allowlist.json` doesn't
list with a reason. Details are in [tools/README.md](../tools/README.md). When a storefront change is intended, add
the narrowest allow-list rule; don't raise thresholds.

## Razorpay test mode

```bash
cd cms
npm run smoke:razorpay                 # exits 2 with setup steps until test keys are in cms/.env
npm run smoke:razorpay -- --checkout   # also a real ₹1 test payment in Razorpay Checkout
```

This has not been run against a real Razorpay account yet, because no keys exist. Setup, the webhook, and the
10-item manual checklist are in [RAZORPAY-TEST-MODE.md](RAZORPAY-TEST-MODE.md).

## Environment quirks (read before a long run)

- **Playwright is pinned to 1.62.0** (the root `@playwright/test` and `tools/package.json`), because this machine's
  browser cache has `chromium-1234`, and 1.63 wants a build that isn't downloaded. On a fresh machine or in CI, run
  `npx playwright install chromium` after `npm ci`. `reducedMotion` isn't a top-level `use` option in 1.62: use
  `test.use({ contextOptions: { reducedMotion: 'reduce' } })`.
- **PeepWalk is expensive under headless software rendering.** The crowd is a 1:1 port of bublr, kept that way at the
  owner's request: 105 sprites, 350px high. On a real GPU canvas it costs about 225 ms of main thread per 3 s at
  120 fps. Headless Chromium rasterises in software and is much slower. **Any spec that fast-forwards a fake clock**
  (`page.clock.runFor` / `fastForward` over many seconds) on a page where the crowd is visible must use
  `test.use({ contextOptions: { reducedMotion: 'reduce' } })`, which draws one still frame. Don't change PeepWalk to
  make a test faster.
- **Mailpit is shared** by every suite and slot. Send to a unique recipient (`unique.email()` in e2e, `uniqueEmail()`
  in CMS int), wait on that recipient, and delete only its messages. Never wipe the inbox.
- **One database per runner.** CMS int drops its `_test` database's schema, each e2e slot resets `wefeasto_e2e_N`,
  and prod smoke resets `wefeasto_prodsmoke_test` unless you pass `PROD_SMOKE_DATABASE_URI`. Two runners sharing one
  corrupt each other's runs.
- **Production builds rename classes.** The e2e stacks and prod smoke run `next build` + `next start` on purpose. A
  check that passes in `next dev` or vitest can fail there. Never match errors on `err.name` or `constructor.name`.
- **Custom Next build directories** (`NEXT_DIST_DIR=.next-<name>`) let parallel CMS builds coexist, but Next rewrites
  `cms/next-env.d.ts` for them. The e2e harness and prod smoke put it back byte for byte. For a build or `next dev`
  of your own, back up `cms/tsconfig.json`, `cms/tsconfig.build.json` and `cms/next-env.d.ts` first, restore them
  afterwards, and delete the directory.
- **`vite preview` serves from `.svelte-kit/output`.** A build in the same tree while a preview runs breaks that
  preview. For isolated runs, copy the repo (without `node_modules`, `.svelte-kit`, `build`, `cms/.next*`), symlink
  both `node_modules`, and build and preview there (`PW_PORT`, `PW_BUILD_DIR`).
- **Keep the Mac awake.** A laptop that sleeps mid-run stalls the servers and fails timing-based specs (mock webhook
  delays, reservation TTLs, `/order` polling). Wrap long runs in `caffeinate -i …` on macOS.
- **Ports.** CMS dev 3000, storefront dev 5173, preview 4173, e2e slots 3700–3704 / 4700–4704, prod smoke 3600 (or
  the next free port), Postgres 54329, Mailpit 54325/54326. `npm run e2e:stack -- status --all` shows which slots are
  busy, and `stop --slot N` only kills that slot's processes.
- **Rate limits** are off in CMS int and e2e (`RATE_LIMIT_DISABLED=1`) and **on** in prod smoke. Tests that exercise
  a limit turn it back on locally.

## CI suggestions

Nothing runs in CI yet. A reasonable split:

1. **Fast (every push, no services):** `npm ci` at the root and in `cms/`, then `npm run test:unit`,
   `cd cms && npm run typecheck && npm run test:unit`, and `npm run test:e2e:harness`.
2. **Backend (every push):** services `postgres:16` on 54329 (create `wefeasto`, `wefeasto_test` and
   `wefeasto_e2e_0`, as `docker/postgres-init/01-extra-dbs.sql` does) and `axllent/mailpit` on 54325/54326, since the
   test environments use those ports. Run `cd cms && npm run check:migrations`, then
   `TEST_DATABASE_URI=…/wefeasto_test npm run test:int`, then `npm run test:prod-smoke`.
3. **Browser (every PR):** `npx playwright install chromium`, `npm run test:e2e:ui`, and
   `npm run test:regression` (checkout with full history, `fetch-depth: 0`, so `2f60a63` exists).
4. **Full stack (before merging to main, or nightly):** `E2E_SLOT=0 npx playwright test --project=full`. It uses
   one worker by default because specs share the slot's database.

Cache `~/.cache/ms-playwright` keyed on 1.62.0, and both `node_modules` keyed on their lockfiles. With `CI` set,
Playwright forbids `test.only` and retries once (`playwright.config.js`). Keep the retry count at 0 for the `full`
project (`E2E_RETRIES`), so flaky money paths show up instead of passing on a retry.
