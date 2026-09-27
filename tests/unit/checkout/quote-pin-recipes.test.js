/*
 * The server-quote client (debounce, stale answers dropped, flush, the
 * PRICE_CHANGED quote), the S5 PIN lookup over the static GeoNames shards
 * (and the shipped shards themselves), and the /order recipe cards.
 */
import fs from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createQuoter, quoteBody, quoteKey, isQuote, quoteView, payLabel, supersedeFor, supersedeRef } from '$lib/checkout/quote.js';
import { quote } from '$shared/pricing.js';
import { codReasonCopy } from '$shared/errors.js';
import { lookupPin, _resetPinCache, PIN_AUTOFILL_RE, planPinFill } from '$lib/checkout/pin.js';
import { PIN_PREFIXES } from '$lib/checkout/pin-prefixes.js';
import { recipeCardsFor, recipeCard } from '$lib/checkout/recipes.js';
import { recipesContent } from '$lib/data/recipes-content.js';
import { recipes as snapshotRecipes } from '$lib/data/cms-snapshot.json';
import { INDIAN_STATES } from '$shared/validate.js';
import { fakeApi, manualTimers, flush, ok, err } from './_helpers.js';

const Q = (totalPaise) => ({ totalPaise, lines: [], issues: [], subtotalPaise: totalPaise });

describe('quoteBody', () => {
	it('drops empty optionals and extra item fields', () => {
		expect(quoteBody({ items: [{ slug: 'muesli', qty: 1, x: 1 }] })).toEqual({ items: [{ slug: 'muesli', qty: 1 }] });
		expect(quoteBody({ items: [], couponCode: 'W10', email: 'a@b.co', pin: '560001', method: 'cod' })).toEqual({ items: [], couponCode: 'W10', email: 'a@b.co', pin: '560001', method: 'cod' });
		expect(quoteKey({ b: 1, a: 2 })).toBe(quoteKey({ a: 2, b: 1 }));
		expect(isQuote(Q(1))).toBe(true);
		expect(isQuote({ totalPaise: 1.5, lines: [], issues: [] })).toBe(false);
	});
});

describe('quoteBody supersede (PI-SF-1)', () => {
	const T = 'dGVzdC10b2tlbi1mb3Itd2YtMTAwMDEtYWJjZGVmZ2hpams';
	const items = [{ slug: 'health-mix', qty: 1 }];
	const pending = { no: 'WF-10001', t: T, at: 1, cartSig: 'health-mix:1' };

	it('names the pending order as {number, token}; part of the quote key', () => {
		const body = quoteBody({ items, method: 'cod', supersede: { number: 'WF-10001', token: T } });
		expect(body).toEqual({ items, method: 'cod', supersede: { number: 'WF-10001', token: T } });
		expect(quoteKey(body)).not.toBe(quoteKey(quoteBody({ items, method: 'cod' })));
	});

	it('left out when missing or malformed (no number / token)', () => {
		for (const supersede of [null, undefined, {}, { number: 'WF-10001' }, { token: T }, { number: '  ', token: T }, { number: 1, token: T }, 'WF-10001']) {
			expect(quoteBody({ items, supersede })).toEqual({ items });
		}
		expect(supersedeRef({ number: ' WF-10001 ', token: T, extra: 1 })).toEqual({ number: 'WF-10001', token: T });
	});

	it('supersedeFor: wefeasto_pending only for exactly this bag', () => {
		expect(supersedeFor(pending, 'health-mix:1')).toEqual({ number: 'WF-10001', token: T });
		expect(supersedeFor(pending, 'health-mix:2')).toBeNull(); // the bag changed: re-quote without it
		expect(supersedeFor({ ...pending, cartSig: '' }, 'health-mix:1')).toBeNull(); // an old entry with no bag
		expect(supersedeFor(pending, '')).toBeNull(); // empty bag
		expect(supersedeFor(null, 'health-mix:1')).toBeNull();
	});

	it('supersedeFor: a pending entry wins over the flow; with storage unavailable, the flow’s own online order for the bag', () => {
		const placed = { order: { number: 'WF-10002', token: T }, method: 'upi', cartSig: 'health-mix:1' };
		expect(supersedeFor(pending, 'health-mix:1', placed)).toEqual({ number: 'WF-10001', token: T });
		expect(supersedeFor({ ...pending, cartSig: 'muesli:1' }, 'health-mix:1', placed)).toBeNull(); // pending is the truth when readable
		expect(supersedeFor(null, 'health-mix:1', placed)).toEqual({ number: 'WF-10002', token: T });
		expect(supersedeFor(null, 'health-mix:2', placed)).toBeNull();
		expect(supersedeFor(null, 'health-mix:1', { ...placed, method: 'cod' })).toBeNull(); // a COD order supersedes nothing
		expect(supersedeFor(null, 'health-mix:1', { ...placed, order: null })).toBeNull();
	});

	it('the quoter re-asks when only the supersede ref changes (e.g. after a dismiss wrote wefeasto_pending)', async () => {
		const timers = manualTimers();
		const api = fakeApi({ '/store/quote': () => ok({ quote: Q(100) }) });
		const qt = createQuoter({ api, timers });
		qt.request(quoteBody({ items, method: 'upi' }));
		await timers.advance(300);
		qt.request(quoteBody({ items, method: 'upi', supersede: { number: 'WF-10001', token: T } }));
		await timers.advance(300);
		expect(api.calls.map((c) => c.opts.body.supersede ?? null)).toEqual([null, { number: 'WF-10001', token: T }]);
		qt.destroy();
	});
});

