import { describe, it, expect } from 'vitest';
import {
	parseItems,
	cartToItems,
	buildLines,
	freeDelivery,
	codAvailability,
	quote,
	indexCatalog,
	MAX_LINES,
	MAX_RAW_ITEMS,
	MAX_UNIT_PAISE
} from '$shared/pricing.js';
import { makeCatalog } from './_fixtures.js';

const catalog = makeCatalog();
const T0 = Date.parse('2026-09-25T10:00:00Z');

describe('parseItems (strict request parser)', () => {
	it('merges duplicate slugs and ignores client price fields', () => {
		const r = parseItems([
			{ slug: 'muesli', qty: 2, price: 1, pricePaise: 1 },
			{ slug: 'cornflakes', qty: '1' },
			{ slug: 'muesli', qty: '1' }
		]);
		expect(r).toEqual({ ok: true, items: [{ slug: 'muesli', qty: 3 }, { slug: 'cornflakes', qty: 1 }] });
	});

	it('passes unknown-but-well-formed slugs through (quote reports UNAVAILABLE)', () => {
		expect(parseItems([{ slug: 'granola', qty: 1 }])).toEqual({ ok: true, items: [{ slug: 'granola', qty: 1 }] });
	});

	it.each([
		['string', 'nope', 'VALIDATION'],
		['object', { slug: 'muesli', qty: 1 }, 'VALIDATION'],
		['null', null, 'VALIDATION'],
		['empty', [], 'EMPTY_CART'],
		['null row', [null], 'VALIDATION'],
		['array row', [['muesli', 1]], 'VALIDATION'],
		['__proto__', [{ slug: '__proto__', qty: 1 }], 'BAD_SLUG'],
		['uppercase', [{ slug: 'Cornflakes', qty: 1 }], 'BAD_SLUG'],
		['overlong', [{ slug: 'x'.repeat(65), qty: 1 }], 'BAD_SLUG'],
		['numeric slug', [{ slug: 5, qty: 1 }], 'BAD_SLUG'],
		['missing slug', [{ qty: 1 }], 'BAD_SLUG'],
		['qty 0', [{ slug: 'muesli', qty: 0 }], 'BAD_QTY'],
		['qty -3', [{ slug: 'muesli', qty: -3 }], 'BAD_QTY'],
		['qty 2.5', [{ slug: 'muesli', qty: 2.5 }], 'BAD_QTY'],
		['qty "1e3"', [{ slug: 'muesli', qty: '1e3' }], 'BAD_QTY'],
		['qty "0x10"', [{ slug: 'muesli', qty: '0x10' }], 'BAD_QTY'],
		['qty " 3"', [{ slug: 'muesli', qty: ' 3' }], 'BAD_QTY'],
		['qty true', [{ slug: 'muesli', qty: true }], 'BAD_QTY'],
		['qty []', [{ slug: 'muesli', qty: [] }], 'BAD_QTY'],
		['qty Infinity', [{ slug: 'muesli', qty: Infinity }], 'BAD_QTY'],
		['qty 99999', [{ slug: 'muesli', qty: 99999 }], 'BAD_QTY'],
		['qty missing', [{ slug: 'muesli' }], 'BAD_QTY']
	])('%s → %s', (_label, raw, code) => {
		const r = parseItems(raw);
		expect(r.ok).toBe(false);
		expect(/** @type {any} */ (r).error.code).toBe(code);
	});

	it('reports index and a bounded slug', () => {
		const r = /** @type {any} */ (parseItems([{ slug: 'muesli', qty: 1 }, { slug: 'y'.repeat(100), qty: 1 }]));
		expect(r.error).toEqual({ code: 'BAD_SLUG', details: { index: 1, slug: 'y'.repeat(64) } });
		const q = /** @type {any} */ (parseItems([{ slug: 'muesli', qty: 1 }, { slug: 'oats', qty: 'x' }]));
		expect(q.error).toEqual({ code: 'BAD_QTY', details: { index: 1, slug: 'oats' } });
	});

	it('line limits', () => {
		const distinct = (n) => Array.from({ length: n }, (_, i) => ({ slug: `p${i}`, qty: 1 }));
		expect(parseItems(distinct(MAX_LINES)).ok).toBe(true);
		expect(/** @type {any} */ (parseItems(distinct(MAX_LINES + 1))).error.code).toBe('TOO_MANY_LINES');
		const rows = Array.from({ length: MAX_RAW_ITEMS }, () => ({ slug: 'muesli', qty: 1 }));
		expect(parseItems(rows)).toEqual({ ok: true, items: [{ slug: 'muesli', qty: MAX_RAW_ITEMS }] });
		expect(/** @type {any} */ (parseItems([...rows, { slug: 'muesli', qty: 1 }])).error.code).toBe('TOO_MANY_LINES');
	});
});

