/*
 * Hunt round 2 (client-ux) regressions in the checkout flow:
 * - ALREADY_PAID for an order this flow didn't place (/checkout?pay=cod naming the bag's unpaid
 *   order, which the UPI app paid meanwhile) opens that order — never a dead-end note;
 * - detach() (the page went away): a payment window that hasn't opened yet never opens; one
 *   already open stays live.
 */
import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { createCheckoutFlow } from '$lib/checkout/flow.js';
import { buildCheckoutBody, checkForm } from '$lib/checkout/request.js';
import { writePending, readPending, writeLastOrder } from '$lib/checkout/storage.js';
import { makeEnv, fakeApi, fakeRazorpay, manualTimers, flush, ok, err, fakeUuid, PAYMENT, TOKEN, TOKEN2 } from './_helpers.js';

const FORM = { name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };
const VALUE = checkForm(FORM).value;
const ITEMS = [{ slug: 'cornflakes', qty: 1 }];
const body = (patch = {}) => buildCheckoutBody({ value: VALUE, items: ITEMS, method: 'cod', expectedTotalPaise: 22400, ...patch });
const PAID = { number: 'WF-10005', status: 'paid', paymentStatus: 'captured', isConfirmed: true };
const alreadyPaid = (order = PAID) => err('ALREADY_PAID', { order }, 409, 'This order is already paid — no need to pay again.');

function make(env, routes, { script = 'dismiss', loadScript } = {}) {
	const api = fakeApi(routes);
	const navigations = [];
	const R = fakeRazorpay(script);
	const flow = createCheckoutFlow({
		api, env, newKey: fakeUuid, timers: manualTimers(), navigate: (u) => navigations.push(u),
		loadScript: loadScript || (async () => R), watchRender: () => ({ rendered: () => true, stop() {} })
	});
	return { flow, api, navigations, R };
}

describe('ALREADY_PAID for an order this flow never placed', () => {
	it('/checkout?pay=cod naming the paid order → /order of that order, with the token the checkout sent', async () => {
		const env = makeEnv();
		const t = make(env, { '/store/checkout': () => alreadyPaid() });
		const r = await t.flow.submit(body({ supersede: { number: 'WF-10005', token: TOKEN } }));
		expect(t.navigations).toEqual([`/order?no=WF-10005&t=${TOKEN}`]);
		expect(get(t.flow.state).phase).toBe('leaving');
		expect(r.error.code).toBe('ALREADY_PAID');
		expect(r.order).toEqual({ number: 'WF-10005', token: TOKEN });
	});

	it('no supersede ref sent (another tab, same bag): the token wefeasto_pending holds for that number', async () => {
		const env = makeEnv();
		writePending({ no: 'WF-10005', t: TOKEN2, cartSig: 'cornflakes:1' }, env);
		const t = make(env, { '/store/checkout': () => alreadyPaid() });
		await t.flow.submit(body({ method: 'upi' }));
		expect(t.navigations).toEqual([`/order?no=WF-10005&t=${TOKEN2}`]);
	});

	it('a ref naming ANOTHER order lends it nothing; the last-order ref for the number does', async () => {
		const env = makeEnv();
		writeLastOrder({ no: 'WF-10005', t: TOKEN2, items: ITEMS }, env);
		const t = make(env, { '/store/checkout': () => alreadyPaid() });
		await t.flow.submit(body({ supersede: { number: 'WF-10004', token: TOKEN } }));
		expect(t.navigations).toEqual([`/order?no=WF-10005&t=${TOKEN2}`]);
	});

	it('no token known for it (or no order in the answer): the plain note, no navigation', async () => {
		const env = makeEnv();
		const t = make(env, { '/store/checkout': [alreadyPaid(), alreadyPaid(null)] });
		await t.flow.submit(body());
		expect(t.navigations).toEqual([]);
		expect(get(t.flow.state)).toMatchObject({ phase: 'error', error: { code: 'ALREADY_PAID', actions: ['goto-order'] } });
		t.flow.reset();
		await t.flow.submit(body({ supersede: { number: 'WF-10005', token: TOKEN } }));
		expect(t.navigations).toEqual([]);
		expect(get(t.flow.state).phase).toBe('error');
	});

	it('the flow\'s own order still wins (retry refused ALREADY_PAID → that order)', async () => {
		const env = makeEnv();
		const own = { number: 'WF-10001', token: TOKEN, status: 'pending_payment', totalPaise: 47400 };
		const t = make(env, { '/store/checkout': () => ok({ order: own, payment: PAYMENT }, 201), '/store/checkout/retry': () => alreadyPaid({ ...PAID, number: 'WF-10001' }) });
		await t.flow.submit(body({ method: 'upi' }));
		await flush();
		expect(get(t.flow.state).phase).toBe('failed'); // dismissed
		await t.flow.retry();
		expect(t.navigations.at(-1)).toBe(`/order?no=WF-10001&t=${TOKEN}`);
	});
});

