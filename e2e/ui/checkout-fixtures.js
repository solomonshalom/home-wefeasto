/*
 * Test harness for the checkout / order UI specs (e2e/ui/checkout*.spec.js,
 * e2e/ui/order*.spec.js). Not a spec itself.
 *
 * - mockBackend(): an in-memory stand-in for the CMS commerce endpoints of
 *   SPEC §6, answered through page.route('/api/**'). It runs the real
 *   $shared rules (parseItems, validateCheckoutForm, quote, errorBody), so
 *   totals, stock issues, COD rules and error bodies are the server's.
 *   Knobs: catalog overrides, coupons, per-endpoint hooks, status sequences.
 * - The Razorpay browser stub (razorpay.md §9.4): checkout.razorpay.com's
 *   checkout.js is routed to a fake that records its options and plays a
 *   scenario (window.__RZP_SCENARIOS, one per open()). Nothing reaches
 *   Razorpay.
 * - Helpers to seed the bag once, fill the form, and wait for hydration.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { expect } from '@playwright/test';
import {
	quote,
	parseItems,
	validateCheckoutForm,
	errorBody,
	resolveSettings,
	normalizeCouponCode,
	cartSignature,
	isConfirmed,
	canRetryPayment,
	maskEmail,
	maskPhone,
	firstName
} from '../../cms/src/commerce/shared/index.js';

export const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));
export const RZP_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export const FORM = {
	name: 'Asha Kumar',
	phone: '98452 62777',
	email: 'asha@example.com',
	address: 'Flat 4B, 12 MG Road, Ashok Nagar',
	pin: '560001',
	city: 'Bengaluru',
	state: 'Karnataka'
};

const isApi = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/');
const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stableHash = (v) => crypto.createHash('sha256').update(JSON.stringify(v, Object.keys(v).sort())).digest('hex');

/**
 * @param {{ catalog?: Record<string, object>, settings?: object, coupons?: Record<string, object>,
 *           hooks?: Record<string, Function>, user?: object | null }} [opts]
 */
