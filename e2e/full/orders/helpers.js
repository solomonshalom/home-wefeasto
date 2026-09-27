/*
 * Domain helpers for the order-lifecycle specs (e2e/full/orders/**): /order, the order emails,
 * reconcile / late payments / refunds, "Your usual" + cart deep links, refill reminders.
 * Everything waits on real signals (DB rows, Mailpit, DOM, responses): no sleeps.
 */
import crypto from 'node:crypto';
import { expect } from '../fixtures.js';
import { formatPaise } from '../../../cms/src/commerce/shared/money.js';
import { buildAddParam } from '../../../cms/src/commerce/shared/cart-links.js';

export { formatPaise, buildAddParam };

/* ------------------------------------------------------------------ subjects (checkout-backend.md §5, retention §4) */

export const SUBJECT = {
	confirmed: (no) => `Order ${no} confirmed — thank you!`,
	codPlaced: (no) => `Order ${no} placed — pay on delivery`,
	late: (no) => `Good news — your payment for ${no} went through`,
	shipped: (no) => `Your order ${no} is on its way`,
	refund: (no, paise) => `We've refunded ${formatPaise(paise)} for order ${no}`,
	refill: /^Running low on /,
	/** The double-opt-in email a guest's ticked consent box sends: the owner confirms by email (retention-backend.md). */
	optIn: 'Confirm your Wefeasto subscription',
	/** The welcome after that confirmation, for someone who has ordered (no first-order code). */
	welcome: "You're in — breakfast ideas inside"
};

/**
 * The address owner clicks the opt-in link a ticked consent box emailed; resolves once the subscriber is
 * confirmed and the welcome email has arrived (so later subject lists are stable). Refill reminders only go
 * to a confirmed subscriber.
 */
export async function confirmOptIn(mailpit, admin, email) {
	const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.optIn });
	const link = mailpit.extractLinks(msg).find((l) => l.includes('/api/store/newsletter/confirm?t='));
	expect(link, 'the opt-in email carries a confirm link').toBeTruthy();
	const res = await fetch(link, { redirect: 'manual' });
	expect(res.status).toBe(303);
	await expect.poll(async () => (await admin.findSubscriber(email))?.status, { message: 'confirmed by the owner' }).toBe('confirmed');
	await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.welcome });
}

/** Subjects as a sorted list (emails sent by one event may land in either order). */
export const sortedSubjects = async (mailpit, to, opts) => (await subjectsTo(mailpit, to, opts)).sort();

/* ------------------------------------------------------------------ orders */

/**
 * An online (UPI) order through the storefront API: { number, token, rzpOrderId, totalPaise, form }.
 * The bag is priced by the server quote, so expectedTotalPaise is always right.
 */
export async function apiOnlineOrder(api, { items = { muesli: 1 }, form = {}, consent = false, couponCode } = {}) {
	const o = await api.placeOrder({ items, method: 'upi', form, consent, couponCode });
	expect(o.status, `online order ${o.number} starts unpaid`).toBe('pending_payment');
	expect(o.payment?.razorpayOrderId, 'a Razorpay order for attempt 1').toMatch(/^order_/);
	return { number: o.number, token: o.token, rzpOrderId: o.payment.razorpayOrderId, totalPaise: o.totalPaise, form: o.form };
}

/** A COD order through the storefront API: { number, token, totalPaise, form }. */
export async function apiCodOrder(api, { items = { muesli: 1 }, form = {}, consent = false, couponCode } = {}) {
	const o = await api.placeOrder({ items, method: 'cod', form, consent, couponCode });
	expect(o.status, `COD order ${o.number}`).toBe('cod_pending');
	expect(o.payment).toBeNull();
	return { number: o.number, token: o.token, totalPaise: o.totalPaise, form: o.form };
}

/** Settle a Razorpay order at the mock (server-side "customer paid"); asserts the mock accepted it. */
export async function mockPay(mock, rzpOrderId, outcome = 'success', opts = {}) {
	const r = await mock.pay(rzpOrderId, outcome, { method: 'upi', ...opts });
	expect(r.status, `mock pay ${outcome} ${rzpOrderId}: ${JSON.stringify(r.json)}`).toBe(200);
	return r.json;
}

/** Poll the admin order doc until `match` (object → toMatchObject, fn → truthy). Resolves the doc. */
export async function waitOrder(admin, number, match, { timeout = 20_000, message } = {}) {
	let doc = null;
	await expect
		.poll(
			async () => {
				doc = await admin.findOrder(number);
				if (!doc) return false;
				if (typeof match === 'function') return !!match(doc);
				try {
					expect(doc).toMatchObject(match);
					return true;
				} catch {
					return false;
				}
			},
			{ timeout, message: message ?? `order ${number} to match ${typeof match === 'function' ? match : JSON.stringify(match)}` }
		)
		.toBe(true);
	return doc;
}