describe('cartToItems (tolerant localStorage reader)', () => {
	it('drops garbage, caps at 20, keeps key order', () => {
		const stored = {
			cornflakes: 2,
			'ghost product': 5,
			muesli: 'abc',
			oats: -3,
			'rolled-oats': '2',
			'health-mix': 1e9,
			'choco-flakes': 2.7,
			__proto__x: 1,
			'steel-cut-oats': 0
		};
		expect(cartToItems(stored)).toEqual([
			{ slug: 'cornflakes', qty: 2 },
			{ slug: 'rolled-oats', qty: 2 },
			{ slug: 'health-mix', qty: 20 },
			{ slug: 'choco-flakes', qty: 2 }
		]);
	});

	it.each([[null], [undefined], ['{}'], [[{ slug: 'muesli', qty: 1 }]], [42]])('non-map %j → []', (v) => {
		expect(cartToItems(v)).toEqual([]);
	});
});

describe('buildLines', () => {
	it('prices known lines with names and defaults', () => {
		const cat = makeCatalog({ muesli: { codAllowed: false, image: '/images/wefeasto/product-muesli.jpg' }, cornflakes: { maxPerOrder: undefined, codAllowed: undefined } });
		const { lines, issues } = buildLines([{ slug: 'muesli', qty: 2 }, { slug: 'cornflakes', qty: 1 }], cat);
		expect(issues).toEqual([]);
		expect(lines).toEqual([
			{ slug: 'muesli', name: 'Muesli', unitPaise: 25000, qty: 2, lineTotalPaise: 50000, codAllowed: false, maxPerOrder: 10, image: '/images/wefeasto/product-muesli.jpg' },
			{ slug: 'cornflakes', name: 'Cornflakes', unitPaise: 17500, qty: 1, lineTotalPaise: 17500, codAllowed: true, maxPerOrder: 10 }
		]);
	});

	it('accepts a cart map and a Map catalog identically', () => {
		const a = buildLines({ muesli: 1, cornflakes: '2' }, catalog);
		const b = buildLines([{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: '2' }], indexCatalog(catalog));
		expect(a).toEqual(b);
		expect(a.lines.map((l) => l.qty)).toEqual([1, 2]);
	});

	it('merges duplicates before applying caps', () => {
		const { lines, issues } = buildLines([{ slug: 'muesli', qty: 6 }, { slug: 'muesli', qty: 6 }], catalog);
		expect(lines).toEqual([]);
		expect(issues).toEqual([{ slug: 'muesli', name: 'Muesli', code: 'QTY_LIMIT', requestedQty: 12, max: 10, suggestedQty: 10 }]);
		expect(buildLines([{ slug: 'muesli', qty: 4 }, { slug: 'muesli', qty: 6 }], catalog).lines[0].qty).toBe(10);
	});

	it('UNAVAILABLE: unknown, malformed, prototype keys, unpublished, broken prices', () => {
		const cat = [
			...makeCatalog(),
			{ slug: 'draft-granola', name: 'Granola', pricePaise: 19900, published: false },
			{ slug: 'free-thing', name: 'Free', pricePaise: 0 },
			{ slug: 'neg', name: 'Neg', pricePaise: -100 },
			{ slug: 'float', name: 'Float', pricePaise: 199.5 },
			{ slug: 'str', name: 'Str', pricePaise: '19900' },
			{ slug: 'huge', name: 'Huge', pricePaise: MAX_UNIT_PAISE + 1 }
		];
		const slugs = ['ghost', '__proto__', 'constructor', 'toString', 'Cornflakes', 'draft-granola', 'free-thing', 'neg', 'float', 'str', 'huge'];
		const { lines, issues } = buildLines(
			slugs.map((slug) => ({ slug, qty: 1 })),
			cat
		);
		expect(lines).toEqual([]);
		expect(issues.map((i) => [i.slug, i.code, i.suggestedQty])).toEqual(slugs.map((s) => [s, 'UNAVAILABLE', 0]));
		expect(issues.find((i) => i.slug === 'draft-granola')?.name).toBe('Granola');
		expect(issues.find((i) => i.slug === 'ghost')?.name).toBe('ghost');
	});

	it('a long garbage slug never aliases a real 64-char product slug', () => {
		const long = 'x'.repeat(64);
		const cat = [{ slug: long, name: 'Long', pricePaise: 100 }];
		const r = buildLines([{ slug: long + 'x', qty: 1 }], cat);
		expect(r.lines).toEqual([]);
		expect(r.issues[0].code).toBe('UNAVAILABLE');
		expect(buildLines([{ slug: long, qty: 1 }], cat).lines).toHaveLength(1);
	});

	it('OUT_OF_STOCK and QTY_LIMIT with suggestions', () => {
		const cat = makeCatalog({
			'rolled-oats': { inStock: false },
			muesli: { stock: 3 },
			cornflakes: { stock: 30 },
			'health-mix': { stock: 5 },
			'choco-flakes': { stock: 0 },
			'steel-cut-oats': { stock: null }
		});
		const { lines, issues } = buildLines(
			{ 'rolled-oats': 1, muesli: 5, cornflakes: 12, 'health-mix': 12, 'choco-flakes': 1, 'steel-cut-oats': 10 },
			cat
		);
		expect(lines.map((l) => [l.slug, l.qty])).toEqual([['steel-cut-oats', 10]]);
		expect(issues).toEqual([
			{ slug: 'rolled-oats', name: 'Rolled Oats', code: 'OUT_OF_STOCK', requestedQty: 1, available: 0, suggestedQty: 0 },
			{ slug: 'muesli', name: 'Muesli', code: 'OUT_OF_STOCK', requestedQty: 5, available: 3, suggestedQty: 3 },
			{ slug: 'cornflakes', name: 'Cornflakes', code: 'QTY_LIMIT', requestedQty: 12, max: 10, suggestedQty: 10 },
			{ slug: 'health-mix', name: 'Health Mix', code: 'OUT_OF_STOCK', requestedQty: 12, available: 5, suggestedQty: 5 },
			{ slug: 'choco-flakes', name: 'Choco’s', code: 'OUT_OF_STOCK', requestedQty: 1, available: 0, suggestedQty: 0 }
		]);
	});

	it('stock exactly equal to qty is fine; maxPerOrder is per product', () => {
		const cat = makeCatalog({ muesli: { stock: 3, maxPerOrder: 3 }, cornflakes: { maxPerOrder: 2 } });
		expect(buildLines({ muesli: 3 }, cat).lines[0].qty).toBe(3);
		expect(buildLines({ cornflakes: 3 }, cat).issues[0]).toMatchObject({ code: 'QTY_LIMIT', max: 2, suggestedQty: 2 });
	});

	it('BAD_QTY for garbage quantities (poisons duplicates of the same slug)', () => {
		const { lines, issues } = buildLines(
			[
				{ slug: 'muesli', qty: -1 },
				{ slug: 'muesli', qty: 2 },
				{ slug: 'cornflakes', qty: 2 },
				{ slug: 'cornflakes', qty: 2.5 },
				{ slug: 'health-mix', qty: '1e3' }
			],
			catalog
		);
		expect(lines).toEqual([]);
		expect(issues.map((i) => [i.slug, i.code, i.requestedQty])).toEqual([
			['muesli', 'BAD_QTY', null],
			['cornflakes', 'BAD_QTY', null],
			['health-mix', 'BAD_QTY', null]
		]);
	});

	it('junk inputs never throw', () => {
		for (const items of [null, undefined, 'x', 42, [null, 1, 'a', { slug: {} }], new Map([['muesli', 1]])]) {
			expect(() => buildLines(items, catalog)).not.toThrow();
		}
		for (const cat of [null, undefined, 'x', [null, { slug: 5 }], {}]) {
			expect(buildLines({ muesli: 1 }, cat).issues[0].code).toBe('UNAVAILABLE');
		}
	});

	it('first catalog entry wins for duplicate slugs', () => {
		const cat = [
			{ slug: 'muesli', name: 'A', pricePaise: 100 },
			{ slug: 'muesli', name: 'B', pricePaise: 999 }
		];
		expect(buildLines({ muesli: 1 }, cat).lines[0].unitPaise).toBe(100);
	});
});

