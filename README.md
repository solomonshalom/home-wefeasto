# Wefeasto

Breakfast shop. Three parts:

- **Storefront** (repo root): SvelteKit 2 and Svelte 5, fully prerendered to a static site with adapter-static.
  The catalog is baked in at build time from a snapshot of the CMS. In the browser it reads live prices and stock,
  and it calls `/api/*` on its own origin, which a dev proxy or a Vercel rewrite forwards to the CMS. GSAP and
  Lenis handle the motion.
- **CMS** (`cms/`): Payload CMS 3.90.2 on Next.js 16, backed by Postgres. It holds products, recipes, policy pages,
  store settings, customers, orders, coupons and subscribers. It also takes payments, sends email and runs the crons.
  The admin is at `/admin`.
- **Payments**: Razorpay Standard Checkout, called through a gateway interface. Until real keys exist, dev, tests
  and e2e use a mock of Razorpay built into the CMS (`PAYMENTS_MODE=mock`). Cash on delivery skips Razorpay.

Phase 1 was a 1:1 Svelte port of the static Webflow site. Phase 2 (branch `feat/payload-razorpay`) turns it into a
working store. What still needs the owner (keys, legal details, policy pages, product facts) is listed in
[docs/OWNER-DECISIONS.md](docs/OWNER-DECISIONS.md).

## Quickstart (local dev)

You need Node 22.12 or newer (Vite 7 needs `^20.19 || >=22.12`; this was built on Node 25.4 and npm 11.7) and Docker.

```bash
docker compose up -d        # Postgres 16 on 127.0.0.1:54329, Mailpit (SMTP 54325, web UI http://127.0.0.1:54326)

# CMS (terminal 1)
cd cms
cp .env.example .env        # dev values already point at the docker services; PAYMENTS_MODE=mock
npm install
npm run seed                # 6 products, 12 recipes, 3 unpublished policy drafts, a dev admin
npm run dev                 # http://localhost:3000/admin

# storefront (terminal 2, repo root)
npm install
npm run dev                 # http://localhost:5173 (/api is proxied to http://localhost:3000)
```

- **Admin login:** `admin@wefeasto.local` with the password `npm run seed` prints once. To choose them yourself, run
  `SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… npm run seed`. If no user exists (for example after
  `npm run seed -- --no-admin`), `/admin` asks you to create one; the first user is always an admin.
- **Emails** (order confirmations, account verification, newsletter) land in Mailpit at <http://127.0.0.1:54326>.
- **Payments:** online checkout opens the mock's "Test mode · mock payment" window, where you can pay or fail on
  purpose. To use Razorpay's real test mode instead, follow [docs/RAZORPAY-TEST-MODE.md](docs/RAZORPAY-TEST-MODE.md).
- **Open the shop at `http://localhost:5173`, not `127.0.0.1`.** The CMS only accepts cookie sign-ins from the
  origins in `STOREFRONT_ORIGINS`.
- The storefront also runs with no CMS at all: `/api` calls fail (the dev proxy answers 500 and the browser logs
  it) and the pages keep the committed snapshot's prices and stock. Checkout, accounts and the newsletter need the CMS.
- Append `?nofx=1` to any URL to turn off all motion. The site also honours `prefers-reduced-motion`.

## Where things live

```
src/routes/                pages: home, shop, products/[slug], recipes, recipes/[slug], cart, checkout, order,
                           login, account, reset-password, terms, privacy, published policy pages, 404
src/lib/components/        nav, footer, cards, cart toast, free-delivery meter, checkout and order views, PeepWalk…
src/lib/data/              cms-snapshot.json (the committed catalog) and the adapters that read it
src/lib/checkout/          checkout flow, Razorpay loader, server-quote client, /order logic, PIN lookup
src/lib/{cart,live,session,api}.js   bag store, live price/stock overlay, customer session, same-origin fetch
static/                    Webflow CSS + wefeasto.css, wf-checkout.css, wf-account.css, fonts, images, PIN shards
scripts/sync-cms.mjs       build-time snapshot sync from the CMS
scripts/e2e-stack.mjs      full-stack e2e stacks (one per slot)
e2e/ui, e2e/full           Playwright: storefront-only and full-stack suites
tests/unit                 storefront unit tests (vitest)
tools/                     regression guard against the pre-Phase-2 build
cms/                       Payload CMS (see cms/README.md)
cms/src/commerce/shared/   pricing, validation, coupon and order-status rules shared by the CMS and the storefront ($shared)
docker-compose.yml         Postgres + Mailpit for dev and tests
vercel.json                storefront hosting: output dir, clean URLs, /api rewrite to the CMS, security headers
```

## Scripts

Storefront (repo root):

| script | what it does |
|---|---|
| `npm run dev` | Vite dev server on :5173, `/api` proxied to `CMS_URL` (default `http://localhost:3000`) |
| `npm run build` | prerenders every page into `build/`. Runs `scripts/sync-cms.mjs` first, which only syncs when `CMS_SYNC=1` |
| `npm run preview` | serves the build on :4173, with the same `/api` proxy |
| `npm run sync:cms` | fetches `/api/store/snapshot` and rewrites `src/lib/data/cms-snapshot.json` |
| `npm run test:unit` | storefront unit tests |
| `npm run test:e2e:ui` | Playwright `ui` project (builds and previews the site; `/api` is stubbed) |
| `npm run test:e2e:full` | Playwright `full` project against a real CMS stack (see `e2e/full/README.md`) |
| `npm run e2e:stack -- start\|stop\|status` | manage a full-stack e2e slot by hand |
| `npm run test:regression` | compares the site with the pre-Phase-2 build (see `tools/README.md`) |

CMS (`cd cms`): `dev`, `build`, `start`, `seed`, `test:unit`, `test:int`, `test:prod-smoke`, `check:migrations`,
`migrate:create`, `build:deploy`, `smoke:razorpay`, `generate:types`, `typecheck`. [cms/README.md](cms/README.md) has
the full table.

## Docs

| doc | for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit: catalog sync, checkout, payments, stock, emails, retention, auth |
| [docs/DEPLOY.md](docs/DEPLOY.md) | the two Vercel projects, environment variables, database, crons, domains, first deploy, rollback |
| [docs/OWNER-DECISIONS.md](docs/OWNER-DECISIONS.md) | every placeholder and assumption the owner has to confirm, and where to change it |
| [docs/RAZORPAY-TEST-MODE.md](docs/RAZORPAY-TEST-MODE.md) | Razorpay test keys, smoke script, webhook, manual checklist, going live |
| [docs/TESTING.md](docs/TESTING.md) | every test suite and how to run it, environment quirks, CI suggestions |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model, controls in place, residual risks |
| [cms/README.md](cms/README.md) | CMS scripts, environment, auth notes, stock, crons, migrations |
| [e2e/full/README.md](e2e/full/README.md) | full-stack e2e harness: slots, fixtures, writing specs |
| [tools/README.md](tools/README.md) | regression guard and the legacy port-verification scripts |
| [COLOR-COMBOS.md](COLOR-COMBOS.md) | the 81 "Mix colors" palette combinations (`/color-combos.html`) |
