/*
 * Hunt round 4 (client-ux, a11y) regressions:
 * - the pending banner's × keeps a QUIET wefeasto_pending (never shown again, still the supersede ref),
 *   so the same bag checked out again replaces the customer's own unpaid order (SUP-OWN-1) instead of
 *   being refused "That offer is for your first order only";
 * - a payment window that closed with no money taken marks the entry `unpaid`: /order then says
 *   "Waiting for payment" (with a way to pay), never "Confirming with your bank… don't pay again";
 * - the PIN autofill of City / State is spoken (announce.js pinFillMessage).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createCheckoutFlow, NO_MONEY_TAKEN } from '$lib/checkout/flow.js';
import { buildCheckoutBody, checkForm } from '$lib/checkout/request.js';
import { viewFor, nextView, pollModeFor } from '$lib/checkout/order.js';
import { supersedeFor } from '$lib/checkout/quote.js';
import { pinFillMessage } from '$lib/checkout/announce.js';
import {
	PENDING_KEY, _resetSeenMemory, writePending, readPending, quietPending, markPendingUnpaid, isUnpaidHere, clearPendingFor
} from '$lib/checkout/storage.js';
import { makeEnv, fakeApi, fakeRazorpay, manualTimers, flush, ok, err, fakeUuid, PAYMENT, TOKEN, TOKEN2 } from './_helpers.js';

const FORM = { name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };
const VALUE = checkForm(FORM).value;
const body = (patch = {}) =>
	buildCheckoutBody({ value: VALUE, items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }], method: 'upi', couponCode: 'WELCOME10', expectedTotalPaise: 45400, ...patch });
const ORDER = { number: 'WF-10001', token: TOKEN, status: 'pending_payment', totalPaise: 45400 };
const SIG = 'cornflakes:1,muesli:1';
const raw = (env) => JSON.parse(env.local().getItem(PENDING_KEY));

function setup({ Razorpay = fakeRazorpay('dismiss'), routes = {}, env = makeEnv(), loadScript, watchRendered = true } = {}) {
	const api = fakeApi({
		'/store/checkout': () => ok({ order: ORDER, payment: PAYMENT }, 201),
		'/store/checkout/verify': () => ok({ order: { ...ORDER, status: 'paid' } }),
		'/store/checkout/retry': () => ok({ order: { number: ORDER.number, status: 'pending_payment' }, payment: { ...PAYMENT, razorpayOrderId: 'order_A2' } }),
		'/store/orders/status': () => ok({ ...ORDER }),
		...routes
	});
	const timers = manualTimers();
	const atOpen = [];
	const flow = createCheckoutFlow({
		api, env, timers, newKey: fakeUuid, navigate: () => {},
		loadScript: loadScript || (async () => (atOpen.push(readPending(env)), Razorpay)),
		watchRender: () => ({ rendered: () => (typeof watchRendered === 'function' ? watchRendered() : watchRendered), stop() {} })
	});
	return { flow, api, env, timers, atOpen, state: () => get(flow.state) };
}

beforeEach(() => _resetSeenMemory());

describe('wefeasto_pending: quiet (× on the banner) and unpaid flags', () => {
	it('× keeps the entry, quiet: the banner skips it, the next checkout of the bag still names it', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: SIG }, env);
		expect(quietPending('WF-10001', env)).toBe(true);
		const p = readPending(env);
		expect(p).toEqual({ no: 'WF-10001', t: TOKEN, at: env.t, cartSig: SIG, quiet: true });
		expect(supersedeFor(p, SIG)).toEqual({ number: 'WF-10001', token: TOKEN });
		expect(supersedeFor(p, 'muesli:1')).toBeNull(); // another bag: not replaced
	});

	it('flags only ever touch the entry for that order; a fresh entry carries none', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10002', t: TOKEN2, cartSig: SIG }, env);
		expect(quietPending('WF-10001', env)).toBe(false);
		expect(markPendingUnpaid('WF-10001', env)).toBe(false);
		expect(raw(env)).toEqual({ no: 'WF-10002', t: TOKEN2, at: env.t, cartSig: SIG });
		markPendingUnpaid('WF-10002', env);
		expect(isUnpaidHere('WF-10002', env)).toBe(true);
		expect(isUnpaidHere('WF-10001', env)).toBe(false);
		writePending({ no: 'WF-10002', t: TOKEN2, cartSig: SIG }, env); // the next window: in flight again
		expect(isUnpaidHere('WF-10002', env)).toBe(false);
		expect(readPending(env)).not.toHaveProperty('quiet');
	});

	it('a quiet entry is still dropped by the usual rules (confirmed order) and by age', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: SIG }, env);
		quietPending('WF-10001', env);
		clearPendingFor('WF-10001', env);
		expect(readPending(env)).toBeNull();
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: SIG }, env);
		quietPending('WF-10001', env);
		env.t += 8 * 86400000;
		expect(readPending(env)).toBeNull();
	});

	it('flags that are not exactly true are ignored; storage that throws never throws here', () => {
		const env = makeEnv();
		env.local().setItem(PENDING_KEY, JSON.stringify({ no: 'WF-10001', t: TOKEN, at: env.t, cartSig: SIG, quiet: 'yes', unpaid: 1 }));
		expect(readPending(env)).toEqual({ no: 'WF-10001', t: TOKEN, at: env.t, cartSig: SIG });
		const blocked = makeEnv({ local: () => { throw new Error('blocked'); } });
		expect(quietPending('WF-10001', blocked)).toBe(false);
		expect(isUnpaidHere('WF-10001', blocked)).toBe(false);
	});
});

describe('flow: a window that took no money marks the order unpaid; anything in flight does not', () => {
	it('dismissed ("no money was taken") → unpaid; a retry clears it as its window opens', async () => {
		const t = setup();
		await t.flow.submit(body());
		await flush(10);
		expect(t.state().failure).toMatchObject({ code: 'DISMISSED', message: NO_MONEY_TAKEN });
		expect(isUnpaidHere('WF-10001', t.env)).toBe(true);
		await t.flow.retry();
		await flush(10);
		expect(t.atOpen[1]).not.toHaveProperty('unpaid'); // in flight while the retry's window was up
		expect(isUnpaidHere('WF-10001', t.env)).toBe(true); // …and dismissed again
	});

	it('a failure that may still authorise, or a pending reason, keeps it "in flight"', async () => {
		for (const script of ['pending_then_dismiss', (r) => queueMicrotask(() => (r.fail('payment_timed_out'), r.dismiss()))]) {
			const t = setup({ Razorpay: fakeRazorpay(script) });
			await t.flow.submit(body());
			await flush(10);
			expect(t.state().phase).toBe('failed');
			expect(isUnpaidHere('WF-10001', t.env)).toBe(false);
		}
	});

	it('paid in the window (handler → verify) is never marked unpaid', async () => {
		const t = setup({ Razorpay: fakeRazorpay('success') });
		await t.flow.submit(body());
		await flush(10);
		expect(isUnpaidHere('WF-10001', t.env)).toBe(false);
	});

	it('checkout.js failing, or a window that never rendered (watchdog) → unpaid', async () => {
		const a = setup({ loadScript: async () => { throw new Error('offline'); } });
		await a.flow.submit(body());
		await flush(10);
		expect(a.state().failure.code).toBe('SCRIPT_LOAD');
		expect(isUnpaidHere('WF-10001', a.env)).toBe(true);
		const b = setup({ Razorpay: fakeRazorpay('silent'), watchRendered: false });
		await b.flow.submit(body());
		await b.timers.advance(20000);
		expect(b.state().failure.code).toBe('OPEN_FAILED');
		expect(isUnpaidHere('WF-10001', b.env)).toBe(true);
	});

	it('a window that vanished with no callback (CLOSED) stays "in flight": they may have paid', async () => {
		let shown = true;
		const t = setup({ Razorpay: fakeRazorpay('silent'), watchRendered: () => shown });
		await t.flow.submit(body());
		await t.timers.advance(2000);
		shown = false;
		await t.timers.advance(5000);
		expect(t.state().failure.code).toBe('CLOSED');
		expect(isUnpaidHere('WF-10001', t.env)).toBe(false);
	});

	it('placed while payments were down (PAYMENTS_UNAVAILABLE): nothing is paying it → unpaid', async () => {
		const t = setup({ routes: { '/store/checkout': () => err('PAYMENTS_UNAVAILABLE', { order: ORDER }, 503) } });
		await t.flow.submit(body());
		await flush(10);
		expect(readPending(t.env)).toMatchObject({ no: 'WF-10001', unpaid: true });
	});
});

describe('order.js: "waiting" only when this device knows nothing is paying it', () => {
	const pending = { number: 'WF-10001', status: 'pending_payment', paymentMethod: 'online', paymentStatus: 'created' };
	it('viewFor: unpaid here → waiting; otherwise (and with money seen) → confirming', () => {
		expect(viewFor(pending)).toBe('confirming');
		expect(viewFor(pending, { unpaid: true })).toBe('waiting');
		expect(viewFor({ ...pending, paymentStatus: 'authorized' }, { unpaid: true })).toBe('confirming');
		expect(viewFor({ ...pending, status: 'paid' }, { unpaid: true })).toBe('confirmed');
		expect(viewFor({ ...pending, status: 'payment_failed' }, { unpaid: true })).toBe('failed');
	});
	it('nextView: "failed" stays; "Still confirming" / "confirming" learn it is unpaid; "waiting" stays on a pending answer', () => {
		expect(nextView('failed', pending, { unpaid: true })).toBe('failed');
		expect(nextView('slow', pending, { unpaid: true })).toBe('waiting');
		expect(nextView('slow', pending)).toBe('slow');
		expect(nextView('loading', pending, { unpaid: true })).toBe('waiting');
		expect(nextView('waiting', pending, { unpaid: true })).toBe('waiting');
		expect(nextView('waiting', { ...pending, status: 'paid' }, { unpaid: true })).toBe('confirmed');
	});
	it('pollModeFor: "waiting" keeps a slow look (paid elsewhere → confirmed)', () => {
		expect(pollModeFor('waiting', pending)).toBe('failed');
		expect(pollModeFor('waiting', { ...pending, status: 'cancelled' })).toBeNull();
	});
});

describe('announce.js pinFillMessage', () => {
	it('names what was filled and asks to check it', () => {
		expect(pinFillMessage({ city: 'Bengaluru', state: 'Karnataka' })).toBe('City and state filled in from your PIN: Bengaluru, Karnataka. Change them if they’re not right.');
		expect(pinFillMessage({ city: 'Bengaluru' })).toBe('City filled in from your PIN: Bengaluru. Change it if it’s not right.');
		expect(pinFillMessage({ state: 'Karnataka' })).toBe('State filled in from your PIN: Karnataka. Change it if it’s not right.');
	});
	it('nothing changed → nothing said', () => {
		expect(pinFillMessage({})).toBe('');
		expect(pinFillMessage(null)).toBe('');
		expect(pinFillMessage({ city: '' })).toBe('');
	});
});
