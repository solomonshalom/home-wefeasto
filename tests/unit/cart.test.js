/*
 * cart.js hardening (roadmap F4/M8): sanitize-on-read, caps, the shared
 * filter behind count/total, cross-tab sync, no lost updates, addMany's
 * single write + single event, subtractLines, and a cart that keeps working
 * when localStorage throws. Plus the neighbouring client state (last order,
 * link offers, attribution).
 *
 * Node env: createCart() is exercised with a fake Storage and EventTarget;
 * the module-level wiring (window 'storage' listener) is checked in
 * cart-browser.test.js with $app/environment mocked to the browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
	createCart,
	sanitizeCart,
	capIndex,
	countOf,
	CART_KEY,
	CART_ADD_EVENT,
	readOffer,
	saveOffer,
	clearOffer,
	OFFER_KEY,
	rememberSource,
	readSource,
	Cart as pageCart,
	cartTotal
} from '$lib/cart.js';
import { catalogForPricing } from '$lib/data/settings.js';
import { readLastOrder, usualTopUp, LAST_ORDER_KEY, usualHidden, hideUsual, USUAL_HIDDEN_KEY } from '$lib/components/YourUsual.svelte';
import { topUpDismissed, dismissTopUp } from '$lib/components/TopUp.svelte';

const CATALOG = catalogForPricing();
const DAY = 86400000;

/** A Storage double that counts writes. */
function memStorage(init = {}) {
	const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
	const s = {
		writes: 0,
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => {
			s.writes++;
			m.set(k, String(v));
		},
		removeItem: (k) => m.delete(k),
		raw: (k) => m.get(k),
		json: (k) => JSON.parse(m.get(k))
	};
	return s;
}

function throwingStorage() {
	return () => {
		throw new DOMException('The operation is insecure.', 'SecurityError');
	};
}

function setup({ stored, storage, catalog = CATALOG, getStorage } = {}) {
	const st = storage || memStorage(stored === undefined ? {} : { [CART_KEY]: stored });
	const events = new EventTarget();
	const seen = [];
	events.addEventListener(CART_ADD_EVENT, (e) => seen.push(e.detail));
	const c = createCart({ getStorage: getStorage || (() => st), events, catalog: () => catalog });
	return { ...c, st, events, seen };
}

describe('sanitizeCart', () => {
	const table = [
		['roadmap garbage mix', { cornflakes: 2, ghost: 5, muesli: 'abc', oats: -3 }, { cornflakes: 2 }],
		['numeric string', { cornflakes: '2' }, { cornflakes: 2 }],
		["exponent string '1e9' (strict parseQty rejects it)", { cornflakes: '1e9' }, {}],
		['1e9 number (over parseQty ceiling)', { cornflakes: 1e9 }, {}],
		['over maxPerOrder is capped', { cornflakes: 15 }, { cornflakes: 10 }],
		['exactly maxPerOrder', { muesli: 10 }, { muesli: 10 }],
		['decimal number', { cornflakes: 2.5 }, {}],
		['decimal string', { cornflakes: '2.5' }, {}],
		['leading zero', { cornflakes: '03' }, {}],
		['padded', { cornflakes: ' 3' }, {}],
		['zero', { cornflakes: 0 }, {}],
		['negative string', { cornflakes: '-1' }, {}],
		['hex', { cornflakes: '0x10' }, {}],
		['bool / null / array / object', { cornflakes: true, muesli: null, 'rolled-oats': [2], 'health-mix': { q: 1 } }, {}],
		['Infinity / NaN', { cornflakes: Infinity, muesli: NaN }, {}],
		['unknown slugs', { ghost: 1, 'Cornflakes': 2, 'cornflakes ': 1 }, {}],
		['key order kept', { muesli: 1, cornflakes: 2, 'rolled-oats': 3 }, { muesli: 1, cornflakes: 2, 'rolled-oats': 3 }]
	];
	it.each(table)('%s', (_, raw, want) => {
		const out = sanitizeCart(raw, CATALOG);
		expect(out).toEqual(want);
		expect(Object.keys(out)).toEqual(Object.keys(want));
	});

	it('prototype keys never match', () => {
		const raw = JSON.parse('{"__proto__": 5, "constructor": 2, "toString": 1, "cornflakes": 1}');
		const out = sanitizeCart(raw, CATALOG);
		expect(out).toEqual({ cornflakes: 1 });
		expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
	});

	it.each([null, undefined, 'x', 42, [], [['cornflakes', 2]]])('non-object %j → {}', (raw) => {
		expect(sanitizeCart(raw, CATALOG)).toEqual({});
	});

	it('cap follows the product maxPerOrder, never above 20', () => {
		const cat = [
			{ slug: 'a', maxPerOrder: 3 },
			{ slug: 'b', maxPerOrder: 50 },
			{ slug: 'c' },
			{ slug: 'd', maxPerOrder: 0 }
		];
		expect(sanitizeCart({ a: 9, b: 99, c: 99, d: 99 }, cat)).toEqual({ a: 3, b: 20, c: 10, d: 10 });
		expect([...capIndex(cat)]).toEqual([
			['a', 3],
			['b', 20],
			['c', 10],
			['d', 10]
		]);
	});
});

