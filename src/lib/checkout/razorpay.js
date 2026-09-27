/*
 * Razorpay Standard Checkout, client side (razorpay.md §4):
 * - loadCheckoutScript: loads payment.checkoutScript on demand (never in
 *   app.html, never with SRI — Razorpay changes the file without notice),
 *   15 s timeout, retryable after a failure. The mock gateway's
 *   /api/payments/mock/checkout.js is accepted too (dev and tests).
 * - buildRazorpayOptions: PaymentInit (SPEC §6) → the options object.
 *   callback_url is always passed: on iOS, in-app browsers and WebViews
 *   checkout.js then switches to a full-page redirect through the CMS
 *   callback (→ /order?no=&t=), and `handler` never runs.
 * - watchRender: did open() put anything on screen? (A bad key renders no
 *   modal and fires no callback at all — razorpay.md §4.2 — so the page
 *   needs a watchdog.)
 */

export const RAZORPAY_SCRIPT_ORIGIN = 'https://checkout.razorpay.com';
export const MOCK_SCRIPT_PATH = '/api/payments/mock/checkout.js';
export const SCRIPT_TIMEOUT_MS = 15000;
export const WATCHDOG_MS = 15000;
export const THEME_COLOR = '#333333';
/** UPI Collect (typing a VPA) is deprecated by NPCI: QR on desktop, intent on phones. */
export const HIDE_UPI_COLLECT = Object.freeze([{ method: 'upi', flows: ['collect'] }]);

