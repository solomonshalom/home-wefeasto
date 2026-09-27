/*
 * Thin HTTP client for the concurrency hunt: talks to the slot CMS directly (no storefront proxy) and
 * records every response status so the fuzzer can assert "no 5xx, ever". Webhooks are signed with the
 * mock's public dev webhook secret (the e2e stack runs PAYMENTS_MODE=mock with no RAZORPAY_* overrides).
 */
import crypto from 'node:crypto';
import { AdminSession, Cron } from '../../../support/admin.js';
import { Db } from '../../../support/db.js';

export const MOCK_WEBHOOK_SECRET = 'wefeasto-mock-webhook-secret-dev-only';

/** Razorpay/PHP-style JSON (what the receiver verifies byte-for-byte). */
export const phpJson = (body) =>
	JSON.stringify(body)
		.replace(/\//g, '\\/')
		.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export class HuntClient {
	constructor(stack) {
		this.stack = stack;
		this.cms = stack.cmsUrl;
		this.admin = new AdminSession(stack);
		this.cron = new Cron(stack);
		this.db = new Db(stack.dbUri);
		/** every non-2xx/3xx/4xx response: [{ what, status, text }] */
		this.serverErrors = [];
		this.calls = 0;
	}

	#note(what, status, text) {
		this.calls++;
		// 503 PAYMENTS_UNAVAILABLE is the documented answer while the gateway is down (injected faults).
		if (status === 503 && /PAYMENTS_UNAVAILABLE/.test(String(text))) return;
		if (status >= 500 || status === 0) this.serverErrors.push({ what, status, text: String(text).slice(0, 300) });
	}

	async call(method, path, { body, headers = {}, raw } = {}) {
		let res;
		try {
			res = await fetch(`${this.cms}/api/${path.replace(/^\/+/, '')}`, {
				method,
				headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
				body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
				redirect: 'manual'
			});
		} catch (err) {
			this.#note(`${method} ${path}`, 0, err.message);
			return { status: 0, json: null, text: err.message };
		}
		const text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		this.#note(`${method} ${path}`, res.status, text);
		return { status: res.status, json, text, headers: res.headers };
	}

	quote(body) {
		return this.call('POST', 'store/quote', { body });
	}
	checkout(body, key) {
		return this.call('POST', 'store/checkout', { body, headers: { 'Idempotency-Key': key } });
	}
	retry(number, token) {
		return this.call('POST', 'store/checkout/retry', { body: { number, token } });
	}
	verify(number, token, triple) {
		return this.call('POST', 'store/checkout/verify', { body: { number, token, ...triple } });
	}
	status(number, token) {
		return this.call('GET', `store/orders/status?no=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`);
	}
	household(number, token, size) {
		return this.call('POST', 'store/orders/household', { body: { number, token, size } });
	}
	mockPay(razorpayOrderId, outcome, opts = {}) {
		return this.call('POST', 'payments/mock/pay', { body: { razorpayOrderId, outcome, ...opts } });
	}
	async reconcile(order) {
		const r = await this.cron.runReconcile(order ? { order } : {});
		this.#note(`reconcile ${order ?? ''}`, r.status, r.text);
		return r;
	}
	async runJobs() {
		const r = await this.cron.runJobs();
		this.#note('jobs', r.status, r.text);
		return r;
	}

	fault(op, kind, { times = 1, commit = false } = {}) {
		return this.call('POST', 'payments/mock/fault', { body: { op, kind, times, commit } });
	}
	clearFaults() {
		return this.call('DELETE', 'payments/mock/fault');
	}

	/** POST a signed webhook with an explicit event id. */
	webhook(event, entities, { eventId = `HuntEvt${crypto.randomBytes(6).toString('hex')}`, createdAt } = {}) {
		const contains = event.startsWith('refund.') ? ['refund', 'payment', 'order'] : ['payment', 'order', 'refund'];
		const payload = {};
		const keys = contains.filter((k) => entities[k]);
		for (const k of keys) payload[k] = { entity: entities[k] };
		const body = phpJson({ entity: 'event', account_id: 'acc_WefeastoMock01', event, contains: keys, payload, created_at: createdAt ?? Math.floor(Date.now() / 1000) });
		const sig = crypto.createHmac('sha256', MOCK_WEBHOOK_SECRET).update(body).digest('hex');
		return this.call('POST', 'payments/razorpay/webhook', { raw: body, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } }).then((r) => ({ ...r, eventId }));
	}

	/* ------------------------------------------------------------- admin (REST as the seeded admin) */
	async adminReq(method, path, body) {
		const r = await this.admin.request(method, path, body !== undefined ? { body } : {});
		this.#note(`admin ${method} ${path}`, r.status, r.text);
		return r;
	}
	async order(number) {
		const r = await this.adminReq('GET', `orders?where[number][equals]=${encodeURIComponent(number)}&depth=0&limit=1`);
		return r.json?.docs?.[0] ?? null;
	}
	async patchOrder(id, data) {
		return this.adminReq('PATCH', `orders/${id}?depth=0`, data);
	}
	async stockAdjust(productId, n) {
		return this.adminReq('PATCH', `products/${productId}?depth=0`, { stockAdjust: n });
	}

	async close() {
		await this.db.close();
	}
}

/** A Razorpay-shaped payment entity for a webhook (only the fields the receiver reads + a few extras). */
export function paymentEntity({ id, orderId, amount, status, method = 'upi', wfOrder, errorReason = null }) {
	return {
		id,
		entity: 'payment',
		amount,
		currency: 'INR',
		status,
		order_id: orderId,
		invoice_id: null,
		international: false,
		method,
		amount_refunded: 0,
		refund_status: null,
		captured: status === 'captured',
		description: `Order ${wfOrder}`,
		email: 'hunt@example.com',
		contact: '+919999999999',
		notes: { wf_order: wfOrder },
		fee: null,
		tax: null,
		error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
		error_description: status === 'failed' ? 'Payment failed' : null,
		error_source: null,
		error_step: null,
		error_reason: status === 'failed' ? errorReason ?? 'payment_failed' : null,
		created_at: Math.floor(Date.now() / 1000)
	};
}
