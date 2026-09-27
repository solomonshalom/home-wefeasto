/*
 * $lib/live.js during SSR/prerender: no fetch, no state change, snapshot
 * values everywhere, so prerendered HTML never depends on the CMS being up.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { get } from 'svelte/store';
import { settings as SNAP_SETTINGS, catalogForPricing as snapCatalog } from '$lib/data/settings.js';

vi.mock('$app/environment', () => ({ browser: false }));

const SNAP = snapCatalog();
const fetchMock = vi.fn(() => {
	throw new Error('fetch must not be called during SSR');
});
let live;

beforeAll(async () => {
	vi.stubGlobal('fetch', fetchMock);
	live = await import('$lib/live.js');
});
afterAll(() => vi.unstubAllGlobals());

describe('live.js on the server', () => {
	it('loadLive resolves with the snapshot state without fetching', async () => {
		const s = await live.loadLive();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(s.ready).toBe(false);
		expect(s.source).toBe('snapshot');
		expect(s.error).toBe(null);
		expect(s.settings).toStrictEqual(SNAP_SETTINGS);
		expect(get(live.liveCatalog)).toBe(s);
	});

	it('forced and repeated loads still never fetch or change state', async () => {
		const before = get(live.liveCatalog);
		const results = await Promise.all([live.loadLive({ force: true }), live.loadLive(), live.loadLive({ force: true })]);
		expect(fetchMock).not.toHaveBeenCalled();
		results.forEach((s) => expect(s).toBe(before));
		expect(get(live.liveCatalog)).toBe(before);
	});

	it('synchronous reads return snapshot values', () => {
		for (const p of SNAP) {
			expect(live.pricePaise(p.slug)).toBe(p.pricePaise);
			expect(live.isInStock(p.slug)).toBe(p.inStock);
			expect(live.lowStock(p.slug)).toBe(null);
		}
		expect(live.catalogForPricing()).toStrictEqual(SNAP);
		expect(live.liveSettings()).toStrictEqual(SNAP_SETTINGS);
		expect(live.pricePaise('unknown')).toBe(null);
		expect(live.isInStock('unknown')).toBe(false);
	});
});
