/*
 * The storefront's public API, called the way the browser does: same-origin /api/* on the
 * storefront (vite preview proxies to the slot CMS). Handy to set up state fast (an order
 * to test /order, a subscriber…) without driving the UI.
 */
import crypto from 'node:crypto';
import { checkoutForm } from './unique.js';

export class StoreApi {
	constructor(stack) {
		this.sfUrl = stack.sfUrl;
	}

	async #call(method, path, { body, headers } = {}) {
		const res = await fetch(`${this.sfUrl}/api/${path.replace(/^\/+/, '')}`, {
			method,
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			redirect: 'manual'
		});
		const text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text, headers: res.headers };
	}

	get(path) {
		return this.#call('GET', path);
	}

	post(path, body, headers) {
		return this.#call('POST', path, { body, headers });
	}

	/** POST /api/store/quote → { status, json: { quote } }. */
	quote(body) {
		return this.post('store/quote', body);
	}

	/** POST /api/store/checkout with an Idempotency-Key (fresh uuid unless given) → { status, json, idempotencyKey }. */
	async checkout(body, { idempotencyKey = crypto.randomUUID() } = {}) {
		const r = await this.post('store/checkout', body, { 'Idempotency-Key': idempotencyKey });
		return { ...r, idempotencyKey };
	}

	/** GET /api/store/orders/status?no=&t= → { status, json: OrderStatusDTO }. */
	status(number, token) {
		return this.get(`store/orders/status?no=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`);
	}

	/** POST /api/store/newsletter { email, website } → { status, json }. */
	newsletter(email, { website } = {}) {
		return this.post('store/newsletter', { email, ...(website !== undefined ? { website } : {}) });
	}

	/**
	 * Place an order through the API (quote first, so expectedTotalPaise is right):
	 * { items = { muesli: 1 }, method = 'cod', form = {}, consent = false, couponCode, source = 'web' }
	 * → { number, token, status, totalPaise, payment, form, idempotencyKey }. Throws unless 200/201.
	 */
	async placeOrder({ items = { muesli: 1 }, method = 'cod', form = {}, consent = false, couponCode, source = 'web' } = {}) {
		const f = checkoutForm({ ...form, method });
		const lines = Object.entries(items).map(([slug, qty]) => ({ slug, qty }));
		const quote = await this.quote({ items: lines, couponCode, email: f.email, pin: f.pin, method });
		if (quote.status !== 200) throw new Error(`api.placeOrder: quote → ${quote.status} ${quote.text.slice(0, 300)}`);
		const body = {
			items: lines,
			contact: { name: f.name, email: f.email, phone: f.phone.startsWith('+') ? f.phone : `+91${f.phone}` },
			address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
			method,
			expectedTotalPaise: quote.json.quote.totalPaise,
			consent: { marketing: !!consent },
			source,
			...(couponCode ? { couponCode } : {})
		};
		const r = await this.checkout(body);
		if (r.status !== 201 && r.status !== 200) throw new Error(`api.placeOrder: checkout → ${r.status} ${r.text.slice(0, 400)}`);
		return { ...r.json.order, payment: r.json.payment, form: f, idempotencyKey: r.idempotencyKey };
	}
}