describe('freeDelivery (pre-discount subtotal)', () => {
	it.each([
		[0, 0, false, 49900, 0],
		[1, 4900, false, 49899, 1 / 49900],
		[17500, 4900, false, 32400, 17500 / 49900],
		[49800, 4900, false, 100, 49800 / 49900], // ₹498 — "add ₹1 more"
		[49899, 4900, false, 1, 49899 / 49900],
		[49900, 0, true, 0, 1], // ₹499 exactly → free
		[49901, 0, true, 0, 1],
		[50000, 0, true, 0, 1],
		[1_000_000, 0, true, 0, 1]
	])('subtotal %s → delivery %s, free %s, to go %s', (subtotal, delivery, isFree, toGo, progress) => {
		const r = freeDelivery(subtotal, {});
		expect(r.deliveryPaise).toBe(delivery);
		expect(r.isFreeDelivery).toBe(isFree);
		expect(r.amountToFreeDeliveryPaise).toBe(toGo);
		expect(r.freeDeliveryProgress).toBeCloseTo(progress, 12);
		expect(r.thresholdPaise).toBe(49900);
	});

	it('uses settings', () => {
		expect(freeDelivery(30000, { freeDeliveryThresholdPaise: 30000 }).deliveryPaise).toBe(0);
		expect(freeDelivery(29999, { freeDeliveryThresholdPaise: 30000, deliveryFeePaise: 3900 }).deliveryPaise).toBe(3900);
	});

	it('delivery fee 0 → every non-empty bag is free delivery, nothing left to go (HUNT data-cms r2)', () => {
		expect(freeDelivery(100, { deliveryFeePaise: 0 })).toEqual({ deliveryPaise: 0, isFreeDelivery: true, thresholdPaise: 49900, amountToFreeDeliveryPaise: 0, freeDeliveryProgress: 1 });
		expect(freeDelivery(25000, { deliveryFeePaise: 0, freeDeliveryThresholdPaise: 49900 })).toMatchObject({ isFreeDelivery: true, amountToFreeDeliveryPaise: 0 });
		expect(freeDelivery(60000, { deliveryFeePaise: 0 })).toMatchObject({ deliveryPaise: 0, isFreeDelivery: true, amountToFreeDeliveryPaise: 0, freeDeliveryProgress: 1 });
		// An empty bag is still not "free delivery" (nothing to deliver).
		expect(freeDelivery(0, { deliveryFeePaise: 0 })).toMatchObject({ deliveryPaise: 0, isFreeDelivery: false, amountToFreeDeliveryPaise: 49900, freeDeliveryProgress: 0 });
	});

	it('threshold 0 → everything non-empty is free', () => {
		expect(freeDelivery(100, { freeDeliveryThresholdPaise: 0 })).toEqual({ deliveryPaise: 0, isFreeDelivery: true, thresholdPaise: 0, amountToFreeDeliveryPaise: 0, freeDeliveryProgress: 1 });
		expect(freeDelivery(0, { freeDeliveryThresholdPaise: 0 })).toMatchObject({ deliveryPaise: 0, isFreeDelivery: false, freeDeliveryProgress: 0 });
	});

	it.each([[-100], [NaN], [1.5], ['49900'], [undefined]])('junk subtotal %j is treated as empty', (v) => {
		expect(freeDelivery(v, {})).toMatchObject({ deliveryPaise: 0, amountToFreeDeliveryPaise: 49900, freeDeliveryProgress: 0 });
	});
});

