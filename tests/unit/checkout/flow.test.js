/*
 * The checkout flow state machine (roadmap M2) with a scripted API and a fake
 * Razorpay: success, COD, in-modal failure then success, dismiss → note →
 * Try again (a fresh Razorpay order via /checkout/retry), pending and
 * already-paid failure reasons, checkout.js failing, the watchdog, double
 * taps, every API refusal, and storage that throws.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createCheckoutFlow, supersedes, NO_MONEY_TAKEN, MONEY_UNSURE, SCRIPT_FAILED, OPEN_FAILED } from '$lib/checkout/flow.js';
import { buildCheckoutBody, checkForm } from '$lib/checkout/request.js';
import { PENDING_KEY, IDEM_KEY, PLACED_PREFIX, _resetSeenMemory, forgetIdempotencyKey, writePending, writePendingForm, consumePlaced } from '$lib/checkout/storage.js';
import { makeEnv, blockedEnv, fakeApi, fakeRazorpay, manualTimers, flush, ok, err, fakeUuid, PAYMENT, TOKEN, TOKEN2 } from './_helpers.js';

const FORM = { name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };
const VALUE = checkForm(FORM).value;
const body = (patch = {}) =>
	buildCheckoutBody({ value: VALUE, items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }], method: 'upi', expectedTotalPaise: 47400, ...patch });

const ORDER = { number: 'WF-10001', token: TOKEN, status: 'pending_payment', totalPaise: 47400 };
const ORDER_URL = `/order?no=WF-10001&t=${TOKEN}`;

function setup({ routes = {}, Razorpay = fakeRazorpay('success'), loadScript, env = makeEnv(), watchRendered = false, watchdogMs = 15000 } = {}) {
	const api = fakeApi({
		'/store/checkout': () => ok({ order: ORDER, payment: PAYMENT }, 201),
		'/store/checkout/verify': () => ok({ order: { ...ORDER, status: 'paid' } }),
		'/store/checkout/retry': () => ok({ order: { number: ORDER.number, status: 'pending_payment' }, payment: { ...PAYMENT, razorpayOrderId: 'order_A2' } }),
		'/store/orders/status': () => ok({ ...ORDER }),
		...routes
	});
	const navigations = [];
	const events = [];
	const phases = [];
	const timers = manualTimers();
	const pendingAtOpen = [];
	const scripts = [];
	const flow = createCheckoutFlow({
		api,
		loadScript:
			loadScript ||
			(async (src) => {
				scripts.push(src);
				pendingAtOpen.push(env.local ? safeGet(env, PENDING_KEY) : null);
				return Razorpay;
			}),
		navigate: (url) => navigations.push(url),
		track: (name, props) => events.push([name, props]),
		newKey: fakeUuid,
		env,
		timers,
		watchRender: () => ({ rendered: () => (typeof watchRendered === 'function' ? watchRendered() : watchRendered), stop() {} }),
		watchdogMs
	});
	flow.state.subscribe((s) => {
		if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
	});
	return { flow, api, navigations, events, phases, timers, Razorpay, env, pendingAtOpen, scripts, state: () => get(flow.state) };
}

function safeGet(env, key) {
	try {
		return JSON.parse(env.local().getItem(key));
	} catch (e) {
		return undefined;
	}
}

const names = (events) => events.map(([n]) => n);

beforeEach(() => _resetSeenMemory());

describe('online payment', () => {
	it('success: checkout (Idempotency-Key) → pending written → Razorpay → verify → /order', async () => {
		const t = setup();
		await t.flow.submit(body());
		await flush(10);
		const checkout = t.api.calls.find((c) => c.key === '/store/checkout');
		expect(checkout.opts.method).toBe('POST');
		expect(checkout.opts.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
		expect(checkout.opts.body).toEqual(body());
		// wefeasto_pending existed before checkout.js was even loaded
		expect(t.pendingAtOpen[0]).toMatchObject({ no: 'WF-10001', t: TOKEN, cartSig: 'cornflakes:1,muesli:1' });
		expect(t.scripts).toEqual([PAYMENT.checkoutScript]);
		const rzp = t.Razorpay.instances[0];
		expect(rzp.options.order_id).toBe('order_A1');
		expect(rzp.options.prefill.method).toBe('upi');
		const verify = t.api.calls.find((c) => c.key === '/store/checkout/verify');
		expect(verify.opts.body).toEqual({ number: 'WF-10001', token: TOKEN, razorpay_order_id: 'order_A1', razorpay_payment_id: 'pay_OK123', razorpay_signature: 'sig' });
		expect(t.navigations).toEqual([ORDER_URL]);
		expect(t.phases).toEqual(['idle', 'submitting', 'opening', 'paying', 'verifying', 'leaving']);
	});

	it('fail in the modal, then succeed on the same Razorpay order (in-modal retry)', async () => {
		const t = setup({ Razorpay: fakeRazorpay('fail_then_success') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.Razorpay.instances.length).toBe(1);
		expect(t.events).toContainEqual(['payment_failed', { code: 'insufficient_funds' }]);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('verify refused (bad signature) or unreachable → still /order, which polls the truth', async () => {
		for (const verify of [() => err('SIGNATURE_INVALID', null, 400), () => ({ ok: false, status: 0, data: null, error: { code: 'NETWORK', message: 'x' } })]) {
			const t = setup({ routes: { '/store/checkout/verify': verify } });
			await t.flow.submit(body());
			await flush(10);
			expect(t.navigations).toEqual([ORDER_URL]);
			expect(t.state().phase).toBe('leaving');
		}
	});

	it('the bag is never touched and no seen/last-order keys are written (only pending + the placed marker)', async () => {
		const t = setup();
		await t.flow.submit(body());
		await flush(10);
		expect([...t.env.localStore.map.keys()].sort()).toEqual([PENDING_KEY, PLACED_PREFIX + 'WF-10001'].sort());
	});
});

describe('COD', () => {
	it('payment: null → straight to /order; Razorpay never loads; no pending', async () => {
		const t = setup({ routes: { '/store/checkout': () => ok({ order: { ...ORDER, status: 'cod_pending' }, payment: null }, 201) } });
		const r = await t.flow.submit(body({ method: 'cod' }));
		expect(r.cod).toBe(true);
		expect(t.navigations).toEqual([ORDER_URL]);
		expect(t.scripts).toEqual([]);
		expect(t.env.localStore.getItem(PENDING_KEY)).toBeNull();
	});
});

describe('dismissed / failed payments', () => {
	it('dismiss → failed with "no money was taken"; tracked; one quiet status check', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.state()).toMatchObject({ phase: 'failed', failure: { code: 'DISMISSED', message: NO_MONEY_TAKEN } });
		expect(names(t.events)).toContain('checkout_dismissed');
		expect(t.api.count('/store/orders/status')).toBe(1);
		expect(t.navigations).toEqual([]);
	});

	it('fail then dismiss → FAILED with the reason', async () => {
		const t = setup({ Razorpay: fakeRazorpay('fail_then_dismiss') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.state().failure).toMatchObject({ code: 'FAILED', reason: 'payment_failed', message: NO_MONEY_TAKEN });
		expect(t.events).toContainEqual(['payment_failed', { code: 'payment_failed' }]);
	});

	it('a timed-out payment (can still authorise late) never claims "no money was taken" (W2V-4)', async () => {
		for (const reason of ['payment_timed_out', 'payment_collect_request_expired']) {
			const t = setup({
				Razorpay: fakeRazorpay((r) =>
					queueMicrotask(() => {
						r.fail(reason);
						r.dismiss();
					})
				)
			});
			await t.flow.submit(body());
			await flush(10);
			expect(t.state().failure).toMatchObject({ code: 'FAILED', reason, message: MONEY_UNSURE });
			expect(t.state().failure.message).not.toMatch(/no money was taken/i);
		}
	});

	it('the customer cancelled / the bank declined: "no money was taken" stands', async () => {
		for (const reason of ['payment_cancelled', 'card_declined']) {
			const t = setup({
				Razorpay: fakeRazorpay((r) =>
					queueMicrotask(() => {
						r.fail(reason);
						r.dismiss();
					})
				)
			});
			await t.flow.submit(body());
			await flush(10);
			expect(t.state().failure).toMatchObject({ code: 'FAILED', reason, message: NO_MONEY_TAKEN });
		}
	});

	it('a pending bank reason never claims "no money was taken"', async () => {
		const t = setup({ Razorpay: fakeRazorpay('pending_then_dismiss') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.state().failure.pending).toBe(true);
		expect(t.state().failure.message).toMatch(/still processing.*don’t pay twice/);
	});

	it('order_already_paid → /order', async () => {
		const t = setup({ Razorpay: fakeRazorpay('already_paid_then_dismiss') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('dismissed, but the status check says it was paid (finished in the UPI app) → /order', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss'), routes: { '/store/orders/status': () => ok({ ...ORDER, status: 'paid' }) } });
		await t.flow.submit(body());
		await flush(10);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('Try again (same cart + form) → /checkout/retry, a NEW Razorpay order, then success', async () => {
		const Razorpay = fakeRazorpay('dismiss');
		const t = setup({ Razorpay });
		await t.flow.submit(body());
		await flush(10);
		expect(t.state().phase).toBe('failed');
		Razorpay.script = 'success';
		await t.flow.submit(body()); // the Pay button again = retry of the same order
		await flush(10);
		expect(t.api.count('/store/checkout')).toBe(1);
		expect(t.api.calls.find((c) => c.key === '/store/checkout/retry').opts.body).toEqual({ number: 'WF-10001', token: TOKEN });
		expect(Razorpay.instances.map((i) => i.options.order_id)).toEqual(['order_A1', 'order_A2']);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('flow.retry() directly (the note’s Try again) works the same', async () => {
		const Razorpay = fakeRazorpay('dismiss');
		const t = setup({ Razorpay });
		await t.flow.submit(body());
		await flush(10);
		Razorpay.script = 'success';
		await t.flow.retry();
		await flush(10);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('changing the bag after a failure places a NEW order (new key), not a retry', async () => {
		const Razorpay = fakeRazorpay('dismiss');
		const t = setup({ Razorpay });
		await t.flow.submit(body());
		await flush(10);
		const k1 = t.api.calls[0].opts.headers['Idempotency-Key'];
		await t.flow.submit(body({ items: [{ slug: 'muesli', qty: 2 }], expectedTotalPaise: 50000 }));
		await flush(10);
		const checkouts = t.api.calls.filter((c) => c.key === '/store/checkout');
		expect(checkouts.length).toBe(2);
		expect(checkouts[1].opts.headers['Idempotency-Key']).not.toBe(k1);
		expect(t.api.count('/store/checkout/retry')).toBe(0);
	});

	it('late callbacks from a settled window are ignored', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss') });
		await t.flow.submit(body());
		await flush(10);
		await t.Razorpay.instances[0].succeed();
		await flush(10);
		expect(t.api.count('/store/checkout/verify')).toBe(0);
		expect(t.state().phase).toBe('failed');
	});

	it('retry refused: ALREADY_PAID → /order; NOT_RETRYABLE → note + fresh key', async () => {
		let t = setup({ Razorpay: fakeRazorpay('dismiss'), routes: { '/store/checkout/retry': () => err('ALREADY_PAID', null, 409) } });
		await t.flow.submit(body());
		await flush(10);
		await t.flow.retry();
		expect(t.navigations).toEqual([ORDER_URL]);

		t = setup({ Razorpay: fakeRazorpay('dismiss'), routes: { '/store/checkout/retry': () => err('NOT_RETRYABLE', null, 409) } });
		await t.flow.submit(body());
		await flush(10);
		await t.flow.retry();
		expect(t.state()).toMatchObject({ phase: 'error', error: { code: 'NOT_RETRYABLE', kind: 'dead' } });
		expect(t.env.sessionStore.getItem(IDEM_KEY)).toBeNull();
	});
});

describe('checkout.js and the payment window', () => {
	it('checkout.js blocked → "Couldn’t load payments…", tracked, pending already written; retry loads again', async () => {
		let fails = true;
		const Razorpay = fakeRazorpay('success');
		const t = setup({
			Razorpay,
			loadScript: async () => {
				if (fails) throw new Error('LOAD_ERROR');
				return Razorpay;
			}
		});
		await t.flow.submit(body());
		await flush(10);
		expect(t.state()).toMatchObject({ phase: 'failed', failure: { code: 'SCRIPT_LOAD', message: SCRIPT_FAILED } });
		expect(t.events).toContainEqual(['payment_failed', { code: 'SCRIPT_LOAD' }]);
		expect(t.env.localStore.getItem(PENDING_KEY)).not.toBeNull();
		fails = false;
		await t.flow.retry();
		await flush(10);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('watchdog: open() shows nothing and nothing fires for 15 s → closed, note, tracked', async () => {
		const t = setup({ Razorpay: fakeRazorpay('silent') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.state().phase).toBe('paying');
		await t.timers.advance(14999);
		expect(t.state().phase).toBe('paying');
		await t.timers.advance(1);
		expect(t.state()).toMatchObject({ phase: 'failed', failure: { code: 'OPEN_FAILED', message: OPEN_FAILED } });
		expect(t.Razorpay.instances[0].closed).toBe(true);
		expect(t.events).toContainEqual(['payment_failed', { code: 'WATCHDOG' }]);
	});

	it('watchdog stays quiet while the modal is on screen', async () => {
		const t = setup({ Razorpay: fakeRazorpay('silent'), watchRendered: true });
		await t.flow.submit(body());
		await flush(10);
		await t.timers.advance(60000);
		expect(t.state().phase).toBe('paying');
	});

	it('the window showed, then vanished with no callback → after 3 s "closed before we heard back" + Check status + one quiet look', async () => {
		let shown = true;
		const t = setup({ Razorpay: fakeRazorpay('silent'), watchRendered: () => shown });
		await t.flow.submit(body());
		await flush(10);
		await t.timers.advance(5000);
		expect(t.state().phase).toBe('paying');
		shown = false;
		await t.timers.advance(2000);
		expect(t.state().phase).toBe('paying');
		await t.timers.advance(1000);
		expect(t.state()).toMatchObject({ phase: 'failed', failure: { code: 'CLOSED', pending: true } });
		expect(t.state().failure.message).toMatch(/closed before we heard back.*don’t pay twice/);
		expect(t.events).toContainEqual(['payment_failed', { code: 'CLOSED' }]);
		await flush(10);
		expect(t.api.count('/store/orders/status')).toBe(1);
		expect(t.timers.pending).toBe(0);
	});

	it('a window that opened and closed between checks (seen, not rendered) → CLOSED, not "didn’t open"', async () => {
		const t = setup({ Razorpay: fakeRazorpay('silent') });
		// A watcher that is never visible at a tick but saw the window once.
		const flow2 = createCheckoutFlow({
			api: t.api,
			loadScript: async () => t.Razorpay,
			navigate: (u) => t.navigations.push(u),
			track: () => {},
			newKey: fakeUuid,
			env: makeEnv(),
			timers: t.timers,
			watchRender: () => ({ rendered: () => false, seen: () => true, stop() {} })
		});
		await flow2.submit(body());
		await flush(10);
		await t.timers.advance(4000);
		expect(get(flow2.state).failure.code).toBe('CLOSED');
	});

	it('a window that flickers (hidden < 3 s) keeps waiting', async () => {
		let shown = true;
		const t = setup({ Razorpay: fakeRazorpay('silent'), watchRendered: () => shown });
		await t.flow.submit(body());
		await flush(10);
		await t.timers.advance(2000);
		shown = false;
		await t.timers.advance(2000);
		shown = true;
		await t.timers.advance(30000);
		expect(t.state().phase).toBe('paying');
	});

	it('vanished, but the order is already paid → /order', async () => {
		let shown = true;
		const t = setup({ Razorpay: fakeRazorpay('silent'), watchRendered: () => shown, routes: { '/store/orders/status': () => ok({ ...ORDER, status: 'paid' }) } });
		await t.flow.submit(body());
		await flush(10);
		await t.timers.advance(1000);
		shown = false;
		await t.timers.advance(3000);
		await flush(10);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('watchdog is cleared by a callback', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.timers.pending).toBe(0);
	});

	it('open() throwing → OPEN_FAILED', async () => {
		const t = setup({ Razorpay: fakeRazorpay('throw') });
		await t.flow.submit(body());
		await flush(10);
		expect(t.state().failure.code).toBe('OPEN_FAILED');
	});

	it('a malformed PaymentInit never loads a script', async () => {
		const t = setup({ routes: { '/store/checkout': () => ok({ order: ORDER, payment: { ...PAYMENT, razorpayOrderId: '' } }, 201) } });
		await t.flow.submit(body());
		await flush(10);
		expect(t.scripts).toEqual([]);
		expect(t.state().failure.code).toBe('OPEN_FAILED');
	});
});

describe('in-flight guard and the Idempotency-Key', () => {
	it('a double tap sends ONE checkout and opens ONE window', async () => {
		let release;
		const t = setup({ routes: { '/store/checkout': () => new Promise((r) => (release = () => r(ok({ order: ORDER, payment: PAYMENT }, 201)))) } });
		const a = t.flow.submit(body());
		const b = await t.flow.submit(body());
		expect(b).toEqual({ ignored: true });
		release();
		await a;
		await flush(10);
		expect(t.api.count('/store/checkout')).toBe(1);
		expect(t.Razorpay.instances.length).toBe(1);
	});

	it('network failure keeps the key: the replay after it carries the same Idempotency-Key', async () => {
		let n = 0;
		const t = setup({
			routes: {
				'/store/checkout': () => (++n === 1 ? { ok: false, status: 0, data: null, error: { code: 'TIMEOUT', message: 'x' } } : ok({ order: ORDER, payment: PAYMENT }, 200))
			}
		});
		await t.flow.submit(body());
		expect(t.state()).toMatchObject({ phase: 'error', error: { kind: 'network' } });
		await t.flow.submit(body());
		await flush(10);
		const keys = t.api.calls.filter((c) => c.key === '/store/checkout').map((c) => c.opts.headers['Idempotency-Key']);
		expect(keys.length).toBe(2);
		expect(keys[0]).toBe(keys[1]);
	});

	it('IDEMPOTENCY_MISMATCH → the key is dropped and the next tap uses a new one', async () => {
		let n = 0;
		const t = setup({ routes: { '/store/checkout': () => (++n === 1 ? err('IDEMPOTENCY_MISMATCH', null, 409) : ok({ order: ORDER, payment: PAYMENT }, 201)) } });
		await t.flow.submit(body());
		expect(t.state().error.kind).toBe('key');
		await t.flow.submit(body());
		const keys = t.api.calls.filter((c) => c.key === '/store/checkout').map((c) => c.opts.headers['Idempotency-Key']);
		expect(keys[0]).not.toBe(keys[1]);
	});
});

describe('API refusals → state.error (errors.js mapping)', () => {
	it.each([
		['VALIDATION', { fields: { phone: 'INVALID' } }, 400, 'fields'],
		['PRICE_CHANGED', { quote: { totalPaise: 52400, lines: [], issues: [] } }, 409, 'price'],
		['OUT_OF_STOCK', { issues: [{ slug: 'muesli', name: 'Muesli', code: 'OUT_OF_STOCK', available: 0 }] }, 409, 'lines'],
		['PIN_UNSERVICEABLE', { pin: '194101' }, 422, 'fields'],
		['COD_UNAVAILABLE', { reason: 'TOO_MANY_OPEN' }, 422, 'cod'],
		['COUPON_INVALID', { reason: 'EXPIRED' }, 422, 'coupon'],
		['RATE_LIMITED', null, 429, 'rate'],
		['PAYMENTS_UNAVAILABLE', null, 503, 'payments']
	])('%s → %s', async (code, details, status, kind) => {
		const t = setup({ routes: { '/store/checkout': () => err(code, details, status) } });
		const r = await t.flow.submit(body());
		expect(r.error.kind).toBe(kind);
		expect(t.state()).toMatchObject({ phase: 'error', error: { code, kind } });
		expect(t.scripts).toEqual([]);
		expect(t.env.localStore.getItem(PENDING_KEY)).toBeNull();
		if (code === 'PAYMENTS_UNAVAILABLE') expect(t.events).toContainEqual(['payment_failed', { code }]);
	});

	it('a 201 without order number/token is an INTERNAL error, not a crash', async () => {
		const t = setup({ routes: { '/store/checkout': () => ok({ order: { number: 5 } }, 201) } });
		await t.flow.submit(body());
		expect(t.state().error.kind).toBe('generic');
	});

	it('reset() clears an error; ignored while busy unless forced (and a forced reset silences the old window)', async () => {
		const t = setup({ routes: { '/store/checkout': () => err('RATE_LIMITED', null, 429) } });
		await t.flow.submit(body());
		t.flow.reset();
		expect(t.state()).toMatchObject({ phase: 'idle', error: null, failure: null });

		const u = setup({ Razorpay: fakeRazorpay('silent') });
		await u.flow.submit(body());
		await flush(10);
		expect(u.state().phase).toBe('paying');
		u.flow.reset();
		expect(u.state().phase).toBe('paying');
		u.flow.reset(true);
		expect(u.state().phase).toBe('idle');
		await u.Razorpay.instances[0].succeed(); // a late handler from the old window
		await flush(10);
		expect(u.api.count('/store/checkout/verify')).toBe(0);
		await u.timers.advance(20000); // nor its watchdog
		expect(u.state().phase).toBe('idle');
	});
});

describe('adopt (pending banner, /order Try again)', () => {
	it('retries an order this page did not create', async () => {
		const t = setup();
		t.flow.adopt({ number: 'WF-10001', token: TOKEN }, 'card', 'muesli:1');
		await t.flow.retry();
		await flush(10);
		expect(t.api.count('/store/checkout')).toBe(0);
		expect(t.Razorpay.instances[0].options.prefill.method).toBe('card');
		expect(JSON.parse(t.env.localStore.getItem(PENDING_KEY)).cartSig).toBe('muesli:1');
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('retry with no order is ignored', async () => {
		const t = setup();
		expect(await t.flow.retry()).toEqual({ ignored: true });
	});
});

describe('storage throwing', () => {
	it('the whole online flow still works (no pending, key in memory)', async () => {
		const env = blockedEnv();
		forgetIdempotencyKey(env);
		const t = setup({ env });
		await t.flow.submit(body());
		await flush(10);
		expect(t.navigations).toEqual([ORDER_URL]);
	});

	it('COD too', async () => {
		const t = setup({ env: blockedEnv(), routes: { '/store/checkout': () => ok({ order: ORDER, payment: null }, 201) } });
		await t.flow.submit(body({ method: 'cod' }));
		expect(t.navigations).toEqual([ORDER_URL]);
	});
});

/* ------------------------------------------------ Wave 3 round 1 fixes */

