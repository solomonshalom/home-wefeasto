/*
 * Hunt round 3 (client-ux) regressions in the checkout flow:
 * - a lost ONLINE answer: the unheard tap's order is found (recall, or the next tap's MISMATCH →
 *   replay) and the next checkout names it (`supersede`), so its offer / last packs are this one's own;
 * - a lost COD answer then corrected details (or a top-up): the order that tap placed is kept, and
 *   wefeasto_kept records what it holds and what changed, for /order to say so.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createCheckoutFlow, mustResolve, orderOf } from '$lib/checkout/flow.js';
import { buildCheckoutBody, checkForm, attemptOf } from '$lib/checkout/request.js';
import { PENDING_KEY, readPlacing, readKept, readPending, _resetSeenMemory } from '$lib/checkout/storage.js';
import { makeEnv, fakeApi, fakeRazorpay, manualTimers, flush, ok, err, fakeUuid, PAYMENT, TOKEN, TOKEN2 } from './_helpers.js';

const FORM = { name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Raod, Ashok Nagr', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };
const VALUE = checkForm(FORM).value;
const ITEMS = [{ slug: 'health-mix', qty: 1 }];
const body = (patch = {}) => buildCheckoutBody({ value: VALUE, items: ITEMS, method: 'upi', couponCode: 'WELCOME10', expectedTotalPaise: 45400, ...patch });
const fixed = (patch = {}) => body({ value: { ...VALUE, line1: 'Flat 4B, 12 MG Road, Ashok Nagar' }, ...patch });

const FIRST = { number: 'WF-10004', token: TOKEN, status: 'pending_payment', totalPaise: 45400 };
const SECOND = { number: 'WF-10005', token: TOKEN2, status: 'pending_payment', totalPaise: 45400 };
const NET = { ok: false, status: 0, data: null, error: { code: 'NETWORK', message: 'x' } };
const MISMATCH = err('IDEMPOTENCY_MISMATCH', null, 409);

/** A flow over `env` whose /store/checkout answers `checkout(opts, n)`. */
function flowOn(env, checkout) {
	const api = fakeApi({ '/store/checkout': checkout });
	const navigations = [];
	const flow = createCheckoutFlow({
		api, env, newKey: fakeUuid, timers: manualTimers(), navigate: (u) => navigations.push(u),
		loadScript: async () => fakeRazorpay('dismiss'), watchRender: () => ({ rendered: () => true, stop() {} })
	});
	const posts = () => api.calls.filter((c) => c.key === '/store/checkout');
	return { flow, api, navigations, posts, keys: () => posts().map((c) => c.opts.headers['Idempotency-Key']), bodies: () => posts().map((c) => c.opts.body) };
}

/** An online tap whose answer was lost (the server placed FIRST). */
async function lostOnline(env, b = body()) {
	const t = flowOn(env, () => NET);
	await t.flow.submit(b);
	return t.keys()[0];
}

beforeEach(() => _resetSeenMemory());

describe('mustResolve / orderOf', () => {
	const p = (method, items) => ({ sig: attemptOf(body({ items })).cartSig, body: body({ method, items }) });
	const a = (items) => attemptOf(body({ items }));
	it('the same bag always; a COD tap also for a bag sharing a product (a top-up); an online tap only for its own bag', () => {
		const top = [...ITEMS, { slug: 'muesli', qty: 1 }];
		const other = [{ slug: 'muesli', qty: 1 }];
		expect(mustResolve(p('upi', ITEMS), a(ITEMS), body())).toBe(true);
		expect(mustResolve(p('upi', ITEMS), a(top), body({ items: top }))).toBe(false);
		expect(mustResolve(p('cod', ITEMS), a(top), body({ items: top }))).toBe(true);
		expect(mustResolve(p('cod', ITEMS), a(other), body({ items: other }))).toBe(false);
		expect(mustResolve(null, a(ITEMS), body())).toBe(false);
	});
	it('orderOf: the order of a 2xx, or the one PAYMENTS_UNAVAILABLE kept; nothing else', () => {
		expect(orderOf(ok({ order: FIRST }))).toBe(FIRST);
		expect(orderOf(err('PAYMENTS_UNAVAILABLE', { order: FIRST }, 503))).toBe(FIRST);
		expect(orderOf(NET)).toBeNull();
		expect(orderOf(ok({ order: { number: 'WF-1' } }))).toBeNull();
	});
});

