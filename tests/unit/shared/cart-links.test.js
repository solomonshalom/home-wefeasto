import { describe, it, expect } from 'vitest';
import { parseAddParam, buildAddParam, buildCartLink, parseSrcParam, cartSignature, CART_LINK_SOURCES } from '$shared/cart-links.js';
import { makeCatalog } from './_fixtures.js';

const catalog = makeCatalog();
const parse = (s, cat = catalog) => parseAddParam(s, cat);
// What the cart page does: read ?add= through URLSearchParams (decodes once, '+' → space).
const fromUrl = (search) => new URLSearchParams(search).get('add');

describe('parseAddParam', () => {
	it('roadmap M5 acceptance: ?add=muesli:-5,foo:3,cornflakes:1e9 → cornflakes ×10 only', () => {
		expect(parse(fromUrl('?add=muesli:-5,foo:3,cornflakes:1e9'))).toEqual({
			lines: [{ slug: 'cornflakes', qty: 10 }],
			dropped: [
				{ slug: 'muesli', name: 'Muesli', reason: 'BAD_QTY' },
				{ slug: 'foo', name: 'foo', reason: 'UNKNOWN' }
			]
		});
	});

	it('basic link', () => {
		expect(parse('cornflakes:2,muesli:1')).toEqual({ lines: [{ slug: 'cornflakes', qty: 2 }, { slug: 'muesli', qty: 1 }], dropped: [] });
	});

	it.each([
		['URLSearchParams-encoded comma', fromUrl('?add=cornflakes:2%2Cmuesli:1')],
		['still-encoded value (%2C, %3A)', 'cornflakes%3A2%2Cmuesli%3A1'],
		['spaces and case', ' Cornflakes : 2 , MUESLI:1 '],
		["'+' as space from a query string", fromUrl('?add=cornflakes:2,+muesli:1')],
		['trailing and doubled commas', ',,cornflakes:2,,muesli:1,']
	])('%s', (_label, value) => {
		expect(parse(value).lines).toEqual([
			{ slug: 'cornflakes', qty: 2 },
			{ slug: 'muesli', qty: 1 }
		]);
	});

	it('missing or empty qty means 1', () => {
		expect(parse('muesli').lines).toEqual([{ slug: 'muesli', qty: 1 }]);
		expect(parse('muesli:').lines).toEqual([{ slug: 'muesli', qty: 1 }]);
	});

	it('sums duplicates, then clamps to 1–10', () => {
		expect(parse('muesli:4,muesli:5').lines).toEqual([{ slug: 'muesli', qty: 9 }]);
		expect(parse('muesli:6,muesli:6').lines).toEqual([{ slug: 'muesli', qty: 10 }]);
		expect(parse('muesli:2.9').lines).toEqual([{ slug: 'muesli', qty: 2 }]);
		expect(parse('muesli:99999999999999999999').lines).toEqual([{ slug: 'muesli', qty: 10 }]);
	});

	it('a garbage token does not poison a valid one for the same slug', () => {
		expect(parse('muesli:-5,muesli:2')).toEqual({ lines: [{ slug: 'muesli', qty: 2 }], dropped: [] });
		expect(parse('muesli:abc').dropped).toEqual([{ slug: 'muesli', name: 'Muesli', reason: 'BAD_QTY' }]);
		expect(parse('muesli:0').dropped[0].reason).toBe('BAD_QTY');
		expect(parse('muesli:0x10').dropped[0].reason).toBe('BAD_QTY');
	});

	it('clamps to a product’s own maxPerOrder when lower', () => {
		const cat = makeCatalog({ muesli: { maxPerOrder: 3 } });
		expect(parse('muesli:8', cat).lines).toEqual([{ slug: 'muesli', qty: 3 }]);
	});

	it('drops out-of-stock and unpublished products with names for the note', () => {
		const cat = makeCatalog({ 'rolled-oats': { inStock: false }, 'health-mix': { stock: 0 }, 'choco-flakes': { published: false } });
		expect(parse('rolled-oats:1,health-mix:2,choco-flakes:1,cornflakes:1', cat)).toEqual({
			lines: [{ slug: 'cornflakes', qty: 1 }],
			dropped: [
				{ slug: 'rolled-oats', name: 'Rolled Oats', reason: 'OUT_OF_STOCK' },
				{ slug: 'health-mix', name: 'Health Mix', reason: 'OUT_OF_STOCK' },
				{ slug: 'choco-flakes', name: 'Choco’s', reason: 'UNKNOWN' }
			]
		});
	});

	it('at most 6 lines; extras dropped as TOO_MANY in link order', () => {
		const cat = Array.from({ length: 8 }, (_, i) => ({ slug: `p${i}`, name: `P${i}`, pricePaise: 10000 }));
		const r = parse(cat.map((p) => `${p.slug}:1`).join(','), cat);
		expect(r.lines.map((l) => l.slug)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
		expect(r.dropped).toEqual([
			{ slug: 'p6', name: 'P6', reason: 'TOO_MANY' },
			{ slug: 'p7', name: 'P7', reason: 'TOO_MANY' }
		]);
		// invalid entries do not use up line slots
		const r2 = parse('ghost:1,' + cat.slice(0, 6).map((p) => `${p.slug}:1`).join(','), cat);
		expect(r2.lines).toHaveLength(6);
	});

	it('prototype keys and junk never crash or match', () => {
		const r = parse('__proto__:1,constructor:1,toString:2,hasOwnProperty:1');
		expect(r.lines).toEqual([]);
		expect(r.dropped.map((d) => d.reason)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
	});

	it('malformed percent-escapes are tolerated', () => {
		expect(() => parse('muesli:1%E0%A4%A')).not.toThrow();
		expect(parse('muesli:1,%ZZ').lines).toEqual([{ slug: 'muesli', qty: 1 }]);
	});

	it('bounds work on hostile input', () => {
		const many = Array.from({ length: 200 }, () => 'muesli:1').join(',');
		expect(parse(many).lines).toEqual([{ slug: 'muesli', qty: 10 }]);
		const huge = 'a'.repeat(1_000_000) + ':1,muesli:1';
		const r = parse(huge);
		expect(r.lines).toEqual([]); // beyond the 2 KB window
		expect(r.dropped[0].slug.length).toBeLessThanOrEqual(64);
		const longSlug = 'x'.repeat(64);
		expect(parse(longSlug + 'x:1', [{ slug: longSlug, name: 'Long', pricePaise: 100 }]).lines).toEqual([]);
	});

	it.each([[null], [undefined], [''], ['   '], [42], [['muesli:1']]])('empty for %j', (v) => {
		expect(parse(v)).toEqual({ lines: [], dropped: [] });
	});

	it('works with a Map catalog', () => {
		expect(parse('muesli:2', new Map(catalog.map((p) => [p.slug, p]))).lines).toEqual([{ slug: 'muesli', qty: 2 }]);
	});
});

describe('buildAddParam', () => {
	it.each([
		['array', [{ slug: 'cornflakes', qty: 2 }, { slug: 'muesli', qty: 1 }], 'cornflakes:2,muesli:1'],
		['cart map', { cornflakes: 2, muesli: '1' }, 'cornflakes:2,muesli:1'],
		['clamps to 10', [{ slug: 'muesli', qty: 25 }], 'muesli:10'],
		['sums duplicates', [{ slug: 'muesli', qty: 2 }, { slug: 'muesli', qty: 3 }], 'muesli:5'],
		['drops garbage', [{ slug: 'muesli', qty: 0 }, { slug: 'Bad Slug', qty: 1 }, { slug: 'oats', qty: 'x' }, null, { slug: 'cornflakes', qty: 1 }], 'cornflakes:1'],
		['max 6 lines', Array.from({ length: 8 }, (_, i) => ({ slug: `p${i}`, qty: 1 })), 'p0:1,p1:1,p2:1,p3:1,p4:1,p5:1'],
		['empty', [], ''],
		['junk', 'muesli:1', '']
	])('%s', (_label, lines, out) => {
		expect(buildAddParam(lines)).toBe(out);
	});

	it('round-trips through parseAddParam', () => {
		const lines = [
			{ slug: 'health-mix', qty: 3 },
			{ slug: 'cornflakes', qty: 10 },
			{ slug: 'muesli', qty: 1 }
		];
		expect(parse(buildAddParam(lines)).lines).toEqual(lines);
		// survives URLSearchParams encoding too
		const url = new URL('https://wefeasto.com/cart');
		url.searchParams.set('add', buildAddParam(lines));
		expect(parse(url.searchParams.get('add')).lines).toEqual(lines);
	});
});

describe('buildCartLink / parseSrcParam', () => {
	it('builds relative links with an optional source', () => {
		expect(buildCartLink([{ slug: 'cornflakes', qty: 2 }, { slug: 'muesli', qty: 1 }], { src: 'email' })).toBe('/cart?add=cornflakes:2,muesli:1&src=email');
		expect(buildCartLink({ muesli: 1 })).toBe('/cart?add=muesli:1');
		expect(buildCartLink({ muesli: 1 }, { src: 'spam' })).toBe('/cart?add=muesli:1');
		expect(buildCartLink([])).toBe('/cart');
	});

	it('parseSrcParam', () => {
		for (const s of CART_LINK_SOURCES) expect(parseSrcParam(s)).toBe(s);
		expect(parseSrcParam(' EMAIL ')).toBe('email');
		for (const bad of ['', 'google', null, 3]) expect(parseSrcParam(bad)).toBeNull();
		expect(CART_LINK_SOURCES).toEqual(['web', 'usual', 'link', 'email', 'refill', 'offer']);
	});
});

describe('cartSignature', () => {
	it('is order-insensitive, merges, ignores garbage, keeps exact quantities', () => {
		const a = cartSignature({ muesli: 1, cornflakes: 2 });
		expect(a).toBe('cornflakes:2,muesli:1');
		expect(cartSignature({ cornflakes: 2, muesli: 1 })).toBe(a);
		expect(cartSignature([{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }, { slug: 'cornflakes', qty: 1 }])).toBe(a);
		expect(cartSignature({ muesli: 1, cornflakes: 2, ghost: -1, 'Bad Slug': 3 })).toBe(a);
		expect(cartSignature({ muesli: 12 })).not.toBe(cartSignature({ muesli: 10 }));
		expect(cartSignature({})).toBe('');
		expect(cartSignature(null)).toBe('');
	});
});
