# Razorpay in test mode: setup, smoke test and checklist

Until you add Razorpay keys, the CMS runs a built-in mock of Razorpay (`PAYMENTS_MODE=mock`). This guide
switches it to the real Razorpay **test mode** (no real money moves), checks the integration with one
command, and then walks through the checks that need a person: paying in Checkout, the iPhone redirect
flow, webhooks and refunds. The last section is the go-live checklist.

It takes about an hour the first time. You need a Razorpay account (free, no KYC for test mode), this repo
running locally (`cms/` on :3000, the storefront on :5173) and, for the webhook checks, a public URL for the
CMS (section 5).

| Section | What |
|---|---|
| 1 | Create the Razorpay account |
| 2 | Get the test API keys |
| 3 | Put them in `cms/.env` |
| 4 | Run `npm run smoke:razorpay` (automated API checks, optional real Checkout payment) |
| 5 | Set up the webhook (needs a public URL) |
| 6 | Manual checklist on the storefront |
| 7 | Going live |
| 8 | Troubleshooting |

---

## 1. Create a Razorpay account (test mode)

1. Sign up at <https://dashboard.razorpay.com/signup> with the business email and phone number.
2. You land in the Dashboard. The switch at the top says **Test Mode** / **Live Mode**. Stay in
   **Test Mode** for everything in sections 2 to 6. Test mode works straight away; activation (KYC) is
   only needed for live payments (section 7).
3. Test and live are separate worlds: separate keys, separate webhooks, separate orders. Nothing you do
   in test mode shows up in live mode.

## 2. Get the test API keys

1. In **Test Mode**, open **Account & Settings → API Keys** and click **Generate Test Key**.
2. Copy both values:
   - **Key Id**, which starts with `rzp_test_`. It is public (Checkout sends it to the browser).
   - **Key Secret**. Razorpay shows it **once**. If you lose it, regenerate the key (the old pair stops working).
3. Pick a **webhook secret** yourself. It is any long random string; you paste the same value into the
   Dashboard in section 5. To make one:

   ```sh
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

Never commit these values or paste them into chat or issues. `cms/.env` is gitignored.

## 3. Configure `cms/.env`

Edit `cms/.env` (copy `cms/.env.example` if it doesn't exist) and set:

```sh
PAYMENTS_MODE=razorpay
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=<the random value from step 2.3>
# Only while you rotate the webhook secret: the previous value, still accepted.
RAZORPAY_WEBHOOK_SECRET_OLD=
# Leave empty locally. APP_ENV=production refuses test keys (it means "the live shop").
APP_ENV=
```

Then restart the CMS (`cd cms && npm run dev`). It refuses to start in razorpay mode when a key is missing,
when the key id isn't `rzp_test_…`/`rzp_live_…`, when a live key is used without `NODE_ENV=production`, or
when `APP_ENV=production` has a test key. The error message names the variable.

The storefront needs no change: the CMS tells it which Checkout script to load, and in razorpay mode that
is Razorpay's own `https://checkout.razorpay.com/v1/checkout.js`.

To go back to the mock at any time, set `PAYMENTS_MODE=mock` and restart.

## 4. Run the smoke test

```sh
cd cms
npm run smoke:razorpay                  # API checks, about 10 seconds
npm run smoke:razorpay -- --checkout    # also pay ₹1 in the real test Checkout
```

The script (`cms/scripts/razorpay-live-smoke.mjs`) reads the keys from `cms/.env` and talks to the real
Razorpay API through the CMS's own payment code (`RazorpayGateway`), so it tests exactly what checkout
uses. It prints each step, then a summary table.

| # | Check | What it proves | If it fails |
|---|---|---|---|
| 0 | config | test key, `PAYMENTS_MODE`, and whether Razorpay can reach your webhook URL | warnings only: read the `!` lines |
| 1 | auth | Razorpay accepts the key id + secret | the pair is wrong or from different modes: copy both again (section 2) |
| 2 | createOrder | a ₹1 order is created with a unique `wf-smoke-…` receipt | the error text says why |
| 3 | fetchOrder | the order reads back with the same amount, currency, status, receipt and notes | report it: the API changed shape |
| 4 | fetchOrderPayments | the new order has no payments (this call is what the reconcile job uses) | as above |
| 5 | duplicate receipt | a second create with the same receipt: **recovered** (same order back) or **distinct** (a second order). Either is fine; the line says which | a WARN here means Razorpay said "duplicate" but couldn't list the order yet |
| 6 | payment signature | the key secret signs and verifies Checkout signatures; forgeries are rejected | the secret is missing or odd |
| 7 | webhook signature | the webhook secret verifies a Razorpay-style body; tampered, re-serialised, unsigned and key-secret-signed bodies are rejected | as above |
| 8 | checkout | only with `--checkout`: a real test payment, the real Checkout signature, and what the storefront would do | see below |