/** statusHistory `to` values for one field ('status' | 'paymentStatus' | …), oldest first. */
export const historyOf = (doc, field = 'status') => (doc?.statusHistory ?? []).filter((h) => h.field === field).map((h) => h.to);

/** The order's coupon-redemption row (status reserved | consumed | released) or null. */
export async function redemptionOf(admin, orderId) {
	const r = await admin.ok('GET', `coupon-redemptions?where[order][equals]=${orderId}&depth=0&limit=5`);
	expect(r.docs.length, 'at most one redemption per order').toBeLessThanOrEqual(1);
	return r.docs[0] ?? null;
}

/** Exact stock of every slug in `slugs`: { slug: n }. */
export async function stocks(db, slugs) {
	const out = {};
	for (const s of slugs) out[s] = await db.stock(s);
	return out;
}

/* ------------------------------------------------------------------ mail */

/**
 * Every subject sent to `to` once the inbox has been quiet for `quietMs` (proves "exactly N").
 * Sorted oldest first.
 */
export async function subjectsTo(mailpit, to, { quietMs = 3000 } = {}) {
	const msgs = await mailpit.settle(to, { quietMs, timeout: quietMs + 20_000 });
	return msgs.map((m) => m.Subject);
}

/** Links of a message that start with `prefix` (absolute URL string). */
export const linksWith = (mailpit, msg, prefix) => mailpit.extractLinks(msg).filter((l) => l.startsWith(prefix));

/** The single /order link for `number` in an order email. */
export function orderLinkIn(mailpit, msg, sfUrl, number) {
	const links = linksWith(mailpit, msg, `${sfUrl}/order?`).filter((l) => new URL(l).searchParams.get('no') === number);
	expect(links, `one /order link for ${number} in "${msg.Subject}"`).toHaveLength(1);
	return links[0];
}

/** The /cart?add= link of an email with src=`src` (email | refill). */
export function cartLinkIn(mailpit, msg, sfUrl, src) {
	const links = linksWith(mailpit, msg, `${sfUrl}/cart?`).filter((l) => new URL(l).searchParams.get('src') === src);
	expect(links, `one /cart?add=…&src=${src} link in "${msg.Subject}"`).toHaveLength(1);
	return links[0];
}

/** Plain-text receipt lines an order email must carry (checkout-backend.md §5, receiptText()). */
export function receiptLines(order) {
	const lines = order.items.map((it) => `${it.name} × ${it.qty} — ${formatPaise(it.lineTotalPaise)}`);
	lines.push(`Subtotal: ${formatPaise(order.subtotalPaise)}`);
	if (order.discountPaise > 0) lines.push(`Discount${order.coupon?.code ? ` (${order.coupon.code})` : ''}: −${formatPaise(order.discountPaise)}`);
	lines.push(`Delivery: ${order.deliveryPaise > 0 ? formatPaise(order.deliveryPaise) : 'Free'}`);
	if (order.codFeePaise > 0) lines.push(`Cash on delivery fee: ${formatPaise(order.codFeePaise)}`);
	lines.push(`Total: ${formatPaise(order.totalPaise)}`);
	return lines;
}

/** Collapse whitespace (HTML → comparable text). */
export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Visible text of an HTML email body (tags dropped, entities for the characters we use decoded). */
export function htmlText(html) {
	return squash(
		String(html ?? '')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/&#39;|&#x27;|&apos;/g, "'")
			.replace(/&quot;/g, '"')
			.replace(/&nbsp;/g, ' ')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
	);
}

/* ------------------------------------------------------------------ pages */

/**
 * Record, per document, every /order view the page shows (data-wf-order-view) and every
 * `wf:track` event, from before the app boots. Read with viewsSeen() / tracked().
 */
export async function recordOrderPage(context) {
	await context.addInitScript(() => {
		window.__wfViews = [];
		window.__wfTracked = [];
		window.__wfCartAdds = [];
		window.addEventListener('wf:cart-add', (e) => window.__wfCartAdds.push(e.detail));
		const note = () => {
			const v = document.querySelector('[data-wf-order-view]')?.getAttribute('data-wf-order-view');
			if (v && window.__wfViews[window.__wfViews.length - 1] !== v) window.__wfViews.push(v);
		};
		new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-wf-order-view'] });
		window.addEventListener('wf:track', (e) => window.__wfTracked.push(e.detail));
	});
}

/** `wf:cart-add` event details of this document (recordOrderPage must run first). */
export const cartAdds = (page) => page.evaluate(() => window.__wfCartAdds ?? []);

/** The /order views this document has shown so far (consecutive duplicates collapsed). */
export const viewsSeen = (page) => page.evaluate(() => window.__wfViews ?? []);

/** `wf:track` events of this document with name `name` (all when omitted). */
export const tracked = (page, name) => page.evaluate((n) => (window.__wfTracked ?? []).filter((e) => !n || e.event === n), name);