describe('reading the stored cart', () => {
	it('sanitizes on read and count/total use the same filter', () => {
		const { Cart, cart } = setup({ stored: { cornflakes: 2, ghost: 5, muesli: 'abc', oats: -3, 'rolled-oats': '1e9' } });
		expect(get(cart)).toEqual({ cornflakes: 2 });
		expect(Cart.read()).toEqual({ cornflakes: 2 });
		expect(Cart.count()).toBe(2);
		expect(Cart.total()).toBe(350);
		expect(Cart.items()).toEqual([{ slug: 'cornflakes', qty: 2, product: expect.objectContaining({ slug: 'cornflakes', price: 175 }) }]);
	});

	it('the roadmap M8 case: {muesli:-1} totals 0', () => {
		const { Cart } = setup({ stored: { muesli: -1 } });
		expect(Cart.count()).toBe(0);
		expect(Cart.total()).toBe(0);
		expect(Cart.items()).toEqual([]);
	});

	it.each([
		['corrupt JSON', '{not json'],
		['an array', '[1,2]'],
		['a string', '"cornflakes"'],
		['null', 'null']
	])('%s in storage reads as an empty bag', (_, raw) => {
		const { Cart } = setup({ storage: memStorage({ [CART_KEY]: raw }) });
		expect(Cart.read()).toEqual({});
		Cart.add('muesli');
		expect(Cart.read()).toEqual({ muesli: 1 });
	});

	it('a write stores the sanitized map (garbage cleaned out)', () => {
		const { Cart, st } = setup({ stored: { cornflakes: '2', ghost: 5, muesli: 'abc' } });
		Cart.add('muesli', 1);
		expect(st.json(CART_KEY)).toEqual({ cornflakes: 2, muesli: 1 });
	});

	it('count() is the sum; countOf helper', () => {
		expect(countOf({ a: 2, b: 3 })).toBe(5);
		expect(countOf({})).toBe(0);
	});
});

describe('Cart.add', () => {
	it('adds, caps at maxPerOrder and reports what was added', () => {
		const { Cart, seen } = setup();
		expect(Cart.add('cornflakes', 2, { source: 'pdp' })).toBe(2);
		expect(seen.at(-1)).toEqual({ slug: 'cornflakes', qty: 2, source: 'pdp', requested: 2, inBag: 2, capped: false });
		expect(Cart.add('cornflakes', 9, { source: 'card' })).toBe(10);
		expect(seen.at(-1)).toEqual({ slug: 'cornflakes', qty: 8, source: 'card', requested: 9, inBag: 10, capped: true });
		// at the cap: nothing added, but the event still explains why
		expect(Cart.add('cornflakes', 1)).toBe(10);
		expect(seen.at(-1)).toMatchObject({ qty: 0, capped: true, inBag: 10, source: null });
	});

	it('defaults to 1; garbage qty reads as 1 (legacy behaviour)', () => {
		const { Cart } = setup();
		Cart.add('muesli');
		Cart.add('muesli', 'abc');
		Cart.add('muesli', -4);
		expect(Cart.read()).toEqual({ muesli: 3 });
	});

	it('ignores unknown slugs: no write, no event', () => {
		const { Cart, st, seen } = setup();
		expect(Cart.add('ghost', 2)).toBe(0);
		expect(Cart.add(undefined)).toBe(0);
		expect(Cart.add('__proto__')).toBe(0);
		expect(seen).toEqual([]);
		expect(st.writes).toBe(0);
		expect(Cart.read()).toEqual({});
	});

	it('source is cleaned (junk → null)', () => {
		const { Cart, seen } = setup();
		Cart.add('muesli', 1, { source: 'topup' });
		Cart.add('muesli', 1, { source: '<script>' });
		Cart.add('muesli', 1, { source: 42 });
		expect(seen.map((d) => d.source)).toEqual(['topup', null, null]);
	});

	it('the store and the event agree', () => {
		const { Cart, cart, events } = setup();
		let inStore = null;
		events.addEventListener(CART_ADD_EVENT, () => (inStore = get(cart)));
		Cart.add('muesli', 2);
		expect(inStore).toEqual({ muesli: 2 });
	});
});