describe('detach(): the page driving the flow went away', () => {
	const ORDER = { number: 'WF-10021', token: TOKEN, status: 'pending_payment', totalPaise: 17400 };

	it('while checkout.js is still loading: the window never opens; wefeasto_pending keeps the order', async () => {
		const env = makeEnv();
		let arrive;
		const R = fakeRazorpay('silent');
		const t = make(env, { '/store/checkout': () => ok({ order: ORDER, payment: PAYMENT }, 201) }, { loadScript: () => new Promise((r) => (arrive = () => r(R))) });
		const done = t.flow.submit(body({ method: 'upi' }));
		await flush();
		expect(get(t.flow.state).phase).toBe('opening');
		t.flow.detach();
		arrive();
		expect(await done).toEqual({ stale: true });
		expect(R.instances).toHaveLength(0);
		expect(readPending(env)).toMatchObject({ no: 'WF-10021', t: TOKEN });
	});

	it('while the order is still being placed: it is kept for the banner, and no window opens', async () => {
		const env = makeEnv();
		let answer;
		const t = make(env, { '/store/checkout': () => new Promise((r) => (answer = () => r(ok({ order: ORDER, payment: PAYMENT }, 201)))) }, { script: 'silent' });
		const done = t.flow.submit(body({ method: 'upi' }));
		await flush();
		t.flow.detach();
		answer();
		expect(await done).toEqual({ stale: true });
		expect(t.R.instances).toHaveLength(0);
		expect(readPending(env)).toMatchObject({ no: 'WF-10021' });
		expect(get(t.flow.state).phase).toBe('idle');
	});

	it('a window already open stays live: paying in it still goes to /order', async () => {
		const env = makeEnv();
		const t = make(env, { '/store/checkout': () => ok({ order: ORDER, payment: PAYMENT }, 201), '/store/checkout/verify': () => ok({ order: { status: 'paid' } }) }, { script: 'silent' });
		await t.flow.submit(body({ method: 'upi' }));
		expect(get(t.flow.state).phase).toBe('paying');
		t.flow.detach();
		await t.R.instances[0].succeed();
		await flush();
		expect(t.navigations).toEqual([`/order?no=WF-10021&t=${TOKEN}`]);
	});

	it('after a dismiss: the quiet look finding it paid no longer navigates from a page that is gone', async () => {
		const env = makeEnv();
		let look;
		const t = make(env, {
			'/store/checkout': () => ok({ order: ORDER, payment: PAYMENT }, 201),
			'/store/orders/status': () => new Promise((r) => (look = () => r(ok({ order: { number: 'WF-10021', status: 'paid', isConfirmed: true } }))))
		});
		await t.flow.submit(body({ method: 'upi' }));
		await flush();
		expect(get(t.flow.state).phase).toBe('failed');
		t.flow.detach();
		look();
		await flush();
		expect(t.navigations).toEqual([]);
	});

	it('a COD order the tap placed still shows (/order) — it is the order they asked for', async () => {
		const env = makeEnv();
		let answer;
		const t = make(env, { '/store/checkout': () => new Promise((r) => (answer = () => r(ok({ order: { ...ORDER, status: 'cod_pending' }, payment: null }, 201)))) });
		const done = t.flow.submit(body());
		await flush();
		t.flow.detach();
		answer();
		await done;
		expect(t.navigations).toEqual([`/order?no=WF-10021&t=${TOKEN}`]);
	});
});

describe('503 PAYMENTS_UNAVAILABLE: the kept order is this bag\'s unpaid online order (SUP-OWN-1 needs its ref)', () => {
	const KEPT = { number: 'WF-10157', token: TOKEN, status: 'pending_payment', totalPaise: 17400 };
	const down = () => err('PAYMENTS_UNAVAILABLE', { order: KEPT }, 503);
	const upi = (patch = {}) => body({ method: 'upi', ...patch });

	it('wefeasto_pending names it (so "Pay on delivery instead" can send the ref), and the flow holds it', async () => {
		const env = makeEnv();
		const t = make(env, { '/store/checkout': () => down() });
		const r = await t.flow.submit(upi());
		expect(r.error.code).toBe('PAYMENTS_UNAVAILABLE');
		expect(get(t.flow.state)).toMatchObject({ phase: 'error', order: { number: 'WF-10157', token: TOKEN } });
		expect(readPending(env)).toMatchObject({ no: 'WF-10157', t: TOKEN, cartSig: 'cornflakes:1' });
		expect(t.flow.cartSig).toBe('cornflakes:1');
		expect(t.navigations).toEqual([]);
	});

	it('Pay on delivery instead naming it → accepted → its pending entry goes; Pay again replays the same key', async () => {
		const env = makeEnv();
		const t = make(env, {
			'/store/checkout': [down(), ok({ order: { ...KEPT, number: 'WF-10158', status: 'cod_pending' }, payment: null }, 201)]
		});
		await t.flow.submit(upi());
		t.flow.reset();
		await t.flow.submit(body({ supersede: { number: 'WF-10157', token: TOKEN } }));
		expect(readPending(env)).toBeNull();
		expect(t.navigations).toEqual([`/order?no=WF-10158&t=${TOKEN}`]);

		const again = make(makeEnv(), { '/store/checkout': [down(), ok({ order: KEPT, payment: PAYMENT }, 200)] });
		await again.flow.submit(upi());
		await again.flow.submit(upi({ supersede: { number: 'WF-10157', token: TOKEN } })); // the ref isn't hashed server-side
		const keys = again.api.calls.filter((c) => c.key === '/store/checkout').map((c) => c.opts.headers['Idempotency-Key']);
		expect(keys[1]).toBe(keys[0]);
	});

	it('an answer without a usable order (or a COD tap) records nothing', async () => {
		const env = makeEnv();
		const t = make(env, { '/store/checkout': [err('PAYMENTS_UNAVAILABLE', null, 503), err('PAYMENTS_UNAVAILABLE', { order: KEPT }, 503)] });
		await t.flow.submit(upi());
		expect(readPending(env)).toBeNull();
		t.flow.reset();
		await t.flow.submit(body());
		expect(readPending(env)).toBeNull();
		expect(get(t.flow.state).order).toBeNull();
	});
});
