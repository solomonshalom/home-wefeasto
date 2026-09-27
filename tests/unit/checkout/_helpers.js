/*
 * Shared fakes for the checkout unit tests: in-memory / throwing Web Storage,
 * a storage env with a settable clock, a scripted fake API, a fake Razorpay
 * and manual timers.
 */

export function memStorage(init = {}) {
	const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
	return {
		map: m,
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		clear: () => m.clear(),
		get length() {
			return m.size;
		}
	};
}

export function throwingStorage() {
	const boom = () => {
		throw new DOMException('The operation is insecure.', 'SecurityError');
	};
	return { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
}

/** {local, session, now} with a mutable clock (env.t). */
export function makeEnv({ local = memStorage(), session = memStorage(), t = 1_800_000_000_000 } = {}) {
	const env = {
		t,
		localStore: local,
		sessionStore: session,
		local: () => (typeof env.localStore === 'function' ? env.localStore() : env.localStore),
		session: () => (typeof env.sessionStore === 'function' ? env.sessionStore() : env.sessionStore),
		now: () => env.t
	};
	return env;
}

export const blockedEnv = (t) =>
	makeEnv({
		local: () => {
			throw new DOMException('blocked', 'SecurityError');
		},
		session: () => {
			throw new DOMException('blocked', 'SecurityError');
		},
		t
	});

export const TOKEN = 'dGVzdC10b2tlbi1mb3Itd2YtMTAwMDEtYWJjZGVmZ2hpams';
export const TOKEN2 = 'b3RoZXItdG9rZW4tZm9yLXdmLTEwMDAyLXp5eHd2dXRzcnE';

let uuidSeq = 0;
export function fakeUuid() {
	uuidSeq++;
	const hex = uuidSeq.toString(16).padStart(12, '0');
	return `00000000-0000-4000-8000-${hex}`;
}

/** A resolved api() result. */
export const ok = (data, status = 200) => ({ ok: true, status, data, error: null });
export const err = (code, details = null, status = 400, message = code) => ({ ok: false, status, data: { error: { code, message, details } }, error: { code, message, details } });

/**
 * Scripted API: routes[path] is a function (opts, call#) → result or a
 * queue of results. Records every call.
 */
export function fakeApi(routes = {}) {
	const calls = [];
	const counts = {};
	const fn = async (path, opts = {}) => {
		const key = path.split('?')[0];
		calls.push({ path, key, opts });
		counts[key] = (counts[key] || 0) + 1;
		const r = routes[key];
		if (!r) return err('NOT_FOUND', null, 404);
		if (Array.isArray(r)) return r.length > 1 ? r.shift() : r[0];
		return r(opts, counts[key], path);
	};
	fn.calls = calls;
	fn.count = (key) => counts[key] || 0;
	return fn;
}

/** Manual timers: run() fires due callbacks as the fake clock advances. */
export function manualTimers() {
	let now = 0;
	let id = 0;
	const q = new Map();
	return {
		setTimeout(fn, ms = 0) {
			const h = ++id;
			q.set(h, { fn, at: now + ms });
			return h;
		},
		clearTimeout(h) {
			q.delete(h);
		},
		get pending() {
			return q.size;
		},
		get now() {
			return now;
		},
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				const due = [...q.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				q.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await flush();
			}
			now = end;
		}
	};
}

export const flush = async (n = 6) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

/**
 * Fake window.Razorpay. `script` decides what open() does:
 *   'success' | 'dismiss' | 'fail_then_dismiss' | 'fail_then_success' | 'silent' | 'throw' | fn(instance)
 * Instances are recorded on Fake.instances.
 */
export function fakeRazorpay(script = 'success') {
	function Fake(options) {
		if (!(this instanceof Fake)) return new Fake(options);
		this.options = options;
		this.listeners = {};
		this.closed = false;
		Fake.instances.push(this);
	}
	Fake.instances = [];
	Fake.prototype.on = function (evt, cb) {
		(this.listeners[evt] = this.listeners[evt] || []).push(cb);
	};
	Fake.prototype.close = function () {
		this.closed = true;
	};
	Fake.prototype.fail = function (reason = 'payment_failed') {
		for (const cb of this.listeners['payment.failed'] || []) {
			cb({ error: { code: 'BAD_REQUEST_ERROR', description: 'Payment failed', reason, metadata: { order_id: this.options.order_id, payment_id: 'pay_x' } } });
		}
	};
	Fake.prototype.succeed = function () {
		return this.options.handler({ razorpay_order_id: this.options.order_id, razorpay_payment_id: 'pay_OK123', razorpay_signature: 'sig' });
	};
	Fake.prototype.dismiss = function () {
		this.options.modal.ondismiss();
	};
	Fake.prototype.open = function () {
		const s = typeof script === 'function' ? script : Fake.script;
		if (typeof s === 'function') return s(this);
		if (s === 'throw') throw new Error('open failed');
		queueMicrotask(() => {
			if (s === 'success') this.succeed();
			else if (s === 'dismiss') this.dismiss();
			else if (s === 'fail_then_dismiss') {
				this.fail('payment_failed');
				this.dismiss();
			} else if (s === 'fail_then_success') {
				this.fail('insufficient_funds');
				this.succeed();
			} else if (s === 'pending_then_dismiss') {
				this.fail('payment_pending');
				this.dismiss();
			} else if (s === 'already_paid_then_dismiss') {
				this.fail('order_already_paid');
				this.dismiss();
			}
			// 'silent': nothing ever fires (lost callback / bad key)
		});
	};
	Fake.script = script;
	return Fake;
}

export const PAYMENT = Object.freeze({
	provider: 'mock',
	keyId: 'rzp_test_abc',
	razorpayOrderId: 'order_A1',
	amount: 47400,
	currency: 'INR',
	checkoutScript: 'https://checkout.razorpay.com/v1/checkout.js',
	callbackUrl: 'http://localhost:3300/api/payments/razorpay/callback?no=WF-10001&t=x',
	name: 'Wefeasto',
	description: 'Order WF-10001',
	image: 'https://wefeasto.com/images/webclip.png',
	prefill: { name: 'Asha Kumar', email: 'asha@example.com', contact: '+919845262777' },
	notes: { wf_order: 'WF-10001' },
	timeoutSeconds: 900
});
