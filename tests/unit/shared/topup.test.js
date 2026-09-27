import { describe, it, expect } from 'vitest';
import { topUpSuggestion, indexCatalog } from '$shared/pricing.js';
import { makeCatalog } from './_fixtures.js';

const catalog = makeCatalog();
const pick = (cart, cat = catalog, settings = {}, options) => topUpSuggestion(cart, cat, settings, options);

describe('topUpSuggestion — roadmap F1 worked examples (threshold ₹499, bias ₹50, today’s prices)', () => {
	it('Muesli (₹250) → Health Mix, +₹21 over', () => {
		expect(pick({ muesli: 1 })).toEqual({
			slug: 'health-mix',
			name: 'Health Mix',
			pricePaise: 27000,
			crosses: true,
			gapPaise: 24900,
			remainingAfterPaise: 0,
			overshootPaise: 2100,
			inCart: false
		});
	});

	it('Muesli + Cornflakes (₹425) → Rolled Oats, +₹51 over', () => {
		expect(pick({ muesli: 1, cornflakes: 1 })).toMatchObject({ slug: 'rolled-oats', crosses: true, gapPaise: 7400, overshootPaise: 5100 });
	});

	it('Muesli + Rolled Oats (₹375) → Steel-Cut Oats, +₹11 over', () => {
		expect(pick({ muesli: 1, 'rolled-oats': 1 })).toMatchObject({ slug: 'steel-cut-oats', crosses: true, gapPaise: 12400, overshootPaise: 1100 });
	});

	it('Cornflakes (₹175) → Health Mix, then ₹54 to go', () => {
		expect(pick({ cornflakes: 1 })).toEqual({
			slug: 'health-mix',
			name: 'Health Mix',
			pricePaise: 27000,
			crosses: false,
			gapPaise: 32400,
			remainingAfterPaise: 5400,
			overshootPaise: 0,
			inCart: false
		});
	});

	it('{muesli: -1} (₹0) → none', () => {
		expect(pick({ muesli: -1 })).toBeNull();
	});
});

