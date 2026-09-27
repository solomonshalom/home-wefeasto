import { describe, it, expect } from 'vitest';
import { productBySlug, formatINR } from '$lib/data/products.js';

describe('storefront test harness', () => {
	it('resolves $lib imports', () => {
		expect(productBySlug('cornflakes')?.price).toBe(175);
		expect(formatINR(1250)).toBe('₹1,250');
	});
});
