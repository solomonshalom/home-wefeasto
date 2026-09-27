/*
 * /order logic: arrival parsing (incl. redirect-mode failures), status →
 * view, the polling schedules (2 s × 30 s, then 5 s to 2 min; a failed
 * payment that can still settle: 8 s × 2 min; paused while hidden) and the
 * watcher that switches between them (W2V-4: a late authorisation after
 * "failed" turns the page confirmed), the failed-state copy, when "Pay on
 * delivery instead" is safe, and the once-per-order side effects on
 * entering "confirmed".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	parseArrival,
	viewFor,
	nextView,
	nextPollDelay,
	nextFailedPollDelay,
	pollModeFor,
	mayStillSettle,
	failedCopy,
	canSwitchToCod,
	COD_SWITCH_WINDOW_MS,
	createPoller,
	createOrderWatcher,
	enterConfirmed,
	fetchStatus,
	orderUrl,
	isOrderDTO
} from '$lib/checkout/order.js';
import { NO_MONEY_TAKEN, MONEY_UNSURE } from '$lib/checkout/errors.js';
import { cartSignature } from '$shared/cart-links.js';
import { ORDER_STATUSES, isConfirmed } from '$shared/order-status.js';
import { writePending, markPlaced, PENDING_KEY, PLACED_PREFIX, LAST_ORDER_KEY, SEEN_PREFIX, _resetSeenMemory } from '$lib/checkout/storage.js';
import { makeEnv, blockedEnv, manualTimers, flush, fakeApi, ok, err, TOKEN } from './_helpers.js';

beforeEach(() => _resetSeenMemory());

const DTO = {
	number: 'WF-10001',
	status: 'paid',
	paymentStatus: 'captured',
	paymentMethod: 'online',
	requestedMethod: 'upi',
	fulfilmentStatus: 'unfulfilled',
	createdAt: '2026-09-26T00:00:00.000Z',
	paidAt: '2026-09-26T00:01:00.000Z',
	items: [
		{ slug: 'muesli', name: 'Muesli', qty: 1, unitPaise: 25000, lineTotalPaise: 25000, image: '/images/x.png' },
		{ slug: 'cornflakes', name: 'Cornflakes', qty: 2, unitPaise: 17500, lineTotalPaise: 35000, image: '/images/y.png' }
	],
	subtotalPaise: 60000,
	discountPaise: 0,
	deliveryPaise: 0,
	codFeePaise: 0,
	totalPaise: 60000,
	coupon: null,
	contact: { firstName: 'Asha', emailMasked: 'a•••@example.com', phoneMasked: '+91 ••••• ••777' },
	address: { city: 'Bengaluru', state: 'Karnataka' },
	canRetryPayment: false,
	isConfirmed: true,
	shippingPromiseText: 'Ships in 1–2 days · delivered in 3–7 days'
};

describe('parseArrival', () => {
	it('reads no, t and a redirect-mode failure', () => {
		expect(parseArrival(`?no=WF-10001&t=${TOKEN}`)).toEqual({ no: 'WF-10001', t: TOKEN, failed: false, reason: null });
		expect(parseArrival(`?no=WF-10001&t=${TOKEN}&payment=failed&reason=payment_cancelled`)).toEqual({ no: 'WF-10001', t: TOKEN, failed: true, reason: 'payment_cancelled' });
		expect(parseArrival(`?no=WF-10001&payment=failed&reason=CARD_DECLINED`).reason).toBe('card_declined');
	});

	it.each([
		['?no=10001&t=x', { no: null, t: null }],
		['?no=WF-1&t=' + TOKEN, { no: null, t: TOKEN }],
		['?no=%20WF-10001%20', { no: 'WF-10001', t: null }],
		['?t=<script>', { no: null, t: null }],
		['', { no: null, t: null }],
		['?reason=<b>x</b>&payment=failed', { reason: null, failed: true }],
		[undefined, { no: null }]
	])('%s', (search, expected) => {
		expect(parseArrival(search)).toMatchObject(expected);
	});

	it('orderUrl round-trips', () => {
		const url = orderUrl('WF-10001', TOKEN);
		expect(url).toBe(`/order?no=WF-10001&t=${TOKEN}`);
		expect(parseArrival(url.slice(url.indexOf('?')))).toMatchObject({ no: 'WF-10001', t: TOKEN });
	});
});

describe('viewFor', () => {
	it('"confirmed" only when $shared isConfirmed says so', () => {
		for (const status of ORDER_STATUSES) {
			expect(viewFor({ status }) === 'confirmed').toBe(isConfirmed(status));
		}
	});

	it.each([
		['pending_payment', 'confirming'],
		['payment_failed', 'failed'],
		['expired', 'failed'],
		['cancelled', 'cancelled'],
		['refunded', 'refunded'],
		['needs_review', 'review'],
		['paid', 'confirmed'],
		['cod_pending', 'confirmed'],
		['cod_confirmed', 'confirmed'],
		['partially_refunded', 'confirmed'],
		['something_new', 'review']
	])('%s → %s', (status, view) => {
		expect(viewFor({ status })).toBe(view);
	});

	it('ignores a lying isConfirmed flag', () => {
		expect(viewFor({ status: 'pending_payment', isConfirmed: true })).toBe('confirming');
	});
});

describe('fetchStatus', () => {
	it('accepts the DTO bare or wrapped in {order}', async () => {
		for (const data of [DTO, { order: DTO }]) {
			const api = fakeApi({ '/store/orders/status': () => ok(data) });
			const r = await fetchStatus(api, 'WF-10001', TOKEN);
			expect(r).toEqual({ ok: true, dto: DTO });
			expect(api.calls[0].path).toBe(`/store/orders/status?no=WF-10001&t=${TOKEN}`);
		}
	});

	it('404 → NOT_FOUND; junk 200 → BAD_RESPONSE', async () => {
		expect(await fetchStatus(fakeApi({ '/store/orders/status': () => err('NOT_FOUND', null, 404) }), 'WF-10001', TOKEN)).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 });
		expect(await fetchStatus(fakeApi({ '/store/orders/status': () => ok({ hello: 1 }) }), 'WF-10001', TOKEN)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
		expect(isOrderDTO({ number: 'WF-10001', status: 'paid' })).toBe(true);
		expect(isOrderDTO({ number: 'x', status: 'paid' })).toBe(false);
	});
});

describe('polling schedule', () => {
	it('2 s for the first 30 s, then 5 s up to 2 min, then stop', () => {
		expect(nextPollDelay(0)).toBe(2000);
		expect(nextPollDelay(29999)).toBe(2000);
		expect(nextPollDelay(30000)).toBe(5000);
		expect(nextPollDelay(119999)).toBe(5000);
		expect(nextPollDelay(120000)).toBeNull();
	});

	it('runs 15 fast + 18 slow polls, then ondone', async () => {
		const timers = manualTimers();
		const at = [];
		let done = false;
		createPoller({ tick: async () => at.push(timers.now), ondone: () => (done = true), timers, doc: null });
		await timers.advance(200000);
		expect(at.length).toBe(33);
		expect(at.slice(0, 3)).toEqual([2000, 4000, 6000]);
		expect(at[14]).toBe(30000);
		expect(at[15]).toBe(35000);
		expect(at[32]).toBe(120000);
		expect(done).toBe(true);
	});

	it("tick → 'stop' ends it (no ondone)", async () => {
		const timers = manualTimers();
		let n = 0;
		let done = false;
		const p = createPoller({ tick: async () => (++n === 3 ? 'stop' : null), ondone: () => (done = true), timers, doc: null });
		await timers.advance(60000);
		expect(n).toBe(3);
		expect(p.stopped).toBe(true);
		expect(done).toBe(false);
	});

	it('a throwing tick keeps polling', async () => {
		const timers = manualTimers();
		let n = 0;
		createPoller({ tick: async () => { n++; throw new Error('x'); }, timers, doc: null });
		await timers.advance(6000);
		expect(n).toBe(3);
	});

	it('pauses while the tab is hidden (hidden time does not count) and looks at once on return', async () => {
		const timers = manualTimers();
		const doc = new EventTarget();
		doc.hidden = false;
		const at = [];
		const p = createPoller({ tick: async () => at.push(timers.now), timers, doc });
		await timers.advance(4000); // 2 polls
		doc.hidden = true;
		doc.dispatchEvent(new Event('visibilitychange'));
		await timers.advance(600000); // ten minutes in the background
		expect(at.length).toBe(2);
		doc.hidden = false;
		doc.dispatchEvent(new Event('visibilitychange'));
		await timers.advance(0);
		expect(at.length).toBe(3);
		expect(at[2]).toBe(604000);
		expect(p.elapsed).toBeLessThan(10000);
		p.stop();
		await timers.advance(10000);
		expect(at.length).toBe(3);
	});

	it('starting hidden waits for the tab to come back', async () => {
		const timers = manualTimers();
		const doc = new EventTarget();
		doc.hidden = true;
		let n = 0;
		createPoller({ tick: async () => n++, timers, doc });
		await timers.advance(10000);
		expect(n).toBe(0);
		doc.hidden = false;
		doc.dispatchEvent(new Event('visibilitychange'));
		await timers.advance(0);
		expect(n).toBe(1);
	});
});

describe('enterConfirmed (side effects exactly once per order)', () => {
	function fakeCart(init) {
		const bag = { ...init };
		return {
			bag,
			calls: 0,
			subtractLines(lines) {
				this.calls++;
				for (const [slug, q] of Object.entries(lines)) {
					if (!(slug in bag)) continue;
					bag[slug] -= q;
					if (bag[slug] <= 0) delete bag[slug];
				}
			}
		};
	}

	it('first time: seen, last order, pending dropped, bag subtracted (not wiped), purchase tracked', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: 'x' }, env);
		const cart = fakeCart({ muesli: 1, cornflakes: 3, 'health-mix': 1 });
		const events = [];
		const r = enterConfirmed(DTO, TOKEN, { cart, track: (n, p) => events.push([n, p]), env });
		expect(r.first).toBe(true);
		expect(env.localStore.getItem(SEEN_PREFIX + 'WF-10001')).toBe('1');
		expect(JSON.parse(env.localStore.getItem(LAST_ORDER_KEY))).toEqual({ no: 'WF-10001', t: TOKEN, items: { muesli: 1, cornflakes: 2 }, at: env.t });
		expect(env.localStore.getItem(PENDING_KEY)).toBeNull();
		expect(cart.bag).toEqual({ cornflakes: 1, 'health-mix': 1 }); // added-since items survive
		expect(events).toEqual([['purchase', { number: 'WF-10001', value: 600, currency: 'INR', method: 'online' }]]);
	});

	it('refresh / second visit: nothing repeats', () => {
		const env = makeEnv();
		markPlaced('WF-10001', env);
		const cart = fakeCart({ muesli: 5 });
		const events = [];
		enterConfirmed(DTO, TOKEN, { cart, track: (n) => events.push(n), env });
		_resetSeenMemory(); // a reload: only storage remembers
		const r = enterConfirmed(DTO, TOKEN, { cart, track: (n) => events.push(n), env });
		expect(r.first).toBe(false);
		expect(cart.calls).toBe(1);
		expect(cart.bag).toEqual({ muesli: 4 });
		expect(events).toEqual(['purchase']);
	});

	it('storage throwing: once per page session, and a throwing cart never breaks the page', () => {
		const env = blockedEnv();
		markPlaced('WF-10001', env); // the session copy: /order reached by goto() from this checkout
		const cart = { calls: 0, subtractLines() { this.calls++; throw new Error('boom'); } };
		expect(enterConfirmed(DTO, TOKEN, { cart, track: () => {}, env }).first).toBe(true);
		expect(enterConfirmed(DTO, TOKEN, { cart, track: () => {}, env }).first).toBe(false);
		expect(cart.calls).toBe(1);
	});

	it('COD orders track method cod', () => {
		const events = [];
		const env = makeEnv();
		markPlaced('WF-10002', env);
		enterConfirmed({ ...DTO, number: 'WF-10002', status: 'cod_pending', paymentMethod: 'cod' }, TOKEN, { cart: fakeCart({}), track: (n, p) => events.push(p), env });
		expect(events[0].method).toBe('cod');
	});
});

describe('enterConfirmed on a device that did not place the order (PI-ORD-3)', () => {
	function fakeCart(init) {
		const bag = { ...init };
		return {
			bag,
			calls: 0,
			subtractLines(lines) {
				this.calls++;
				for (const [slug, q] of Object.entries(lines)) {
					if (!(slug in bag)) continue;
					bag[slug] -= q;
					if (bag[slug] <= 0) delete bag[slug];
				}
			}
		};
	}
	const COD = { ...DTO, number: 'WF-10002', status: 'cod_pending', paymentMethod: 'cod', items: [{ slug: 'muesli', name: 'Muesli', qty: 2, unitPricePaise: 30000, lineTotalPaise: 60000 }] };

	it('the emailed link opened elsewhere: seen + "Your usual" only; the bag, its own pending order and analytics untouched', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10009', t: TOKEN, cartSig: 'cornflakes:1' }, env); // this device's own unpaid order
		const cart = fakeCart({ muesli: 3, cornflakes: 1 });
		const events = [];
		const r = enterConfirmed(COD, TOKEN, { cart, track: (n, p) => events.push([n, p]), env });
		expect(r).toEqual({ first: true, here: false });
		expect(env.localStore.getItem(SEEN_PREFIX + 'WF-10002')).toBe('1');
		expect(JSON.parse(env.localStore.getItem(LAST_ORDER_KEY))).toMatchObject({ no: 'WF-10002', items: { muesli: 2 } });
		expect(cart.calls).toBe(0);
		expect(cart.bag).toEqual({ muesli: 3, cornflakes: 1 });
		expect(events).toEqual([]);
		expect(JSON.parse(env.localStore.getItem(PENDING_KEY))).toMatchObject({ no: 'WF-10009' });
		// A second visit there changes nothing either.
		_resetSeenMemory();
		expect(enterConfirmed(COD, TOKEN, { cart, track: (n, p) => events.push([n, p]), env }).first).toBe(false);
		expect(cart.calls).toBe(0);
	});

	it('placed here (the checkout marked it): subtracted + tracked once; the marker is consumed; another order’s pending entry survives', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10009', t: TOKEN, cartSig: 'cornflakes:1' }, env);
		markPlaced('WF-10002', env);
		expect(env.localStore.getItem(PLACED_PREFIX + 'WF-10002')).toBe(String(env.t));
		const cart = fakeCart({ muesli: 3, cornflakes: 1 });
		const events = [];
		expect(enterConfirmed(COD, TOKEN, { cart, track: (n) => events.push(n), env })).toEqual({ first: true, here: true });
		expect(cart.bag).toEqual({ muesli: 1, cornflakes: 1 });
		expect(events).toEqual(['purchase']);
		expect(env.localStore.getItem(PLACED_PREFIX + 'WF-10002')).toBeNull();
		expect(JSON.parse(env.localStore.getItem(PENDING_KEY))).toMatchObject({ no: 'WF-10009' });
	});

	it('its wefeasto_pending names it (tab closed mid-payment, the banner’s Check status, a redirect return): here, pending dropped', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10001', t: TOKEN, cartSig: 'cornflakes:2,muesli:1' }, env);
		const cart = fakeCart({ muesli: 1, cornflakes: 2 });
		expect(enterConfirmed(DTO, TOKEN, { cart, track: () => {}, env })).toEqual({ first: true, here: true });
		expect(cart.bag).toEqual({});
		expect(env.localStore.getItem(PENDING_KEY)).toBeNull();
	});

	it('storage blocked and nothing marked in this page session: not here', () => {
		const cart = fakeCart({ muesli: 3 });
		const events = [];
		expect(enterConfirmed(COD, TOKEN, { cart, track: (n) => events.push(n), env: blockedEnv() })).toEqual({ first: true, here: false });
		expect(cart.calls).toBe(0);
		expect(events).toEqual([]);
	});
});

/* ---------------- failed payments that can still settle (W2V-4) ---------------- */