describe('quoteView / payLabel (W2V-5: the sold-out race)', () => {
	const CATALOG = [
		{ slug: 'steel-cut-oats', name: 'Steel-Cut Oats', pricePaise: 29900, inStock: false },
		{ slug: 'muesli', name: 'Muesli', pricePaise: 25000 },
		{ slug: 'cornflakes', name: 'Cornflakes', pricePaise: 17500, codAllowed: false }
	];
	const SETTINGS = { freeDeliveryThresholdPaise: 49900, deliveryFeePaise: 4900, codEnabled: true, codFeePaise: 0, codMaxPaise: 200000, codMinSubtotalPaise: 0 };
	const q = (items, method = 'upi') => quote({ items, catalog: CATALOG, settings: SETTINGS, method });

	it('every line sold out: the $shared quote says EMPTY / ₹0 — the page must not repeat that', () => {
		const sq = q([{ slug: 'steel-cut-oats', qty: 1 }]);
		// what the page used to show: "Add something to your bag first." and "Pay ₹0 securely"
		expect(sq.lines).toEqual([]);
		expect(sq.codUnavailableReason).toBe('EMPTY');
		expect(sq.totalPaise).toBe(0);
		expect(codReasonCopy('EMPTY')).toBe('Add something to your bag first.');
		expect(quoteView(sq)).toEqual({ allBlocked: true, bagBlocked: true, codAvailable: true });
		expect(payLabel('upi', sq.totalPaise, true)).toBe('Pay securely');
		expect(payLabel('cod', sq.totalPaise, true)).toBe('Place order · Pay on delivery');
	});

	it('some lines blocked: the rest is still priced, COD answers for them, Pay has no amount', () => {
		const sq = q([{ slug: 'steel-cut-oats', qty: 1 }, { slug: 'muesli', qty: 1 }]);
		expect(quoteView(sq)).toEqual({ allBlocked: false, bagBlocked: true, codAvailable: true });
		const noCod = q([{ slug: 'steel-cut-oats', qty: 1 }, { slug: 'cornflakes', qty: 1 }]);
		expect(noCod.codUnavailableReason).toBe('ITEM_NOT_ALLOWED');
		expect(quoteView(noCod).codAvailable).toBe(false); // a real COD reason still shows
	});

	it('a clean bag: nothing blocked, the amount is on the button', () => {
		const sq = q([{ slug: 'muesli', qty: 1 }]);
		expect(quoteView(sq)).toEqual({ allBlocked: false, bagBlocked: false, codAvailable: true });
		expect(payLabel('upi', sq.totalPaise)).toBe('Pay ₹299 securely');
		expect(payLabel('card', sq.totalPaise, false)).toBe('Pay ₹299 securely');
		expect(payLabel('cod', sq.totalPaise)).toBe('Place order · Pay ₹299 on delivery');
	});

	it('W2V2-5: never "₹0" — a zero / missing total (prerendered, pre-hydration, empty bag) gets the amount-less label', () => {
		for (const total of [0, -100, NaN, undefined, null, 1.5]) {
			expect(payLabel('upi', total)).toBe('Pay securely');
			expect(payLabel('card', total, false)).toBe('Pay securely');
			expect(payLabel('cod', total)).toBe('Place order · Pay on delivery');
		}
		expect(payLabel('upi', 100)).toBe('Pay ₹1 securely');
		expect(payLabel('upi', 47400, true)).toBe('Pay securely');
	});

	it('an order-level problem (above the max) blocks too; an empty bag is not "blocked" (it has its own state)', () => {
		expect(quoteView({ lines: [{}], issues: [], orderError: { code: 'ABOVE_MAX' }, codAvailable: false, codUnavailableReason: 'ABOVE_MAX' })).toEqual({ allBlocked: false, bagBlocked: true, codAvailable: false });
		expect(quoteView(q([]))).toEqual({ allBlocked: false, bagBlocked: false, codAvailable: false });
		expect(quoteView(null)).toEqual({ allBlocked: false, bagBlocked: false, codAvailable: true });
	});
});

