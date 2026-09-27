/*
 * pages.server.js: the storefront's policy pages, for prerender-time loads
 * only. Today no page is published, so there is nothing to route or link; once
 * the owner publishes a reviewed page in the CMS and the snapshot is synced,
 * it appears here (and only published pages ever do).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as pagesModule from '$lib/data/pages.server.js';
import { snapshotCopy } from './fixtures.js';

const page = (slug, extra = {}) => ({ slug, title: slug.toUpperCase(), bodyHtml: `<p>${slug} body</p>`, published: true, ...extra });

/** pages.server.js re-imported over a snapshot whose pages[] is `pages`. */
async function withSnapshotPages(pages) {
	vi.resetModules();
	vi.doMock('$lib/data/cms-snapshot.json', async (importOriginal) => {
		const orig = await importOriginal();
		return { ...orig, pages, default: { ...orig.default, pages } };
	});
	return import('$lib/data/pages.server.js');
}

afterEach(() => {
	vi.doUnmock('$lib/data/cms-snapshot.json');
	vi.resetModules();
});

describe('pages.server.js (committed snapshot)', () => {
	it('exports publishedPages and publishedPage', () => {
		expect(Object.keys(pagesModule).sort()).toEqual(['publishedPage', 'publishedPages']);
	});

	it('has no published page yet: the policy drafts are not in the snapshot at all', () => {
		expect(snapshotCopy().pages).toEqual([]);
		expect(pagesModule.publishedPages).toEqual([]);
		expect(Object.isFrozen(pagesModule.publishedPages)).toBe(true);
		for (const slug of ['shipping', 'refunds', 'grievances']) expect(pagesModule.publishedPage(slug)).toBeNull();
	});
});

describe('pages.server.js (a synced snapshot with pages)', () => {
	it('lists published pages in snapshot (footer) order, as frozen copies', async () => {
		const pages = [page('shipping'), page('refunds')];
		const mod = await withSnapshotPages(pages);
		expect(mod.publishedPages).toStrictEqual([page('shipping'), page('refunds')]);
		expect(mod.publishedPages[0]).not.toBe(pages[0]);
		expect(Object.isFrozen(mod.publishedPages[0])).toBe(true);
		expect(() => (mod.publishedPages[0].bodyHtml = '<p>x</p>')).toThrow(TypeError);
		expect(pages[0].bodyHtml).toBe('<p>shipping body</p>');
	});

	it('publishedPage(slug) finds a page or returns null', async () => {
		const mod = await withSnapshotPages([page('shipping'), page('refunds')]);
		expect(mod.publishedPage('refunds')).toStrictEqual(page('refunds'));
		for (const slug of ['grievances', '', 'Shipping', null, undefined, 42, '__proto__']) expect(mod.publishedPage(slug)).toBeNull();
	});

	it('never exposes a page that is not published: true, even if one slipped into the snapshot', async () => {
		const mod = await withSnapshotPages([
			page('shipping', { published: false }),
			page('refunds'),
			page('grievances', { published: 'yes' }),
			page('terms', { published: 1 })
		]);
		expect(mod.publishedPages.map((p) => p.slug)).toEqual(['refunds']);
		expect(mod.publishedPage('shipping')).toBeNull();
		expect(mod.publishedPage('grievances')).toBeNull();
	});
});