/** JSON.parse(localStorage[key]) in the page (null when absent). */
export const readLocal = (page, key) =>
	page.evaluate((k) => {
		const v = localStorage.getItem(k);
		try {
			return v === null ? null : JSON.parse(v);
		} catch {
			return v;
		}
	}, key);

/** Resolves on the next GET /api/store/orders/status response for `number`. */
export const nextStatusPoll = (page, number, { timeout = 15_000 } = {}) =>
	page.waitForResponse((r) => r.url().includes('/api/store/orders/status') && r.url().includes(`no=${number}`), { timeout });

/**
 * The PeepWalk canvas has painted something (alpha sum > 0). The roadmap's "canvas is not blank".
 */
export async function expectCanvasPainted(page, selector = 'canvas.wf-peepwalk') {
	await expect
		.poll(
			() =>
				page.evaluate((sel) => {
					const c = document.querySelector(sel);
					if (!c || !c.width || !c.height) return 0;
					const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
					let a = 0;
					for (let i = 3; i < d.length; i += 4) a += d[i];
					return a;
				}, selector),
			{ timeout: 15_000, message: 'PeepWalk canvas painted (alpha sum > 0)' }
		)
		.toBeGreaterThan(0);
}

/** The bag as the app sees it, with zero-qty keys dropped. */
export const bagOf = (page) => page.evaluate(() => window.WefeastoCart?.read?.() ?? null);

/* ------------------------------------------------------------------ refill jobs */

/** refillReminder jobs of an order (payload_jobs), oldest first. */
export const refillJobs = (db, number) => db.jobs({ orderNumber: number, task: 'refillReminder' });

/**
 * message-log keys of an order (confirm:, ship:, refill:, refill-queue:…). Queried by key here:
 * admin.messageLog({ order }) filters client-side over the 100 OLDEST rows only, so it misses new
 * orders once a slot DB has sent ~100 emails (reported to the harness owner).
 */
export async function logKeys(admin, number) {
	const r = await admin.ok('GET', `message-log?where[key][like]=${encodeURIComponent(number)}&depth=0&limit=200&sort=createdAt`);
	const mine = new RegExp(`:${number.replace(/[-]/g, '\\-')}(:|$)`);
	return r.docs.map((d) => d.key).filter((k) => mine.test(k)).sort();
}

/** Proves absence: `read()` keeps returning `want` for `ms` (polled every 250 ms; fails at the first difference). */
export async function staysEqual(read, want, { ms = 3000, message } = {}) {
	const end = Date.now() + ms;
	do {
		expect(await read(), message).toEqual(want);
		await new Promise((r) => setTimeout(r, 250));
	} while (Date.now() < end);
}

/* ------------------------------------------------------------------ signed Razorpay webhooks */

/** The mock gateway's webhook secret when RAZORPAY_WEBHOOK_SECRET is unset (cms/src/payments/config.ts). */
export const MOCK_WEBHOOK_SECRET = 'wefeasto-mock-webhook-secret-dev-only';

/** A Razorpay payment entity (the fields markPaid / recordPaymentFailure read). */
export function paymentEntity({ paymentId, rzpOrderId, amount, number, status, amountRefunded = 0 }) {
	return {
		id: paymentId,
		entity: 'payment',
		amount,
		currency: 'INR',
		status,
		order_id: rzpOrderId,
		invoice_id: null,
		international: false,
		method: 'upi',
		amount_refunded: amountRefunded,
		refund_status: amountRefunded ? (amountRefunded >= amount ? 'full' : 'partial') : null,
		captured: status === 'captured' || status === 'refunded',
		description: `Order ${number}`,
		vpa: 'wefeasto.mock@okhdfcbank',
		notes: { wf_order: number },
		error_code: null,
		error_reason: null,
		created_at: Math.floor(Date.now() / 1000)
	};
}

/**
 * POST one Razorpay-shaped webhook, signed like Razorpay (HMAC-SHA256 of the exact body), to the
 * slot CMS. `payload` = { payment: entity, order?: entity, refund?: entity }. Resolves { status, json }.
 */
export async function deliverWebhook(stack, { event, payload, eventId, secret = MOCK_WEBHOOK_SECRET }) {
	const body = JSON.stringify({
		entity: 'event',
		account_id: 'acc_WefeastoMock01',
		event,
		contains: Object.keys(payload),
		payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, { entity: v }])),
		created_at: Math.floor(Date.now() / 1000)
	});
	const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
	const res = await fetch(`${stack.cmsUrl}/api/payments/razorpay/webhook`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId },
		body
	});
	return { status: res.status, json: await res.json().catch(() => null) };
}

/** A unique webhook event id. */
export const eventId = (tag = 'evt') => `E2EEvt${crypto.randomBytes(5).toString('hex')}${tag}`;
