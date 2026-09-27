/*
 * $lib/live.js in the browser: the live catalog overlay over the snapshot.
 * fetch is mocked; every test imports a fresh module (its memo and store are
 * module state). Server-side behaviour is in live-ssr.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { settings as SNAP_SETTINGS, catalogForPricing as snapCatalog } from '$lib/data/settings.js';
import { products as SNAP_PRODUCTS } from '$lib/data/cms-snapshot.json';
import { buildShopItems } from '$lib/data/derive.js';

vi.mock('$app/environment', () => ({ browser: true }));

const SNAP = snapCatalog();
const SLUGS = SNAP.map((p) => p.slug);
const snapRow = (slug) => SNAP.find((p) => p.slug === slug);

/** A well-formed /api/store/catalog body: the snapshot catalog, with overrides per slug. */
function catalogBody(overrides = {}, settings = {}) {
	return {
		settings: { ...structuredClone(SNAP_SETTINGS), ...settings },
		products: SNAP.map((p) => ({ ...p, lowStock: null, ...(overrides[p.slug] || {}) }))
	};
}

const json = (status, body) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const raw = (status, text, type = 'text/html') => new Response(text, { status, headers: { 'Content-Type': type } });

/** fetch that never settles until its AbortSignal fires (like a hung CMS). */
const hangingFetch = () =>
	vi.fn(
		(_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			})
	);

let fetchMock;
let live;