describe('lost online answer → recall(): the unheard tap’s order becomes this bag’s pending order', () => {
	it('replays that tap under its key; the order is named from then on and the tap is closed', async () => {
		const env = makeEnv();
		const k = await lostOnline(env);
		const t = flowOn(env, () => ok({ order: FIRST, payment: PAYMENT }, 200));
		const o = await t.flow.recall('health-mix:1');
		expect(o).toMatchObject({ number: 'WF-10004', token: TOKEN });
		expect(t.keys()).toEqual([k]);
		expect(t.bodies()[0]).toEqual(body());
		expect(readPending(env)).toMatchObject({ no: 'WF-10004', t: TOKEN, cartSig: 'health-mix:1' });
		expect(readPlacing(env)).toBeNull();
		expect(get(t.flow.state).phase).toBe('idle'); // nothing opens
	});

	it('another bag, a COD tap, or no tap: nothing is asked', async () => {
		const env = makeEnv();
		await lostOnline(env);
		const t = flowOn(env, () => ok({ order: FIRST, payment: PAYMENT }));
		expect(await t.flow.recall('muesli:1')).toBeNull();
		const envC = makeEnv();
		await flowOn(envC, () => NET).flow.submit(body({ method: 'cod' }));
		const c = flowOn(envC, () => ok({ order: FIRST, payment: null }));
		expect(await c.flow.recall('health-mix:1')).toBeNull();
		expect(await flowOn(makeEnv(), () => NET).flow.recall('health-mix:1')).toBeNull();
		expect(t.posts().length + c.posts().length).toBe(0);
	});

	it('still unheard → the tap stays open; refused outright (a 4xx) → it made no order: closed', async () => {
		const env = makeEnv();
		await lostOnline(env);
		expect(await flowOn(env, () => NET).flow.recall('health-mix:1')).toBeNull();
		expect(readPlacing(env)).not.toBeNull();
		expect(await flowOn(env, () => err('RATE_LIMITED', null, 429)).flow.recall('health-mix:1')).toBeNull();
		expect(readPlacing(env)).not.toBeNull();
		expect(await flowOn(env, () => err('COUPON_INVALID', { reason: 'EXPIRED' }, 422)).flow.recall('health-mix:1')).toBeNull();
		expect(readPlacing(env)).toBeNull();
	});

	it('Pay tapped while the recall is in flight waits for it and names the order it found', async () => {
		const env = makeEnv();
		await lostOnline(env);
		let release;
		const gate = new Promise((r) => (release = r));
		const t = flowOn(env, async (opts, n) => (n === 1 ? (await gate, ok({ order: FIRST, payment: PAYMENT })) : ok({ order: SECOND, payment: PAYMENT }, 201)));
		const r = t.flow.recall('health-mix:1');
		const s = t.flow.submit(fixed()); // the page built it before the recall answered: no ref yet
		await flush();
		expect(t.posts()).toHaveLength(1);
		release();
		await r;
		await s;
		expect(t.bodies()[1].supersede).toEqual({ number: 'WF-10004', token: TOKEN });
		expect(t.keys()[1]).not.toBe(t.keys()[0]);
	});
});

describe('lost online answer → changed details → Pay: the unseen order is replaced, never refused over', () => {
	it('MISMATCH under that tap’s key → its own request names it → the new details go under a new key, naming it', async () => {
		const env = makeEnv();
		const k = await lostOnline(env);
		const t = flowOn(env, (opts, n) => (n === 1 ? MISMATCH : n === 2 ? ok({ order: FIRST, payment: PAYMENT }, 200) : ok({ order: SECOND, payment: PAYMENT }, 201)));
		await t.flow.submit(fixed());
		await flush(10);
		expect(t.keys().slice(0, 2)).toEqual([k, k]);
		expect(t.bodies()[0]).toEqual(fixed());
		expect(t.bodies()[1]).toEqual(body()); // that tap's exact request
		expect(t.keys()[2]).not.toBe(k);
		expect(t.bodies()[2]).toEqual({ ...fixed(), supersede: { number: 'WF-10004', token: TOKEN } });
		expect(t.flow.order.number).toBe('WF-10005');
		expect(readPending(env)).toMatchObject({ no: 'WF-10005' }); // the replaced one's entry went; the new one's is written
		expect(readPlacing(env)).toBeNull();
	});

	it('that tap never arrived → the changed details are placed under its key (one order, no replay)', async () => {
		const env = makeEnv();
		const k = await lostOnline(env);
		const t = flowOn(env, () => ok({ order: SECOND, payment: PAYMENT }, 201));
		await t.flow.submit(fixed());
		expect(t.keys()).toEqual([k]);
		expect(t.bodies()[0].supersede).toBeUndefined();
	});

	it('the replay itself unheard → the network note; the tap stays open for the next one', async () => {
		const env = makeEnv();
		await lostOnline(env);
		const t = flowOn(env, (opts, n) => (n === 1 ? MISMATCH : NET));
		const r = await t.flow.submit(fixed());
		expect(r.error.code).toBe('NETWORK');
		expect(readPlacing(env)).toMatchObject({ body: body() });
	});

	it('an order money already reached is kept, not replaced (no second order)', async () => {
		const env = makeEnv();
		await lostOnline(env);
		const t = flowOn(env, (opts, n) => (n === 1 ? MISMATCH : ok({ order: { ...FIRST, status: 'paid' }, payment: null }, 200)));
		await t.flow.submit(fixed());
		expect(t.posts()).toHaveLength(2);
		expect(t.navigations).toEqual([`/order?no=WF-10004&t=${TOKEN}`]);
		expect(readKept('WF-10004', env)).toMatchObject({ line1: VALUE.line1, changed: ['address'] });
	});
});