const dtoWith = (status, extra = {}) => ({
	...DTO,
	status,
	paymentStatus: status === 'paid' ? 'captured' : status === 'payment_failed' ? 'failed' : 'created',
	isConfirmed: isConfirmed(status),
	canRetryPayment: !isConfirmed(status),
	...extra
});

describe('nextView (what a new answer does to the view on screen)', () => {
	it('a still-pending answer never flips "failed" or "Still confirming" back to "Confirming…"', () => {
		expect(nextView('failed', dtoWith('pending_payment'))).toBe('failed');
		expect(nextView('slow', dtoWith('pending_payment'))).toBe('slow');
		expect(nextView('loading', dtoWith('pending_payment'))).toBe('confirming');
		expect(nextView('confirming', dtoWith('pending_payment'))).toBe('confirming');
	});

	it('real news always wins', () => {
		for (const from of ['loading', 'confirming', 'slow', 'failed']) {
			expect(nextView(from, dtoWith('paid'))).toBe('confirmed');
			expect(nextView(from, dtoWith('cancelled'))).toBe('cancelled');
			expect(nextView(from, dtoWith('needs_review'))).toBe('review');
		}
		expect(nextView('confirming', dtoWith('payment_failed'))).toBe('failed');
		expect(nextView('slow', dtoWith('expired'))).toBe('failed');
	});
});