beforeEach(async () => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.resetModules();
	live = await import('$lib/live.js');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('before any load', () => {
	it('importing the module does not fetch', () => {
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('exposes the snapshot, not ready', () => {
		const s = get(live.liveCatalog);
		expect(s.ready).toBe(false);
		expect(s.source).toBe('snapshot');
		expect(s.error).toBe(null);
		expect(s.fetchedAt).toBe(null);
		expect(s.settings).toStrictEqual(SNAP_SETTINGS);
		expect(Object.keys(s.bySlug)).toEqual(SLUGS);
		for (const p of SNAP) expect(s.bySlug[p.slug]).toStrictEqual({ ...p, lowStock: null });
	});

	it('synchronous reads return snapshot values', () => {
		for (const p of SNAP) {
			expect(live.pricePaise(p.slug)).toBe(p.pricePaise);
			expect(live.isInStock(p.slug)).toBe(p.inStock);
			expect(live.lowStock(p.slug)).toBe(null);
		}
		expect(live.catalogForPricing()).toStrictEqual(SNAP);
		expect(live.liveSettings()).toStrictEqual(SNAP_SETTINGS);
	});

	it('catalogForPricing returns fresh copies each call', () => {
		const a = live.catalogForPricing();
		a[0].pricePaise = 1;
		a.pop();
		expect(live.catalogForPricing()).toStrictEqual(SNAP);
	});

	it('the store is read-only (no set/update)', () => {
		expect(Object.keys(live.liveCatalog)).toEqual(['subscribe']);
	});
});

describe('successful load', () => {
	const overrides = {
		cornflakes: { pricePaise: 19900, name: 'Cornflakes Classic' },
		'rolled-oats': { inStock: false },
		muesli: { lowStock: 3 },
		'health-mix': { maxPerOrder: 4, codAllowed: false }
	};

	it('requests GET /api/store/catalog once, same-origin', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody()));
		await live.loadLive();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/store/catalog');
		expect(init.method).toBe('GET');
		expect(init.credentials).toBe('same-origin');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('live values override the snapshot, field by field', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody(overrides)));
		const s = await live.loadLive();
		expect(s.ready).toBe(true);
		expect(s.source).toBe('live');
		expect(s.error).toBe(null);
		expect(typeof s.fetchedAt).toBe('number');
		expect(s.bySlug.cornflakes).toStrictEqual({ ...snapRow('cornflakes'), name: 'Cornflakes Classic', pricePaise: 19900, lowStock: null });
		expect(live.pricePaise('cornflakes')).toBe(19900);
		expect(live.isInStock('rolled-oats')).toBe(false);
		expect(live.isInStock('cornflakes')).toBe(true);
		expect(live.lowStock('muesli')).toBe(3);
		expect(live.catalogForPricing().find((p) => p.slug === 'health-mix')).toStrictEqual({
			...snapRow('health-mix'),
			maxPerOrder: 4,
			codAllowed: false
		});
		// Untouched products keep snapshot values.
		expect(s.bySlug['steel-cut-oats']).toStrictEqual({ ...snapRow('steel-cut-oats'), lowStock: null });
	});

	it('the resolved state is the store value, and subscribers see not-ready then ready', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody(overrides)));
		const seen = [];
		const unsub = live.liveCatalog.subscribe((v) => seen.push(v));
		const s = await live.loadLive();
		unsub();
		expect(seen.map((v) => [v.ready, v.source])).toEqual([
			[false, 'snapshot'],
			[true, 'live']
		]);
		expect(get(live.liveCatalog)).toBe(s);
	});

	it('merged catalogForPricing keeps catalog order and the pricing shape', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody(overrides)));
		await live.loadLive();
		const cat = live.catalogForPricing();
		expect(cat.map((p) => p.slug)).toEqual(SLUGS);
		cat.forEach((p) => expect(Object.keys(p)).toEqual(['slug', 'name', 'pricePaise', 'inStock', 'maxPerOrder', 'codAllowed']));
	});

	it('live settings override snapshot settings, type-checked, nested', async () => {
		fetchMock.mockResolvedValue(
			json(
				200,
				catalogBody(
					{},
					{
						freeDeliveryThresholdPaise: 59900,
						codEnabled: false,
						announcement: { enabled: true, text: 'Diwali: free delivery', href: '/shop' },
						deliveryFeePaise: '4900', // wrong type → snapshot value
						codMaxPaise: 1.5, // not integer paise → snapshot value
						topUpDiscoveryBiasPaise: -5, // negative → snapshot value
						shippingPromiseText: null, // wrong type → snapshot value
						legal: 'nope', // not an object → snapshot legal
						stock: 5, // unknown key → ignored
						reservationMinutes: 30 // server-only, unknown here → ignored
					}
				)
			)
		);
		await live.loadLive();
		const st = live.liveSettings();
		expect(st.freeDeliveryThresholdPaise).toBe(59900);
		expect(st.codEnabled).toBe(false);
		expect(st.announcement).toStrictEqual({ enabled: true, text: 'Diwali: free delivery', href: '/shop' });
		expect(st.deliveryFeePaise).toBe(SNAP_SETTINGS.deliveryFeePaise);
		expect(st.codMaxPaise).toBe(SNAP_SETTINGS.codMaxPaise);
		expect(st.topUpDiscoveryBiasPaise).toBe(SNAP_SETTINGS.topUpDiscoveryBiasPaise);
		expect(st.shippingPromiseText).toBe(SNAP_SETTINGS.shippingPromiseText);
		expect(st.legal).toStrictEqual(SNAP_SETTINGS.legal);
		expect(Object.keys(st)).toEqual(Object.keys(SNAP_SETTINGS));
		expect(get(live.liveCatalog).settings).toBe(st);
	});

	it('missing or malformed settings fall back to the snapshot settings', async () => {
		const body = catalogBody();
		delete body.settings;
		fetchMock.mockResolvedValue(json(200, body));
		await live.loadLive();
		expect(live.liveSettings()).toStrictEqual(SNAP_SETTINGS);
		expect(get(live.liveCatalog).source).toBe('live');
	});

	it('state is deep-frozen (consumers cannot corrupt shared state)', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody(overrides)));
		const s = await live.loadLive();
		expect(() => {
			s.bySlug.cornflakes.pricePaise = 1;
		}).toThrow(TypeError);
		expect(() => {
			s.settings.announcement.enabled = true;
		}).toThrow(TypeError);
		expect(() => {
			s.ready = false;
		}).toThrow(TypeError);
		expect(live.pricePaise('cornflakes')).toBe(19900);
	});
});