describe('codAvailability', () => {
	const line = (codAllowed = true) => ({ slug: 'muesli', name: 'Muesli', unitPaise: 25000, qty: 1, lineTotalPaise: 25000, codAllowed, maxPerOrder: 10 });
	const base = { lines: [line()], subtotalPaise: 25000, codTotalPaise: 29900 };

	it.each([
		['available', {}, {}, true, null],
		['disabled', { settings: { codEnabled: false } }, {}, false, 'DISABLED'],
		['empty', { lines: [], subtotalPaise: 0, codTotalPaise: 0 }, {}, false, 'EMPTY'],
		['item not allowed', { lines: [line(), line(false)] }, {}, false, 'ITEM_NOT_ALLOWED'],
		['pin blocked', { pin: '744101', settings: { codBlockedPinPrefixes: ['744'] } }, {}, false, 'PIN_BLOCKED'],
		['pin fine', { pin: '560001', settings: { codBlockedPinPrefixes: ['744'] } }, {}, true, null],
		['no pin → not checked', { settings: { codBlockedPinPrefixes: ['5'] } }, {}, true, null],
		['below min subtotal', { settings: { codMinSubtotalPaise: 30000 } }, {}, false, 'BELOW_MIN'],
		['min subtotal met exactly', { settings: { codMinSubtotalPaise: 25000 } }, {}, true, null],
		['above max', { codTotalPaise: 200001 }, {}, false, 'ABOVE_MAX'],
		['at max exactly', { codTotalPaise: 200000 }, {}, true, null],
		['disabled wins over everything', { settings: { codEnabled: false }, lines: [], codTotalPaise: 9e9 }, {}, false, 'DISABLED'],
		['item beats pin/min/max', { lines: [line(false)], pin: '744101', codTotalPaise: 9e9, settings: { codBlockedPinPrefixes: ['744'] } }, {}, false, 'ITEM_NOT_ALLOWED']
	])('%s', (_label, over, _unused, available, reason) => {
		const r = codAvailability({ ...base, ...over });
		expect(r).toEqual({ codAvailable: available, codUnavailableReason: reason });
	});
});