describe('mayStillSettle / pollModeFor / nextFailedPollDelay', () => {
	it('only an unpaid ONLINE order in pending_payment / payment_failed can still turn paid by itself', () => {
		expect(mayStillSettle(dtoWith('payment_failed'))).toBe(true);
		expect(mayStillSettle(dtoWith('pending_payment'))).toBe(true);
		for (const s of ['expired', 'cancelled', 'paid', 'needs_review', 'refunded', 'cod_pending']) expect(mayStillSettle(dtoWith(s))).toBe(false);
		expect(mayStillSettle(dtoWith('pending_payment', { paymentMethod: 'cod' }))).toBe(false);
		expect(mayStillSettle(null)).toBe(false);
	});

	it('picks the schedule from the view shown', () => {
		expect(pollModeFor('confirming', dtoWith('pending_payment'))).toBe('confirming');
		expect(pollModeFor('failed', dtoWith('payment_failed'))).toBe('failed');
		expect(pollModeFor('failed', dtoWith('pending_payment'))).toBe('failed'); // redirect-mode failure, webhook not in yet
		expect(pollModeFor('failed', dtoWith('expired'))).toBeNull();
		expect(pollModeFor('slow', dtoWith('pending_payment'))).toBeNull();
		expect(pollModeFor('confirmed', dtoWith('paid'))).toBeNull();
	});

	it('the failed schedule: every 8 s for 2 minutes', () => {
		expect(nextFailedPollDelay(0)).toBe(8000);
		expect(nextFailedPollDelay(119999)).toBe(8000);
		expect(nextFailedPollDelay(120000)).toBeNull();
	});
});