describe('field validation', () => {
	it.each([
		['pricePaise as a string', { pricePaise: '19900' }],
		['pricePaise not integer', { pricePaise: 199.5 }],
		['pricePaise below 100', { pricePaise: 99 }],
		['pricePaise zero', { pricePaise: 0 }],
		['pricePaise negative', { pricePaise: -100 }],
		['pricePaise null', { pricePaise: null }]
	])('%s → snapshot price', async (_label, bad) => {
		fetchMock.mockResolvedValue(json(200, catalogBody({ cornflakes: { ...bad, codAllowed: false } })));
		await live.loadLive();
		expect(live.pricePaise('cornflakes')).toBe(snapRow('cornflakes').pricePaise);
		// Other valid fields on the same row still apply.
		expect(live.catalogForPricing()[0].codAllowed).toBe(false);
	});

	it.each([
		['inStock', { inStock: 'false' }, 'inStock'],
		['inStock', { inStock: 0 }, 'inStock'],
		['maxPerOrder', { maxPerOrder: 0 }, 'maxPerOrder'],
		['maxPerOrder', { maxPerOrder: 2.5 }, 'maxPerOrder'],
		['maxPerOrder', { maxPerOrder: '3' }, 'maxPerOrder'],
		['codAllowed', { codAllowed: 1 }, 'codAllowed'],
		['codAllowed', { codAllowed: null }, 'codAllowed'],
		['name', { name: '' }, 'name'],
		['name', { name: '   ' }, 'name'],
		['name', { name: 42 }, 'name']
	])('bad %s %j → snapshot value', async (_label, bad, field) => {
		fetchMock.mockResolvedValue(json(200, catalogBody({ muesli: bad })));
		await live.loadLive();
		expect(get(live.liveCatalog).bySlug.muesli[field]).toBe(snapRow('muesli')[field]);
	});

	it.each([
		[{ lowStock: 3 }, 3],
		[{ lowStock: 1 }, 1],
		[{ lowStock: 0 }, null],
		[{ lowStock: -2 }, null],
		[{ lowStock: 2.5 }, null],
		[{ lowStock: '3' }, null],
		[{ lowStock: null }, null],
		[{}, null],
		[{ lowStock: 2, inStock: false }, null]
	])('lowStock %j → %s', async (fields, expected) => {
		const body = catalogBody();
		const row = body.products.find((p) => p.slug === 'muesli');
		delete row.lowStock;
		Object.assign(row, fields);
		fetchMock.mockResolvedValue(json(200, body));
		await live.loadLive();
		expect(live.lowStock('muesli')).toBe(expected);
	});
});