const OTHER = { number: 'WF-10002', token: TOKEN, status: 'pending_payment', totalPaise: 47400 };
const keysOf = (t) => t.api.calls.filter((c) => c.key === '/store/checkout').map((c) => c.opts.headers['Idempotency-Key']);

describe('the placing device (PI-ORD-3) and the pending order a new order replaces', () => {
	it('checkout marks the order as placed on this device (online and COD); /order consumes it once', async () => {
		const t = setup();
		await t.flow.submit(body());
		await flush(10);
		expect(t.env.localStore.getItem(PLACED_PREFIX + 'WF-10001')).toBe(String(t.env.t));
		expect(consumePlaced('WF-10001', t.env)).toBe(true);
		expect(consumePlaced('WF-10001', t.env)).toBe(false);

		const c = setup({ routes: { '/store/checkout': () => ok({ order: { ...OTHER, status: 'cod_pending' }, payment: null }, 201) } });
		await c.flow.submit(body({ method: 'cod' }));
		expect(consumePlaced('WF-10002', c.env)).toBe(true);
	});

	it('a COD order for the same bag that names the pending online order (supersede ref) drops it; the pending order of another bag stays', async () => {
		const cod = () => ok({ order: { ...OTHER, status: 'cod_pending' }, payment: null }, 201);
		const ref = { number: 'WF-10001', token: TOKEN };
		let t = setup({ routes: { '/store/checkout': cod } });
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: 'cornflakes:1,muesli:1' }, t.env);
		await t.flow.submit(body({ method: 'cod', supersede: ref }));
		expect(t.api.calls.find((c) => c.key === '/store/checkout').opts.body.supersede).toEqual(ref);
		expect(t.env.localStore.getItem(PENDING_KEY)).toBeNull();

		t = setup({ routes: { '/store/checkout': cod } });
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: 'health-mix:1' }, t.env);
		await t.flow.submit(body({ method: 'cod', supersede: ref }));
		expect(JSON.parse(t.env.localStore.getItem(PENDING_KEY))).toMatchObject({ no: 'WF-10001' });
	});

	it('cartSig: the bag of the flow’s order ("" with none)', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss') });
		expect(t.flow.cartSig).toBe('');
		await t.flow.submit(body());
		await flush(10);
		expect(t.flow.cartSig).toBe('cornflakes:1,muesli:1');
	});
});