describe('failedCopy ("no money was taken" only where certain)', () => {
	it('the webhook said payment_failed (no reason on the page): unsure, and watching', () => {
		expect(failedCopy(dtoWith('payment_failed'), null)).toEqual({ message: MONEY_UNSURE, certain: false, watching: true });
		expect(MONEY_UNSURE).not.toMatch(/no money was taken/i);
	});

	it('timeout-type reasons can still authorise late: unsure', () => {
		for (const r of ['payment_timed_out', 'request_timed_out', 'payment_session_expired', 'payment_collect_request_expired', 'PAYMENT_TIMED_OUT']) {
			expect(failedCopy(dtoWith('pending_payment'), r).message).toBe(MONEY_UNSURE);
		}
		expect(failedCopy(dtoWith('pending_payment'), 'payment_timed_out').watching).toBe(true);
	});

	it('technical / unknown reasons: unsure', () => {
		expect(failedCopy(dtoWith('payment_failed'), 'bank_technical_error').certain).toBe(false);
		expect(failedCopy(dtoWith('payment_failed'), 'something_new').certain).toBe(false);
	});

	it('cancelled by the customer, declined, auth failed, risk: certain (and no "watching" line)', () => {
		for (const r of ['payment_cancelled', 'card_declined', 'insufficient_funds', 'incorrect_otp', 'payment_risk_check_failed']) {
			expect(failedCopy(dtoWith('payment_failed'), r)).toEqual({ message: NO_MONEY_TAKEN, certain: true, watching: false });
		}
	});

	it('expired (the server found no payment): certain, nothing to watch; before any answer: unsure', () => {
		expect(failedCopy(dtoWith('expired'), null)).toEqual({ message: NO_MONEY_TAKEN, certain: true, watching: false });
		expect(failedCopy(null, null)).toEqual({ message: MONEY_UNSURE, certain: false, watching: false });
	});
});