**Exit codes:** `0` all passed (warnings allowed), `1` a check failed, `2` not configured or a bad option
(it prints the setup steps), `3` refused because the keys are live.

### With `--checkout`

The script starts a small page on `http://127.0.0.1:5199/<random>/` and opens it in your browser. The page
loads the real Checkout for the ₹1 order. It has two buttons:

- **Pay (storefront options)** opens Checkout exactly as the storefront does. The storefront hides the UPI ID
  field (NPCI has deprecated "UPI Collect"), so on a desktop UPI shows a QR code, which test mode can't pay.
- **Pay with the UPI ID field shown** keeps the UPI ID field so you can type `success@razorpay`.

Pay with `success@razorpay`, or with card `4100 2800 0000 1007` (any future expiry, any CVV, choose
**Success** on the bank page). You can try `failure@razorpay` or card `4100 2800 0006 0003` (choose
**Failure**) first: the window stays open for a retry on the same order, like on the storefront.

The terminal then shows the order going `created → attempted → paid`, the payments on it, whether the real
Checkout signature verifies with your `RAZORPAY_KEY_SECRET`, what `POST /api/store/checkout/verify` would
answer, and what the storefront would show. A PASS here means keys, signature and capture all work.

Useful options: `--no-open` (print the URL instead of opening a browser), `--port 0` (any free port),
`--wait 900` (wait longer than the default 600 s), `--dotenv <file>` (read another env file). Ctrl-C stops
waiting and still prints the summary.

**Safety.** The script never prints secrets (every line passes through a redactor). It refuses `rzp_live_`
keys unless you pass `--allow-live` **and** type `LIVE-<last 4 characters of the key id>` in a terminal. It
never uses a real order's receipt (`WF-…`), and its orders carry no `wf_order` note, so if the CMS webhook
receives their events it logs them as "orphan" and does nothing. Razorpay has no API to delete orders; the
unpaid ₹1 test orders stay in the Dashboard and are harmless.

---

## 5. Set up the webhook

Webhooks are how Razorpay tells the CMS about a payment when the customer's browser never comes back: they
paid in their UPI app and closed the tab, the phone lost signal, or the redirect page didn't load. The CMS
also confirms payments without them (the customer's browser calls verify, and a reconcile job asks Razorpay
every 5 minutes), but refunds made in the Dashboard and disputes only arrive by webhook.

### 5.1 The CMS needs a public HTTPS URL

Razorpay only delivers to public URLs on port 80 or 443. It refuses `localhost`, `*.local`, `*.internal`,
`*.corp`, and several tunnel and request-bin domains (`ngrok.io`, `loca.lt`, `webhook.site`,
`requestbin.com`, `hookbin.com`, `beeceptor.com`, `mockbin.org`, among others). The smoke test's step 0
warns when `PAYLOAD_PUBLIC_SERVER_URL` is one of these.

Two ways to get a public URL:

- **A deployed preview of the CMS (recommended).** Deploy `cms/` to a Vercel preview with its own database,
  `PAYMENTS_MODE=razorpay`, the **test** keys and the webhook secret. Previews run with
  `VERCEL_ENV=preview`, so test keys are allowed there. The webhook URL is
  `https://<preview-host>/api/payments/razorpay/webhook`. Vercel protects previews with a login by
  default (Deployment Protection), which would answer Razorpay with 401: turn it off for the CMS project's
  previews, or enable **Protection Bypass for Automation** and append
  `?x-vercel-protection-bypass=<that secret>` to the webhook URL.