describe('SUP-PHONE-1 / SUP-OWN-1: the pending order is dropped only when the server cancelled it (the ref named it)', () => {
	const SIG = 'cornflakes:1,muesli:1';
	const REF = { number: 'WF-10001', token: TOKEN };
	const PHONE_B = { ...FORM, phone: '98450 00001' };
	const bodyB = (patch = {}) => body({ value: checkForm(PHONE_B).value, method: 'cod', ...patch });
	const cod = () => ok({ order: { ...OTHER, status: 'cod_pending' }, payment: null }, 201);
	const pendingNo = (t) => JSON.parse(t.env.localStore.getItem(PENDING_KEY) || 'null')?.no ?? null;

	/** An unpaid online order WF-10001 for this bag, placed in this tab with `placedWith` (or another tab: null). */
	function withPending(placedWith = FORM) {
		const t = setup({ routes: { '/store/checkout': cod } });
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: SIG }, t.env);
		if (placedWith) writePendingForm({ no: 'WF-10001', form: placedWith }, t.env);
		return t;
	}

	it('phone changed, the checkout names the order (supersede ref) → the server cancels it → dropped', async () => {
		const t = withPending();
		await t.flow.submit(bodyB({ supersede: REF }));
		expect(t.navigations).toEqual([`/order?no=WF-10002&t=${TOKEN}`]);
		expect(pendingNo(t)).toBeNull();
	});

	it('same phone (however it was typed), no ref → SUP-OWN-1: a shared phone replaces nothing → kept', async () => {
		const t = withPending({ ...FORM, phone: '+91 98452-62777' });
		await t.flow.submit(body({ method: 'cod' }));
		expect(pendingNo(t)).toBe('WF-10001');
	});

	it('phone changed and no ref → that order is still payable: its pending entry (the banner) stays', async () => {
		const t = withPending();
		await t.flow.submit(bodyB());
		expect(t.navigations).toEqual([`/order?no=WF-10002&t=${TOKEN}`]);
		expect(pendingNo(t)).toBe('WF-10001');
	});

	it('details this tab never saw (another tab placed it) and no ref → kept', async () => {
		const t = withPending(null);
		await t.flow.submit(body({ method: 'cod' }));
		expect(pendingNo(t)).toBe('WF-10001');
	});

	it.each([
		['another order', { number: 'WF-09999', token: TOKEN }],
		['a stale token', { number: 'WF-10001', token: TOKEN2 }]
	])('a ref for %s with a changed phone does not cover the pending order → kept', async (_, ref) => {
		const t = withPending();
		await t.flow.submit(bodyB({ supersede: ref }));
		expect(pendingNo(t)).toBe('WF-10001');
	});

	it('a new ONLINE order that names it replaces the entry with its own (before its window opens)', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss'), routes: { '/store/checkout': () => ok({ order: OTHER, payment: PAYMENT }, 201) } });
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: SIG }, t.env);
		await t.flow.submit(bodyB({ method: 'upi', supersede: REF }));
		await flush(10);
		expect(t.pendingAtOpen[0]).toMatchObject({ no: 'WF-10002', cartSig: SIG });
	});

	it('a replay onto the pending order itself (same key, now with its own ref) never drops it', async () => {
		const t = setup({ Razorpay: fakeRazorpay('dismiss') });
		await t.flow.submit(body());
		await flush(10);
		expect(pendingNo(t)).toBe('WF-10001');
		// A reload: the page now reads wefeasto_pending and sends it as the ref; the key is the same.
		const again = setup({ env: t.env, Razorpay: fakeRazorpay('dismiss') });
		await again.flow.submit(body({ supersede: REF }));
		await flush(10);
		const k1 = t.api.calls.find((c) => c.key === '/store/checkout').opts.headers['Idempotency-Key'];
		const k2 = again.api.calls.find((c) => c.key === '/store/checkout').opts.headers['Idempotency-Key'];
		expect(k2).toBe(k1);
		expect(pendingNo(again)).toBe('WF-10001');
	});

	it('supersedes(): only the ref proves it (number AND token); the phone it was placed with proves nothing (SUP-OWN-1)', () => {
		const env = makeEnv();
		const prev = { no: 'WF-10001', t: TOKEN };
		expect(supersedes(prev, bodyB({ supersede: REF }))).toBe(true);
		expect(supersedes(prev, body({ method: 'cod', supersede: REF }))).toBe(true);
		expect(supersedes(prev, bodyB({ supersede: { number: 'WF-10001', token: TOKEN2 } }))).toBe(false);
		expect(supersedes(prev, bodyB())).toBe(false);
		writePendingForm({ no: 'WF-10001', form: { ...FORM, phone: '09845262777' } }, env);
		expect(supersedes(prev, body({ method: 'cod' }))).toBe(false); // same phone, no ref
		expect(supersedes(prev, null)).toBe(false);
	});
});

