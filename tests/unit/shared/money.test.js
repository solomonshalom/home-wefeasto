import { describe, it, expect } from 'vitest';
import { formatPaise, formatPaiseExact, rupeesToPaise, paiseToRupees, isPaise, MIN_ORDER_PAISE } from '$shared/money.js';
import { prng } from './_fixtures.js';

// Frozen copy of the storefront's formatINR (src/lib/data/products.js) — the parity target.
const formatINR = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

describe('formatPaise', () => {
	it.each([
		[0, '₹0'],
		[100, '₹1'],
		[4900, '₹49'],
		[17500, '₹175'],
		[49900, '₹499'],
		[125000, '₹1,250'],
		[200000, '₹2,000'],
		[5000000, '₹50,000'],
		[10000000, '₹1,00,000'],
		[12345678900, '₹12,34,56,789'],
		[1750, '₹18'], // ₹17.50 rounds like formatINR
		[1749, '₹17'],
		[50, '₹1'],
		[49, '₹0'],
		[-125000, '₹-1,250']
	])('%s → %s', (p, out) => {
		expect(formatPaise(p)).toBe(out);
	});

	it('handles junk like formatINR (non-finite → ₹0)', () => {
		expect(formatPaise(NaN)).toBe('₹0');
		expect(formatPaise(undefined)).toBe('₹0');
		expect(formatPaise(null)).toBe('₹0');
		expect(formatPaise(Infinity)).toBe('₹0');
		expect(formatPaise(-0)).toBe('₹0');
		expect(formatPaise(-40)).toBe('₹0'); // formatINR would print '₹-0'; documented deviation
	});

	it('matches formatINR(p / 100) for 5000 random amounts', () => {
		const r = prng(20260925);
		for (let i = 0; i < 5000; i++) {
			const magnitude = r.pick([100, 10_000, 1_000_000, 100_000_000, 1e12, 1e15]);
			const p = r.int(0, magnitude);
			expect(formatPaise(p)).toBe(formatINR(p / 100));
		}
	});
});

describe('formatPaiseExact', () => {
	it.each([
		[0, '₹0'],
		[1700, '₹17'],
		[1750, '₹17.50'],
		[1705, '₹17.05'],
		[1, '₹0.01'],
		[12345678901, '₹12,34,56,789.01'],
		[-1750, '₹-17.50'],
		[NaN, '₹0']
	])('%s → %s', (p, out) => {
		expect(formatPaiseExact(p)).toBe(out);
	});
});

describe('rupeesToPaise / paiseToRupees', () => {
	it.each([
		[175, 17500],
		[0, 0],
		[1.1, 110],
		[0.29, 29], // 0.29*100 = 28.999999999999996
		[4.35, 435],
		[125.5, 12550],
		['175', 17500],
		['175.5', 17550],
		['175.50', 17550],
		['0.01', 1]
	])('%s → %s', (r, p) => {
		expect(rupeesToPaise(r)).toBe(p);
	});

	it.each([[-1], [NaN], [Infinity], ['1e3'], ['₹175'], [' 175'], ['175.505'], ['-5'], [''], [null], [undefined], [true], [[]], [{}], [1e300]])(
		'rejects %s',
		(r) => {
			expect(rupeesToPaise(r)).toBeNull();
		}
	);

	it('round-trips every catalog-sized rupee amount', () => {
		for (let rupees = 0; rupees <= 100_000; rupees += 7) {
			expect(paiseToRupees(rupeesToPaise(rupees))).toBe(rupees);
		}
	});

	it('paiseToRupees tolerates junk', () => {
		expect(paiseToRupees(12550)).toBe(125.5);
		expect(paiseToRupees(undefined)).toBe(0);
	});
});

describe('isPaise', () => {
	it.each([[0], [1], [49900], [Number.MAX_SAFE_INTEGER]])('%s is paise', (v) => expect(isPaise(v)).toBe(true));
	it.each([[-1], [1.5], [NaN], [Infinity], [2 ** 53], ['100'], [null], [undefined], [true]])('%s is not', (v) => expect(isPaise(v)).toBe(false));
	it('MIN_ORDER_PAISE is Razorpay’s ₹1 minimum', () => expect(MIN_ORDER_PAISE).toBe(100));
});