describe('slugs', () => {
	it('unknown live slugs are ignored; unknown reads are safe', async () => {
		const body = catalogBody();
		body.products.push({ slug: 'granola-bar', name: 'Granola Bar', pricePaise: 9900, inStock: true, maxPerOrder: 10, codAllowed: true });
		fetchMock.mockResolvedValue(json(200, body));
		await live.loadLive();
		expect(Object.keys(get(live.liveCatalog).bySlug)).toEqual(SLUGS);
		expect(live.isInStock('granola-bar')).toBe(false);
		expect(live.pricePaise('granola-bar')).toBe(null);
		expect(live.lowStock('granola-bar')).toBe(null);
		expect(live.catalogForPricing().map((p) => p.slug)).toEqual(SLUGS);
	});

	it('a snapshot product missing from the live catalog is no longer in stock', async () => {
		const body = catalogBody();
		body.products = body.products.filter((p) => p.slug !== 'choco-flakes');
		fetchMock.mockResolvedValue(json(200, body));
		await live.loadLive();
		expect(live.isInStock('choco-flakes')).toBe(false);
		expect(live.lowStock('choco-flakes')).toBe(null);
		// Price stays known (the cart can still show the line it has).
		expect(live.pricePaise('choco-flakes')).toBe(snapRow('choco-flakes').pricePaise);
		expect(live.isInStock('cornflakes')).toBe(true);
	});

	it('duplicate live rows: the first wins', async () => {
		const body = catalogBody({ cornflakes: { pricePaise: 18000 } });
		body.products.push({ ...body.products[0], pricePaise: 99900 });
		fetchMock.mockResolvedValue(json(200, body));
		await live.loadLive();
		expect(live.pricePaise('cornflakes')).toBe(18000);
	});

	it('rows without a string slug are skipped', async () => {
		const body = catalogBody({ cornflakes: { pricePaise: 18000 } });
		body.products.unshift(null, 7, 'cornflakes', [], { slug: 42, pricePaise: 100 }, { pricePaise: 100 });
		fetchMock.mockResolvedValue(json(200, body));
		await live.loadLive();
		expect(live.pricePaise('cornflakes')).toBe(18000);
		expect(get(live.liveCatalog).source).toBe('live');
	});

	it.each([undefined, null, 42, {}, [], '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'CORNFLAKES'])(
		'reads for %j never throw and report unknown',
		(slug) => {
			expect(live.isInStock(slug)).toBe(false);
			expect(live.lowStock(slug)).toBe(null);
			expect(live.pricePaise(slug)).toBe(null);
		}
	);
});

describe('failures fall back to the snapshot silently', () => {
	async function expectFallback(error) {
		const s = await live.loadLive();
		expect(s.ready).toBe(true);
		expect(s.source).toBe('snapshot');
		expect(s.error).toBe(error);
		expect(s.settings).toStrictEqual(SNAP_SETTINGS);
		expect(live.catalogForPricing()).toStrictEqual(SNAP);
		expect(get(live.liveCatalog)).toBe(s);
	}

	it('500 → INTERNAL', async () => {
		fetchMock.mockResolvedValue(json(500, { error: { code: 'INTERNAL', message: 'boom' } }));
		await expectFallback('INTERNAL');
	});

	it('502 HTML from a proxy → INTERNAL', async () => {
		fetchMock.mockResolvedValue(raw(502, '<html>Bad gateway</html>'));
		await expectFallback('INTERNAL');
	});

	it('404 (static host with no /api) → NOT_FOUND', async () => {
		fetchMock.mockResolvedValue(raw(404, '<!doctype html><title>404</title>'));
		await expectFallback('NOT_FOUND');
	});

	it('malformed JSON with 200 → BAD_RESPONSE', async () => {
		fetchMock.mockResolvedValue(raw(200, '{"products": [', 'application/json'));
		await expectFallback('BAD_RESPONSE');
	});

	it('HTML with 200 (SPA fallback page) → BAD_RESPONSE', async () => {
		fetchMock.mockResolvedValue(raw(200, '<!doctype html><html></html>'));
		await expectFallback('BAD_RESPONSE');
	});

	it.each([
		['null', null],
		['an array', []],
		['a string', 'catalog'],
		['no products', { settings: {} }],
		['products not an array', { products: { cornflakes: {} } }],
		['empty products', { products: [] }],
		['only junk rows', { products: [null, 1, 'x', { name: 'no slug' }] }]
	])('well-formed JSON that is not a catalog (%s) → BAD_RESPONSE', async (_label, body) => {
		fetchMock.mockResolvedValue(json(200, body));
		await expectFallback('BAD_RESPONSE');
	});

	it('empty 200 body → BAD_RESPONSE', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		await expectFallback('BAD_RESPONSE');
	});

	it('network error → NETWORK', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		await expectFallback('NETWORK');
	});

	it('fetch throwing synchronously → NETWORK, loadLive still resolves', async () => {
		fetchMock.mockImplementation(() => {
			throw new Error('sync boom');
		});
		await expectFallback('NETWORK');
	});

	it('timeout: aborts after 4 s → TIMEOUT', async () => {
		vi.useFakeTimers();
		fetchMock = hangingFetch();
		vi.stubGlobal('fetch', fetchMock);
		let settled = null;
		const p = live.loadLive().then((s) => (settled = s));
		await vi.advanceTimersByTimeAsync(3999);
		expect(settled).toBe(null);
		expect(get(live.liveCatalog).ready).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(settled.ready).toBe(true);
		expect(settled.source).toBe('snapshot');
		expect(settled.error).toBe('TIMEOUT');
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
		expect(live.catalogForPricing()).toStrictEqual(SNAP);
	});

	it('a failed refresh keeps the last good live values', async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValueOnce(json(200, catalogBody({ cornflakes: { pricePaise: 19900 } })));
		await live.loadLive();
		fetchMock.mockResolvedValueOnce(json(503, { error: { code: 'UNAVAILABLE', message: 'down' } }));
		vi.advanceTimersByTime(15000);
		const s = await live.loadLive();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(s.source).toBe('live');
		expect(s.error).toBe('UNAVAILABLE');
		expect(live.pricePaise('cornflakes')).toBe(19900);
		// …and the next good response clears the error.
		fetchMock.mockResolvedValueOnce(json(200, catalogBody({ cornflakes: { pricePaise: 21000 } })));
		vi.advanceTimersByTime(15000);
		const s2 = await live.loadLive();
		expect(s2.error).toBe(null);
		expect(live.pricePaise('cornflakes')).toBe(21000);
	});
});