describe('Try again refused for the bag (PI-PAY-3): the order is done, the next tap places a NEW one', () => {
	it.each([
		['OUT_OF_STOCK', { issues: [{ slug: 'muesli', name: 'Muesli', code: 'OUT_OF_STOCK', available: 1, suggestedQty: 1 }] }, 409],
		['QTY_LIMIT', { issues: [{ slug: 'muesli', name: 'Muesli', code: 'QTY_LIMIT', maxQty: 1, suggestedQty: 1 }] }, 409],
		['UNAVAILABLE', { issues: [{ slug: 'muesli', name: 'Muesli', code: 'UNAVAILABLE' }] }, 409]
	])('retry → %s: lines error, key forgotten, order dropped; Pay with the same bag + form → /store/checkout with a fresh key', async (code, details, status) => {
		const Razorpay = fakeRazorpay('dismiss');
		let n = 0;
		const t = setup({
			Razorpay,
			routes: {
				'/store/checkout/retry': () => err(code, details, status),
				'/store/checkout': () => (++n === 1 ? ok({ order: ORDER, payment: PAYMENT }, 201) : ok({ order: OTHER, payment: { ...PAYMENT, razorpayOrderId: 'order_B1' } }, 201))
			}
		});
		await t.flow.submit(body());
		await flush(10);
		const r = await t.flow.retry();
		expect(r.error).toMatchObject({ code, kind: 'lines', actions: ['refresh-quote'] });
		expect(t.state()).toMatchObject({ phase: 'error', error: { code } });
		expect(t.env.sessionStore.getItem(IDEM_KEY)).toBeNull();
		expect(t.flow.order).toBeNull();
		expect(await t.flow.retry()).toEqual({ ignored: true }); // nothing left to retry
		expect(t.navigations).toEqual([]);

		// Stock is back for the same bag: still a NEW order, never a replay of the expired one.
		Razorpay.script = 'success';
		await t.flow.submit(body());
		await flush(10);
		const keys = keysOf(t);
		expect(keys).toHaveLength(2);
		expect(keys[1]).not.toBe(keys[0]);
		expect(t.api.count('/store/checkout/retry')).toBe(1);
		expect(t.navigations).toEqual([`/order?no=WF-10002&t=${TOKEN}`]);
	});

	it('a refusal at checkout (not retry) keeps the key: a replay after a timeout still finds the same order', async () => {
		const t = setup({ routes: { '/store/checkout': () => err('OUT_OF_STOCK', { issues: [{ slug: 'muesli', code: 'OUT_OF_STOCK', available: 0 }] }, 409) } });
		await t.flow.submit(body());
		expect(t.env.sessionStore.getItem(IDEM_KEY)).not.toBeNull();
	});
});