export function mockBackend(opts = {}) {
	const b = {
		orders: new Map(), // number → order
		byKey: new Map(), // Idempotency-Key → {hash, number}
		calls: [], // {method, path, body, headers}
		seq: 10000,
		statusSeq: new Map(), // number → [status, …] applied one per GET status
		catalogOver: { ...(opts.catalog || {}) },
		settingsOver: { ...(opts.settings || {}) },
		coupons: { ...(opts.coupons || {}) },
		hooks: { ...(opts.hooks || {}) },
		user: opts.user ?? null,
		verify: 'ok',
		checkoutScript: opts.checkoutScript || RZP_SRC,
		keyId: opts.keyId || 'rzp_test_e2e'
	};

	b.catalog = () =>
		SNAPSHOT.products.map((p) => ({
			slug: p.slug,
			name: p.name,
			pricePaise: p.pricePaise,
			inStock: p.inStock,
			maxPerOrder: p.maxPerOrder,
			codAllowed: p.codAllowed,
			...(b.catalogOver[p.slug] || {})
		}));
	b.settings = () => resolveSettings({ ...SNAPSHOT.settings, ...b.settingsOver });
	b.count = (path) => b.calls.filter((c) => c.path === path).length;
	b.last = (path) => [...b.calls].reverse().find((c) => c.path === path);
	b.order = (number) => b.orders.get(number);
	b.firstOrder = () => [...b.orders.values()][0];

	function quoteFor(body) {
		const parsed = parseItems(body.items);
		if (!parsed.ok) return { error: json(400, errorBody(parsed.error.code, parsed.error.details)) };
		const code = normalizeCouponCode(body.couponCode);
		const coupon = code && Object.prototype.hasOwnProperty.call(b.coupons, code) ? b.coupons[code] : null;
		const q = quote({
			items: parsed.items,
			catalog: b.catalog(),
			settings: b.settings(),
			coupon,
			method: body.method,
			context: { now: Date.now(), email: body.email || body.contact?.email, pin: body.pin || body.address?.pin, couponCode: body.couponCode, isFirstOrder: true, customerUsageCount: 0 }
		});
		return { q, items: parsed.items };
	}

	function dto(o) {
		return {
			number: o.number,
			status: o.status,
			paymentStatus: o.paymentStatus,
			paymentMethod: o.method === 'cod' ? 'cod' : 'online',
			requestedMethod: o.method,
			fulfilmentStatus: 'unfulfilled',
			createdAt: o.createdAt,
			paidAt: o.status === 'paid' ? new Date().toISOString() : null,
			items: o.q.lines.map((l) => ({ slug: l.slug, name: l.name, qty: l.qty, unitPaise: l.unitPaise, lineTotalPaise: l.lineTotalPaise, image: l.image || null })),
			subtotalPaise: o.q.subtotalPaise,
			discountPaise: o.q.discountPaise,
			deliveryPaise: o.q.deliveryPaise,
			codFeePaise: o.q.codFeePaise,
			totalPaise: o.q.totalPaise,
			coupon: o.q.coupon ? { code: o.q.coupon.code, discountPaise: o.q.discountPaise } : null,
			contact: { firstName: firstName(o.contact.name), emailMasked: maskEmail(o.contact.email), phoneMasked: maskPhone(o.contact.phone) },
			address: { city: o.address.city, state: o.address.state },
			canRetryPayment: canRetryPayment({ status: o.status, paymentStatus: o.paymentStatus, paymentMethod: o.method === 'cod' ? 'cod' : 'online', razorpay: { attempts: o.attempts } }),
			isConfirmed: isConfirmed(o.status),
			shippingPromiseText: b.settings().shippingPromiseText
		};
	}

	function paymentFor(o, origin) {
		const attempt = o.attempts.length + 1;
		const id = `order_E2E${o.number.slice(3)}${attempt > 1 ? '_a' + attempt : ''}`;
		o.attempts.push({ orderId: id });
		return {
			provider: 'mock',
			keyId: b.keyId,
			razorpayOrderId: id,
			amount: o.q.totalPaise,
			currency: 'INR',
			checkoutScript: b.checkoutScript,
			callbackUrl: `${origin}/api/payments/razorpay/callback?no=${o.number}&t=${o.token}`,
			name: 'Wefeasto',
			description: `Order ${o.number}`,
			image: `${origin}/images/webclip.png`,
			prefill: { name: o.contact.name, email: o.contact.email, contact: o.contact.phone },
			notes: { wf_order: o.number },
			timeoutSeconds: 900
		};
	}

	/** The order behind a Razorpay order id (any attempt). */
	b.byRazorpayOrder = (id) => [...b.orders.values()].find((o) => o.attempts.some((a) => a.orderId === id)) || null;

	const find = (number, token) => {
		const o = b.orders.get(number);
		return o && o.token === token ? o : null;
	};
	const NOT_FOUND = json(404, errorBody('NOT_FOUND'));

	async function handle(route) {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace(/^\/api/, '');
		let body = null;
		try {
			body = req.postData() ? JSON.parse(req.postData()) : null;
		} catch (e) {
			body = null;
		}
		const call = { method: req.method(), path, query: Object.fromEntries(url.searchParams), body, headers: req.headers() };
		b.calls.push(call);
		const n = b.count(path);
		const hook = b.hooks[path];
		if (hook) {
			const r = await hook({ body, n, call, b });
			if (r) return route.fulfill(r);
		}
		switch (`${req.method()} ${path}`) {
			case 'POST /store/quote': {
				const r = quoteFor(body || {});
				if (r.error) return route.fulfill(r.error);
				return route.fulfill(json(200, { quote: r.q }));
			}
			case 'POST /store/checkout': {
				const key = req.headers()['idempotency-key'];
				if (!key) return route.fulfill(json(400, errorBody('IDEMPOTENCY_KEY_REQUIRED')));
				// The `supersede` ref names what to replace, not what is ordered: not part of the request hash.
				const { supersede: ref = null, ...hashed } = body || {};
				const hash = stableHash(hashed);
				const seen = b.byKey.get(key);
				if (seen) {
					if (seen.hash !== hash) return route.fulfill(json(409, errorBody('IDEMPOTENCY_MISMATCH')));
					const o = b.orders.get(seen.number);
					return route.fulfill(json(200, { order: { number: o.number, token: o.token, status: o.status, totalPaise: o.q.totalPaise }, payment: seen.payment }));
				}
				const s = b.settings();
				const form = validateCheckoutForm({ ...body.contact, ...body.address }, { blockedPinPrefixes: s.blockedPinPrefixes });
				if (form.errors.pin === 'UNSERVICEABLE') return route.fulfill(json(422, errorBody('PIN_UNSERVICEABLE', { pin: form.value.pin })));
				if (!form.ok) return route.fulfill(json(400, errorBody('VALIDATION', { fields: form.errors })));
				const r = quoteFor(body);
				if (r.error) return route.fulfill(r.error);
				const q = r.q;
				if (q.issues.length) return route.fulfill(json(409, errorBody(q.issues[0].code, { issues: q.issues })));
				if (q.orderError) return route.fulfill(json(400, errorBody(q.orderError.code, q.orderError)));
				if (q.couponError) return route.fulfill(json(422, errorBody('COUPON_INVALID', { reason: q.couponError.reason })));
				if (q.pinServiceable === false) return route.fulfill(json(422, errorBody('PIN_UNSERVICEABLE', { pin: form.value.pin })));
				if (body.method === 'cod' && !q.codAvailable) return route.fulfill(json(422, errorBody('COD_UNAVAILABLE', { reason: q.codUnavailableReason })));
				if (body.expectedTotalPaise !== q.totalPaise) return route.fulfill(json(409, errorBody('PRICE_CHANGED', { quote: q })));
				const number = 'WF-' + ++b.seq;
				const o = {
					number,
					token: crypto.randomBytes(32).toString('base64url'),
					method: body.method,
					status: body.method === 'cod' ? 'cod_pending' : 'pending_payment',
					paymentStatus: body.method === 'cod' ? 'none' : 'created',
					contact: form.value && { name: form.value.name, email: form.value.email, phone: form.value.phone },
					address: { line1: form.value.line1, city: form.value.city, state: form.value.state, pin: form.value.pin },
					q,
					cartSig: cartSignature(r.items),
					consent: body.consent,
					source: body.source,
					couponCode: body.couponCode || null,
					attempts: [],
					createdAt: new Date().toISOString(),
					household: null
				};
				// Supersede (checkout-backend.md §1.2): the same bag cancels still-unpaid online orders from
				// the last 30 minutes: the one the `supersede` {number, token} ref names (any phone,
				// SUP-PHONE-1) and the same phone's (the real rule, minus the DB).
				for (const old of b.orders.values()) {
					const oldSig = cartSignature(old.q.lines.map((l) => ({ slug: l.slug, qty: l.qty })));
					const named = !!ref && ref.number === old.number && ref.token === old.token;
					if (
						old.method !== 'cod' &&
						(old.status === 'pending_payment' || old.status === 'payment_failed') &&
						['none', 'created', 'attempted', 'failed'].includes(old.paymentStatus) &&
						(named || old.contact?.phone === o.contact.phone) &&
						oldSig === o.cartSig &&
						Date.now() - Date.parse(old.createdAt) < 30 * 60000
					) {
						old.status = 'cancelled';
						old.supersededBy = number;
					}
				}
				b.orders.set(number, o);
				const payment = body.method === 'cod' ? null : paymentFor(o, url.origin);
				b.byKey.set(key, { hash, number, payment });
				return route.fulfill(json(201, { order: { number, token: o.token, status: o.status, totalPaise: q.totalPaise }, payment }));
			}
			case 'POST /store/checkout/retry': {
				const o = find(body?.number, body?.token);
				if (!o) return route.fulfill(NOT_FOUND);
				if (isConfirmed(o.status)) return route.fulfill(json(409, errorBody('ALREADY_PAID')));
				if (o.method === 'cod') return route.fulfill(json(409, errorBody('NOT_RETRYABLE')));
				o.status = 'pending_payment';
				return route.fulfill(json(200, { order: { number: o.number, status: o.status, totalPaise: o.q.totalPaise }, payment: paymentFor(o, url.origin) }));
			}
			case 'POST /store/checkout/verify': {
				const o = find(body?.number, body?.token);
				if (!o || !o.attempts.some((a) => a.orderId === body.razorpay_order_id)) return route.fulfill(json(400, errorBody('SIGNATURE_INVALID')));
				if (b.verify === 'bad_signature') return route.fulfill(json(400, errorBody('SIGNATURE_INVALID')));
				o.status = 'paid';
				o.paymentStatus = 'captured';
				return route.fulfill(json(200, { order: dto(o) }));
			}
			case 'GET /store/orders/status': {
				const o = find(url.searchParams.get('no'), url.searchParams.get('t'));
				if (!o) return route.fulfill(NOT_FOUND);
				const seq = b.statusSeq.get(o.number);
				if (seq && seq.length) {
					o.status = seq.shift();
					if (o.status === 'paid') o.paymentStatus = 'captured';
				}
				return route.fulfill(json(200, dto(o)));
			}
			case 'POST /store/orders/household': {
				const o = find(body?.number, body?.token);
				if (!o) return route.fulfill(NOT_FOUND);
				o.household = body.size;
				return route.fulfill(json(200, { ok: true }));
			}
			case 'GET /customers/me':
				return route.fulfill(json(200, { user: b.user, collection: 'customers' }));
			default:
				return route.fulfill(json(404, {}));
		}
	}

	/** Make an order directly (as if placed earlier / on another device). */
	b.seedOrder = ({ items = { muesli: 1 }, method = 'upi', status = 'pending_payment', contact } = {}) => {
		const q = quote({ items, catalog: b.catalog(), settings: b.settings(), method });
		const number = 'WF-' + ++b.seq;
		const o = {
			number,
			token: crypto.randomBytes(32).toString('base64url'),
			method,
			status,
			paymentStatus: status === 'paid' ? 'captured' : method === 'cod' ? 'none' : 'created',
			contact: contact || { name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777' },
			address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
			q,
			cartSig: cartSignature(items),
			attempts: method === 'cod' ? [] : [{ orderId: `order_SEED${number.slice(3)}` }],
			createdAt: new Date().toISOString()
		};
		b.orders.set(number, o);
		return o;
	};

	b.install = async (page) => {
		await page.route(isApi, handle);
	};
	return b;
}

/* ------------------------------------------------ Razorpay browser stub */

/** Runs in the page as checkout.js. */
function razorpayStub() {
	let seq = 0;
	const rid = (p) => p + '_' + Date.now().toString(36) + (++seq).toString().padStart(4, '0');
	function Razorpay(options) {
		if (!(this instanceof Razorpay)) return new Razorpay(options);
		if (!options || !options.key) throw new Error('key is required');
		this.options = options;
		this.listeners = {};
		window.__rzpInstances = (window.__rzpInstances || []).concat([
			{ options: JSON.parse(JSON.stringify(options, (k, v) => (typeof v === 'function' ? '[fn]' : v))) }
		]);
	}
	Razorpay.prototype.on = function (evt, cb) {
		(this.listeners[evt] = this.listeners[evt] || []).push(cb);
		return this;
	};
	Razorpay.prototype.show = function () {
		const el = document.createElement('div');
		el.className = 'razorpay-container';
		el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.4)';
		document.body.appendChild(el);
		this.el = el;
	};
	Razorpay.prototype.close = function () {
		if (this.el) this.el.remove();
		this.el = null;
		window.__rzpClosed = (window.__rzpClosed || 0) + 1;
	};
	Razorpay.prototype.emitFail = function (reason) {
		const resp = {
			error: { code: 'BAD_REQUEST_ERROR', description: 'Payment failed', source: 'customer', step: 'payment_authentication', reason, metadata: { order_id: this.options.order_id, payment_id: rid('pay') } }
		};
		(this.listeners['payment.failed'] || []).forEach((cb) => cb(resp));
	};
	Razorpay.prototype.succeed = function () {
		const payment_id = rid('pay');
		this.close();
		setTimeout(() => this.options.handler({ razorpay_payment_id: payment_id, razorpay_order_id: this.options.order_id, razorpay_signature: 'sig_' + payment_id }), 20);
	};
	Razorpay.prototype.dismiss = function () {
		this.close();
		setTimeout(() => this.options.modal && this.options.modal.ondismiss && this.options.modal.ondismiss(), 20);
	};
	Razorpay.prototype.open = function () {
		const queue = window.__RZP_SCENARIOS || [];
		const s = queue.length ? queue.shift() : window.__RZP_SCENARIO || 'success';
		window.__rzpOpened = (window.__rzpOpened || []).concat([s]);
		if (s === 'blank') return; // bad key: nothing renders, nothing fires
		this.show();
		const self = this;
		setTimeout(() => {
			if (s === 'success') return self.succeed();
			if (s === 'dismiss') return self.dismiss();
			if (s === 'fail_then_dismiss') {
				self.emitFail('payment_failed');
				return self.dismiss();
			}
			if (s === 'fail_then_success') {
				self.emitFail('insufficient_funds');
				return setTimeout(() => self.succeed(), 50);
			}
			// 'lost_callback': the modal is up; the customer pays in their UPI app and the tab dies.
		}, 80);
	};
	window.Razorpay = Razorpay;
}