describe('lost COD answer → corrected details / a top-up → Place order: the order it placed is kept, and said so', () => {
	const cod = (patch = {}) => body({ method: 'cod', ...patch });
	const COD1 = { ...FIRST, status: 'cod_pending' };

	it('corrected address → that order (no second), and wefeasto_kept says where it ships and what changed', async () => {
		const env = makeEnv();
		await flowOn(env, () => NET).flow.submit(cod());
		const t = flowOn(env, (opts, n) => (n === 1 ? MISMATCH : ok({ order: COD1, payment: null }, 200)));
		await t.flow.submit(fixed({ method: 'cod' }));
		expect(t.bodies()[1]).toEqual(cod());
		expect(t.navigations).toEqual([`/order?no=WF-10004&t=${TOKEN}`]);
		expect(readKept('WF-10004', env)).toMatchObject({ line1: 'Flat 4B, 12 MG Raod, Ashok Nagr', city: 'Bengaluru', pin: '560001', phone: '+919845262777', method: 'cod', changed: ['address'] });
		expect(readKept('WF-10005', env)).toBeNull();
	});

	it('switched to UPI after it → still that COD order (no payment window), noted as a method change', async () => {
		const env = makeEnv();
		await flowOn(env, () => NET).flow.submit(cod());
		const t = flowOn(env, (opts, n) => (n === 1 ? MISMATCH : ok({ order: COD1, payment: null }, 200)));
		await t.flow.submit(body());
		expect(get(t.flow.state).method).toBe('cod');
		expect(readKept('WF-10004', env).changed).toEqual(['method']);
	});

	it('a top-up since (the bag shares its product) → resolved against it: that order, not a 2nd shipment', async () => {
		const env = makeEnv();
		await flowOn(env, () => NET).flow.submit(cod());
		const top = [...ITEMS, { slug: 'muesli', qty: 1 }];
		const t = flowOn(env, (opts, n) => (n === 1 ? MISMATCH : ok({ order: COD1, payment: null }, 200)));
		await t.flow.submit(cod({ items: top }));
		expect(t.keys()[0]).toBe(t.keys()[1]);
		expect(t.navigations).toEqual([`/order?no=WF-10004&t=${TOKEN}`]);
		expect(t.flow.cartSig).toBe('health-mix:1'); // the bag that order holds
		expect(readKept('WF-10004', env).changed).toEqual(['items']);
	});

	it('the same details → a plain replay: nothing kept, nothing to say', async () => {
		const env = makeEnv();
		await flowOn(env, () => NET).flow.submit(cod());
		const t = flowOn(env, () => ok({ order: COD1, payment: null }, 200));
		await t.flow.submit(cod());
		expect(t.posts()).toHaveLength(1);
		expect(readKept('WF-10004', env)).toBeNull();
		expect(env.localStore.getItem(PENDING_KEY)).toBeNull();
	});
});

describe('attempt: what the flow’s order was placed with', () => {
	it('null with no order; the placed attempt after one (Try again compares the form with it)', async () => {
		const t = flowOn(makeEnv(), () => ok({ order: FIRST, payment: PAYMENT }, 201));
		expect(t.flow.attempt).toBeNull();
		await t.flow.submit(body());
		await flush(10);
		expect(t.flow.attempt).toEqual(attemptOf(body()));
		expect(t.flow.attempt.formHash).not.toBe(attemptOf(fixed()).formHash);
	});
});