describe('createQuoter', () => {
	it('debounces: rapid asks → one POST for the latest body', async () => {
		const timers = manualTimers();
		const api = fakeApi({ '/store/quote': (opts) => ok({ quote: Q(opts.body.items[0].qty * 100) }) });
		const qt = createQuoter({ api, timers, delayMs: 250 });
		qt.request(quoteBody({ items: [{ slug: 'm', qty: 1 }] }));
		qt.request(quoteBody({ items: [{ slug: 'm', qty: 2 }] }));
		qt.request(quoteBody({ items: [{ slug: 'm', qty: 3 }] }));
		expect(get(qt.state).status).toBe('loading');
		await timers.advance(250);
		await flush();
		expect(api.count('/store/quote')).toBe(1);
		expect(get(qt.state)).toMatchObject({ status: 'ok', quote: { totalPaise: 300 }, key: quoteKey(quoteBody({ items: [{ slug: 'm', qty: 3 }] })) });
	});

	it('the same ask twice is a no-op', async () => {
		const timers = manualTimers();
		const api = fakeApi({ '/store/quote': () => ok({ quote: Q(1) }) });
		const qt = createQuoter({ api, timers });
		const b = quoteBody({ items: [{ slug: 'm', qty: 1 }] });
		qt.request(b);
		await timers.advance(300);
		await flush();
		qt.request({ ...b });
		await timers.advance(300);
		expect(api.count('/store/quote')).toBe(1);
	});

	it('a late answer to an older ask is dropped; the older request is aborted', async () => {
		const timers = manualTimers();
		const resolvers = [];
		const api = fakeApi({ '/store/quote': (opts) => new Promise((r) => resolvers.push({ r, opts })) });
		const qt = createQuoter({ api, timers, delayMs: 10 });
		qt.request(quoteBody({ items: [{ slug: 'm', qty: 1 }] }));
		await timers.advance(10);
		qt.request(quoteBody({ items: [{ slug: 'm', qty: 2 }] }));
		await timers.advance(10);
		expect(resolvers[0].opts.signal.aborted).toBe(true);
		resolvers[1].r(ok({ quote: Q(200) }));
		await flush();
		resolvers[0].r(ok({ quote: Q(100) }));
		await flush();
		expect(get(qt.state).quote.totalPaise).toBe(200);
	});

	it('errors are reported (the page falls back to the local quote)', async () => {
		const timers = manualTimers();
		const qt = createQuoter({ api: fakeApi({ '/store/quote': () => err('NOT_FOUND', null, 404) }), timers });
		qt.request(quoteBody({ items: [] }));
		await timers.advance(300);
		await flush();
		expect(get(qt.state)).toMatchObject({ status: 'error', quote: null, error: 'NOT_FOUND' });
		const qt2 = createQuoter({ api: fakeApi({ '/store/quote': () => ok({ quote: { nope: 1 } }) }), timers });
		qt2.request(quoteBody({ items: [] }));
		await timers.advance(300);
		await flush();
		expect(get(qt2.state).error).toBe('BAD_RESPONSE');
	});

	it('flush() sends a debounced ask now and waits for it', async () => {
		const timers = manualTimers();
		const api = fakeApi({ '/store/quote': () => ok({ quote: Q(5) }) });
		const qt = createQuoter({ api, timers, delayMs: 10000 });
		qt.request(quoteBody({ items: [{ slug: 'm', qty: 1 }] }));
		const s = await qt.flush();
		expect(s).toMatchObject({ status: 'ok', quote: { totalPaise: 5 } });
		expect(timers.pending).toBe(0);
		expect((await qt.flush()).status).toBe('ok'); // nothing pending: returns at once
	});

	it('setQuote (PRICE_CHANGED details.quote) wins over an in-flight ask; invalidate refetches', async () => {
		const timers = manualTimers();
		let release;
		const api = fakeApi({ '/store/quote': () => new Promise((r) => (release = () => r(ok({ quote: Q(1) })))) });
		const qt = createQuoter({ api, timers, delayMs: 0 });
		const b = quoteBody({ items: [{ slug: 'm', qty: 1 }] });
		qt.request(b);
		await timers.advance(0);
		qt.setQuote(Q(52400), b);
		release();
		await flush();
		expect(get(qt.state)).toMatchObject({ status: 'ok', quote: { totalPaise: 52400 }, key: quoteKey(b) });
		qt.invalidate();
		qt.request(b);
		await timers.advance(0);
		expect(api.count('/store/quote')).toBe(2);
		qt.setQuote({ junk: true }, b); // ignored
		qt.destroy();
	});
});