describe('canSwitchToCod (only where a COD checkout supersedes the online order)', () => {
	const now = Date.parse('2026-09-26T10:00:00.000Z');
	const ago = (min) => new Date(now - min * 60000).toISOString();
	const bag = cartSignature([{ slug: 'cornflakes', qty: 2 }, { slug: 'muesli', qty: 1 }]);

	it('unpaid online order, same bag, last 25 minutes → yes', () => {
		expect(canSwitchToCod(dtoWith('payment_failed', { createdAt: ago(5) }), bag, now)).toBe(true);
		expect(canSwitchToCod(dtoWith('pending_payment', { createdAt: ago(24) }), bag, now)).toBe(true);
		expect(canSwitchToCod(dtoWith('payment_failed', { createdAt: ago(-2) }), bag, now)).toBe(true); // client clock behind
	});

	it('a different bag (qty, extra item, empty) → no: supersede would not match', () => {
		const o = dtoWith('payment_failed', { createdAt: ago(5) });
		expect(canSwitchToCod(o, cartSignature([{ slug: 'cornflakes', qty: 1 }, { slug: 'muesli', qty: 1 }]), now)).toBe(false);
		expect(canSwitchToCod(o, cartSignature([{ slug: 'cornflakes', qty: 2 }, { slug: 'muesli', qty: 1 }, { slug: 'health-mix', qty: 1 }]), now)).toBe(false);
		expect(canSwitchToCod(o, '', now)).toBe(false);
		expect(canSwitchToCod({ ...o, items: [] }, '', now)).toBe(false);
	});

	it('too old, paid, authorised, COD or cancelled → no', () => {
		expect(canSwitchToCod(dtoWith('payment_failed', { createdAt: new Date(now - COD_SWITCH_WINDOW_MS - 1000).toISOString() }), bag, now)).toBe(false);
		expect(canSwitchToCod(dtoWith('payment_failed', { createdAt: 'nonsense' }), bag, now)).toBe(false);
		expect(canSwitchToCod(dtoWith('pending_payment', { createdAt: ago(5), paymentStatus: 'authorized' }), bag, now)).toBe(false);
		expect(canSwitchToCod(dtoWith('payment_failed', { createdAt: ago(5), paymentStatus: 'captured' }), bag, now)).toBe(false);
		for (const s of ['paid', 'cancelled', 'needs_review', 'refunded', 'cod_pending', 'cod_confirmed']) expect(canSwitchToCod(dtoWith(s, { createdAt: ago(5) }), bag, now)).toBe(false);
		expect(canSwitchToCod(dtoWith('pending_payment', { createdAt: ago(5), paymentMethod: 'cod' }), bag, now)).toBe(false);
		expect(canSwitchToCod(null, bag, now)).toBe(false);
		expect(canSwitchToCod('WF-10001', bag, now)).toBe(false);
	});

	it('expired (nothing left to supersede: no payment, stock released) → yes for the same bag, at any age', () => {
		expect(canSwitchToCod(dtoWith('expired', { createdAt: ago(5) }), bag, now)).toBe(true);
		expect(canSwitchToCod(dtoWith('expired', { createdAt: ago(3 * 24 * 60) }), bag, now)).toBe(true);
		expect(canSwitchToCod(dtoWith('expired', { createdAt: 'nonsense' }), bag, now)).toBe(true);
		expect(canSwitchToCod(dtoWith('expired', { createdAt: ago(40) }), cartSignature([{ slug: 'muesli', qty: 1 }]), now)).toBe(false);
		expect(canSwitchToCod(dtoWith('expired', { createdAt: ago(40), paymentStatus: 'authorized' }), bag, now)).toBe(false);
		expect(canSwitchToCod(dtoWith('expired', { createdAt: ago(40), paymentMethod: 'cod' }), bag, now)).toBe(false);
	});
});

