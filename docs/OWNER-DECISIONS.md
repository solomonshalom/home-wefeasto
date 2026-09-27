# Owner decisions

Everything below is a placeholder or an assumption made while building Phase 2. Each one needs the owner to confirm
it or supply the real value. "Admin" means the Payload admin (`/admin`). **Store settings** is Admin → Settings →
Store settings. Money fields there are entered in **paise** (₹49 = 4900). Saving store settings rebuilds the
storefront through the deploy hook (DEPLOY.md §7). The values in the "Now" column come from
`src/lib/data/cms-snapshot.json` and `cms/src/commerce/shared/settings.js` as of this writing.

## 1. Delivery, COD and order limits

| Item | Now | Where to change | Notes |
|---|---|---|---|
| Delivery fee | ₹49 below ₹499, free from ₹499 | Store settings → Delivery & payment: `deliveryFeePaise` 4900, `freeDeliveryThresholdPaise` 49900 | Judged on the subtotal **before** any discount, so a coupon never takes free delivery away. |
| Cash on delivery | on | Store settings → Delivery & payment: `codEnabled` | Per product: Admin → Catalog → Products → `codAllowed` (on for all six). |
| COD cap | ₹2,000 order total | `codMaxPaise` 200000 | |
| COD fee | ₹0 | `codFeePaise` 0 | Added to the total only when COD is picked. |
| COD minimum | ₹0 | `codMinSubtotalPaise` 0 | |
| Open COD orders per phone | 2 | Store settings → Server only: `codMaxOpenPerPhone` | "Open" means placed or confirmed and not yet delivered or returned. 0 turns COD off. No OTP check in v1. |
| COD-blocked / undeliverable PIN prefixes | none | Server only: `codBlockedPinPrefixes`, `blockedPinPrefixes` | e.g. `744` for the Andamans. |
| Largest order | ₹50,000 | `maxOrderPaise` 5000000 | Keep it within your Razorpay per-transaction limit. |
| Per-product limit | 10 packs | Products → `maxPerOrder` | `lowStockThreshold` (5) makes `/api/store/catalog` report low stock, but no page shows it yet. |
| Stock hold for unpaid online orders | 30 min | Server only: `reservationMinutes` | "Pay on delivery instead" relies on this being ≥ 30 (the storefront offers it for 25 minutes). |
| Shipping promise | "Ships in 1–2 days · delivered in 3–7 days" | Delivery & payment: `shippingPromiseText` | Shown in the cart, checkout, order page and emails. |

The policy drafts (§4) repeat ₹49, ₹499, ₹2,000 and the WhatsApp number as plain text. If you change a setting,
change the policy text as well.

## 2. Products

| Item | Now | Where to change |
|---|---|---|
| **Health Mix net quantity** | unknown: `packSize`, `packGrams` and `facts.netQuantity` are empty, so its product page shows no "Product facts" | Admin → Catalog → Products → Health Mix |
| **Product facts** for all six: ingredients, allergens, best before, manufacturer/packer with address, country of origin | only net quantity is filled (from the pack size). Allergens are empty for every product, but the planning notes say Muesli and Health Mix may contain nuts. | Products → Product facts group. The page lists only the facts that are filled in (`ProductFacts.svelte`). |
| **Ratings** | Cornflakes 5, Steel-Cut Oats 4.3, Rolled Oats 4.4, Muesli 4, Choco's 4.5, Health Mix 5 (the Phase 1 values), with no source | Products → `rating`, `ratingSource`. The storefront shows the stars whether or not `ratingSource` is set, and it doesn't display the source yet. Removing unsourced ratings needs a code change. |
| Days per pack (drives refill reminder timing) | Cornflakes 21, Steel-Cut Oats 16, Rolled Oats 16, Muesli 11, Choco's 10, Health Mix empty (treated as 14) | Products → `daysPerPack` (with `packGrams`, `servingGrams`) |
| Opening stock | 0 in production (you set it) | Products → **Adjust stock by (±N)** |

Indian e-commerce and packaging rules expect several of these declarations (net quantity, manufacturer, country of
origin, best before, allergens) on the product page. Confirm the list with your advisor.

## 3. Legal identity (footer, grievance page, Razorpay KYC)