describe('lookupPin (S5)', () => {
	beforeEach(() => _resetPinCache());

	const shard = { '001': ['Bengaluru', 'Karnataka'], '002': ['', 'karnataka'], '003': 'junk' };
	function fetcher(responses) {
		const calls = [];
		const fn = async (url) => {
			calls.push(url);
			const r = responses[url];
			if (r instanceof Error) throw r;
			if (!r) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => r };
		};
		fn.calls = calls;
		return fn;
	}

	it('560001 → Bengaluru / Karnataka from /pin/560.json (one fetch per shard)', async () => {
		const f = fetcher({ '/pin/560.json': shard });
		expect(await lookupPin('560001', { fetch: f })).toEqual({ city: 'Bengaluru', state: 'Karnataka' });
		expect(await lookupPin('560 002', { fetch: f })).toEqual({ city: '', state: 'Karnataka' });
		expect(await lookupPin('560003', { fetch: f })).toBeNull();
		expect(await lookupPin('560099', { fetch: f })).toBeNull();
		expect(f.calls).toEqual(['/pin/560.json']);
	});

	it('never looks up malformed PINs or 9xxxxx (Army Postal Service)', async () => {
		const f = fetcher({});
		for (const pin of ['56000', '5600011', '060001', '900001', 'abcdef', null, 560001.5]) expect(await lookupPin(pin, { fetch: f })).toBeNull();
		expect(f.calls).toEqual([]);
		expect(PIN_AUTOFILL_RE.test('800001')).toBe(true);
	});

	it('missing shard (404) → null and cached; network failure → null and retried next time', async () => {
		const f = fetcher({ '/pin/111.json': new Error('offline') });
		const any = { fetch: f, prefixes: null }; // every prefix tried (as if the set were stale)
		expect(await lookupPin('123456', any)).toBeNull();
		expect(await lookupPin('123457', any)).toBeNull();
		expect(f.calls.filter((u) => u === '/pin/123.json').length).toBe(1);
		expect(await lookupPin('111111', any)).toBeNull();
		await flush();
		expect(await lookupPin('111112', any)).toBeNull();
		expect(f.calls.filter((u) => u === '/pin/111.json').length).toBe(2);
	});

	it('a prefix with no shard (150001) → null with no fetch at all: no 404 in the console (PI-PAY-4)', async () => {
		const f = fetcher({ '/pin/560.json': shard });
		expect(PIN_PREFIXES.has('150')).toBe(false);
		expect(await lookupPin('150001', { fetch: f })).toBeNull();
		expect(await lookupPin('111111', { fetch: f })).toBeNull();
		expect(f.calls).toEqual([]);
		expect(await lookupPin('560001', { fetch: f })).toEqual({ city: 'Bengaluru', state: 'Karnataka' });
		expect(f.calls).toEqual(['/pin/560.json']);
		// An injected set (tests, a refreshed build) is honoured.
		expect(await lookupPin('560001', { fetch: f, prefixes: new Set(['110']) })).toBeNull();
	});

	it('the generated prefix set is exactly the shipped shards (re-run build-pin-shards.mjs --prefixes-only after a refresh)', () => {
		const shipped = fs
			.readdirSync(new URL('../../../static/pin/', import.meta.url))
			.filter((f) => /^\d{3}\.json$/.test(f))
			.map((f) => f.slice(0, 3))
			.sort();
		expect(shipped.length).toBeGreaterThan(300);
		expect([...PIN_PREFIXES].sort()).toEqual(shipped);
	});

	it('a shard that is not an object → null', async () => {
		expect(await lookupPin('560001', { fetch: fetcher({ '/pin/560.json': ['x'] }) })).toBeNull();
	});
});

