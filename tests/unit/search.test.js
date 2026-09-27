/*
 * src/lib/search.js: queries and the index are folded the same way
 * (searchKey), so what a phone keyboard types matches what the CMS stores
 * (hunt w5-client-ux search-typographic-apostrophe), and ASCII queries rank
 * exactly as the original port did.
 */
import { describe, expect, it, vi } from 'vitest';

const { catalog } = vi.hoisted(() => ({
	catalog: {
		products: [
			{ name: "Choco's", category: 'Cereal', searchTerms: ['choco', 'chocos', 'chocolate'], image: '/a.png', url: '/products/chocos', price: 1 },
			// An owner who typed a curly apostrophe / en dash / double space in the CMS.
			{ name: 'Nana’s Granola', category: 'Granola', searchTerms: ['nana'], image: '/b.png', url: '/products/nanas', price: 2 },
			{ name: 'Steel–Cut  Oats', category: 'Oats', searchTerms: ['steel cut', 'oats'], image: '/c.png', url: '/products/steel', price: 3 },
			{ name: 'Rolled Oats', category: 'Oats', searchTerms: ['porridge', 'oatmeal'], image: '/d.png', url: '/products/rolled', price: 4 }
		],
		recipes: [{ title: 'Overnight Oats', category: 'Breakfast', searchTerms: ['jar', 'no cook'], image: '/r.png', url: '/recipes/overnight' }]
	}
}));
vi.mock('$lib/data/products.js', () => catalog);

const { searchCatalog, searchKey } = await import('$lib/search.js');
const labels = (q) => searchCatalog(q).map((i) => i.label);

/** The original scoring (lower-case + indexOf, no folding), for ASCII parity. */
function original(query) {
	const items = [
		...catalog.products.map((p) => ({ label: p.name, category: p.category, terms: p.searchTerms.join(' ').toLowerCase() })),
		...catalog.recipes.map((r) => ({ label: r.title, category: r.category, terms: r.searchTerms.join(' ').toLowerCase() }))
	];
	const q = String(query || '').trim().toLowerCase();
	if (!q) return items.map((i) => i.label);
	const score = (i) => {
		const l = i.label.toLowerCase();
		if (l.indexOf(q) === 0) return 0;
		if (l.indexOf(q) > -1) return 1;
		if (i.category.toLowerCase().indexOf(q) > -1) return 2;
		if (i.terms.indexOf(q) > -1) return 3;
		return -1;
	};
	return items
		.map((i) => ({ s: score(i), i }))
		.filter((x) => x.s > -1)
		.sort((a, b) => a.s - b.s)
		.map((x) => x.i.label);
}

describe('searchKey', () => {
	it.each([
		['Choco’s', "choco's"], // U+2019, iOS Smart Punctuation
		['Choco‘s', "choco's"], // U+2018
		['Chocoʼs', "choco's"], // U+02BC modifier apostrophe
		['Choco´s', "choco's"], // U+00B4 (NFKC would make it a space + accent)
		['Choco`s', "choco's"],
		['Choco＇s', "choco's"], // full-width (NFKC)
		['ＣＨＯＣＯ', 'choco'], // full-width letters
		['steel—cut', 'steel-cut'], // smart dash
		['steel‑cut', 'steel-cut'], // non-breaking hyphen
		['  rolled   oats ', 'rolled oats'], // no-break + repeated spaces
		[null, ''],
		[undefined, '']
	])('%j → %j', (input, key) => {
		expect(searchKey(input)).toBe(key);
	});
});

describe('searchCatalog folds the query and the index alike', () => {
	it.each(['Choco’s', 'choco‘s', 'CHOCOʼS', 'choco’'])('%j finds Choco\'s first', (q) => {
		expect(labels(q)[0]).toBe("Choco's");
	});

	it('a curly apostrophe stored in the CMS is found by an ASCII one (and by itself)', () => {
		expect(labels("nana's")).toEqual(['Nana’s Granola']);
		expect(labels('nana’s')).toEqual(['Nana’s Granola']);
	});

	it('dashes and spaces in a stored name are folded too', () => {
		expect(labels('steel-cut oats')).toEqual(['Steel–Cut  Oats']);
		expect(labels('steel—cut')).toEqual(['Steel–Cut  Oats']);
	});

	it('results keep the display label and category as stored', () => {
		const [hit] = searchCatalog('nana’s');
		expect(hit).toMatchObject({ type: 'product', label: 'Nana’s Granola', category: 'Granola', url: '/products/nanas', price: 2 });
	});

	it.each(['', 'o', 'oats', 'OATS', ' rolled ', 'cut', 'breakfast', 'porridge', 'jar', "choco's", 'zzz'])(
		'ASCII %j ranks exactly as the original port',
		(q) => {
			expect(labels(q)).toEqual(original(q));
		}
	);
});
