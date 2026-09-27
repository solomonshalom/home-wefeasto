/*
 * Test fixtures for the shared commerce module: today's catalog (prices in
 * paise, catalog order as in src/lib/data/products.js) and a seeded PRNG so
 * the randomized property tests are reproducible.
 */

/** @returns {import('$shared/pricing.js').CatalogItem[]} */
export function makeCatalog(overrides = {}) {
	return [
		['cornflakes', 'Cornflakes', 17500],
		['steel-cut-oats', 'Steel-Cut Oats', 13500],
		['rolled-oats', 'Rolled Oats', 12500],
		['muesli', 'Muesli', 25000],
		['choco-flakes', 'Choco’s', 20000],
		['health-mix', 'Health Mix', 27000]
	].map(([slug, name, pricePaise]) => ({
		slug,
		name,
		pricePaise,
		inStock: true,
		maxPerOrder: 10,
		codAllowed: true,
		...(overrides[slug] || {})
	}));
}

export const PRICES = {
	cornflakes: 17500,
	'steel-cut-oats': 13500,
	'rolled-oats': 12500,
	muesli: 25000,
	'choco-flakes': 20000,
	'health-mix': 27000
};

export const SLUGS = Object.keys(PRICES);

/** mulberry32 — tiny deterministic PRNG. */
export function prng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		pick: (arr) => arr[Math.floor(next() * arr.length)],
		bool: (p = 0.5) => next() < p,
		shuffle(arr) {
			const a2 = arr.slice();
			for (let i = a2.length - 1; i > 0; i--) {
				const j = Math.floor(next() * (i + 1));
				[a2[i], a2[j]] = [a2[j], a2[i]];
			}
			return a2;
		}
	};
}

/** A character by code point — keeps invisible characters out of the source text. */
export const ch = (cp) => String.fromCodePoint(cp);
