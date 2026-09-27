// @vitest-environment jsdom
/*
 * The storefront runs this module in the browser. Load it in a DOM
 * environment and exercise the paths the cart/checkout pages will call.
 */
import { describe, it, expect } from 'vitest';
import { quote, topUpSuggestion, cartToItems, parseAddParam, buildCartLink, validateCheckoutForm, formatPaise, publicSettings, INDIAN_STATES } from '$shared/index.js';
import { makeCatalog } from './_fixtures.js';

describe('shared module in a browser-like environment', () => {
	it('runs the cart page flow', () => {
		expect(typeof window).toBe('object');
		const settings = publicSettings();
		const catalog = makeCatalog();
		// a hand-edited wefeasto_cart value (as JSON text, the way localStorage returns it;
		// jsdom's localStorage is not usable under Node 25 + vitest, so no real storage here)
		const stored = JSON.parse('{"muesli":1,"cornflakes":"1","ghost":3,"oats":-2}');
		const q = quote({ items: cartToItems(stored), catalog, settings });
		expect(formatPaise(q.subtotalPaise)).toBe('₹425');
		expect(formatPaise(q.deliveryPaise)).toBe('₹49');
		expect(formatPaise(q.totalPaise)).toBe('₹474');
		expect(q.issues.map((i) => i.slug)).toEqual(['ghost']);
		expect(topUpSuggestion(stored, catalog, settings)?.slug).toBe('rolled-oats');

		const url = new URL('https://wefeasto.com' + buildCartLink({ muesli: 2 }, { src: 'email' }));
		expect(parseAddParam(url.searchParams.get('add'), catalog).lines).toEqual([{ slug: 'muesli', qty: 2 }]);
		expect(validateCheckoutForm({ name: 'Asha', email: 'a@b.co', phone: '9845262777', line1: '12 MG Road', city: 'Bengaluru', state: INDIAN_STATES[15], pin: '560001' }).ok).toBe(true);
	});
});
