/*
 * HUNT data-cms (round 2): one mistyped product image path blocks every later storefront deploy.
 *
 * Products → Images → "Image path" is free text ("e.g. /images/wefeasto/product-oats.jpg"); the CMS and
 * the snapshot validator only check its shape (checkPathOrUrl). A path to a file that is not in static/
 * is accepted, synced, and then the prerender crawler follows the product's <img src> on / and /shop and
 * fails the whole build:  Error: 404 /images/wefeasto/product-muesli-typo.jpg (linked from /)
 * site-links.js explains why CMS typos must not do this ("one typo (/shopp) would block every later
 * storefront deploy"), and handleHttpError forgives 404s from recipe/page HTML — but not from the
 * catalog's own image fields (products[].image, recipes[].image), which templates render.
 *
 * Correct behaviour: the CMS refuses the path (400), or sync + build still succeed (a broken image, a
 * build warning), exactly like a mistyped link in recipe HTML.
 */
import { test, expect } from '../../fixtures.js';
import { errorLines, syncAndBuild } from './helpers.js';

test.describe.configure({ timeout: 300_000 });

test('a product image path to a missing file keeps the storefront buildable', async ({ admin, stack }) => {
	try {
		await admin.updateProduct('muesli', { image: '/images/wefeasto/product-muesli-typo.jpg' }); // restored after the test
	} catch (e) {
		if (/→ 400/.test(String(e?.message))) return; // refused on save: fine
		throw e;
	}
	const { sync, build } = await syncAndBuild(stack.cmsUrl);
	expect(sync.code, `sync-cms refused the CMS snapshot:\n${errorLines(sync.out)}`).toBe(0);
	expect(build?.code, `storefront build failed:\n${errorLines(build?.out)}`).toBe(0);
});