- **A tunnel to your laptop.** `cloudflared tunnel --url http://localhost:3000` prints a
  `https://<random>.trycloudflare.com` address. Caveat: Razorpay's docs name **zrok** as the tunnel to use
  and block several others; `trycloudflare.com` was not on the published list when we checked
  (September 2026), but Razorpay can add it at any time. If the Dashboard refuses the URL, use zrok
  (`zrok share public localhost:3000`) or a deployed preview. A quick tunnel's address changes every time
  you restart it, so you'd have to edit the webhook again. Set `PAYLOAD_PUBLIC_SERVER_URL` to the tunnel
  address and restart the CMS so the redirect flow (section 6, check 6) also points at it.

### 5.2 Add the webhook in the Dashboard

1. **Test Mode → Account & Settings → Webhooks → Add New Webhook** (older dashboards: **Settings → Webhooks**).
2. **Webhook URL:** `<cms origin>/api/payments/razorpay/webhook`, for example
   `https://wefeasto-cms-git-razorpay.vercel.app/api/payments/razorpay/webhook`.
3. **Secret:** the same value as `RAZORPAY_WEBHOOK_SECRET`.
4. **Alert email:** yours. Razorpay emails it when deliveries keep failing, and disables the webhook after
   24 hours of failures.
5. **Active events:** tick these seven:

   | Event | What the CMS does with it |
   |---|---|
   | `payment.authorized` | marks the order paid (also covers late authorisations) |
   | `payment.captured` | marks it paid / records the capture |
   | `payment.failed` | records the failed attempt; the order stays retryable (never final) |
   | `order.paid` | marks the order paid (the main "money arrived" signal) |
   | `refund.processed` | records the refund; the order becomes refunded / partially refunded |
   | `refund.failed` | records it and adds an alert to Review Reason; if nothing of the payment is refunded any more, a partly refunded order goes back to paid (payment captured) |
   | `payment.dispute.created` | puts the order on hold (`needs_review`) and logs an alert |

   Optional, also handled: `refund.created` and the other `payment.dispute.*` events (won, lost, closed,
   under_review, action_required).
6. Save. In test mode the Dashboard may ask for an OTP when you add, edit or delete a webhook: Razorpay's
   docs give **754081** as the test-mode OTP.

### 5.3 Check it

Make one test payment (section 6, check 3). In the Dashboard, open the webhook and look at its recent
deliveries: every one should show **200**. In the Payload admin, **Payments → Payment Events** lists each
delivery with its `event` and `outcome` (`paid`, `already_paid`, `payment_failed`, `refund_recorded`,
`orphan`, `duplicate`, …).

A delivery answered with **400** means the signature didn't match: the Dashboard secret and
`RAZORPAY_WEBHOOK_SECRET` differ. Fix one of them and restart the CMS. Failed deliveries are retried for 24
hours, so they catch up once it's fixed.

---

## 6. Manual checklist on the storefront

**Setup.** CMS in razorpay mode with test keys (section 3) and, for checks 8 and 9, a webhook that reaches
it (section 5). Storefront: `npm run dev` at the repo root (its `/api` proxy goes to `http://localhost:3000`;
for a CMS preview use `CMS_URL=https://<preview-host> npm run dev`, and set `STOREFRONT_URL=http://localhost:5173`
on the preview so its redirects come back to you). Locally, emails land in Mailpit at <http://127.0.0.1:54326>.

**Where to look in the Payload admin** (`<cms>/admin`):