describe('planPinFill (S5; W2V2-3: never under the caret)', () => {
	const HIT = { city: 'Mysuru', state: 'Karnataka' };
	const NONE = { city: false, state: false };

	it('empty fields, customer elsewhere: fills both', () => {
		expect(planPinFill(HIT, { city: '', state: '' }, NONE)).toEqual({ fill: { city: 'Mysuru', state: 'Karnataka' }, hold: {} });
		expect(planPinFill(HIT, { city: '   ', state: '' }, NONE, null).fill.city).toBe('Mysuru');
	});

	it('the field the customer is in is held, not filled (the "MysuruMysore" race); the other still fills', () => {
		expect(planPinFill(HIT, { city: '', state: '' }, NONE, 'city')).toEqual({ fill: { state: 'Karnataka' }, hold: { city: 'Mysuru' } });
		expect(planPinFill(HIT, { city: '', state: '' }, NONE, 'state')).toEqual({ fill: { city: 'Mysuru' }, hold: { state: 'Karnataka' } });
		// an earlier answer's value in the focused field is held too (the customer may be about to type)
		expect(planPinFill(HIT, { city: 'Bengaluru', state: 'Karnataka' }, { city: true, state: true }, 'city')).toEqual({ fill: {}, hold: { city: 'Mysuru' } });
	});

	it('never over what the customer typed or picked — focused or not', () => {
		for (const focused of [null, 'city', 'state']) {
			expect(planPinFill(HIT, { city: 'Mysore', state: 'Kerala' }, NONE, focused)).toEqual({ fill: {}, hold: {} });
		}
	});

	it('an earlier answer follows the new PIN; an unchanged value is left alone', () => {
		expect(planPinFill(HIT, { city: 'Bengaluru', state: 'Maharashtra' }, { city: true, state: true })).toEqual({ fill: { city: 'Mysuru', state: 'Karnataka' }, hold: {} });
		expect(planPinFill(HIT, { city: 'Mysuru', state: 'Karnataka' }, { city: true, state: true }, 'city')).toEqual({ fill: {}, hold: {} });
	});

	it('partial or junk answers', () => {
		expect(planPinFill({ city: '', state: 'Karnataka' }, { city: '', state: '' }, NONE)).toEqual({ fill: { state: 'Karnataka' }, hold: {} });
		expect(planPinFill({ city: 'Mysuru' }, { city: '', state: '' }, NONE, 'city')).toEqual({ fill: {}, hold: { city: 'Mysuru' } });
		for (const junk of [null, undefined, 'Mysuru', { city: 42 }]) expect(planPinFill(junk, { city: '', state: '' }, NONE)).toEqual({ fill: {}, hold: {} });
		expect(planPinFill(HIT, {}, undefined)).toEqual({ fill: { city: 'Mysuru', state: 'Karnataka' }, hold: {} });
	});
});