describe('quote', () => {
	it('Muesli + Cornflakes (UPI): honest totals', () => {
		const q = quote({ items: { muesli: 1, cornflakes: 1 }, catalog, settings: {}, method: 'upi' });
		expect(q).toMatchObject({
			itemCount: 2,
			subtotalPaise: 42500,
			discountPaise: 0,
			deliveryPaise: 4900,
			codFeePaise: 0,
			totalPaise: 47400,
			currency: 'INR',
			freeDeliveryThresholdPaise: 49900,
			amountToFreeDeliveryPaise: 7400,
			isFreeDelivery: false,
			codAvailable: true,
			codUnavailableReason: null,
			pinServiceable: null,
			coupon: null,
			couponError: null,
			orderError: null,
			canCheckout: true,
			method: 'upi',
			issues: []
		});
		expect(q.freeDeliveryProgress).toBeCloseTo(42500 / 49900, 12);
	});

	it('delivery fee 0 through the quote: FREE below the threshold, nothing to go (HUNT data-cms r2)', () => {
		const q = quote({ items: { muesli: 1 }, catalog, settings: { deliveryFeePaise: 0 }, method: 'upi' });
		expect(q).toMatchObject({ subtotalPaise: 25000, deliveryPaise: 0, totalPaise: 25000, isFreeDelivery: true, amountToFreeDeliveryPaise: 0, freeDeliveryThresholdPaise: 49900, freeDeliveryProgress: 1 });
	});

	it('₹499 boundary through the quote', () => {
		const cat = [{ slug: 'unit', name: 'Unit', pricePaise: 100, maxPerOrder: 9999 }];
		const at = (rupees) => quote({ items: [{ slug: 'unit', qty: rupees }], catalog: cat });
		expect(at(498)).toMatchObject({ subtotalPaise: 49800, deliveryPaise: 4900, totalPaise: 54700, amountToFreeDeliveryPaise: 100 });
		expect(at(499)).toMatchObject({ subtotalPaise: 49900, deliveryPaise: 0, totalPaise: 49900, isFreeDelivery: true });
		expect(at(500)).toMatchObject({ subtotalPaise: 50000, deliveryPaise: 0, totalPaise: 50000 });
	});

	it('COD fee only for method=cod, shown in the total', () => {
		const settings = { codFeePaise: 2500 };
		const cod = quote({ items: { muesli: 1 }, catalog, settings, method: 'cod' });
		expect(cod).toMatchObject({ subtotalPaise: 25000, deliveryPaise: 4900, codFeePaise: 2500, totalPaise: 32400, method: 'cod' });
		const upi = quote({ items: { muesli: 1 }, catalog, settings, method: 'upi' });
		expect(upi).toMatchObject({ codFeePaise: 0, totalPaise: 29900 });
		const junk = quote({ items: { muesli: 1 }, catalog, settings, method: 'bitcoin' });
		expect(junk).toMatchObject({ codFeePaise: 0, method: null });
		expect(quote({ items: { muesli: 1 }, catalog, settings }).method).toBeNull();
	});

	it('COD availability is judged on the COD total even when paying by UPI', () => {
		const cat = [{ slug: 'big', name: 'Big', pricePaise: 199900 }];
		const settings = { codFeePaise: 100 };
		expect(quote({ items: { big: 1 }, catalog: cat, settings, method: 'upi' }).codAvailable).toBe(true); // 199900 + 100 = 200000
		const cat2 = [{ slug: 'big', name: 'Big', pricePaise: 199901 }];
		const q = quote({ items: { big: 1 }, catalog: cat2, settings, method: 'upi' });
		expect(q).toMatchObject({ codAvailable: false, codUnavailableReason: 'ABOVE_MAX', canCheckout: true });
	});

	it('COD ABOVE_MAX with today’s catalog: 8 × Health Mix', () => {
		const q = quote({ items: { 'health-mix': 8 }, catalog, method: 'cod' });
		expect(q).toMatchObject({ totalPaise: 216000, codAvailable: false, codUnavailableReason: 'ABOVE_MAX' });
	});

	it('COD ITEM_NOT_ALLOWED and PIN_BLOCKED', () => {
		const cat = makeCatalog({ muesli: { codAllowed: false } });
		expect(quote({ items: { muesli: 1, cornflakes: 1 }, catalog: cat }).codUnavailableReason).toBe('ITEM_NOT_ALLOWED');
		const q = quote({ items: { cornflakes: 1 }, catalog, settings: { codBlockedPinPrefixes: ['744'] }, context: { pin: '744101' } });
		expect(q).toMatchObject({ codAvailable: false, codUnavailableReason: 'PIN_BLOCKED', pinServiceable: true });
	});

	it('pinServiceable follows blockedPinPrefixes', () => {
		const settings = { blockedPinPrefixes: ['79'] };
		expect(quote({ items: { muesli: 1 }, catalog, settings, context: { pin: '791001' } }).pinServiceable).toBe(false);
		expect(quote({ items: { muesli: 1 }, catalog, settings, context: { pin: '560001' } }).pinServiceable).toBe(true);
		expect(quote({ items: { muesli: 1 }, catalog, settings }).pinServiceable).toBeNull();
	});

	it('empty bag: zero everything, EMPTY_CART, no COD fee', () => {
		for (const items of [{}, [], null, { muesli: -1 }, { ghost: 2 }]) {
			const q = quote({ items, catalog, settings: { codFeePaise: 2500 }, method: 'cod' });
			expect(q).toMatchObject({ subtotalPaise: 0, deliveryPaise: 0, codFeePaise: 0, discountPaise: 0, totalPaise: 0, amountToFreeDeliveryPaise: 49900, freeDeliveryProgress: 0, canCheckout: false });
			expect(q.orderError).toEqual({ code: 'EMPTY_CART' });
			expect(q.codUnavailableReason).toBe('EMPTY');
		}
	});

	it('issue lines are excluded from totals and block checkout', () => {
		const cat = makeCatalog({ 'rolled-oats': { inStock: false } });
		const q = quote({ items: { muesli: 1, 'rolled-oats': 2, ghost: 1 }, catalog: cat });
		expect(q.lines.map((l) => l.slug)).toEqual(['muesli']);
		expect(q.issues.map((i) => i.code)).toEqual(['OUT_OF_STOCK', 'UNAVAILABLE']);
		expect(q).toMatchObject({ subtotalPaise: 25000, deliveryPaise: 4900, totalPaise: 29900, orderError: null, canCheckout: false });
	});

	it('ABOVE_MAX order cap from settings', () => {
		const q = quote({ items: { muesli: 3 }, catalog, settings: { maxOrderPaise: 50000 } });
		expect(q.orderError).toEqual({ code: 'ABOVE_MAX', limitPaise: 50000 });
		expect(q.canCheckout).toBe(false);
		expect(quote({ items: { muesli: 2 }, catalog, settings: { maxOrderPaise: 50000 } }).orderError).toBeNull(); // exactly at the cap
	});

	it('BELOW_MIN only when a tiny price and no fee put the total under ₹1', () => {
		const cat = [{ slug: 'mint', name: 'Mint', pricePaise: 50 }];
		expect(quote({ items: { mint: 1 }, catalog: cat }).orderError).toBeNull(); // 50 + 4900 delivery
		expect(quote({ items: { mint: 1 }, catalog: cat, settings: { deliveryFeePaise: 0 } }).orderError).toEqual({ code: 'BELOW_MIN', limitPaise: 100 });
	});

	describe('with a coupon', () => {
		const pct = (value, extra = {}) => ({ code: 'WELCOME10', type: 'percent', value, active: true, usedCount: 0, ...extra });

		it('percent off; delivery still judged on the PRE-discount subtotal', () => {
			const q = quote({ items: { muesli: 2 }, catalog, coupon: pct(10), context: { now: T0 } });
			// ₹500 bag qualifies for free delivery; ₹50 off does not take it away.
			expect(q).toMatchObject({ subtotalPaise: 50000, discountPaise: 5000, deliveryPaise: 0, totalPaise: 45000, isFreeDelivery: true });
			expect(q.coupon).toEqual({ code: 'WELCOME10', type: 'percent', discountPaise: 5000, deferredChecks: [] });
			expect(q.couponError).toBeNull();
		});

		it('below the threshold the fee stays; percent floors to whole rupees; cap applies', () => {
			const q = quote({ items: { muesli: 1, cornflakes: 1 }, catalog, coupon: pct(10, { maxDiscountPaise: 7500 }) });
			expect(q).toMatchObject({ subtotalPaise: 42500, discountPaise: 4200, deliveryPaise: 4900, totalPaise: 43200 });
			const big = quote({ items: { 'health-mix': 10 }, catalog, coupon: pct(10, { maxDiscountPaise: 7500 }) });
			expect(big.discountPaise).toBe(7500);
		});

		it('clamps: never more than the subtotal, never a total below ₹1', () => {
			const fixed = { code: 'BIGFIXED', type: 'fixed', value: 1_000_000 };
			const a = quote({ items: { muesli: 1 }, catalog, coupon: fixed });
			expect(a).toMatchObject({ subtotalPaise: 25000, discountPaise: 25000, deliveryPaise: 4900, totalPaise: 4900 });
			const b = quote({ items: { muesli: 2 }, catalog, coupon: pct(100) });
			expect(b).toMatchObject({ subtotalPaise: 50000, discountPaise: 49900, deliveryPaise: 0, totalPaise: 100 });
			const c = quote({ items: { muesli: 2 }, catalog, coupon: pct(100), settings: { codFeePaise: 2500 }, method: 'cod' });
			expect(c).toMatchObject({ discountPaise: 50000, codFeePaise: 2500, totalPaise: 2500 });
		});

		it('free_delivery coupon waives the fee as a discount', () => {
			const fd = { code: 'SHIPFREE', type: 'free_delivery' };
			expect(quote({ items: { cornflakes: 1 }, catalog, coupon: fd })).toMatchObject({ discountPaise: 4900, deliveryPaise: 4900, totalPaise: 17500 });
			expect(quote({ items: { muesli: 2 }, catalog, coupon: fd })).toMatchObject({ discountPaise: 0, totalPaise: 50000, couponError: null });
		});

		it('unknown code → NOT_FOUND; invalid coupon → error and no discount', () => {
			const nf = quote({ items: { muesli: 1 }, catalog, coupon: null, context: { couponCode: 'NOPE10' } });
			expect(nf).toMatchObject({ discountPaise: 0, coupon: null, couponError: { code: 'COUPON_INVALID', reason: 'NOT_FOUND' } });
			const expired = quote({ items: { muesli: 1 }, catalog, coupon: pct(10, { endsAt: T0 - 1 }), context: { now: T0 } });
			expect(expired).toMatchObject({ discountPaise: 0, coupon: null, couponError: { code: 'COUPON_INVALID', reason: 'EXPIRED' }, totalPaise: 29900 });
			expect(quote({ items: { muesli: 1 }, catalog, context: { couponCode: '   ' } }).couponError).toBeNull();
		});

		it('identity checks are deferred until the caller provides identity', () => {
			const welcome = pct(10, { boundEmail: 'asha@example.com', firstOrderOnly: true, perCustomerLimit: 1 });
			const early = quote({ items: { muesli: 1 }, catalog, coupon: welcome });
			expect(early.coupon?.deferredChecks).toEqual(['EMAIL', 'FIRST_ORDER', 'PER_CUSTOMER']);
			const ok = quote({ items: { muesli: 1 }, catalog, coupon: welcome, context: { email: 'ASHA@example.com', isFirstOrder: true, customerUsageCount: 0 } });
			expect(ok.coupon?.deferredChecks).toEqual([]);
			expect(ok.discountPaise).toBe(2500);
			const other = quote({ items: { muesli: 1 }, catalog, coupon: welcome, context: { email: 'someone@example.com', isFirstOrder: true, customerUsageCount: 0 } });
			expect(other.couponError).toEqual({ code: 'COUPON_INVALID', reason: 'EMAIL_MISMATCH' });
		});

		it('MIN_SUBTOTAL uses the pre-discount subtotal', () => {
			const c = pct(10, { minSubtotalPaise: 42500 });
			expect(quote({ items: { muesli: 1, cornflakes: 1 }, catalog, coupon: c }).discountPaise).toBe(4200);
			expect(quote({ items: { muesli: 1 }, catalog, coupon: c }).couponError?.reason).toBe('MIN_SUBTOTAL');
		});

		it('coupon discount can make COD available under the cap', () => {
			const cat = [{ slug: 'big', name: 'Big', pricePaise: 210000 }];
			expect(quote({ items: { big: 1 }, catalog: cat }).codAvailable).toBe(false);
			expect(quote({ items: { big: 1 }, catalog: cat, coupon: { code: 'TENK', type: 'fixed', value: 10000 } }).codAvailable).toBe(true);
		});
	});

	it('is deterministic, JSON-safe and catalog-shape independent', () => {
		const args = { items: [{ slug: 'muesli', qty: 1 }, { slug: 'ghost', qty: 1 }], catalog, settings: { codFeePaise: 500 }, method: 'cod', context: { pin: '560001' } };
		const a = quote(args);
		const b = quote(args);
		expect(a).toEqual(b);
		expect(JSON.parse(JSON.stringify(a))).toEqual(a);
		expect(quote({ ...args, catalog: indexCatalog(catalog) })).toEqual(a);
	});

	it('never mutates its inputs', () => {
		const items = [{ slug: 'muesli', qty: 1 }];
		const cat = makeCatalog();
		const settings = { blockedPinPrefixes: ['79'] };
		const before = JSON.stringify([items, cat, settings]);
		quote({ items, catalog: cat, settings, coupon: { code: 'X10', type: 'percent', value: 10 }, method: 'cod', context: { pin: '560001' } });
		expect(JSON.stringify([items, cat, settings])).toBe(before);
	});
});