describe('Cart.addMany', () => {
	it('one write, one event, merged into the bag', () => {
		const { Cart, st, seen } = setup({ stored: { cornflakes: 1 } });
		const before = st.writes;
		const r = Cart.addMany(
			[
				{ slug: 'cornflakes', qty: 2 },
				{ slug: 'muesli', qty: 1 },
				{ slug: 'ghost', qty: 3 },
				{ slug: 'rolled-oats', qty: 'abc' },
				{ slug: 'muesli', qty: 1 }
			],
			{ source: 'usual' }
		);
		expect(st.writes - before).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({
			slug: 'cornflakes',
			qty: 4,
			source: 'usual',
			lines: [
				{ slug: 'cornflakes', qty: 2 },
				{ slug: 'muesli', qty: 2 }
			]
		});
		expect(Cart.read()).toEqual({ cornflakes: 3, muesli: 2 });
		expect(r.added).toEqual(seen[0].lines);
		expect(r.skipped).toEqual(
			expect.arrayContaining([
				{ slug: 'rolled-oats', reason: 'BAD_QTY' },
				{ slug: 'ghost', reason: 'UNKNOWN' }
			])
		);
	});

	it('accepts a {slug: qty} map; clamps each line to 10 and each SKU to maxPerOrder', () => {
		const { Cart } = setup({ stored: { muesli: 7 } });
		const r = Cart.addMany({ cornflakes: '1e9', muesli: 5 });
		expect(Cart.read()).toEqual({ muesli: 10, cornflakes: 10 });
		expect(r.added).toEqual([
			{ slug: 'cornflakes', qty: 10 },
			{ slug: 'muesli', qty: 3 }
		]);
	});

	it('nothing added → no event, no write (and AT_LIMIT reported)', () => {
		const { Cart, seen, st } = setup({ stored: { muesli: 10 } });
		const r = Cart.addMany([{ slug: 'muesli', qty: 1 }, { slug: 'ghost', qty: 1 }]);
		expect(seen).toEqual([]);
		expect(st.writes).toBe(0);
		expect(r.added).toEqual([]);
		expect(r.skipped).toEqual([
			{ slug: 'muesli', reason: 'AT_LIMIT' },
			{ slug: 'ghost', reason: 'UNKNOWN' }
		]);
	});

	it('a garbage token never poisons a good one for the same slug', () => {
		const { Cart } = setup();
		const r = Cart.addMany([
			{ slug: 'muesli', qty: -5 },
			{ slug: 'muesli', qty: 2 }
		]);
		expect(Cart.read()).toEqual({ muesli: 2 });
		expect(r.skipped).toEqual([]);
	});

	it.each([null, undefined, 'x', 5, [null, 7]])('junk input %j is a no-op', (lines) => {
		const { Cart, seen } = setup();
		expect(Cart.addMany(lines).added).toEqual([]);
		expect(seen).toEqual([]);
	});
});

describe('setQty / remove / restore / clear', () => {
	it('setQty caps, and ≤0 or garbage removes', () => {
		const { Cart } = setup({ stored: { cornflakes: 2, muesli: 1 } });
		Cart.setQty('cornflakes', 99);
		expect(Cart.read().cornflakes).toBe(10);
		Cart.setQty('cornflakes', '3');
		expect(Cart.read().cornflakes).toBe(3);
		Cart.setQty('cornflakes', 0);
		Cart.setQty('muesli', 'abc');
		expect(Cart.read()).toEqual({});
		Cart.setQty('ghost', 3);
		expect(Cart.read()).toEqual({});
	});

	it('restore puts a line back at its old position', () => {
		const { Cart, st } = setup({ stored: { cornflakes: 2, muesli: 4, 'rolled-oats': 1 } });
		Cart.remove('muesli');
		expect(Object.keys(Cart.read())).toEqual(['cornflakes', 'rolled-oats']);
		Cart.restore('muesli', 4, 1);
		expect(Cart.read()).toEqual({ cornflakes: 2, muesli: 4, 'rolled-oats': 1 });
		expect(Object.keys(st.json(CART_KEY))).toEqual(['cornflakes', 'muesli', 'rolled-oats']);
		// restoring over a line that came back meanwhile replaces it in place
		Cart.restore('muesli', 2, 0);
		expect(Object.entries(Cart.read())).toEqual([
			['muesli', 2],
			['cornflakes', 2],
			['rolled-oats', 1]
		]);
		Cart.restore('ghost', 1, 0);
		expect(Object.keys(Cart.read())).not.toContain('ghost');
	});

	it('clear empties the bag', () => {
		const { Cart, st } = setup({ stored: { cornflakes: 2 } });
		Cart.clear();
		expect(Cart.read()).toEqual({});
		expect(st.json(CART_KEY)).toEqual({});
	});
});