| Item | Now | Where to change |
|---|---|---|
| Legal entity name, registered address | empty. The footer says "© 2026 Wefeasto". | Store settings → Legal: `entityName`, `address` |
| FSSAI licence (14 digits) | empty (the footer shows the FSSAI line only once it's set) | Legal: `fssaiLicence` |
| GSTIN | empty | Legal: `gstin` |
| Grievance officer: name, designation, email, phone | empty (required by the Consumer Protection (E-Commerce) Rules 2020) | Legal: `grievanceOfficer.*` |
| Support WhatsApp number | `+919845262777`, the phone number from the Phase 1 footer. Confirm it's on WhatsApp and staffed. | Store settings → Announcement & support: `supportWhatsappE164` (empty hides WhatsApp help) |
| Footer phone and hours, and the contact lines in Terms and Privacy | `+91-9845262777`, Mon–Sat 09:00–18:00, `hello@wefeasto.com` | Hard-coded: `src/lib/components/Footer.svelte`, `src/lib/data/terms-body.html`, `src/lib/data/privacy-body.html` (a code change) |

## 4. Policy pages

- **Shipping Policy, Refunds & Cancellations and Grievance Redressal exist only as unpublished drafts** (Admin →
  Content → Pages, seeded from `src/lib/data/policy-drafts.server.json`). They start with "Draft — to be reviewed by
  Wefeasto before publishing", and the grievance page has eight `[to be added]` placeholders. Publishing refuses a page
  that still contains either marker.
- Review the promises they make: damage reports within 48 hours, refunds started within 2 working days, COD refunds
  paid to a UPI ID or bank account, complaints acknowledged within 48 hours and resolved within a month.
- To publish: edit the page, remove the markers, tick **Show on the storefront**, then Publish. The storefront
  rebuilds and adds the page and its footer link. Razorpay checks these pages before approving a live account.
- **Terms and Privacy** are the Phase 1 pages (`src/lib/data/terms-body.html`, `privacy-body.html`), not CMS pages.
  The privacy policy doesn't name Razorpay (payments), the email provider or Vercel (hosting). Review it for DPDP,
  and add an email and address if Razorpay asks for them.

## 5. Offers, coupons and marketing

| Item | Now | Where to change |
|---|---|---|
| Welcome offer | 10% off the first order, at most ₹75, valid 30 days, one use, bound to the subscriber's email, code `HELLO-XXXX` | Store settings → Announcement & support → Welcome offer: `percent` 10, `maxDiscountPaise` 7500, `validDays` 30. It only affects codes issued after the change. |
| Percent coupons | rounded **down** to whole rupees (10% of ₹425 is ₹42), capped by `maxDiscountPaise`. A discount never takes the total below ₹1. | `cms/src/commerce/shared/coupons.js` (a code change) |
| Coupon entry | no coupon box. Codes work only by link: `/cart?offer=CODE`. | Admin → Shop → Coupons to create codes |
| Checkout consent text | "Send me refill reminders & recipes. Unsubscribe anytime." (unticked by default) | `src/routes/checkout/+page.svelte` and the backend default in `cms/src/commerce/checkout/` |
| Refill reminders | one per order, about three quarters of the way to the estimated run-out minus 2 days, at 10:00 IST, only for confirmed subscribers | `cms/src/retention/timing.ts` (code) plus `daysPerPack` (data) |
| Announcement bar | off | Store settings → Announcement & support |
| Sender address | `Wefeasto <hello@wefeasto.com>` | CMS env `EMAIL_FROM`. You need control of the domain's DNS (SPF/DKIM, DEPLOY.md §10) and someone reading replies. |
| Refunds made in the Razorpay Dashboard | no customer email (only automatic refunds send one) | Tell the customer yourself, or ask for a code change. |

## 6. Payments (Razorpay)

| Item | Status | Where |
|---|---|---|
| Razorpay account, KYC, live activation | not started. No keys exist; everything so far has run against the built-in mock. | [RAZORPAY-TEST-MODE.md](RAZORPAY-TEST-MODE.md) §1–2 and §7 |
| Website policies Razorpay reviews | Terms and Privacy are live. Shipping, Refunds and Grievances are unpublished drafts (§4). | §4 above |
| Automatic capture | assumed **on**. An authorised payment is shown to the customer as confirmed. | Razorpay Dashboard → Payment capture |
| Payment methods | The checkout has three pills: UPI, Card and Cash on Delivery. UPI and Card only preselect a method; Razorpay Checkout shows every method enabled on the account. The deprecated "UPI Collect" flow (typing a UPI ID) is hidden. COD skips Razorpay. | `src/lib/checkout/razorpay.js`; Razorpay Dashboard → payment methods |
| Live webhook with its own secret, the seven events | not set up | RAZORPAY-TEST-MODE.md §5.2 and §7 |
| Business name shown in Checkout | "Wefeasto", logo `STOREFRONT_URL/images/webclip.png` | `cms/src/commerce/checkout/paymentInit.ts` |

## 7. Hosting and operations

| Item | Assumption | Where |
|---|---|---|
| Domains | `wefeasto.com` (storefront), `cms.wefeasto.com` (CMS). These are placeholders. | `vercel.json` rewrite and CSP `form-action`; CMS env vars (DEPLOY.md §6, §8) |
| **Vercel plan for crons** | The 5-minute reconcile and jobs crons need **Pro**. On Hobby, use an external scheduler, or accept up to a day before unpaid orders release their stock and missed webhooks are picked up. | DEPLOY.md §5 |
| Postgres provider and backups | Neon or Supabase, pooled URL, point-in-time restore on | DEPLOY.md §3 |
| Email provider | any SMTP (Resend suggested) | DEPLOY.md §10 |
| Storefront preview deployments | they use the production CMS (the rewrite is fixed) | turn them off, or accept it (DEPLOY.md §6) |
| Analytics | none. `src/lib/track.js` only pushes events to `window.dataLayer`. | Add a vendor and cookie consent if you want one. |

## 8. Accounts

- Customer sign-up needs email verification. Guests can always check out, and guest orders are **never** attached
  to an account afterwards, not even one with the same email.
- "Continue with Google" is hidden until OAuth exists.
- Passwords must be 8–128 characters. An account locks for 10 minutes after 5 wrong passwords.
- Staff: the seed creates one admin. Add editors in Admin → Settings → Users. Editors can change the catalog,
  recipes, pages and media, and nothing else.

## 9. Artwork, code and data licences

| Item | Licence | Action |
|---|---|---|
| **PeepWalk crowd animation** (`src/lib/components/PeepWalk.svelte`), plus the Spinner and Squiggle ports | Ported from **bublr** (`github.com/solomonshalom/Bublr`), which is licensed **CC BY-NC-ND 4.0** (`bublr/LICENSE`). That licence lets others share it unchanged and non-commercially; only the copyright holders can adapt it for a shop. The port was made at the owner's request, and the owner maintains bublr (`bublr/AUTHORS.md`). The bublr git history for `bublr/src/components/PeepWalk.js` also has commits by **`justice-rest <bonjour@justice.rest>`**, who has 136 commits in that repo. | **Confirm** that you hold the rights to the ported code. If `justice-rest` is someone else, get their written OK, or have the parts they wrote re-implemented. Don't change the PeepWalk visuals, crowd size, timing, sprite, frame rate or size (ui-kit contract). |
| Open Peeps artwork (`static/images/peeps/characters.png`) | CC0 (Pablo Stanley, openpeeps.com) | None; credited in `static/images/peeps/CREDITS.txt`. |
| Crowd Simulator (the lineage of PeepWalk's algorithm) | MIT (public CodePen by Szenia Zadvornykh) | Keep the attribution header in `PeepWalk.svelte`. |
| PIN code → city/state data (`static/pin/`) | GeoNames, CC BY 4.0 | Keep the credit in `static/pin/CREDITS.txt` and next to the autofill hint. |
| Logo and imagery | The Phase 1 README called them placeholders. `static/images/webclip.png` is now the Wefeasto mark. | Confirm the final assets and your rights to the photos. |

## 10. Smaller leftovers

- `src/app.html` still carries Webflow's `data-wf-domain="the-foodie-fact-v2.webflow.io"` attributes and
  `<meta name="generator" content="Webflow">`, left over from Phase 1. They're harmless. Removing them changes every
  prerendered page, so update the regression allow-list (`npm run test:regression`) at the same time.
- There is no policy index page (`/policies` is a 404). Published policy pages are linked from the footer only.