describe('createOrderWatcher (the /order page\'s look-and-poll loop)', () => {
	/**
	 * A page stand-in: apply() goes through nextView like the page does.
	 * `answers` is consumed one per look; the last one repeats.
	 */
	function harness({ answers, view = 'loading', doc = null } = {}) {
		const timers = manualTimers();
		const seq = [...answers];
		const h = { view, looks: [], slow: 0, notFound: 0, busy: false };
		const w = createOrderWatcher({
			look: async () => {
				h.looks.push(timers.now);
				const a = seq.length > 1 ? seq.shift() : seq[0];
				if (a === 'NOT_FOUND' || a === 'NETWORK') return { ok: false, code: a, status: a === 'NOT_FOUND' ? 404 : 0 };
				return { ok: true, dto: dtoWith(a) };
			},
			apply: (dto) => (h.view = nextView(h.view, dto)),
			onNotFound: () => {
				h.notFound++;
				h.view = 'notfound';
			},
			onSlow: () => {
				h.slow++;
				if (h.view === 'confirming') h.view = 'slow';
			},
			busy: () => h.busy,
			recheckOnReturn: () => h.view === 'failed' || h.view === 'slow',
			timers,
			doc
		});
		return { h, w, timers, seq };
	}

	function fakeDoc() {
		const doc = new EventTarget();
		doc.hidden = false;
		doc.hide = () => {
			doc.hidden = true;
			doc.dispatchEvent(new Event('visibilitychange'));
		};
		doc.show = () => {
			doc.hidden = false;
			doc.dispatchEvent(new Event('visibilitychange'));
		};
		return doc;
	}

	it('W2V-4: confirming → the webhook says payment_failed → keeps a slow look → a late authorisation turns it confirmed', async () => {
		const { h, w, timers } = harness({ answers: ['pending_payment', 'payment_failed', 'payment_failed', 'payment_failed', 'paid'] });
		await w.start('confirming');
		expect(h.view).toBe('confirming');
		expect(w.mode).toBe('confirming');
		await timers.advance(2000);
		expect(h.view).toBe('failed');
		expect(w.mode).toBe('failed'); // before the fix polling stopped right here
		await timers.advance(8000);
		await timers.advance(8000);
		expect(h.view).toBe('failed');
		await timers.advance(8000);
		expect(h.view).toBe('confirmed');
		expect(h.looks).toEqual([0, 2000, 10000, 18000, 26000]);
		expect(w.mode).toBeNull();
		await timers.advance(300000);
		expect(h.looks.length).toBe(5); // confirmed is final
		expect(timers.pending).toBe(0);
	});

	it('redirect-mode failure (payment still pending on the server): stays "failed", looks every 8 s, confirmed when paid', async () => {
		const { h, w, timers } = harness({ view: 'failed', answers: ['pending_payment', 'pending_payment', 'paid'] });
		await w.start('failed');
		expect(h.view).toBe('failed'); // never "Confirming…" after the bank said no
		expect(w.mode).toBe('failed');
		await timers.advance(8000);
		expect(h.view).toBe('failed');
		await timers.advance(8000);
		expect(h.view).toBe('confirmed');
		expect(h.looks).toEqual([0, 8000, 16000]);
	});

	it('the failed look gives up after 2 minutes (16 looks in all), without "Still confirming"', async () => {
		const { h, w, timers } = harness({ answers: ['payment_failed'] });
		await w.start();
		await timers.advance(600000);
		expect(h.looks.length).toBe(16);
		expect(h.looks.at(-1)).toBe(120000);
		expect(h.view).toBe('failed');
		expect(h.slow).toBe(0);
		expect(w.mode).toBeNull();
		expect(timers.pending).toBe(0);
	});

	it('an expired order is final: one look, no polling', async () => {
		const { h, w, timers } = harness({ answers: ['expired'] });
		await w.start();
		await timers.advance(300000);
		expect(h.view).toBe('failed');
		expect(h.looks).toEqual([0]);
	});

	it('confirming runs out → onSlow once; a pending answer later never undoes "Still confirming"', async () => {
		const { h, w, timers } = harness({ answers: ['pending_payment'] });
		await w.start();
		await timers.advance(600000);
		expect(h.view).toBe('slow');
		expect(h.slow).toBe(1);
		expect(h.looks.length).toBe(34);
	});

	it('no looks while a retry’s payment window is open (busy), then it carries on', async () => {
		const { h, w, timers } = harness({ answers: ['payment_failed'] });
		await w.start();
		h.busy = true;
		await timers.advance(40000);
		expect(h.looks).toEqual([0]);
		h.busy = false;
		await timers.advance(8000);
		expect(h.looks).toEqual([0, 48000]);
	});

	it('coming back to the tab after the failed look stopped: looks again and restarts it; paid → confirmed', async () => {
		const doc = fakeDoc();
		const { h, w, timers, seq } = harness({ answers: ['payment_failed'], doc });
		await w.start();
		await timers.advance(130000);
		expect(w.mode).toBeNull();
		const n = h.looks.length;
		doc.hide();
		await timers.advance(600000); // ten minutes in the UPI app
		expect(h.looks.length).toBe(n);
		doc.show();
		await timers.advance(0);
		expect(h.looks.length).toBe(n + 1);
		expect(w.mode).toBe('failed'); // still failed: a fresh 2-minute look
		seq.splice(0, seq.length, 'paid');
		await timers.advance(8000);
		expect(h.view).toBe('confirmed');
		expect(h.looks.length).toBe(n + 2);
	});

	it('coming back to "Still confirming": one look (paid → confirmed; pending → stays, no new polling)', async () => {
		const doc = fakeDoc();
		const { h, w, timers, seq } = harness({ answers: ['pending_payment'], doc });
		await w.start();
		await timers.advance(600000);
		expect(h.view).toBe('slow');
		const n = h.looks.length;
		doc.hide();
		doc.show();
		await timers.advance(60000);
		expect(h.looks.length).toBe(n + 1);
		expect(h.view).toBe('slow');
		expect(w.mode).toBeNull();
		seq.splice(0, seq.length, 'paid');
		doc.hide();
		doc.show();
		await timers.advance(0);
		expect(h.view).toBe('confirmed');
		doc.hide();
		doc.show();
		await timers.advance(0);
		expect(h.looks.length).toBe(n + 2); // confirmed: returning never looks again
	});

	it('while a schedule runs, returning to the tab looks once (the poller’s own resume), not twice', async () => {
		const doc = fakeDoc();
		const { h, w, timers } = harness({ answers: ['payment_failed'], doc });
		await w.start();
		doc.hide();
		await timers.advance(60000);
		doc.show();
		await timers.advance(0);
		expect(h.looks).toEqual([0, 60000]);
	});

	it('NOT_FOUND → onNotFound, polling ends', async () => {
		const { h, w, timers } = harness({ answers: ['pending_payment', 'NOT_FOUND'] });
		await w.start();
		await timers.advance(60000);
		expect(h.notFound).toBe(1);
		expect(h.view).toBe('notfound');
		expect(h.looks).toEqual([0, 2000]);
	});

	it('no answer on the first look (offline): keeps looking on the fallback schedule', async () => {
		const a = harness({ answers: ['NETWORK', 'NETWORK', 'pending_payment'] });
		await a.w.start('confirming');
		expect(a.w.mode).toBe('confirming');
		await a.timers.advance(4000);
		expect(a.h.looks).toEqual([0, 2000, 4000]);
		expect(a.h.view).toBe('confirming');

		const b = harness({ view: 'failed', answers: ['NETWORK', 'payment_failed'] });
		await b.w.start('failed');
		expect(b.w.mode).toBe('failed');
		await b.timers.advance(8000);
		expect(b.h.looks).toEqual([0, 8000]);
		expect(b.w.mode).toBe('failed');
	});

	it('poll(mode) switches schedules (after a retry’s payment); stop() ends everything and unhooks the tab listener', async () => {
		const doc = fakeDoc();
		const { h, w, timers } = harness({ view: 'failed', answers: ['payment_failed'], doc });
		await w.start('failed');
		h.view = 'confirming';
		w.poll('confirming');
		await timers.advance(2000);
		expect(h.looks).toEqual([0, 2000]); // the confirming schedule, and the failed answer moves it back
		expect(w.mode).toBe('failed');
		w.stop();
		await timers.advance(600000);
		doc.hide();
		doc.show();
		await timers.advance(0);
		expect(h.looks).toEqual([0, 2000]);
		expect(timers.pending).toBe(0);
	});
});
