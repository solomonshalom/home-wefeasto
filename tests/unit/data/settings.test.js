import { describe, it, expect } from 'vitest';
import * as settingsModule from '$lib/data/settings.js';
import { PUBLIC_SETTINGS_DEFAULTS } from '$lib/data/snapshot-schema.js';
import { snapshotCopy } from './fixtures.js';

const { settings, catalogForPricing, productPaise } = settingsModule;
const snapshot = snapshotCopy();

describe('settings.js', () => {
	it('exports settings, catalogForPricing, productPaise — no policy pages (browser code imports this module)', () => {
		expect(Object.keys(settingsModule).sort()).toEqual(['catalogForPricing', 'productPaise', 'settings']);
	});

	it('settings === snapshot.settings (canonical public keys and values)', () => {
		expect(settings).toStrictEqual(snapshot.settings);
		expect(settings).toStrictEqual(PUBLIC_SETTINGS_DEFAULTS);
	});

	it('settings are deeply read-only (ESM is strict mode, so writes throw)', () => {
		expect(() => (settings.deliveryFeePaise = 0)).toThrow(TypeError);
		expect(() => (settings.legal.grievanceOfficer.name = 'x')).toThrow(TypeError);
		expect(() => (settings.announcement.enabled = true)).toThrow(TypeError);
		expect(settings.deliveryFeePaise).toBe(4900);
	});
});

describe('catalogForPricing()', () => {
	it('lists every product in catalog order with exactly the pricing fields', () => {
		expect(catalogForPricing()).toStrictEqual([
			{ slug: 'cornflakes', name: 'Cornflakes', pricePaise: 17500, inStock: true, maxPerOrder: 10, codAllowed: true },
			{ slug: 'steel-cut-oats', name: 'Steel-Cut Oats', pricePaise: 13500, inStock: true, maxPerOrder: 10, codAllowed: true },
			{ slug: 'rolled-oats', name: 'Rolled Oats', pricePaise: 12500, inStock: true, maxPerOrder: 10, codAllowed: true },
			{ slug: 'muesli', name: 'Muesli', pricePaise: 25000, inStock: true, maxPerOrder: 10, codAllowed: true },
			{ slug: 'choco-flakes', name: "Choco's", pricePaise: 20000, inStock: true, maxPerOrder: 10, codAllowed: true },
			{ slug: 'health-mix', name: 'Health Mix', pricePaise: 27000, inStock: true, maxPerOrder: 10, codAllowed: true }
		]);
	});

	it('returns fresh copies (a caller mutating its catalog cannot change prices for others)', () => {
		const a = catalogForPricing();
		a[0].pricePaise = 1;
		a.pop();
		const b = catalogForPricing();
		expect(b).toHaveLength(6);
		expect(b[0].pricePaise).toBe(17500);
		expect(productPaise('cornflakes')).toBe(17500);
	});
});

describe('productPaise()', () => {
	it.each([
		['cornflakes', 17500],
		['steel-cut-oats', 13500],
		['rolled-oats', 12500],
		['muesli', 25000],
		['choco-flakes', 20000],
		['health-mix', 27000]
	])('%s → %i', (slug, paise) => {
		expect(productPaise(slug)).toBe(paise);
	});

	it.each(['granola', '', 'Cornflakes', ' cornflakes', 'constructor', '__proto__', 'toString', null, undefined, 42, {}])(
		'unknown %j → null',
		(slug) => {
			expect(productPaise(slug)).toBeNull();
		}
	);
});