describe('memoization (15 s) and request sharing', () => {
	it('a second call within 15 s reuses the result without fetching', async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValue(json(200, catalogBody()));
		const a = await live.loadLive();
		vi.advanceTimersByTime(14999);
		const b = await live.loadLive();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(b).toBe(a);
	});

	it('refetches once 15 s have passed', async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValue(json(200, catalogBody()));
		await live.loadLive();
		vi.advanceTimersByTime(15000);
		fetchMock.mockResolvedValue(json(200, catalogBody({ cornflakes: { pricePaise: 18500 } })));
		await live.loadLive();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(live.pricePaise('cornflakes')).toBe(18500);
	});

	it('failures are memoized too (a down CMS is not hammered)', async () => {
		vi.useFakeTimers();
		fetchMock.mockRejectedValue(new TypeError('offline'));
		await live.loadLive();
		await live.loadLive();
		vi.advanceTimersByTime(10000);
		await live.loadLive();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5000);
		await live.loadLive();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('concurrent callers share one request', async () => {
		let resolve;
		fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
		const p1 = live.loadLive();
		const p2 = live.loadLive();
		const p3 = live.loadLive({ force: true });
		expect(p2).toBe(p1);
		expect(p3).toBe(p1);
		resolve(json(200, catalogBody()));
		const [a, b, c] = await Promise.all([p1, p2, p3]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it('force skips the memo', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody()));
		await live.loadLive();
		fetchMock.mockResolvedValue(json(200, catalogBody({ muesli: { inStock: false } })));
		await live.loadLive({ force: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(live.isInStock('muesli')).toBe(false);
	});

	it('loadLive() with odd arguments still works', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody()));
		await expect(live.loadLive(undefined)).resolves.toMatchObject({ ready: true, source: 'live' });
		for (const arg of [{}, null, 0, 'force', []]) await expect(live.loadLive(arg)).resolves.toMatchObject({ ready: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('a throwing subscriber cannot make loadLive reject', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody({ cornflakes: { pricePaise: 19900 } })));
		let calls = 0;
		const unsub = live.liveCatalog.subscribe(() => {
			if (calls++ > 0) throw new Error('subscriber bug');
		});
		await expect(live.loadLive()).resolves.toMatchObject({ ready: true, source: 'live' });
		expect(live.pricePaise('cornflakes')).toBe(19900);
		unsub();
	});
});