describe('Cart.subtractLines (post-purchase)', () => {
	it('subtracts only what was ordered, keeps later additions', () => {
		const { Cart, seen } = setup({ stored: { cornflakes: 3, muesli: 1, 'rolled-oats': 2 } });
		const left = Cart.subtractLines([
			{ slug: 'cornflakes', qty: 2 },
			{ slug: 'muesli', qty: 1 },
			{ slug: 'health-mix', qty: 1 }
		]);
		expect(left).toEqual({ cornflakes: 1, 'rolled-oats': 2 });
		expect(Cart.read()).toEqual(left);
		expect(seen).toEqual([]);
	});

	it('accepts a map, sums duplicates, never goes negative, ignores garbage', () => {
		const { Cart } = setup({ stored: { cornflakes: 3, muesli: 2 } });
		Cart.subtractLines([
			{ slug: 'cornflakes', qty: 1 },
			{ slug: 'cornflakes', qty: 1 },
			{ slug: 'muesli', qty: 'abc' }
		]);
		expect(Cart.read()).toEqual({ cornflakes: 1, muesli: 2 });
		Cart.subtractLines({ cornflakes: 5 });
		expect(Cart.read()).toEqual({ muesli: 2 });
	});
});

describe('cross-tab safety', () => {
	it('re-reads storage before every write (no lost updates)', () => {
		const storage = memStorage();
		const tabA = setup({ storage });
		const tabB = setup({ storage });
		tabA.Cart.add('cornflakes', 2);
		// tab B never saw that write in memory…
		expect(tabB.Cart.read()).toEqual({});
		tabB.Cart.add('muesli', 1);
		// …but its write merged with it instead of clobbering it
		expect(storage.json(CART_KEY)).toEqual({ cornflakes: 2, muesli: 1 });
		expect(tabB.Cart.read()).toEqual({ cornflakes: 2, muesli: 1 });
		tabA.Cart.remove('cornflakes');
		expect(storage.json(CART_KEY)).toEqual({ muesli: 1 });
	});

	it('refresh() (the storage-event handler) picks up another tab’s write', () => {
		const storage = memStorage();
		const tabA = setup({ storage });
		const tabB = setup({ storage });
		const values = [];
		tabB.cart.subscribe((v) => values.push(v));
		tabA.Cart.add('rolled-oats', 3);
		tabB.refresh();
		expect(get(tabB.cart)).toEqual({ 'rolled-oats': 3 });
		tabB.refresh(); // unchanged → no extra store update
		expect(values).toEqual([{}, { 'rolled-oats': 3 }]);
		expect(tabB.Cart.count()).toBe(3);
	});

	it('another tab writing garbage is sanitized on refresh', () => {
		const storage = memStorage();
		const tab = setup({ storage });
		storage.setItem(CART_KEY, JSON.stringify({ muesli: '1e9', cornflakes: '4' }));
		tab.refresh();
		expect(tab.Cart.read()).toEqual({ cornflakes: 4 });
	});
});

