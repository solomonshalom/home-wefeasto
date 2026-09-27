/*
 * Hunt round 2 (client-ux, a11y) regressions around the checkout page:
 * - navigate.js: reaching /order after a payment survives a failed page-code request
 *   (never SvelteKit's "ERROR 500" page with nothing polling);
 * - announce.js: /checkout's status messages (top-up add, offer applying, fees, sold-out lines);
 * - the prerendered PIN input leaves room for "560 001".
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';
import { createSafeNavigate, pathOf, nextOnline } from '$lib/checkout/navigate.js';
import { summarySnapshot, bagChanges, summaryChanges } from '$lib/checkout/announce.js';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/checkout') } }));

const URL1 = '/order?no=WF-10018&t=abc';

function nav({ preload = async () => {}, land = { path: '/order', error: false }, gotoFails = false, online = true } = {}) {
	const calls = [];
	let onlineWaits = 0;
	const navigate = createSafeNavigate({
		preload: async (p) => (calls.push(['preload', p]), preload(p)),
		goto: async (u) => {
			calls.push(['goto', u]);
			if (gotoFails) throw new Error('navigation failed');
		},
		errorAt: () => land,
		hard: (u) => calls.push(['hard', u]),
		online: () => online,
		whenOnline: async () => void onlineWaits++
	});
	return { navigate, calls, waits: () => onlineWaits };
}

describe('navigate.js: /order after money may have moved', () => {
	it('page code loaded → client-side goto, nothing else', async () => {
		const n = nav();
		expect(await n.navigate(URL1)).toBe('client');
		expect(n.calls).toEqual([['preload', '/order'], ['goto', URL1]]);
	});

	it('the page-code request fails (a network blip) → a full page load of the same URL, no goto', async () => {
		const n = nav({ preload: async () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
		expect(await n.navigate(URL1)).toBe('full');
		expect(n.calls).toEqual([['preload', '/order'], ['hard', URL1]]);
		expect(n.waits()).toBe(0);
	});

	it('offline: the full load waits for the connection to come back', async () => {
		const n = nav({ preload: () => Promise.reject(new Error('x')), online: false });
		await n.navigate(URL1);
		expect(n.waits()).toBe(1);
		expect(n.calls.at(-1)).toEqual(['hard', URL1]);
	});

	it('goto landed on the error page at /order anyway → a full page load', async () => {
		const n = nav({ land: { path: '/order', error: true } });
		expect(await n.navigate(URL1)).toBe('full');
		expect(n.calls.at(-1)).toEqual(['hard', URL1]);
	});

	it('goto failed and the customer is elsewhere (they navigated meanwhile) → left alone', async () => {
		const n = nav({ gotoFails: true, land: { path: '/shop', error: false } });
		expect(await n.navigate(URL1)).toBe('elsewhere');
		expect(n.calls.some(([k]) => k === 'hard')).toBe(false);
	});

	it('pathOf strips the query and hash; nextOnline resolves on the event', async () => {
		expect(pathOf(URL1)).toBe('/order');
		expect(pathOf('/order#x')).toBe('/order');
		expect(pathOf('/cart')).toBe('/cart');
		const handlers = {};
		const win = { addEventListener: (e, f) => (handlers[e] = f) };
		const p = nextOnline(win);
		handlers.online();
		await expect(p).resolves.toBeUndefined();
		await expect(nextOnline(null)).resolves.toBeUndefined();
	});
});

const line = (slug, name, qty, each) => ({ slug, name, qty, lineTotalPaise: qty * each });
const quote = (patch = {}) => ({
	lines: [line('cornflakes', 'Cornflakes', 1, 17500)],
	issues: [],
	subtotalPaise: 17500,
	deliveryPaise: 4900,
	isFreeDelivery: false,
	codFeePaise: 0,
	totalPaise: 22400,
	coupon: null,
	couponError: null,
	...patch
});
const nameOf = (s) => ({ 'health-mix': 'Health Mix', cornflakes: 'Cornflakes' })[s] || s;

describe('announce.js: /checkout status messages', () => {
	it('top-up "+ Add" that makes a pending offer apply: what was added, the offer, the new total', () => {
		const before = summarySnapshot(quote({ couponError: { reason: 'MIN_SUBTOTAL', minSubtotalPaise: 17600 } }), { offerCode: 'E2E1', nameOf });
		const after = summarySnapshot(
			quote({ lines: [line('cornflakes', 'Cornflakes', 1, 17500), line('health-mix', 'Health Mix', 1, 27000)], subtotalPaise: 44500, coupon: { code: 'E2E1' }, discountPaise: 4450, totalPaise: 44950 }),
			{ offerCode: 'E2E1', nameOf }
		);
		const msg = [...bagChanges({ cornflakes: 1 }, { cornflakes: 1, 'health-mix': 1 }, nameOf), ...summaryChanges(before, after)].join(' ');
		expect(msg).toBe('Added Health Mix. Offer E2E1 applied. Total now ₹450.');
		expect(before.offer.state).toBe('invalid');
		expect(before.offer.why).toMatch(/\.$/);
	});

	it('an offer that stops applying says why; removing it says so', () => {
		const on = summarySnapshot(quote({ coupon: { code: 'X1' } }), { offerCode: 'X1' });
		const off = summarySnapshot(quote({ couponError: { reason: 'EXPIRED' } }), { offerCode: 'X1' });
		expect(summaryChanges(on, off)).toEqual(['Offer X1 can’t be used: That offer has expired.']);
		expect(summaryChanges(on, summarySnapshot(quote(), {}))).toEqual(['Offer X1 removed.']);
		expect(summaryChanges(on, on)).toEqual([]); // nothing changed: nothing said
	});

	it('COD fee, free delivery, quantities and removals', () => {
		const upi = summarySnapshot(quote(), { method: 'upi' });
		const cod = summarySnapshot(quote({ codFeePaise: 2500, totalPaise: 24900 }), { method: 'cod' });
		expect(summaryChanges(upi, cod)).toEqual(['Cash on delivery fee ₹25 added.', 'Total now ₹249.']);
		expect(summaryChanges(cod, upi)).toEqual(['Cash on delivery fee removed.', 'Total now ₹224.']);
		const free = summarySnapshot(quote({ isFreeDelivery: true, deliveryPaise: 0, totalPaise: 52500 }));
		expect(summaryChanges(upi, free)).toEqual(['Delivery is now free.', 'Total now ₹525.']);
		expect(bagChanges({ cornflakes: 1, muesli: 2 }, { cornflakes: 3 }, nameOf)).toEqual(['Cornflakes: quantity now 3.', 'Removed muesli.']);
		expect(bagChanges({}, { 'health-mix': 2 }, nameOf)).toEqual(['Added Health Mix × 2.']);
	});

	it('a line that sells out is named; with every line blocked there is no total to speak of', () => {
		const ok1 = summarySnapshot(quote());
		const sold = summarySnapshot(quote({ lines: [], issues: [{ slug: 'cornflakes', code: 'OUT_OF_STOCK', name: 'Cornflakes' }], totalPaise: 0 }));
		const out = summaryChanges(ok1, sold);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/^Cornflakes .*\.$/);
		expect(sold.blocked).toBe(true);
	});
});

describe('/checkout PIN input (prerendered)', () => {
	it('leaves room for "560 001" (the space is dropped as it is typed); pattern still 6 digits', async () => {
		const { default: CheckoutPage } = await import('../../../src/routes/checkout/+page.svelte');
		const out = render(CheckoutPage, { props: {} }).body;
		const pin = out.match(/<input[^>]*id="wf-co-pin"[^>]*>/)[0];
		expect(pin).toContain('maxlength="7"');
		expect(pin).toContain('pattern="[0-9]{6}"');
		expect(out).not.toContain('data-wf-co-live'); // the live region arrives with hydration (no prerender diff)
	}, 30_000); // compiling the page on first import is slow on a loaded machine
});
