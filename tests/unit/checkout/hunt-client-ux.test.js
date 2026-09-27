/*
 * Hunt round 1 (client-ux) regressions in the checkout flow and its storage:
 * - the Idempotency-Key retires once its order is seen confirmed (same bag again = a NEW order);
 * - a COD tap that never heard back is resolved by the next checkout of the bag (never a 2nd order);
 * - adopt() keeps wefeasto_pending's bag signature for the same order;
 * - the busy label after a payment never says "Opening payment…";
 * - canSwitchToCod never mixes the server's clock with the device's on the placing device.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createCheckoutFlow, busyLabel } from '$lib/checkout/flow.js';
import { buildCheckoutBody, checkForm } from '$lib/checkout/request.js';
import { canSwitchToCod, COD_SWITCH_WINDOW_MS } from '$lib/checkout/order.js';
import {
	PENDING_KEY, PLACING_MAX_AGE_MS, _resetSeenMemory, markSeen, markPlaced, placedAt, writePending,
	readPlacing, writePlacing, idempotencyKeyFor, noteIdempotentOrder
} from '$lib/checkout/storage.js';
import { makeEnv, fakeApi, fakeRazorpay, manualTimers, flush, ok, err, fakeUuid, PAYMENT, TOKEN } from './_helpers.js';

const FORM = { name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };
const VALUE = checkForm(FORM).value;
const body = (patch = {}) =>
	buildCheckoutBody({ value: VALUE, items: [{ slug: 'muesli', qty: 1 }], method: 'cod', expectedTotalPaise: 29900, ...patch });
const moved = () => body({ value: { ...VALUE, line1: VALUE.line1 + ', near the park' } });

const ORDER = { number: 'WF-10001', token: TOKEN, status: 'cod_pending', totalPaise: 29900 };
const URL1 = `/order?no=WF-10001&t=${TOKEN}`;
const NET = { ok: false, status: 0, data: null, error: { code: 'NETWORK', message: 'x' } };

function flowOn(env, checkout) {
	const api = fakeApi({ '/store/checkout': checkout, '/store/checkout/retry': () => ok({ order: { number: 'WF-10001' }, payment: PAYMENT }) });
	const navigations = [];
	const flow = createCheckoutFlow({
		api, env, newKey: fakeUuid, timers: manualTimers(), navigate: (u) => navigations.push(u),
		loadScript: async () => fakeRazorpay('dismiss'), watchRender: () => ({ rendered: () => true, stop() {} })
	});
	const posts = () => api.calls.filter((c) => c.key === '/store/checkout');
	return { flow, api, navigations, posts, keys: () => posts().map((c) => c.opts.headers['Idempotency-Key']) };
}

beforeEach(() => _resetSeenMemory());

describe('Idempotency-Key: retired once its order is seen confirmed', () => {
	it('storage: the same attempt keeps its key until the order it made is seen', () => {
		const env = makeEnv();
		const a = { cartSig: 'muesli:1', formHash: 'f1' };
		const k = idempotencyKeyFor(a, { newKey: fakeUuid, env });
		expect(noteIdempotentOrder('00000000-0000-4000-8000-ffffffffffff', 'WF-10001', env)).toBe(false); // another key
		expect(noteIdempotentOrder(k, 'WF-10001', env)).toBe(true);
		expect(idempotencyKeyFor(a, { newKey: fakeUuid, env })).toBe(k); // unpaid / unseen: reload + tap replays
		markSeen('WF-10001', env);
		expect(idempotencyKeyFor(a, { newKey: fakeUuid, env })).not.toBe(k);
	});

	it('COD, then "Buy again" with the same saved details → a NEW key (a new order), not the old one replayed', async () => {
		const env = makeEnv();
		const first = flowOn(env, () => ok({ order: ORDER, payment: null }, 201));
		await first.flow.submit(body());
		markSeen('WF-10001', env); // /order showed it confirmed
		const again = flowOn(env, () => ok({ order: { ...ORDER, number: 'WF-10002' }, payment: null }, 201));
		await again.flow.submit(body());
		expect(again.keys()[0]).not.toBe(first.keys()[0]);
		expect(again.navigations[0]).toContain('WF-10002');
	});

	it('an order not seen confirmed yet (reload before /order) still replays under its key', async () => {
		const env = makeEnv();
		const first = flowOn(env, () => ok({ order: ORDER, payment: null }, 201));
		await first.flow.submit(body());
		const again = flowOn(env, () => ok({ order: ORDER, payment: null }, 200));
		await again.flow.submit(body());
		expect(again.keys()[0]).toBe(first.keys()[0]);
	});
});

describe('a COD "Place order" that never heard back (wefeasto_placing)', () => {
	it('is recorded before the request and kept through a network failure — online taps too (hunt round 3)', async () => {
		const env = makeEnv();
		const t = flowOn(env, () => NET);
		await t.flow.submit(body());
		expect(readPlacing(env)).toMatchObject({ k: t.keys()[0], sig: 'muesli:1', body: body() });
		const env2 = makeEnv();
		const u = flowOn(env2, () => NET);
		await u.flow.submit(body({ method: 'upi' }));
		expect(readPlacing(env2)).toMatchObject({ k: u.keys()[0], sig: 'muesli:1', body: body({ method: 'upi' }) });
	});

	it('changed details after a reload: the server has that tap\'s order (MISMATCH) → its own request replays → that order, no 2nd', async () => {
		const env = makeEnv();
		const lost = flowOn(env, () => NET);
		await lost.flow.submit(body());
		const t = flowOn(env, (opts, n) => (n === 1 ? err('IDEMPOTENCY_MISMATCH', null, 409) : ok({ order: ORDER, payment: null }, 200)));
		await t.flow.submit(moved());
		expect(t.keys()).toEqual([lost.keys()[0], lost.keys()[0]]);
		expect(t.posts()[0].opts.body).toEqual(moved());
		expect(t.posts()[1].opts.body).toEqual(body()); // the first tap's exact request
		expect(t.navigations).toEqual([URL1]);
		expect(readPlacing(env)).toBeNull();
		expect(get(t.flow.state).phase).toBe('leaving');
	});

	it('the first tap never arrived: the next one is placed under its key (one order)', async () => {
		const env = makeEnv();
		const lost = flowOn(env, () => NET);
		await lost.flow.submit(body());
		const t = flowOn(env, () => ok({ order: ORDER, payment: null }, 201));
		await t.flow.submit(moved());
		expect(t.keys()).toEqual([lost.keys()[0]]);
		expect(readPlacing(env)).toBeNull();
	});

	it('another bag is not resolved against it; a 5xx keeps it open, a 4xx closes it', async () => {
		const env = makeEnv();
		await flowOn(env, () => NET).flow.submit(body());
		const other = flowOn(env, () => err('INTERNAL', null, 500));
		await other.flow.submit(body({ items: [{ slug: 'cornflakes', qty: 2 }] }));
		expect(readPlacing(env).sig).toBe('cornflakes:2'); // its own tap, unresolved (a 5xx may have made it)
		await flowOn(env, () => err('VALIDATION', { fields: { pin: 'INVALID' } }, 400)).flow.submit(body({ items: [{ slug: 'cornflakes', qty: 2 }] }));
		expect(readPlacing(env)).toBeNull();
	});

	it('expires after 30 minutes; junk is removed', () => {
		const env = makeEnv();
		writePlacing({ k: '00000000-0000-4000-8000-000000000abc', sig: 'muesli:1', body: body() }, env);
		env.t += PLACING_MAX_AGE_MS + 1;
		expect(readPlacing(env)).toBeNull();
		env.sessionStore.setItem('wefeasto_placing', '{"k":"nope"}');
		expect(readPlacing(env)).toBeNull();
		expect(env.sessionStore.getItem('wefeasto_placing')).toBeNull();
	});
});

describe('adopt() keeps the bag signature of the order it retries', () => {
	it('no signature given → wefeasto_pending\'s for the SAME order survives the retry', async () => {
		const env = makeEnv();
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: 'health-mix:1' }, env);
		const t = flowOn(env, () => NET);
		t.flow.adopt({ number: 'WF-10001', token: TOKEN }, 'upi');
		await t.flow.retry();
		await flush(10);
		expect(JSON.parse(env.localStore.getItem(PENDING_KEY)).cartSig).toBe('health-mix:1');
		expect(t.flow.cartSig).toBe('health-mix:1');
	});

	it('another order\'s entry lends it nothing', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10009', t: TOKEN, cartSig: 'health-mix:1' }, env);
		const t = flowOn(env, () => NET);
		t.flow.adopt({ number: 'WF-10001', token: TOKEN }, 'upi');
		expect(t.flow.cartSig).toBe('');
	});
});

describe('busyLabel', () => {
	it('after an online payment ("leaving" for /order) it keeps confirming — never "Opening payment…"', () => {
		expect(busyLabel('leaving', 'upi')).toBe('Confirming your payment…');
		expect(busyLabel('verifying', 'card')).toBe('Confirming your payment…');
		expect(busyLabel('paying', 'upi')).toBe('Waiting for payment…');
		expect(busyLabel('submitting', 'upi')).toBe('Opening payment…');
		expect(busyLabel('opening', 'card')).toBe('Opening payment…');
		expect(busyLabel('submitting', 'cod')).toBe('Placing your order…');
		expect(busyLabel('leaving', 'cod')).toBe('Placing your order…');
	});
});

describe('canSwitchToCod: one clock at a time', () => {
	const SERVER_NOW = Date.parse('2026-09-26T10:00:00Z');
	const dto = { number: 'WF-10001', status: 'payment_failed', paymentMethod: 'online', paymentStatus: 'failed', createdAt: new Date(SERVER_NOW - 20_000).toISOString(), items: [{ slug: 'muesli', qty: 1 }] };
	const AHEAD = 2 * 3600_000;

	it('placing device, clock hours ahead: a 20-second-old order is offered (device time since placing)', () => {
		expect(canSwitchToCod(dto, 'muesli:1', SERVER_NOW + AHEAD, SERVER_NOW + AHEAD - 20_000)).toBe(true);
		expect(canSwitchToCod(dto, 'muesli:1', SERVER_NOW + 5.5 * 3600_000, SERVER_NOW + 5.5 * 3600_000 - 20_000)).toBe(true);
	});

	it('placing device, clock behind: an order placed 26 minutes ago is not offered', () => {
		const old = { ...dto, createdAt: new Date(SERVER_NOW - 26 * 60_000).toISOString() };
		expect(canSwitchToCod(old, 'muesli:1', SERVER_NOW - AHEAD, SERVER_NOW - AHEAD - 26 * 60_000)).toBe(false);
	});

	it('not placed here: the server\'s createdAt against this clock, as before', () => {
		expect(canSwitchToCod(dto, 'muesli:1', SERVER_NOW, null)).toBe(true);
		expect(canSwitchToCod(dto, 'muesli:1', SERVER_NOW + COD_SWITCH_WINDOW_MS + 1, null)).toBe(false);
	});

	it('markPlaced keeps the FIRST time (a replay doesn\'t make the order younger); placedAt reads it', () => {
		const env = makeEnv({ t: 1000 });
		markPlaced('WF-10001', env);
		env.t = 99_000;
		markPlaced('WF-10001', env);
		expect(placedAt('WF-10001', env)).toBe(1000);
		expect(placedAt('WF-10002', env)).toBeNull();
	});
});