describe('when localStorage throws', () => {
	it('the cart works in memory for the session', () => {
		const t = setup({ getStorage: throwingStorage() });
		expect(t.Cart.read()).toEqual({});
		expect(t.Cart.add('cornflakes', 2, { source: 'pdp' })).toBe(2);
		t.Cart.addMany([{ slug: 'muesli', qty: 1 }]);
		t.Cart.setQty('cornflakes', 3);
		expect(t.Cart.read()).toEqual({ cornflakes: 3, muesli: 1 });
		expect(get(t.cart)).toEqual({ cornflakes: 3, muesli: 1 });
		expect(t.seen.map((d) => d.source)).toEqual(['pdp', null]);
		t.Cart.subtractLines({ muesli: 1 });
		t.Cart.remove('cornflakes');
		expect(t.Cart.read()).toEqual({});
		expect(t.refresh()).toEqual({});
	});

	it('a storage whose getItem/setItem throw', () => {
		const bad = {
			getItem() {
				throw new Error('boom');
			},
			setItem() {
				throw new Error('boom');
			}
		};
		const t = setup({ storage: bad });
		t.Cart.add('muesli', 2);
		expect(t.Cart.read()).toEqual({ muesli: 2 });
	});

	it('a failed write (quota) switches to memory so later reads are not stale', () => {
		const st = memStorage({ [CART_KEY]: { cornflakes: 1 } });
		const t = setup({ storage: st });
		st.setItem = () => {
			throw new DOMException('quota', 'QuotaExceededError');
		};
		t.Cart.add('muesli', 1);
		t.Cart.add('muesli', 1);
		expect(t.Cart.read()).toEqual({ cornflakes: 1, muesli: 2 });
		expect(t.isMemoryOnly()).toBe(true);
	});

	it('getStorage returning null (SSR) is an in-memory cart', () => {
		const t = setup({ getStorage: () => null });
		t.Cart.add('muesli');
		expect(t.Cart.read()).toEqual({ muesli: 1 });
	});
});

describe('module weight', () => {
	it('cart.js statically imports only light modules (Nav loads it on every page)', async () => {
		const fs = await import('node:fs');
		const src = fs.readFileSync(new URL('../../src/lib/cart.js', import.meta.url), 'utf8');
		const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
		expect(imports.sort()).toEqual(['$app/environment', '$lib/data/cms-snapshot.json', '$lib/data/products.js', '$lib/track.js', '$shared/qty.js', 'svelte/store']);
	});
});

describe('module cart (server side)', () => {
	it('exports the legacy surface and never touches storage on the server', () => {
		expect(pageCart.read()).toEqual({});
		expect(pageCart.count()).toBe(0);
		expect(get(cartTotal)).toBe(0);
		for (const fn of ['read', 'add', 'addMany', 'setQty', 'remove', 'restore', 'subtractLines', 'clear', 'count', 'total', 'items']) {
			expect(typeof pageCart[fn]).toBe('function');
		}
	});
});

/* ------------------------------------------------ neighbouring state */

function stubWindow({ local = memStorage(), session = memStorage() } = {}) {
	vi.stubGlobal('window', { localStorage: local, sessionStorage: session });
	return { local, session };
}

afterEach(() => {
	vi.unstubAllGlobals();
	clearOffer();
});

describe('last order ("Your usual")', () => {
	const now = Date.UTC(2026, 8, 25);
	const order = (over = {}) => ({ no: 'WF-10001', t: 'tok', items: { cornflakes: 2, muesli: 1 }, at: now - 10 * DAY, ...over });

	it('reads a valid order, sanitizing its items', () => {
		const got = readLastOrder(now, CATALOG, order({ items: { cornflakes: 2, ghost: 1, muesli: 'x', 'rolled-oats': 1 } }));
		expect(got).toEqual({ no: 'WF-10001', t: 'tok', items: { cornflakes: 2, 'rolled-oats': 1 }, at: now - 10 * DAY });
	});

	it.each([
		['missing', null],
		['not an object', 'x'],
		['older than 120 days', order({ at: now - 121 * DAY })],
		['exactly 120 days is still shown', order({ at: now - 120 * DAY }), true],
		['from the future', order({ at: now + 2 * DAY })],
		['no valid items', order({ items: { ghost: 2 } })],
		['bad at', order({ at: 'yesterday' })],
		['ISO at works', order({ at: new Date(now - DAY).toISOString() }), true]
	])('%s', (_, stored, ok = false) => {
		expect(readLastOrder(now, CATALOG, stored) !== null).toBe(ok);
	});

	it('reads localStorage by default; storage throwing → null', () => {
		const { local } = stubWindow();
		local.setItem(LAST_ORDER_KEY, JSON.stringify(order({ at: Date.now() - DAY })));
		expect(readLastOrder()?.items).toEqual({ cornflakes: 2, muesli: 1 });
		vi.stubGlobal('window', {
			get localStorage() {
				throw new DOMException('x', 'SecurityError');
			}
		});
		expect(readLastOrder()).toBeNull();
	});

	it('usualTopUp: only the missing units of lines still sold', () => {
		const cat = CATALOG.map((p) => (p.slug === 'rolled-oats' ? { ...p, inStock: false } : p));
		const usual = { cornflakes: 2, muesli: 1, 'rolled-oats': 1 };
		expect(usualTopUp(usual, {}, cat)).toEqual([
			{ slug: 'cornflakes', qty: 2, name: 'Cornflakes', pricePaise: 17500 },
			{ slug: 'muesli', qty: 1, name: 'Muesli', pricePaise: 25000 }
		]);
		expect(usualTopUp(usual, { cornflakes: 1 }, cat)).toEqual([
			{ slug: 'cornflakes', qty: 1, name: 'Cornflakes', pricePaise: 17500 },
			{ slug: 'muesli', qty: 1, name: 'Muesli', pricePaise: 25000 }
		]);
		expect(usualTopUp(usual, { cornflakes: 5, muesli: 1 }, cat)).toEqual([]);
	});

	it('the 14-day dismissal', () => {
		const { local } = stubWindow();
		expect(usualHidden(now)).toBe(false);
		expect(hideUsual(now - 13 * DAY)).toBe(true);
		expect(local.json(USUAL_HIDDEN_KEY)).toBe(now - 13 * DAY);
		expect(usualHidden(now)).toBe(true);
		hideUsual(now - 15 * DAY);
		expect(usualHidden(now)).toBe(false);
	});
});

