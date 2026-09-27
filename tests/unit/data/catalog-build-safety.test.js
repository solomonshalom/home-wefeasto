/*
 * Catalog content the owner controls must never block every later storefront
 * deploy (hunt data-cms round 2):
 * - image-path-typo-breaks-build: products[].image / recipes[].image /
 *   recipes[].iconSrc are free text in the CMS; a path to a file static/ lacks
 *   is CMS content, so the crawled 404 warns (svelte.config.js) and sync-cms
 *   names it early. An uploaded image (/api/media/file/…) is served by the CMS
 *   at runtime: the crawler can't fetch it, and that is no warning at all.
 * - no-recipes-breaks-build: snapshot-schema.md lets `recipes` be empty, so
 *   /recipes/[slug] may build no page exactly when the snapshot has none.
 * The real builds for both are in catalog-edge-build.test.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cmsImageFields, cmsLinkTargets } from '../../../src/lib/data/site-links.js';
import { handleHttpError, handleUnseenRoutes, resetBuildSnapshot, MAY_BE_UNSEEN, MAY_BE_EMPTY } from '../../../svelte.config.js';
import { missingStaticImages, syncCms } from '../../../scripts/sync-cms.mjs';
import { ROOT } from './fixtures.js';

const committed = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
const TYPO = '/images/wefeasto/product-muesli-typo.jpg';
const UPLOAD = '/api/media/file/hunt-upload.png';

/** The committed snapshot with a mistyped product image, a mistyped recipe image and an uploaded image. */
function withImages() {
	const s = committed();
	s.products.find((p) => p.slug === 'muesli').image = TYPO;
	s.products.find((p) => p.slug === 'cornflakes').image = UPLOAD;
	s.recipes[0].image = '/images/typo-recipe.jpg';
	s.recipes[1].iconSrc = '/images/typo%20icon.svg';
	return s;
}

const http404 = (p) => ({ status: 404, path: p, referrer: '/', referenceType: 'linked', message: `404 ${p} (linked from /)` });

describe('the catalog image fields are CMS content', () => {
	it('cmsImageFields lists every product and recipe image field (as stored)', () => {
		const s = withImages();
		const fields = cmsImageFields(s);
		expect(fields).toHaveLength(s.products.length + 2 * s.recipes.length);
		expect(fields).toContainEqual({ field: 'products[muesli].image', url: TYPO });
		expect(fields).toContainEqual({ field: `recipes[${s.recipes[0].slug}].image`, url: '/images/typo-recipe.jpg' });
		expect(fields).toContainEqual({ field: `recipes[${s.recipes[1].slug}].iconSrc`, url: '/images/typo%20icon.svg' });
		expect(cmsImageFields({ products: [{ slug: 'x', image: '' }], recipes: [{ slug: 'y' }] })).toEqual([]);
	});

	it('cmsLinkTargets includes them (decoded, off-site URLs left out)', () => {
		const s = withImages();
		s.products.find((p) => p.slug === 'health-mix').image = 'https://blob.example.com/h.jpg';
		const { paths } = cmsLinkTargets(s);
		for (const p of [TYPO, UPLOAD, '/images/typo-recipe.jpg', '/images/typo icon.svg']) expect(paths.has(p), p).toBe(true);
		expect([...paths].some((p) => p.includes('blob.example.com'))).toBe(false);
	});
});

describe('svelte.config.js handleHttpError with the catalog image fields', () => {
	afterEach(() => {
		resetBuildSnapshot();
		vi.restoreAllMocks();
	});
	const warn = () => vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);

	it('a mistyped product or recipe image path warns; the build goes on', () => {
		resetBuildSnapshot(withImages());
		const w = warn();
		expect(() => handleHttpError(http404(TYPO))).not.toThrow();
		expect(() => handleHttpError(http404('/images/typo-recipe.jpg'))).not.toThrow();
		expect(() => handleHttpError(http404('/images/typo icon.svg'))).not.toThrow();
		expect(w).toHaveBeenCalledTimes(3);
		expect(w.mock.calls[0][1]).toMatch(/^\[prerender\] 404 \/images\/wefeasto\/product-muesli-typo\.jpg .*\n {2}\(linked from CMS content/);
	});

	it('an uploaded image (/api/media/file/…) passes silently: the CMS serves it at runtime', () => {
		resetBuildSnapshot(withImages());
		const w = warn();
		expect(() => handleHttpError(http404(UPLOAD))).not.toThrow();
		expect(w).not.toHaveBeenCalled();
	});

	it('an image only our templates link, another /api path, or a non-404 still fails the build', () => {
		resetBuildSnapshot(withImages());
		expect(() => handleHttpError(http404('/images/wefeasto/logo-typo.png'))).toThrow('404 /images/wefeasto/logo-typo.png');
		expect(() => handleHttpError(http404('/api/media/file/not-in-the-snapshot.png'))).toThrow('404');
		expect(() => handleHttpError({ ...http404(TYPO), status: 500, message: '500' })).toThrow('500');
	});

	it('the committed snapshot: a template image is not CMS-linked by accident', () => {
		resetBuildSnapshot();
		expect(() => handleHttpError(http404('/images/webclip.png'))).toThrow('404');
	});
});