describe('withLivePrices', () => {
	it('before load: fresh copies equal to the input', () => {
		const out = live.withLivePrices(SNAP_PRODUCTS);
		expect(out).toStrictEqual(SNAP_PRODUCTS);
		expect(out[0]).not.toBe(SNAP_PRODUCTS[0]);
	});

	it('after load: live commerce fields laid over, so derive.js re-derives price lines', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody({ cornflakes: { pricePaise: 19900, inStock: false, name: 'Ignored' } })));
		await live.loadLive();
		const out = live.withLivePrices(SNAP_PRODUCTS);
		const corn = out.find((p) => p.slug === 'cornflakes');
		expect(corn.pricePaise).toBe(19900);
		expect(corn.inStock).toBe(false);
		// Display fields are untouched (the page's copy stays the snapshot's).
		expect(corn.name).toBe(SNAP_PRODUCTS[0].name);
		expect(buildShopItems({ products: out })[0].priceLine).toBe('₹199 · 120 cal');
		// Input not mutated.
		expect(SNAP_PRODUCTS[0].pricePaise).toBe(17500);
	});

	it.each([undefined, null, 'x', {}])('non-array input %j → []', (input) => {
		expect(live.withLivePrices(input)).toEqual([]);
	});

	it('passes through rows it does not know', () => {
		expect(live.withLivePrices([{ slug: 'nope', pricePaise: 1 }, null])).toEqual([{ slug: 'nope', pricePaise: 1 }, null]);
	});
});

describe('readyRow / soldOutIn (display reads, ready-gated)', () => {
	it('before any load: null / false, so prerendered markup keeps the snapshot values', () => {
		const s = get(live.liveCatalog);
		for (const slug of SLUGS) {
			expect(live.readyRow(s, slug)).toBe(null);
			expect(live.soldOutIn(s, slug)).toBe(false);
		}
	});

	it('after a live load: the merged row; sold out for stock 0 and for a product the CMS no longer lists', async () => {
		const [a, b, c] = SLUGS;
		const body = catalogBody({ [a]: { pricePaise: 19900 }, [b]: { inStock: false } });
		body.products = body.products.filter((p) => p.slug !== c);
		fetchMock.mockResolvedValue(json(200, body));
		const s = await live.loadLive();
		expect(live.readyRow(s, a)).toMatchObject({ slug: a, pricePaise: 19900, inStock: true });
		expect(live.soldOutIn(s, a)).toBe(false);
		expect(live.soldOutIn(s, b)).toBe(true);
		expect(live.soldOutIn(s, c)).toBe(true);
		expect(live.readyRow(s, c)).toMatchObject({ slug: c, pricePaise: snapRow(c).pricePaise, inStock: false });
	});

	it('after a failed load: the snapshot rows (ready, nothing flagged that the snapshot sells)', async () => {
		fetchMock.mockResolvedValue(json(404, {}));
		const s = await live.loadLive();
		expect(s.ready).toBe(true);
		for (const p of SNAP) {
			expect(live.readyRow(s, p.slug).pricePaise).toBe(p.pricePaise);
			expect(live.soldOutIn(s, p.slug)).toBe(!p.inStock);
		}
	});

	it('unknown slugs, prototype keys and odd states give null / false', async () => {
		fetchMock.mockResolvedValue(json(200, catalogBody()));
		const s = await live.loadLive();
		for (const slug of ['nope', '', 'constructor', '__proto__', 'toString', null, undefined, 42, {}]) {
			expect(live.readyRow(s, slug)).toBe(null);
			expect(live.soldOutIn(s, slug)).toBe(false);
		}
		for (const odd of [null, undefined, 'x', [], {}, { ready: true }, { ready: 'yes', bySlug: s.bySlug }, { ready: true, bySlug: null }]) {
			expect(live.readyRow(odd, SLUGS[0])).toBe(null);
			expect(live.soldOutIn(odd, SLUGS[0])).toBe(false);
		}
	});
});
