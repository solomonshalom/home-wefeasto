/*
 * Domain helpers for the checkout & payments full-stack specs (e2e/full/payments/**).
 * Everything here drives the real storefront against the real CMS (production build,
 * mock Razorpay); nothing is stubbed unless a helper says so.
 */
import { expect, orderFromUrl, waitOrderView, mockModal } from '../fixtures.js';

/** Safari on an iPhone: Razorpay's checkout.js forces redirect mode when callback_url is set. */
export const IPHONE_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
/** Instagram's in-app browser on Android (only the "Instagram" token puts checkout.js in redirect mode). */
export const INSTAGRAM_UA =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 Instagram 347.0.0.36.89 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; en_US; 634108168)';

/** Customer copy the specs assert (storefront-checkout.md §4, $lib/checkout/errors.js, $shared/errors.js). */
export const COPY = {
	noMoneyTaken: 'Payment didn’t go through — no money was taken.',
	moneyUnsure: 'Payment didn’t go through. If any money left your account, we’ll confirm your order or refund it automatically.',
	scriptFailed: 'Couldn’t load payments. Retry, or choose Pay on delivery.',
	openFailed: 'The payment window didn’t open. Retry, or choose Pay on delivery.',
	closedUnheard: 'The payment window closed before we heard back.',
	paymentsUnavailable: 'Payments are temporarily unavailable. Try again, or choose Cash on Delivery.',
	priceChanged: 'Prices changed since you opened your bag — please check the new total.',
	codAboveMax: 'Cash on delivery is available on orders up to ₹2,000 — please pay online.',
	codPinBlocked: 'Cash on delivery isn’t available for your PIN code yet — please pay online.',
	codTooManyOpen: 'You already have cash-on-delivery orders on the way — please pay online for this one.',
	declined: 'That payment didn’t go through. Try another card or UPI.',
	technical: 'Your bank or UPI app had a technical problem. Try again in a moment, or use another method.',
	emailMismatch: 'That offer belongs to a different email address.'
};

/** The checkout note for a code (DISMISSED, FAILED, CLOSED, OPEN_FAILED, SCRIPT_LOAD, PRICE_CHANGED, …). */
export const coNote = (page, code) => page.locator(`.wf-co-note[data-wf-co-note="${code}"]`);
/** Any checkout note. */
export const anyNote = (page) => page.locator('.wf-co-note');
/** An action button/link in a note or banner. */
export const action = (scope, id) => scope.locator(`[data-wf-action="${id}"]`);

/** wefeasto_pending ({no, t, at, cartSig}) or null. */
export const readPending = (page) =>
	page.evaluate(() => {
		try {
			return JSON.parse(localStorage.getItem('wefeasto_pending') || 'null');
		} catch {
			return null;
		}
	});

/** Wait for wefeasto_pending to name an order; resolves {number, token, cartSig}. */
export async function pendingOrder(page) {
	await expect.poll(async () => (await readPending(page))?.no ?? null, { message: 'wefeasto_pending written' }).toMatch(/^WF-\d+$/);
	const p = await readPending(page);
	return { number: p.no, token: p.t, cartSig: p.cartSig };
}

/** Pay button state: 'ready' | 'busy' | 'disabled'. */
export const payState = (page) => page.locator('#wf-place-order').getAttribute('data-wf-pay-state');

/** Wait until the debounced server quote has settled (the summary is not re-quoting). */
export async function quoteSettled(page, { timeout = 20_000 } = {}) {
	await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.classList.contains('wf-loading'), null, { timeout });
}

/**
 * Record every POST /api/store/checkout (+ /retry) the page makes: [{ path, body, key, status, json }].
 * Resolves the live array (responses fill in as they arrive).
 */
export function recordCheckoutCalls(page) {
	const calls = [];
	page.on('request', (req) => {
		const u = new URL(req.url());
		if (req.method() !== 'POST' || !/^\/api\/store\/checkout(\/retry)?$/.test(u.pathname)) return;
		const entry = { path: u.pathname, body: req.postDataJSON(), key: req.headers()['idempotency-key'] ?? null, status: null, json: null, done: false };
		calls.push(entry);
		req
			.response()
			.then(async (res) => {
				if (!res) return;
				entry.json = await res.json().catch(() => null);
				entry.status = res.status();
			})
			.catch(() => {})
			.finally(() => (entry.done = true));
	});
	return calls;
}

/** Wait until `n` recorded calls have their response (status + parsed JSON); resolves the calls. */
export async function answered(calls, n = 1, { timeout = 20_000 } = {}) {
	await expect.poll(() => calls.slice(0, n).filter((c) => c.done).length, { message: `${n} checkout call(s) answered`, timeout }).toBe(n);
	return calls;
}

/** The newest Razorpay order id (attempt) of an order, from the admin API. */
export async function latestAttempt(admin, number) {
	const o = await admin.findOrder(number);
	const a = o?.razorpay?.attempts ?? [];
	return a.length ? a[a.length - 1] : null;
}

/** Poll the order until `status` (and optionally paymentStatus) matches; resolves the doc. */
export async function waitOrderStatus(admin, number, status, { timeout = 25_000 } = {}) {
	await expect
		.poll(async () => (await admin.findOrder(number))?.status ?? null, { message: `${number} → ${status}`, timeout })
		.toBe(status);
	return admin.findOrder(number);
}

/** Exactly these subjects (strings = substrings, RegExp) and nothing else, once mail has settled. */
export async function expectOnlyEmails(mailpit, to, wanted, { quietMs = 3000 } = {}) {
	for (const w of wanted) await mailpit.waitForMessage({ to, subjectIncludes: w });
	const all = (await mailpit.settle(to, { quietMs })).map((m) => m.Subject);
	expect(all, `mail to ${to}`).toHaveLength(wanted.length);
	for (const w of wanted) {
		const hit = all.filter((s) => (w instanceof RegExp ? w.test(s) : s.includes(w)));
		expect(hit, `exactly one "${w}" in ${JSON.stringify(all)}`).toHaveLength(1);
	}
	return all;
}

/** On /order: the view and the order + token from the URL. */
export async function orderPage(page, views = ['confirmed'], opts) {
	const view = await waitOrderView(page, views, opts);
	return { view, ...orderFromUrl(page.url()) };
}

/** The mock payment modal: its buttons by name. */
export const modal = {
	root: (page) => mockModal(page),
	pay: (page) => mockModal(page).getByRole('button', { name: /^Pay/ }),
	fail: (page) => mockModal(page).getByRole('button', { name: 'Fail payment' }),
	cancel: (page) => mockModal(page).getByRole('button', { name: 'Cancel' }),
	confirmCancel: (page) => mockModal(page).getByRole('button', { name: 'Yes, cancel' })
};

/** Rupees as the storefront prints them: 42500 → '₹425', 200000 → '₹2,000'. */
export function rupees(paise) {
	const d = String(Math.round(paise / 100));
	const grouped = d.length <= 3 ? d : d.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + d.slice(-3);
	return '₹' + grouped;
}

/** Server quote total for a bag (through the storefront's /api proxy). */
export async function serverTotal(api, items, extra = {}) {
	const lines = Object.entries(items).map(([slug, qty]) => ({ slug, qty }));
	const r = await api.quote({ items: lines, ...extra });
	expect(r.status, `quote ${JSON.stringify(items)}`).toBe(200);
	return r.json.quote;
}