export const RAZORPAY_STUB = `(${razorpayStub.toString()})();`;

/** Route checkout.js to the stub (and block anything else Razorpay). */
export async function stubRazorpay(page, scenarios = ['success']) {
	await page.route(RZP_SRC, (r) => r.fulfill({ contentType: 'text/javascript', body: RAZORPAY_STUB }));
	await page.route(/^https:\/\/([a-z0-9-]+\.)*razorpay\.com\//, (r) => (r.request().url() === RZP_SRC ? r.fallback() : r.abort()));
	// Every document starts with this queue; setScenarios() changes it on a live page.
	await page.addInitScript((s) => {
		window.__RZP_SCENARIOS = s.slice();
	}, scenarios);
}

/** Change what the next open() does (on the live page). */
export const setScenarios = (page, scenarios) => page.evaluate((s) => (window.__RZP_SCENARIOS = s), scenarios);
export const rzpInstances = (page) => page.evaluate(() => window.__rzpInstances || []);

/* ------------------------------------------------------------ the bag */

/** Put `bag` in wefeasto_cart once (first document only; reloads keep what the app wrote). */
export async function seedBag(page, bag, extra = {}) {
	await page.addInitScript(
		({ bag, extra }) => {
			try {
				if (window.sessionStorage.getItem('__seeded')) return;
				window.sessionStorage.setItem('__seeded', '1');
				window.localStorage.setItem('wefeasto_cart', JSON.stringify(bag));
				for (const [k, v] of Object.entries(extra)) window.localStorage.setItem(k, JSON.stringify(v));
			} catch (e) {
				/* storage-throwing variant */
			}
		},
		{ bag, extra }
	);
}

export const readLS = (page, key) =>
	page.evaluate((k) => {
		try {
			const v = window.localStorage.getItem(k);
			return v === null ? null : JSON.parse(v);
		} catch (e) {
			return undefined;
		}
	}, key);

/** Make every Web Storage access throw (both storages), before any script runs. */
export function breakStorage() {
	for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
		Storage.prototype[m] = function () {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
	}
}

/* ---------------------------------------------------------- the page */

/** Hydrated: the nav badge gets its class or count only after the layout mounts. */
export async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

/** /checkout is interactive: the summary rendered from the bag (or the empty state). */
export async function checkoutReady(page) {
	await expect(page.locator('#wf-co-summary')).not.toContainText('Loading your bag…');
	await hydrated(page);
}

/** Server quote settled (no .wf-loading). */
export async function quoteSettled(page) {
	await expect(page.locator('#wf-co-summary')).not.toHaveClass(/wf-loading/);
}

export async function fillForm(page, form = FORM) {
	await page.fill('#wf-co-name', form.name);
	await page.fill('#wf-co-phone', form.phone);
	await page.fill('#wf-co-email', form.email);
	await page.fill('#wf-co-address', form.address);
	await page.fill('#wf-co-pin', form.pin);
	await page.fill('#wf-co-city', form.city);
	await page.selectOption('#wf-co-state', form.state);
}

export const payButton = (page) => page.locator('#wf-place-order');
export const note = (page) => page.locator('.wf-co-note');

/** Collect uncaught page errors (the specs assert there are none). */
export function pageErrors(page) {
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	return errors;
}