describe('topUpSuggestion — more cases', () => {
	it.each([
		[{}, null],
		[{ muesli: 2 }, null], // ₹500 — already free
		[{ 'health-mix': 1, muesli: 1 }, null],
		[{ ghost: 3 }, null],
		[{ muesli: 'abc' }, null],
		[{ 'rolled-oats': 1 }, { slug: 'health-mix', crosses: false, remainingAfterPaise: 10400 }],
		[{ 'health-mix': 1 }, { slug: 'muesli', crosses: true, overshootPaise: 2100 }],
		[{ 'choco-flakes': 2 }, { slug: 'rolled-oats', crosses: true, overshootPaise: 2600 }],
		[{ 'rolled-oats': 3 }, { slug: 'steel-cut-oats', crosses: true, overshootPaise: 1100 }],
		// bias applies to in-bag SKUs but a 2nd Rolled Oats (₹61 over + ₹50) still beats Choco’s (₹136 over)
		[{ 'rolled-oats': 1, 'steel-cut-oats': 1, cornflakes: 1 }, { slug: 'rolled-oats', crosses: true, overshootPaise: 6100, inCart: true }],
		[{ muesli: '1', ghost: 5 }, { slug: 'health-mix' }] // string qty + unknown slug ignored
	])('%j → %j', (cart, expected) => {
		const r = pick(cart);
		if (expected === null) expect(r).toBeNull();
		else expect(r).toMatchObject(expected);
	});

	it('bias 0 behaves like "second pack" (B), bias ₹50 prefers discovery (C)', () => {
		expect(pick({ muesli: 1 }, catalog, { topUpDiscoveryBiasPaise: 0 })).toMatchObject({ slug: 'muesli', inCart: true, overshootPaise: 100 });
		expect(pick({ muesli: 1 }, catalog, { topUpDiscoveryBiasPaise: 5000 })).toMatchObject({ slug: 'health-mix', inCart: false });
		expect(pick({ muesli: 1 }, catalog, {})).toMatchObject({ slug: 'health-mix' }); // default bias ₹50
		expect(pick({ muesli: 1 }, catalog, { topUpDiscoveryBiasPaise: 1900 })).toMatchObject({ slug: 'muesli' }); // 100 + 1900 < 2100
		expect(pick({ muesli: 1 }, catalog, { topUpDiscoveryBiasPaise: 2000 })).toMatchObject({ slug: 'muesli' }); // tie at 2100 → lower price wins
		expect(pick({ muesli: 1 }, catalog, { topUpDiscoveryBiasPaise: 2001 })).toMatchObject({ slug: 'health-mix' });
	});

	it('never suggests an out-of-stock SKU', () => {
		const cat = makeCatalog({ 'health-mix': { inStock: false } });
		expect(pick({ muesli: 1 }, cat)).toMatchObject({ slug: 'muesli', crosses: true, inCart: true });
		const cat2 = makeCatalog({ 'health-mix': { stock: 0 }, muesli: { stock: 1 } });
		// Muesli: 1 in bag, stock 1 → no second pack; nothing else crosses → biggest step
		expect(pick({ muesli: 1 }, cat2)).toMatchObject({ slug: 'choco-flakes', crosses: false, remainingAfterPaise: 4900 });
	});

	it('respects maxPerOrder for the extra unit', () => {
		const cat = makeCatalog({ muesli: { maxPerOrder: 1 }, 'health-mix': { inStock: false } });
		expect(pick({ muesli: 1 }, cat)).toMatchObject({ slug: 'choco-flakes', crosses: false });
	});

	it('an over-limit line still counts as "in the bag"', () => {
		// muesli ×12 is a QTY_LIMIT issue (excluded from the subtotal) — never suggest a 13th
		const r = pick({ muesli: 12, cornflakes: 1 });
		expect(r).toMatchObject({ slug: 'health-mix', crosses: false });
		const noHealth = makeCatalog({ 'health-mix': { inStock: false } });
		expect(pick({ muesli: 12, cornflakes: 1 }, noHealth)).toMatchObject({ slug: 'choco-flakes' });
	});

	it('exclude = suggestions the customer already dismissed', () => {
		expect(pick({ muesli: 1 }, catalog, {}, { exclude: ['health-mix'] })).toMatchObject({ slug: 'muesli' });
		expect(pick({ muesli: 1 }, catalog, {}, { exclude: ['health-mix', 'muesli'] })).toMatchObject({ slug: 'choco-flakes', crosses: false });
		const all = catalog.map((p) => p.slug);
		expect(pick({ muesli: 1 }, catalog, {}, { exclude: all })).toBeNull();
		expect(pick({ muesli: 1 }, catalog, {}, { exclude: 'health-mix' })).toMatchObject({ slug: 'health-mix' }); // non-array ignored
	});

	it('ties → lower price → catalog order', () => {
		const cat = [
			{ slug: 'a', name: 'A', pricePaise: 30000 },
			{ slug: 'b', name: 'B', pricePaise: 30000 },
			{ slug: 'c', name: 'C', pricePaise: 20000 }
		];
		// bag = c (₹200), gap ₹299: a and b both overshoot by ₹1 → catalog order
		expect(pick({ c: 1 }, cat, { topUpDiscoveryBiasPaise: 0 })).toMatchObject({ slug: 'a', overshootPaise: 100 });
		expect(pick({ c: 1 }, [cat[1], cat[0], cat[2]], { topUpDiscoveryBiasPaise: 0 })).toMatchObject({ slug: 'b' });
		// equal score, different price → the cheaper SKU wins
		const cat2 = [
			{ slug: 'p', name: 'P', pricePaise: 26000 }, // not in bag: overshoot 1000
			{ slug: 'q', name: 'Q', pricePaise: 25000 } // in bag: overshoot 0 + bias 1000
		];
		const s2 = { freeDeliveryThresholdPaise: 50000, topUpDiscoveryBiasPaise: 1000 };
		expect(pick({ q: 1 }, cat2, s2)).toMatchObject({ slug: 'q', inCart: true, overshootPaise: 0 });
		expect(pick({ q: 1 }, cat2, { ...s2, topUpDiscoveryBiasPaise: 1001 })).toMatchObject({ slug: 'p', inCart: false });
	});

	it('threshold from settings', () => {
		expect(pick({ muesli: 1 }, catalog, { freeDeliveryThresholdPaise: 30000 })).toMatchObject({ slug: 'rolled-oats', gapPaise: 5000, overshootPaise: 7500 });
		expect(pick({ muesli: 1 }, catalog, { freeDeliveryThresholdPaise: 25000 })).toBeNull();
	});

	it('delivery fee 0 → delivery is already free, no top-up (HUNT data-cms r2)', () => {
		expect(pick({ muesli: 1 }, catalog, { deliveryFeePaise: 0 })).toBeNull();
		expect(pick({ muesli: 1 }, catalog, { deliveryFeePaise: 100 })).toMatchObject({ slug: 'health-mix', crosses: true });
	});

	it('gap larger than every price → the biggest not-in-bag step', () => {
		expect(pick({ 'rolled-oats': 1 }, catalog, { freeDeliveryThresholdPaise: 200000 })).toMatchObject({ slug: 'health-mix', crosses: false, remainingAfterPaise: 200000 - 12500 - 27000 });
		// all SKUs in the bag: bias applies uniformly, biggest price wins
		const all = Object.fromEntries(catalog.map((p) => [p.slug, 1]));
		expect(pick(all, catalog, { freeDeliveryThresholdPaise: 500000 })).toMatchObject({ slug: 'health-mix', inCart: true, crosses: false });
	});

	it('is independent of cart key order and catalog container', () => {
		const a = pick({ muesli: 1, cornflakes: 1, 'choco-flakes': 0 });
		const b = pick({ cornflakes: 1, 'choco-flakes': 0, muesli: 1 });
		const c = pick([{ slug: 'cornflakes', qty: 1 }, { slug: 'muesli', qty: 1 }]);
		const d = pick({ muesli: 1, cornflakes: 1 }, indexCatalog(catalog));
		expect(a).toEqual(b);
		expect(a).toEqual(c);
		expect(a).toEqual(d);
	});

	it('skips unpublished and mispriced catalog entries', () => {
		const cat = [...makeCatalog({ 'health-mix': { published: false } }), { slug: 'freebie', name: 'Free', pricePaise: 0 }, { slug: 'Bad Slug', name: 'Bad', pricePaise: 24900 }];
		expect(pick({ muesli: 1 }, cat)).toMatchObject({ slug: 'muesli' });
	});
});