- **Shop → Orders**, open the order by its number (`WF-…`, shown on the storefront's order page):
  - the top row: **Status**, **Payment status**, **Fulfilment status**;
  - **Paid at** and **Paid via** (`client` = the browser's verify, `callback` = iPhone redirect,
    `webhook`, `reconcile`);
  - the **Razorpay** group: **Attempts** (one Razorpay order per "Pay" press: `order_…`, receipt `WF-…-a1`,
    `-a2`, …), **Payment id**, **Method**, **Captured at**, and **Payments** (every payment attempt with its
    status, method, amount, error code/reason and how we heard about it);
  - **Refunds**, **Dispute**, **Status history**.
- **Payments → Payment Events**: one row per webhook delivery, with its outcome.
- **Settings → Message Log**: one row per email sent (`confirm:WF-…`, `refund:rfnd_…`), never two.
- The Razorpay Dashboard (Test Mode) → **Transactions → Payments / Orders** shows the same ids.

Tick each check when it behaves as described.

- [ ] **1. UPI, success (`success@razorpay`).** Add a product, check out with *Pay online* and UPI.
  If Checkout shows a UPI ID field, enter `success@razorpay`. On a desktop it usually shows only a QR
  code, because the storefront hides the deprecated UPI Collect flow; test mode can't pay a QR, so do this
  check with `npm run smoke:razorpay -- --checkout` (second button) or with the phone setup of check 6,
  where mobile web may still offer the UPI ID field. Real UPI QR and intent payments can only be tried in
  live mode (section 7).
  *Expect:* the order page says the order is confirmed; the bag is emptied.
  *Admin:* Status `paid`, Payment status `captured`, Method `upi`, one Payments row `captured`; one
  `confirm:WF-…` in the Message Log and one confirmation email.
- [ ] **2. UPI, failure (`failure@razorpay`).** Same, with `failure@razorpay`.
  *Expect:* Checkout shows the failure and offers another try in the same window. Close it: the checkout page
  says the payment didn't go through and offers to pay again.
  *Admin:* once the CMS hears of it (the `payment.failed` webhook, or the reconcile job), a Payments row
  `failed` with its error reason and Status `payment_failed`, which stays retryable; no confirmation email.
- [ ] **3. Card, success.** Card `4100 2800 0000 1007` (Visa) or `5555 5100 0008 1006` (Mastercard), any
  future expiry, any CVV. On Razorpay's test bank page choose **Success** (or enter an OTP of 4 to 10 digits).
  *Expect / Admin:* as check 1, Method `card`, Paid via `client` (or `webhook` if the webhook was faster).
  *Payment Events:* `payment.authorized`, `payment.captured`, `order.paid` with outcomes `paid` then
  `already_paid`. Keep this order for check 8.
- [ ] **4. Card, failure.** Card `4100 2800 0006 0003`, choose **Failure** on the bank page (reason
  `card_declined`). Then, in the same window, pay with the success card: the retry on the same Razorpay
  order must confirm the order.
  *Admin:* two Payments rows (`failed`, then `captured`), one Attempt, Status `paid`.
  Optional: card `4100 2800 0009 0000` + **Failure** gives `payment_timed_out`; after closing the window the
  checkout page must NOT promise "no money was taken" (a timed-out payment can still be authorised later).
- [ ] **5. Dismiss.** Open Checkout and close it before choosing a method (confirm "cancel"). Don't
  cancel a UPI payment to test this: in test mode a cancelled UPI payment counts as a success.
  *Expect:* "Payment didn’t go through — no money was taken." and a way to pay again. Pay again: a new
  Razorpay order is created (Attempt `-a2`) and paying it confirms the order.
  *Admin:* Status `pending_payment` after the dismiss (stock stays reserved until the reservation ends);
  two Attempts after the second try. An order left unpaid expires after its reservation: the reconcile job
  sets `expired` and releases the stock.
- [ ] **6. Redirect mode (iPhone, Instagram and other in-app browsers).** On iPhones, iPads, Chrome for
  iOS, Instagram/Facebook in-app browsers and Android WebViews, Checkout replaces the pop-up with a
  full-page redirect: Razorpay posts the result to the CMS (`/api/payments/razorpay/callback`), which sends
  the customer on to the order page. Pick one way to get an iPhone browser:
  - **Chrome DevTools (quickest):** open the checkout page, DevTools → *Toggle device toolbar* → an iPhone
    model, then **reload** (Checkout reads the user agent when it loads).
  - **iOS Simulator** (Xcode): Safari in the simulator can open `http://localhost:5173` directly.
  - **A real phone on the same Wi-Fi:** start the storefront with `npm run dev -- --host`, set
    `PAYLOAD_PUBLIC_SERVER_URL=http://<your Mac's LAN IP>:3000` and `STOREFRONT_URL=http://<LAN IP>:5173`
    in `cms/.env` (add that origin to `STOREFRONT_ORIGINS` too if you'll sign in on the phone), restart the CMS, and open
    `http://<LAN IP>:5173` on the phone. (The callback is posted by the phone's browser, so the LAN is
    enough; webhooks still need section 5.)

  Pay with the success card.
  *Expect:* Razorpay opens as a full page instead of a pop-up; after the bank page you land on the
  storefront's order page, confirmed.
  *Admin:* Paid via `callback` (or `webhook` if it was faster). A failed card in redirect mode stays on
  Razorpay's page so the customer can retry there.
- [ ] **7. Cash on delivery.** Check out with *Cash on delivery*.
  *Expect:* no Razorpay window; the order page shows the order as placed, to be paid on delivery.
  (COD can be refused, e.g. for too many open COD orders on one phone number; the page explains why.)
  *Admin:* Payment method `cod`, Status `cod_pending`, no Razorpay attempts; the "placed, pay on delivery"
  email. Nothing appears in the Razorpay Dashboard.
- [ ] **8. Refund from the Dashboard.** Needs the webhook (section 5). In Test Mode open
  **Transactions → Payments**, the captured payment from check 3, **Issue Refund**: first a partial amount,
  later the rest.
  *Admin:* a **Refunds** row per refund (`rfnd_…`, amount, status `processed`); Status and Payment status
  `partially_refunded` after the first, `refunded` after the second. *Payment Events:* `refund.processed`
  with outcome `refund_recorded`. The customer gets **no** Wefeasto email for a refund you make in the
  Dashboard (the refund email is only sent for automatic refunds: duplicate payment, out of stock, cancelled
  order), so tell them yourself. Without a working webhook the CMS never hears about Dashboard refunds.
  A **full** refund of an order that hasn't shipped yet (Fulfilment `unfulfilled` or `packed`) puts its
  packs back in stock, like cancelling it; once shipped, stock is left alone. A refund never lifts a hold:
  an order in `needs_review` (a chargeback, or one you put on hold) stays there after a partial refund.
  To ship the rest, set its Status to `partially_refunded` yourself.
- [ ] **9. Confirmation by webhook alone** (optional). Check out, choose **Netbanking** and a bank. When
  the bank's pop-up opens, close the shop's tab, then click **Success** in the pop-up.
  *Admin:* the order becomes `paid` with Paid via `webhook` within seconds, and the confirmation email goes
  out, although the browser never reported the payment. Without a webhook the reconcile job does the same
  within about 5 minutes (Paid via `reconcile`); signed in as an admin you can force it with
  `<cms>/api/payments/reconcile?order=WF-…`.
- [ ] **10. Webhook deliveries.** Dashboard → the webhook → recent deliveries: all **200**. Any 400 means a
  secret mismatch (section 5.3); any 5xx or timeout, look at the CMS log.

**Covered by automated tests, no need to click:** duplicate payments on one order (the second is refunded
automatically), late authorisations after an order expired, webhooks arriving twice or out of order, amount
mismatches, re-serialised or forged webhook bodies, Razorpay outages and timeouts, disputes. These run
against the CMS's Razorpay mock in `cms/tests/int/checkout-*.int.spec.ts` and the e2e suite.

---

## 7. Going live

Do these in order. Live keys only ever go into the **production** CMS environment (Vercel → the CMS project
→ Settings → Environment Variables → Production), never into a laptop's `cms/.env`: the CMS refuses live
keys without `NODE_ENV=production`, and the smoke script refuses them without `--allow-live`.

- [ ] **Activate the account (KYC).** Dashboard → *Activate account*: business type and category, PAN,
  GSTIN if registered, business address, the bank account for settlements, and the website URL. Razorpay
  reviews the website before approving.
- [ ] **Website policies Razorpay checks.** The live storefront must show, reachable from every page
  (footer): **Contact us** (phone, email, address), **Terms & Conditions**, **Privacy Policy**,
  **Refund & Cancellation Policy** and **Shipping & Delivery Policy**, plus product pages with prices in ₹.
  Ours: `/terms` and `/privacy` exist. *Shipping Policy*, *Refunds & Cancellations* and *Grievance
  Redressal* exist as **unpublished drafts** in the CMS (**Pages**): review, edit and publish them, then
  rebuild the storefront (only published pages get a page and a footer link). The footer shows a phone
  number and hours; add a support email and the registered address if Razorpay asks for them.
- [ ] **Live API keys.** Live Mode → Account & Settings → API Keys → *Generate Live Key*. In production set
  `PAYMENTS_MODE=razorpay`, `RAZORPAY_KEY_ID=rzp_live_…`, `RAZORPAY_KEY_SECRET` and `APP_ENV=production`
  (with `APP_ENV=production` the CMS refuses test keys and the mock, so a test key can never take "orders"
  that are never paid).
- [ ] **Live webhook.** Live Mode → Webhooks: URL `https://cms.wefeasto.com/api/payments/razorpay/webhook`
  (the production CMS), the same seven events as section 5.2, your alert email, and a **new** secret (not
  the test one) in the production `RAZORPAY_WEBHOOK_SECRET`.
- [ ] **Automatic capture on.** Account & Settings → Payment capture → *Automatic* (Razorpay's default).
  The CMS relies on it: with manual capture, payments stay "authorized" and Razorpay refunds them after a
  few days.
- [ ] **Payment methods and limits.** UPI, cards, netbanking and wallets enabled; the per-transaction limit
  covers your largest basket (Account & Settings → Transaction limits).
- [ ] **Crons.** The reconcile job must run every 5 minutes (Vercel Pro, or an external scheduler on the
  Hobby plan): see *Crons* in `cms/README.md`.
- [ ] **One real order.** On the live site, buy something small with your own UPI app (this is the first
  time UPI QR and UPI intent can be tried: test mode can't) and with a card. Check the order is `paid` in
  the admin, the confirmation email arrived, the Dashboard shows the payment *captured* and the webhook
  deliveries are 200. Then refund it from the Dashboard (check 8). Test cards don't work in live mode.
- [ ] **Content-Security-Policy: from report-only to enforced.** The storefront sends a report-only CSP
  (`vercel.json`) whose violation reports go to `/api/store/csp-report`, and the production CMS logs each
  one at info as `csp violation` (directive, blocked URL, page; origin + path only, never the query). After
  the real orders above and a week or two of traffic, search the CMS logs (Vercel → the CMS project → Logs)
  for `csp violation`. Browser extensions cause noise (`chrome-extension`, `moz-extension`); anything else on
  `/checkout` is either a source to add to the policy or a script that must not be there. Once the reports
  are clean, enforce it: in `vercel.json` move the report-only value into the `Content-Security-Policy` entry
  (it already holds that entry's three directives), keep the report directives, drop the report-only entry,
  and update `tests/unit/security-headers.test.js` to match.
- [ ] **Settlements.** A few days later, check the money under Settlements in the Dashboard.
- [ ] **Secret rotation (later).** To change the webhook secret without losing deliveries: put the old
  value in `RAZORPAY_WEBHOOK_SECRET_OLD`, the new one in `RAZORPAY_WEBHOOK_SECRET` and in the Dashboard,
  redeploy; remove `_OLD` a day later.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Smoke test step 1: `401 … Authentication failed` | Key id and secret don't belong together, or one is from live mode. Copy both again; regenerate the key if the secret is lost. |
| Smoke test exits `2` | Something in `cms/.env` is missing or wrong; the message names it. |
| Smoke test exits `3` | The key is `rzp_live_…`. Use test keys. |
| Checkout says "The id provided does not exist" | The Razorpay order was made with other keys (test vs live, or keys changed without a restart). Restart the CMS and start checkout again. |
| Pressing Pay opens nothing | A wrong key id, an ad blocker blocking `checkout.razorpay.com`, or no network. The storefront re-enables Pay after 15 seconds. |
| UPI shows only a QR code in test mode | Expected (see check 1). Use the smoke script's second button, a phone, or a card. |
| The logo is missing inside Checkout locally | Checkout loads it from `STOREFRONT_URL/images/webclip.png`, which it can't reach at `http://localhost`. Fine in production. |
| Webhook deliveries answered 400 | The Dashboard secret and `RAZORPAY_WEBHOOK_SECRET` differ. |
| Webhook deliveries answered 401 or 403 | Vercel Deployment Protection on the preview (section 5.1). |
| Razorpay disabled the webhook | 24 hours of failed deliveries. Fix the cause, then re-enable it in the Dashboard. |
| An order stays on "Confirming your payment…" | Neither the browser's verify nor a webhook got through. The reconcile job settles it within about 5 minutes; as an admin you can force it with `<cms>/api/payments/reconcile?order=WF-…`. |
| Payments stay "authorized" | Automatic capture is off (section 7). |
| The CMS won't start after editing `.env` | The error lists each bad variable (missing key, test key with `APP_ENV=production`, live key outside production). |
