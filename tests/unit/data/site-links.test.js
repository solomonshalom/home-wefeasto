/*
 * CMS content links vs. the pages the build produces (hunt data-cms
 * unpublish-breaks-build): unpublishing a product that a recipe body links,
 * or a typo in a page body, must not fail the storefront build.
 * - site-links.js (pure): which links are dead, unwrapping them, and what CMS
 *   content links (the svelte.config.js backstop);
 * - STATIC_PAGES / NON_PAGE_ROOTS stay in step with src/routes and static/;
 * - svelte.config.js handleHttpError / handleMissingId: CMS-linked → warn,
 *   anything else → fail (the SvelteKit default).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { STATIC_PAGES, NON_PAGE_ROOTS, sitePath, builtPagePaths, isDeadPageLink, unlinkDeadLinks, cmsLinkTargets, cmsBodies } from '../../../src/lib/data/site-links.js';
import { handleHttpError, handleMissingId, resetCmsLinks } from '../../../svelte.config.js';
import { ROOT } from './fixtures.js';

const built = builtPagePaths({ products: [{ slug: 'muesli' }], recipes: [{ slug: 'wf-parfait' }], pageSlugs: ['shipping'] });

describe('the page lists stay in step with the app', () => {
	it('STATIC_PAGES is every src/routes page without a [param]', () => {
		const found = [];
		const walk = (dir, url) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				if (e.isDirectory()) walk(path.join(dir, e.name), `${url === '/' ? '' : url}/${e.name}`);
				else if (e.name === '+page.svelte' && !url.includes('[')) found.push(url.replace(/\/\([^)]*\)/g, '') || '/');
			}
		};
		walk(path.join(ROOT, 'src/routes'), '/');
		expect([...STATIC_PAGES].sort()).toEqual(found.sort());
	});

	it('NON_PAGE_ROOTS is /_app, /api and every extensionless entry of static/', () => {
		const statics = fs.readdirSync(path.join(ROOT, 'static')).filter((n) => !n.startsWith('.') && !n.includes('.'));
		expect([...NON_PAGE_ROOTS].sort()).toEqual(['_app', 'api', ...statics].sort());
	});
});

describe('sitePath / isDeadPageLink', () => {
	it('resolves root-relative and relative hrefs on this site; off-site links are null', () => {
		expect(sitePath('/products/muesli/')).toEqual({ path: '/products/muesli', hash: '' });
		expect(sitePath('/shop?x=1#top')).toEqual({ path: '/shop', hash: 'top' });
		expect(sitePath('#steps', '/recipes/wf-parfait')).toEqual({ path: '/recipes/wf-parfait', hash: 'steps' });
		expect(sitePath('muesli', '/products/x')).toEqual({ path: '/products/muesli', hash: '' });
		expect(sitePath('/caf%C3%A9')).toEqual({ path: '/café', hash: '' });
		for (const off of ['https://example.com/shop', '//cdn.example.com/x', 'mailto:hi@wefeasto.com', 'tel:+911234567890', '', '  ', null]) expect(sitePath(off)).toBe(null);
	});

	it('pages the build produces are alive; everything else that looks like a page is dead', () => {
		for (const ok of ['/', '/shop', '/shop/', '/products/muesli', '/recipes/wf-parfait', '/shipping', '#x', 'https://x.com/nope']) expect(isDeadPageLink(ok, built), ok).toBe(false);
		for (const dead of ['/products/steel-cut-oats', '/shopp', '/products', '/recipes/gone', '/Shop', '/refunds']) expect(isDeadPageLink(dead, built), dead).toBe(true);
	});

	it('files and non-page roots are left to the build (never unwrapped)', () => {
		for (const file of ['/images/menu.pdf', '/color-combos.html', '/api/media/file/x.png', '/api/anything', '/_app/x', '/pin/110.json', '/images']) expect(isDeadPageLink(file, built), file).toBe(false);
	});
});

describe('unlinkDeadLinks', () => {
	it('unwraps dead links (text and inline markup stay), keeps every other link byte-for-byte', () => {
		const html =
			'<ul><li>1 cup <a href="/products/steel-cut-oats">Wefeasto <strong>Steel-Cut</strong> Oats</a></li>' +
			'<li><a href="/products/muesli">Muesli</a> · <a class="x" href=\'/shopp\' title="a > b">shop</a> · <a href=/typo>t</a></li>' +
			'<li><a href="https://example.com/x">ext</a> <a href="#steps">steps</a> <a name="anchor">n</a> <A HREF="/Nope">caps</A></li></ul>';
		const { html: out, dropped } = unlinkDeadLinks(html, built, '/recipes/wf-parfait');
		expect(out).toBe(
			'<ul><li>1 cup Wefeasto <strong>Steel-Cut</strong> Oats</li>' +
				'<li><a href="/products/muesli">Muesli</a> · shop · t</li>' +
				'<li><a href="https://example.com/x">ext</a> <a href="#steps">steps</a> <a name="anchor">n</a> caps</li></ul>'
		);
		expect(dropped).toEqual(['/products/steel-cut-oats', '/shopp', '/typo', '/Nope']);
	});

	it('decodes entities in the href before judging it', () => {
		expect(unlinkDeadLinks('<a href="&#x2F;products&#47;muesli">m</a>', built).dropped).toEqual([]);
		expect(unlinkDeadLinks('<a href="/shop?a=1&amp;b=2">s</a>', built).dropped).toEqual([]);
	});

	it('is a no-op on HTML without links and on non-strings', () => {
		expect(unlinkDeadLinks('<p>plain</p>', built)).toEqual({ html: '<p>plain</p>', dropped: [] });
		expect(unlinkDeadLinks(undefined, built)).toEqual({ html: undefined, dropped: [] });
	});
});

describe('cmsLinkTargets (the prerender backstop input)', () => {
	const snapshot = {
		settings: { announcement: { enabled: true, text: 'Sale', href: '/products/gone' } },
		recipes: [{ slug: 'wf-parfait', ingredientsHtml: '<a href="/products/muesli">m</a><img src="/images/typo.png" srcset="/images/a.png 1x, /images/b.png 2x">', directionsHtml: '<a href="#missing">x</a>', whyHtml: '' }],
		pages: [{ slug: 'shipping', bodyHtml: "<a href='/shop#nope'>s</a>" }]
	};

	it('collects href / src / srcset paths and #hash links, resolved on the page each body renders on', () => {
		const { paths, hashlinks } = cmsLinkTargets(snapshot);
		expect([...paths].sort()).toEqual(['/images/a.png', '/images/b.png', '/images/typo.png', '/products/gone', '/products/muesli', '/recipes/wf-parfait', '/shop'].sort());
		expect([...hashlinks].sort()).toEqual(['/recipes/wf-parfait#missing', '/shop#nope']);
		expect(cmsBodies(snapshot).map((b) => b.from)).toEqual(['/recipes/wf-parfait', '/recipes/wf-parfait', '/recipes/wf-parfait', '/shipping']);
	});

	it('tolerates a snapshot without recipes, pages or settings', () => {
		expect(cmsLinkTargets({})).toEqual({ paths: new Set(), hashlinks: new Set() });
	});
});

describe('svelte.config.js prerender backstop', () => {
	afterEach(() => {
		resetCmsLinks();
		vi.restoreAllMocks();
	});
	// The warning goes straight to stderr (fd 2): the prerender worker may drop async console output.
	const warn = () => vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);

	it('a 404 that CMS content links warns; the build goes on', () => {
		resetCmsLinks({ paths: new Set(['/images/typo.png', '/shopp']), hashlinks: new Set() });
		const w = warn();
		expect(() => handleHttpError({ status: 404, path: '/images/typo.png', referrer: '/recipes/x', referenceType: 'linked', message: '404 /images/typo.png' })).not.toThrow();
		expect(() => handleHttpError({ status: 404, path: '/shopp/', referrer: '/x', referenceType: 'linked', message: '404 /shopp/' })).not.toThrow();
		expect(w).toHaveBeenCalledTimes(2);
		expect(w.mock.calls[0][0]).toBe(2);
		expect(w.mock.calls[0][1]).toMatch(/^\[prerender\] 404 \/images\/typo\.png\n {2}\(linked from CMS content/);
	});

	it('everything else still fails the build: template links, our own page routes, other statuses', () => {
		resetCmsLinks({ paths: new Set(['/shop', '/images/typo.png']), hashlinks: new Set() });
		expect(() => handleHttpError({ status: 404, path: '/nav-typo', referrer: '/', referenceType: 'linked', message: '404 /nav-typo' })).toThrow('404 /nav-typo');
		expect(() => handleHttpError({ status: 404, path: '/shop', referrer: '/', referenceType: 'linked', message: '404 /shop' })).toThrow('404 /shop');
		expect(() => handleHttpError({ status: 500, path: '/images/typo.png', referrer: '/', referenceType: 'linked', message: '500 /images/typo.png' })).toThrow('500');
	});

	it('a missing #id warns only when CMS content links it', () => {
		resetCmsLinks({ paths: new Set(), hashlinks: new Set(['/shop#nope']) });
		warn();
		expect(() => handleMissingId({ path: '/shop', id: 'nope', referrers: ['/shipping'], message: 'missing #nope' })).not.toThrow();
		expect(() => handleMissingId({ path: '/recipes/x', id: 'Ingredients', referrers: ['/recipes/x'], message: 'missing #Ingredients' })).toThrow('missing #Ingredients');
	});

	it('reads the committed snapshot when nothing is cached: its recipe product links are CMS-linked', () => {
		resetCmsLinks();
		warn();
		expect(() => handleHttpError({ status: 404, path: '/products/steel-cut-oats', referrer: '/recipes/x', referenceType: 'linked', message: '404' })).not.toThrow();
	});
});

describe('the data layer on the committed snapshot', () => {
	it('builtPaths holds every product, recipe and static page; no committed body link is dead', async () => {
		const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
		const { builtPaths, withLiveLinks, liveHref } = await import('$lib/data/site-paths.js');
		for (const p of snapshot.products) expect(builtPaths.has(`/products/${p.slug}`)).toBe(true);
		for (const r of snapshot.recipes) expect(builtPaths.has(`/recipes/${r.slug}`)).toBe(true);
		for (const s of STATIC_PAGES) expect(builtPaths.has(s)).toBe(true);
		const { recipesContent } = await import('$lib/data/recipes-content.js');
		for (const r of snapshot.recipes) {
			for (const key of ['ingredientsHtml', 'directionsHtml', 'whyHtml']) expect(recipesContent[r.slug][key], `${r.slug}.${key}`).toBe(r[key]);
		}
		expect(withLiveLinks('<a href="/products/not-a-cereal">Not a cereal</a> <a href="/shop">shop</a>', '/x')).toBe('Not a cereal <a href="/shop">shop</a>');
		expect(liveHref('/products/not-a-cereal')).toBe('');
		expect(liveHref('/shop')).toBe('/shop');
		expect(liveHref('https://example.com/sale')).toBe('https://example.com/sale');
	});
});