describe('link offers (?offer=)', () => {
	const now = Date.UTC(2026, 8, 25);

	it('normalizes, stores {code, at} and expires after 30 days', async () => {
		const { local } = stubWindow();
		expect(await saveOffer('  hello-7k2q ', now)).toEqual({ code: 'HELLO-7K2Q', at: now });
		expect(local.json(OFFER_KEY)).toEqual({ code: 'HELLO-7K2Q', at: now });
		expect(await readOffer(now + 29 * DAY)).toEqual({ code: 'HELLO-7K2Q', at: now });
		expect(await readOffer(now + 31 * DAY)).toBeNull();
		clearOffer();
		expect(await readOffer(now)).toBeNull();
	});

	it.each(['', 'x', '<b>', 'a'.repeat(40), null, 42])('rejects a malformed code %j', async (code) => {
		stubWindow();
		expect(await saveOffer(code, now)).toBeNull();
		expect(await readOffer(now)).toBeNull();
	});

	it('a tampered stored value is ignored', async () => {
		const { local } = stubWindow();
		local.setItem(OFFER_KEY, JSON.stringify({ code: 'not valid!', at: now }));
		expect(await readOffer(now)).toBeNull();
		local.setItem(OFFER_KEY, JSON.stringify({ code: 'OK10', at: 'yesterday' }));
		expect(await readOffer(now)).toBeNull();
	});

	it('works for the session when storage throws', async () => {
		vi.stubGlobal('window', {
			get localStorage() {
				throw new DOMException('x', 'SecurityError');
			}
		});
		expect(await saveOffer('WELCOME10', now)).toEqual({ code: 'WELCOME10', at: now });
		expect(await readOffer(now)).toEqual({ code: 'WELCOME10', at: now });
		clearOffer();
		expect(await readOffer(now)).toBeNull();
	});
});

describe('dismissed top-up suggestions', () => {
	it('are remembered (max 20, no duplicates) and never throw without storage', () => {
		const { session } = stubWindow();
		dismissTopUp('muesli');
		dismissTopUp('muesli');
		dismissTopUp('rolled-oats');
		dismissTopUp(42);
		expect(get(topUpDismissed)).toEqual(['muesli', 'rolled-oats']);
		expect(JSON.parse(session.raw('wefeasto_topup_dismissed'))).toEqual(['muesli', 'rolled-oats']);
		for (let i = 0; i < 25; i++) dismissTopUp('p' + i);
		expect(get(topUpDismissed)).toHaveLength(20);
		vi.stubGlobal('window', {});
		expect(() => dismissTopUp('x')).not.toThrow();
		expect(get(topUpDismissed).at(-1)).toBe('x');
	});
});

describe('link attribution (&src=)', () => {
	it('remembers a valid src per tab', async () => {
		const { session } = stubWindow();
		expect(await rememberSource(' Email ')).toBe('email');
		expect(await readSource()).toBe('email');
		expect(JSON.parse(session.raw('wefeasto_src')).src).toBe('email');
		expect(await rememberSource('evil')).toBeNull();
		expect(await readSource()).toBe('email');
		session.setItem('wefeasto_src', JSON.stringify({ src: 'evil', at: 1 }));
		expect(await readSource()).toBeNull();
	});

	it('never throws without storage', async () => {
		vi.stubGlobal('window', {});
		expect(await rememberSource('link')).toBe('link');
		expect(await readSource()).toBeNull();
	});
});