describe('the shipped shards (static/pin)', () => {
	const dir = new URL('../../../static/pin/', import.meta.url);
	const files = fs.readdirSync(dir).filter((f) => /^\d{3}\.json$/.test(f));

	it('cover every prefix 110–855 region, with credits', () => {
		expect(files.length).toBeGreaterThan(350);
		expect(fs.readFileSync(new URL('CREDITS.txt', dir), 'utf8')).toMatch(/GeoNames[\s\S]*CC|Creative Commons Attribution 4\.0/);
	});

	it('the acceptance PINs resolve as expected', () => {
		const read = (p) => JSON.parse(fs.readFileSync(new URL(p.slice(0, 3) + '.json', dir), 'utf8'))[p.slice(3)];
		expect(read('560001')).toEqual(['Bengaluru', 'Karnataka']);
		expect(read('400001')).toEqual(['Mumbai', 'Maharashtra']);
		expect(read('600001')[1]).toBe('Tamil Nadu');
		expect(read('194101')).toEqual(['Leh', 'Ladakh']);
		expect(read('190001')[1]).toBe('Jammu and Kashmir');
	});

	it('every entry is [city, official state], every shard key 3 digits, files small', () => {
		const states = new Set(INDIAN_STATES);
		const bad = [];
		let entries = 0;
		for (const f of files) {
			const raw = fs.readFileSync(new URL(f, dir), 'utf8');
			if (raw.length >= 16 * 1024) bad.push(`${f}: ${raw.length} bytes`);
			for (const [k, v] of Object.entries(JSON.parse(raw))) {
				entries++;
				const ok = /^\d{3}$/.test(k) && Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && states.has(v[1]);
				if (!ok) bad.push(`${f}#${k}: ${JSON.stringify(v)}`);
			}
		}
		expect(bad).toEqual([]);
		expect(entries).toBeGreaterThan(19000);
	});
});

describe('recipeCardsFor (/order "Make something with it")', () => {
	it('each card equals recipes-content’s card for the same (wf-) slug', () => {
		for (const r of snapshotRecipes) expect(recipeCard(r)).toEqual(recipesContent[r.slug].card);
	});

	it('spreads across the ordered products, max 2, wf- slugs that exist', () => {
		const two = recipeCardsFor(['muesli', 'cornflakes']);
		expect(two.length).toBe(2);
		for (const c of two) expect(Object.keys(recipesContent)).toContain(c.slug);
		const usesMuesli = snapshotRecipes.find((r) => r.slug === two[0].slug).products.some((p) => p.slug === 'muesli');
		const usesCorn = snapshotRecipes.find((r) => r.slug === two[1].slug).products.some((p) => p.slug === 'cornflakes');
		expect(usesMuesli && usesCorn).toBe(true);
	});

	it('one product → its first two recipes; unknown products → none', () => {
		const one = recipeCardsFor(['muesli']);
		const expected = snapshotRecipes.filter((r) => r.products.some((p) => p.slug === 'muesli')).slice(0, 2).map((r) => r.slug);
		expect(one.map((c) => c.slug)).toEqual(expected);
		expect(recipeCardsFor(['nope', null])).toEqual([]);
		expect(recipeCardsFor(null)).toEqual([]);
	});

	it('every product in the catalog has at least one recipe card', () => {
		const slugs = new Set(snapshotRecipes.flatMap((r) => r.products.map((p) => p.slug)));
		for (const s of slugs) expect(recipeCardsFor([s]).length).toBeGreaterThan(0);
	});
});