describe('svelte.config.js handleUnseenRoutes: /recipes/[slug] with no recipes', () => {
	afterEach(() => resetBuildSnapshot());
	const unseen = (routes) => () => handleUnseenRoutes({ routes, message: 'x' });

	it('may build no page when the snapshot has no recipes', () => {
		expect(MAY_BE_UNSEEN).toEqual(['/[policy=policy]']);
		expect(MAY_BE_EMPTY).toEqual({ '/recipes/[slug]': 'recipes' });
		resetBuildSnapshot({ ...committed(), recipes: [] });
		expect(unseen(['/recipes/[slug]'])).not.toThrow();
		expect(unseen(['/recipes/[slug]', '/[policy=policy]'])).not.toThrow();
	});

	it('still fails with recipes in the snapshot, an unreadable snapshot, or any other route', () => {
		resetBuildSnapshot(committed());
		expect(unseen(['/recipes/[slug]'])).toThrow(/- \/recipes\/\[slug\][^]*only with no recipes/);
		resetBuildSnapshot(null);
		expect(unseen(['/recipes/[slug]'])).toThrow(/recipes/);
		resetBuildSnapshot({ ...committed(), recipes: [], products: [] });
		expect(unseen(['/products/[slug]'])).toThrow(/products/);
		expect(unseen(['/recipes/[slug]', '/products/[slug]'])).toThrow(/- \/products\/\[slug\]/);
	});

	it('reads the committed snapshot when nothing is cached (it has recipes)', () => {
		resetBuildSnapshot();
		expect(unseen(['/recipes/[slug]'])).toThrow(/recipes/);
	});
});

describe('sync-cms names image paths static/ lacks (never fatal)', () => {
	it('missingStaticImages: the committed snapshot has none; typos are listed; uploads and https are skipped', () => {
		expect(missingStaticImages(committed())).toEqual([]);
		const s = withImages();
		s.products.find((p) => p.slug === 'health-mix').image = 'https://blob.example.com/h.jpg';
		s.recipes[2].image = '/../package.json';
		expect(missingStaticImages(s).sort()).toEqual(
			[`products[muesli].image: ${TYPO}`, `recipes[${s.recipes[0].slug}].image: /images/typo-recipe.jpg`, `recipes[${s.recipes[1].slug}].iconSrc: /images/typo%20icon.svg`, `recipes[${s.recipes[2].slug}].image: /../package.json`].sort()
		);
	});

	it('a directory is not an image file', () => {
		const s = committed();
		s.products[0].image = '/images';
		expect(missingStaticImages(s)).toEqual([`products[${s.products[0].slug}].image: /images`]);
	});

	it('syncCms still writes the snapshot (exit 0, even with CMS_REQUIRED=1) and warns with the fields', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sync-images-'));
		try {
			const file = path.join(dir, 'snap.json');
			const s = withImages();
			const warn = vi.fn();
			const code = await syncCms({
				argv: ['--force'],
				env: { CMS_URL: 'http://cms.test', CMS_REQUIRED: '1' },
				file,
				fetchImpl: async () => new Response(JSON.stringify(s), { status: 200, headers: { 'content-type': 'application/json' } }),
				log: () => {},
				warn
			});
			expect(code).toBe(0);
			expect(JSON.parse(fs.readFileSync(file, 'utf8')).products.find((p) => p.slug === 'muesli').image).toBe(TYPO);
			expect(warn).toHaveBeenCalledTimes(1);
			const msg = warn.mock.calls[0][0];
			expect(msg).toMatch(/^sync-cms: warning: 3 image path\(s\) name no file in static\//);
			expect(msg).toContain(`  - products[muesli].image: ${TYPO}`);
			expect(msg).not.toContain(UPLOAD);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
