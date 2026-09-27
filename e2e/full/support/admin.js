/*
 * REST clients against the slot CMS origin (not through the storefront proxy):
 * - AdminSession: JWT login as the seeded admin (users collection), cached per worker.
 * - AdminClient: the per-test admin helper. Everything it changes on shared records
 *   (product stock/price/fields, store settings, coupons it creates) is put back by
 *   restoreAll(), which the `admin` fixture calls after every test.
 * - Cron: the two cron endpoints with the CRON_SECRET bearer.
 */
import { uniqueCode } from './unique.js';

const q = (v) => encodeURIComponent(v);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** message-log page size and the most pages messageLog() reads before it gives up. */
const MESSAGE_LOG_PAGE = 500;
const MESSAGE_LOG_MAX_PAGES = 40;

/**
 * Matches a message-log key that names `order` as a whole `:`-delimited segment after the type:
 * `:WF-1009` followed by `:` or the end, so `WF-1009` never matches `confirm:WF-10092`.
 */
export const orderKeyPattern = (order) => new RegExp(`:${escapeRe(order)}(?::|$)`);

export class AdminSession {
	constructor(stack) {
		this.cmsUrl = stack.cmsUrl;
		this.creds = stack.admin;
		this.token = null;
	}

	async login() {
		const res = await fetch(`${this.cmsUrl}/api/users/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(this.creds)
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok || !body.token) throw new Error(`admin login ${this.creds.email} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		this.token = body.token;
		return this.token;
	}

	/** Raw request: { status, json, text }. Logs in (again) when needed. */
	async request(method, path, { body, query } = {}) {
		if (!this.token) await this.login();
		const url = `${this.cmsUrl}/api/${path.replace(/^\/+/, '')}${query ? (path.includes('?') ? '&' : '?') + new URLSearchParams(query) : ''}`;
		const send = () =>
			fetch(url, {
				method,
				headers: { Authorization: `JWT ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
				body: body !== undefined ? JSON.stringify(body) : undefined
			});
		let res = await send();
		if (res.status === 401) {
			await this.login();
			res = await send();
		}
		const text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text };
	}

	/** Like request() but throws unless 2xx; resolves the JSON body. */
	async ok(method, path, opts) {
		const r = await this.request(method, path, opts);
		if (r.status < 200 || r.status > 299) throw new Error(`admin ${method} /api/${path} → ${r.status} ${r.text.slice(0, 400)}`);
		return r.json;
	}
}

export class AdminClient {
	/** @param {AdminSession} session */
	constructor(session) {
		this.session = session;
		/** slug → { id, fields: { key: originalValue } } */
		this.productOriginals = new Map();
		/** settings key → original value */
		this.settingsOriginals = new Map();
		/** coupon ids created by this test */
		this.coupons = [];
	}

	request(method, path, opts) {
		return this.session.request(method, path, opts);
	}

	ok(method, path, opts) {
		return this.session.ok(method, path, opts);
	}

	/* ---------------------------------------------------------------- products */

	/** The product doc (depth 0, server-only fields included) or throws. */
	async getProduct(slug) {
		const r = await this.ok('GET', `products?where[slug][equals]=${q(slug)}&depth=0&limit=1`);
		const doc = r.docs?.[0];
		if (!doc) throw new Error(`admin.getProduct: no product ${slug}`);
		return doc;
	}

	/** Every product (depth 0), catalog order. */
	async listProducts() {
		return (await this.ok('GET', 'products?depth=0&limit=100&sort=sortOrder')).docs;
	}

	async #remember(slug, keys) {
		const doc = await this.getProduct(slug);
		const entry = this.productOriginals.get(slug) ?? { id: doc.id, fields: {} };
		for (const k of keys) if (!(k in entry.fields)) entry.fields[k] = doc[k] ?? null;
		this.productOriginals.set(slug, entry);
		return entry;
	}

	/**
	 * PATCH a product by id. `stock` is special: the CMS refuses an absolute stock from a
	 * form (src/lib/productStock.ts: orders change it concurrently), so an absolute target is
	 * turned into the virtual `stockAdjust` (±N) from the live value, re-read and retried if
	 * an order moved it in between. Resolves the updated doc.
	 */
	async #patchProduct(id, data) {
		const { stock, ...rest } = data;
		let doc = null;
		if (Object.keys(rest).length) {
			const r = await this.ok('PATCH', `products/${id}?depth=0`, { body: rest });
			doc = r.doc ?? r;
		}
		if (stock === undefined || stock === null) return doc ?? (await this.ok('GET', `products/${id}?depth=0`));
		if (!Number.isInteger(stock) || stock < 0) throw new Error(`admin: stock must be a whole number ≥ 0, got ${stock}`);
		for (let attempt = 0; attempt < 3; attempt++) {
			const live = doc?.stock ?? (await this.ok('GET', `products/${id}?depth=0`)).stock;
			if (live === stock) return doc ?? (await this.ok('GET', `products/${id}?depth=0`));
			const r = await this.ok('PATCH', `products/${id}?depth=0`, { body: { stockAdjust: stock - live } });
			doc = r.doc ?? r;
			if (doc.stock === stock) return doc;
			doc = null; // moved concurrently: read again
		}
		throw new Error(`admin: could not set product ${id} stock to ${stock} (it kept changing)`);
	}

	/** PATCH product fields (published). Originals are restored after the test. Resolves the updated doc. */
	async updateProduct(slug, data) {
		const entry = await this.#remember(slug, Object.keys(data));
		return this.#patchProduct(entry.id, data);
	}

	/** Set the exact stock of a product (via ±N stockAdjust; the original is restored after the test). */
	setStock(slug, stock) {
		return this.updateProduct(slug, { stock });
	}

	/** Add (or with a negative n remove) packs; the original stock is restored after the test. */
	async adjustStock(slug, n) {
		const entry = await this.#remember(slug, ['stock']);
		const r = await this.ok('PATCH', `products/${entry.id}?depth=0`, { body: { stockAdjust: n } });
		return r.doc ?? r;
	}

	/** Set the price in paise (restored after the test). */
	setPrice(slug, pricePaise) {
		return this.updateProduct(slug, { pricePaise });
	}

	/** Put a product's changed fields back now (and stop tracking it). */
	async restoreProduct(slug) {
		const entry = this.productOriginals.get(slug);
		if (!entry) return null;
		this.productOriginals.delete(slug);
		return this.#patchProduct(entry.id, entry.fields);
	}

	/* ---------------------------------------------------------------- orders */

	/** The order doc (depth 0) by number, or null. */
	async findOrder(number) {
		const r = await this.ok('GET', `orders?where[number][equals]=${q(number)}&depth=0&limit=1`);
		return r.docs?.[0] ?? null;
	}

	/** Orders placed with this contact email (newest first). */
	async ordersByEmail(email) {
		const r = await this.ok('GET', `orders?where[contact.email][equals]=${q(String(email).toLowerCase())}&depth=0&limit=50&sort=-createdAt`);
		return r.docs;
	}

	/**
	 * PATCH an order as an admin would in /admin: `status`, `paymentStatus`,
	 * `fulfilmentStatus`, `reviewReason` (other fields are server-write-only and ignored).
	 * Transitions follow $shared/order-status.js (invalid → 400). Resolves { status, doc, error }.
	 */
	async updateOrder(number, data) {
		const order = await this.findOrder(number);
		if (!order) throw new Error(`admin.updateOrder: no order ${number}`);
		const r = await this.request('PATCH', `orders/${order.id}?depth=0`, { body: data });
		return { status: r.status, doc: r.json?.doc ?? null, error: r.status >= 400 ? r.json ?? r.text : null };
	}

	/** Mark shipped (a COD order is confirmed first: cod_pending → cod_confirmed). Throws on refusal. */
	async shipOrder(number) {
		let order = await this.findOrder(number);
		if (!order) throw new Error(`admin.shipOrder: no order ${number}`);
		if (order.status === 'cod_pending') {
			const c = await this.updateOrder(number, { status: 'cod_confirmed' });
			if (c.status !== 200) throw new Error(`admin.shipOrder: confirm COD → ${c.status} ${JSON.stringify(c.error)}`);
		}
		const s = await this.updateOrder(number, { fulfilmentStatus: 'shipped' });
		if (s.status !== 200) throw new Error(`admin.shipOrder: → ${s.status} ${JSON.stringify(s.error)}`);
		return s.doc;
	}

	/** Mark delivered (ships first when needed). */
	async deliverOrder(number) {
		const order = await this.findOrder(number);
		if (order?.fulfilmentStatus !== 'shipped') await this.shipOrder(number);
		const s = await this.updateOrder(number, { fulfilmentStatus: 'delivered' });
		if (s.status !== 200) throw new Error(`admin.deliverOrder: → ${s.status} ${JSON.stringify(s.error)}`);
		return s.doc;
	}

	/** Cancel an order (admin path: releases stock + coupon). Resolves { status, doc, error }. */
	cancelOrder(number) {
		return this.updateOrder(number, { status: 'cancelled' });
	}

	/* ---------------------------------------------------------------- coupons */

	/**
	 * Create a coupon (deleted after the test). Defaults: unique code, 10% off, active,
	 * no limits. Any coupon field can be overridden (see cms-foundation.md §7).
	 */
	async createCoupon(data = {}) {
		const body = { code: uniqueCode(), type: 'percent', value: 10, active: true, usedCount: 0, firstOrderOnly: false, ...data };
		const r = await this.ok('POST', 'coupons?depth=0', { body });
		const doc = r.doc ?? r;
		this.coupons.push(doc.id);
		return doc;
	}

	async getCoupon(code) {
		const r = await this.ok('GET', `coupons?where[code][equals]=${q(String(code).toUpperCase())}&depth=0&limit=1`);
		return r.docs?.[0] ?? null;
	}

	/* ---------------------------------------------------------------- settings */

	/** The store-settings global (server-only fields included). */
	getSettings() {
		return this.ok('GET', 'globals/store-settings?depth=0');
	}

	/** Update top-level store-settings keys; the original values are restored after the test. */
	async updateSettings(patch) {
		const cur = await this.getSettings();
		for (const k of Object.keys(patch)) if (!this.settingsOriginals.has(k)) this.settingsOriginals.set(k, cur[k] ?? null);
		const r = await this.ok('POST', 'globals/store-settings?depth=0', { body: patch });
		return r.result ?? r.doc ?? r;
	}

	/** Put the changed settings back now. */
	async restoreSettings() {
		if (!this.settingsOriginals.size) return;
		const body = Object.fromEntries(this.settingsOriginals);
		this.settingsOriginals.clear();
		await this.ok('POST', 'globals/store-settings?depth=0', { body });
	}

	/* ---------------------------------------------------------------- people */

	/** Subscribers (all, or the one row for `email`), newest first. */
	async listSubscribers({ email } = {}) {
		const where = email ? `where[email][equals]=${q(String(email).toLowerCase())}&` : '';
		return (await this.ok('GET', `subscribers?${where}depth=0&limit=100&sort=-createdAt`)).docs;
	}

	async findSubscriber(email) {
		return (await this.listSubscribers({ email }))[0] ?? null;
	}

	/** The customer account for an email, or null. */
	async findCustomer(email) {
		const r = await this.ok('GET', `customers?where[email][equals]=${q(String(email).toLowerCase())}&depth=0&limit=1`);
		return r.docs?.[0] ?? null;
	}

	/**
	 * message-log rows (oldest first) whose key names the order number as a whole `:`-delimited
	 * segment (`confirm:WF-10003`, `ship:WF-10003`, `refill:WF-10003:1`, `refill-queue:WF-10003:1:h0`)
	 * and/or starts with `keyPrefix`. Both narrow the query on the server (key LIKE, every page
	 * read), so rows of a new order are found however many older rows the slot DB holds; the exact
	 * match is then applied here (LIKE is "contains", so `WF-1009` would also hit `WF-10092`).
	 * Refund emails are keyed `refund:<refundId>`, so they don't carry the order number.
	 */
	async messageLog({ order, keyPrefix } = {}) {
		const terms = [order, keyPrefix].filter((t) => t !== undefined && t !== null && t !== '').map(String);
		const where = terms.map((t, i) => `where[and][${i}][key][like]=${q(t)}&`).join('');
		const seen = new Set();
		const docs = [];
		for (let page = 1; ; page++) {
			if (page > MESSAGE_LOG_MAX_PAGES) throw new Error(`admin.messageLog: more than ${MESSAGE_LOG_MAX_PAGES * MESSAGE_LOG_PAGE} rows match ${JSON.stringify(terms)}`);
			const r = await this.ok('GET', `message-log?${where}depth=0&limit=${MESSAGE_LOG_PAGE}&page=${page}&sort=createdAt`);
			for (const d of r.docs ?? []) {
				if (seen.has(d.id)) continue; // a row inserted mid-read can shift one onto the next page
				seen.add(d.id);
				docs.push(d);
			}
			if (!r.hasNextPage) break;
		}
		const mine = order ? orderKeyPattern(order) : null;
		return docs.filter((d) => {
			const key = String(d.key ?? '');
			return (!mine || mine.test(key)) && (!keyPrefix || key.startsWith(String(keyPrefix)));
		});
	}

	/* ---------------------------------------------------------------- cleanup */

	/** Undo everything this client changed (products, settings, coupons). Collects errors. */
	async restoreAll() {
		const errors = [];
		for (const slug of [...this.productOriginals.keys()]) {
			await this.restoreProduct(slug).catch((e) => errors.push(`product ${slug}: ${e.message}`));
		}
		await this.restoreSettings().catch((e) => errors.push(`settings: ${e.message}`));
		for (const id of this.coupons.splice(0)) {
			const r = await this.request('DELETE', `coupons/${id}`);
			if (r.status >= 400 && r.status !== 404) {
				// Referenced by a redemption: deactivate instead, so it can't leak into later tests.
				const d = await this.request('PATCH', `coupons/${id}`, { body: { active: false } });
				if (d.status >= 400) errors.push(`coupon ${id}: delete ${r.status}, deactivate ${d.status}`);
			}
		}
		if (errors.length) throw new Error(`admin.restoreAll failed:\n  ${errors.join('\n  ')}`);
	}
}

/** The cron endpoints, called like Vercel Cron does (Authorization: Bearer CRON_SECRET). */
export class Cron {
	constructor(stack) {
		this.cmsUrl = stack.cmsUrl;
		this.secret = stack.cronSecret;
	}

	async #get(path) {
		const res = await fetch(`${this.cmsUrl}${path}`, { headers: { Authorization: `Bearer ${this.secret}` } });
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text };
	}

	/**
	 * GET /api/payments/reconcile (checkout-backend.md §1.10) → { status, json }.
	 * `order: 'WF-10001'` limits the run to one order and skips its age/throttle filters.
	 */
	runReconcile({ order, limit, budgetMs } = {}) {
		const p = new URLSearchParams();
		if (order) p.set('order', order);
		if (limit) p.set('limit', String(limit));
		if (budgetMs) p.set('budgetMs', String(budgetMs));
		return this.#get(`/api/payments/reconcile${p.size ? `?${p}` : ''}`);
	}

	/** GET /api/payload-jobs/run?queue=default&limit=50 (refill reminders, sendEmail retries) → { status, json }. */
	runJobs({ queue = 'default', limit = 50 } = {}) {
		return this.#get(`/api/payload-jobs/run?queue=${q(queue)}&limit=${limit}`);
	}
}