describe('an online replay onto an order nothing can be paid on (PI-PAY-3)', () => {
	it.each(['expired', 'cancelled'])('status %s, payment null → key dropped, ONE new order with a fresh key → its payment opens; never the dead order’s /order', async (status) => {
		let n = 0;
		const t = setup({
			routes: {
				'/store/checkout': () => (++n === 1 ? ok({ order: { ...ORDER, status }, payment: null }) : ok({ order: OTHER, payment: { ...PAYMENT, razorpayOrderId: 'order_B1' } }, 201))
			}
		});
		await t.flow.submit(body());
		await flush(10);
		const keys = keysOf(t);
		expect(keys).toHaveLength(2);
		expect(keys[1]).not.toBe(keys[0]);
		expect(t.Razorpay.instances.map((i) => i.options.order_id)).toEqual(['order_B1']);
		expect(t.navigations).toEqual([`/order?no=WF-10002&t=${TOKEN}`]);
		expect(consumePlaced('WF-10001', t.env)).toBe(false); // the dead order was never "placed" here again
	});

	it('the fresh try is dead too → an error note (re-quote, new key), no navigation, no loop', async () => {
		const t = setup({ routes: { '/store/checkout': () => ok({ order: { ...ORDER, status: 'expired' }, payment: null }) } });
		const r = await t.flow.submit(body());
		expect(t.api.count('/store/checkout')).toBe(2);
		expect(r.error).toMatchObject({ code: 'NOT_RETRYABLE', kind: 'dead', actions: ['new-key', 'refresh-quote'] });
		expect(t.state().phase).toBe('error');
		expect(t.navigations).toEqual([]);
		expect(t.state().order).toBeNull();
	});

	it.each(['paid', 'needs_review', 'pending_payment', 'refunded'])('status %s, payment null → /order (it shows the truth; money moved or is settling)', async (status) => {
		const t = setup({ routes: { '/store/checkout': () => ok({ order: { ...ORDER, status }, payment: null }) } });
		const r = await t.flow.submit(body());
		expect(t.api.count('/store/checkout')).toBe(1);
		expect(t.navigations).toEqual([ORDER_URL]);
		expect(r).toMatchObject({ cod: false, order: { number: 'WF-10001' } });
	});

	it('COD replays always go to /order', async () => {
		const t = setup({ routes: { '/store/checkout': () => ok({ order: { ...ORDER, status: 'cancelled' }, payment: null }) } });
		await t.flow.submit(body({ method: 'cod' }));
		expect(t.api.count('/store/checkout')).toBe(1);
		expect(t.navigations).toEqual([ORDER_URL]);
	});
});