/** Only Razorpay's own host, or the mock gateway's script (any origin: the CMS may differ in dev). */
export function isAllowedScript(src, base = typeof location !== 'undefined' ? location.href : 'http://localhost/') {
	if (typeof src !== 'string' || !src) return false;
	let u;
	try {
		u = new URL(src, base);
	} catch (e) {
		return false;
	}
	if (u.origin === RAZORPAY_SCRIPT_ORIGIN) return true;
	return (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === MOCK_SCRIPT_PATH;
}

const loads = new Map(); // src → Promise<Razorpay>

/**
 * Resolve window.Razorpay, loading `src` first when it isn't there yet.
 * Rejects with Error('BLOCKED' | 'LOAD_ERROR' | 'TIMEOUT' | 'NO_RAZORPAY');
 * a failed load is forgotten, so the next call tries again.
 * @param {string} src
 * @param {{ timeoutMs?: number, win?: any, doc?: Document }} [opts]
 * @returns {Promise<any>}
 */
export function loadCheckoutScript(src, { timeoutMs = SCRIPT_TIMEOUT_MS, win = window, doc = document } = {}) {
	if (typeof win.Razorpay === 'function') return Promise.resolve(win.Razorpay);
	if (!isAllowedScript(src, win.location?.href)) return Promise.reject(new Error('BLOCKED'));
	const pending = loads.get(src);
	if (pending) return pending;
	const p = new Promise((resolve, reject) => {
		const s = doc.createElement('script');
		s.src = src;
		s.async = true;
		s.setAttribute('data-wf-checkout-js', '');
		let done = false;
		const finish = (err) => {
			if (done) return;
			done = true;
			win.clearTimeout(timer);
			s.onload = s.onerror = null;
			if (!err && typeof win.Razorpay !== 'function') err = new Error('NO_RAZORPAY');
			if (err) {
				loads.delete(src);
				s.remove();
				reject(err);
			} else {
				resolve(win.Razorpay);
			}
		};
		const timer = win.setTimeout(() => finish(new Error('TIMEOUT')), timeoutMs);
		s.onload = () => finish(null);
		s.onerror = () => finish(new Error('LOAD_ERROR'));
		doc.head.appendChild(s);
	});
	loads.set(src, p);
	return p;
}

/** Tests only. */
export function _resetScriptLoads() {
	loads.clear();
}

/**
 * PaymentInit → Razorpay options.
 * @param {any} payment  SPEC §6 PaymentInit
 * @param {{ method?: string, handler: (resp: any) => void, onDismiss: () => void }} opts
 */
export function buildRazorpayOptions(payment, { method, handler, onDismiss }) {
	const p = payment || {};
	const pre = p.prefill && typeof p.prefill === 'object' ? p.prefill : {};
	const prefill = {};
	for (const k of ['name', 'email', 'contact']) if (typeof pre[k] === 'string' && pre[k]) prefill[k] = pre[k];
	// Preselect the pill the customer chose (checkout.js honours it only with contact + email).
	const m = method === 'upi' || method === 'card' ? method : pre.method === 'upi' || pre.method === 'card' ? pre.method : null;
	if (m) prefill.method = m;
	const wfOrder = p.notes && typeof p.notes.wf_order === 'string' ? p.notes.wf_order : '';
	/** @type {Record<string, any>} */
	const options = {
		key: p.keyId,
		order_id: p.razorpayOrderId,
		amount: p.amount,
		currency: p.currency || 'INR',
		name: p.name || 'Wefeasto',
		description: p.description || (wfOrder ? `Order ${wfOrder}` : 'Wefeasto order'),
		prefill,
		notes: p.notes && typeof p.notes === 'object' ? { ...p.notes } : {},
		theme: { color: THEME_COLOR },
		modal: { ondismiss: onDismiss, confirm_close: true },
		retry: { enabled: true },
		timeout: Number.isSafeInteger(p.timeoutSeconds) && p.timeoutSeconds > 0 ? p.timeoutSeconds : 900,
		config: { display: { hide: HIDE_UPI_COLLECT.map((h) => ({ method: h.method, flows: [...h.flows] })) } },
		handler
	};
	if (typeof p.image === 'string' && p.image) options.image = p.image;
	if (prefill.contact) options.readonly = { contact: true };
	if (typeof p.callbackUrl === 'string' && p.callbackUrl) options.callback_url = p.callbackUrl;
	return options;
}

/** Is the payment surface good to show? (PaymentInit sanity before loading anything.) */
export function isPaymentInit(p) {
	return (
		!!p &&
		typeof p === 'object' &&
		typeof p.keyId === 'string' &&
		!!p.keyId &&
		typeof p.razorpayOrderId === 'string' &&
		!!p.razorpayOrderId &&
		Number.isSafeInteger(p.amount) &&
		p.amount >= 100 &&
		typeof p.checkoutScript === 'string'
	);
}

function visible(el) {
	if (!el || !el.isConnected) return false;
	try {
		const cs = el.ownerDocument.defaultView.getComputedStyle(el);
		if (cs.display === 'none' || cs.visibility === 'hidden') return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	} catch (e) {
		return false;
	}
}

/**
 * Watches <body> from just before rzp.open(). rendered(): is something the
 * payment window added (Razorpay's .razorpay-container, the mock's overlay)
 * or a Razorpay frame visible right now? seen(): was one ever visible — also
 * checked as nodes arrive, so a window that closes within a second still
 * counts as having opened.
 * @param {Document} [doc]
 */
export function watchRender(doc = document) {
	const added = [];
	let seen = false;
	let mo = null;
	const take = (records) => {
		for (const r of records) {
			for (const n of r.addedNodes) {
				if (n.nodeType !== 1) continue;
				added.push(n);
				if (!seen && visible(n)) seen = true;
			}
		}
	};
	try {
		mo = new doc.defaultView.MutationObserver(take);
		mo.observe(doc.body, { childList: true });
	} catch (e) {
		mo = null;
	}
	const now = () => {
		if (mo) take(mo.takeRecords());
		const on = added.some(visible) || [...doc.querySelectorAll('.razorpay-container, iframe.razorpay-checkout-frame')].some(visible);
		if (on) seen = true;
		return on;
	};
	return {
		rendered: now,
		seen() {
			now();
			return seen;
		},
		stop() {
			mo?.disconnect();
			mo = null;
		}
	};
}
