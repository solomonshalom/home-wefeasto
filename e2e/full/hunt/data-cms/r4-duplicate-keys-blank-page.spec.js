/*
 * HUNT data-cms (round 4): two marketplace links with the same URL (or two recipe "extras" with the same
 * title) blank the whole product (recipe) page on the built storefront.
 *
 * The storefront renders these lists as keyed each blocks on CMS values:
 *   src/lib/components/PartnersDropdown.svelte   {#each partners as partner (partner.url)}
 *   src/routes/recipes/[slug]/+page.svelte       {#each r.extras as extra (extra.title)}
 * Svelte 5.56 throws each_key_duplicate on a duplicate key in PRODUCTION too, during hydration. SvelteKit's
 * client start then fails: the prerendered page is torn down and nothing is mounted — a blank page (no nav,
 * no product, no Add to Cart) with "https://svelte.dev/e/each_key_duplicate" as an uncaught error.
 * Neither the CMS (Products.partners / Recipes.extras have no uniqueness rule) nor the snapshot validator
 * (sync-cms) refuses the duplicates, so a routine edit — "Amazon" and "Amazon Fresh" pointing at the same
 * listing, a copy-pasted extra — ships a dead page.
 *
 * Correct behaviour: the page renders and hydrates (keys that can't collide, e.g. the index), or the CMS
 * refuses the duplicate on save.
 */
import { test, expect } from '../../fixtures.js';
import { createProduct, deleteProduct, uniqueSlug } from './helpers.js';
import { buildAndServe, recipeBody } from './r4-helpers.js';

test.setTimeout(420_000);

test('duplicate partner URL / extras title: product and recipe pages still render and hydrate', async ({ page, admin, stack, consoleErrors }) => {
	const url = 'https://www.amazon.in/dp/B0HUNTDUP1';
	let product = null;
	let recipeId = null;
	let site = null;
	try {
		try {
			product = await createProduct(admin, {
				partners: [
					{ name: 'Amazon', url },
					{ name: 'Amazon Fresh', url }
				]
			});
		} catch (e) {
			if (!/→ 400/.test(String(e?.message))) throw e; // refused on save: fine for this half
		}
		const body = await recipeBody(admin, { slug: `wf-${uniqueSlug('dup')}`, title: 'Hunt duplicate extras', _status: 'published' });
		const extra = body.extras[0];
		body.extras = [extra, { title: extra.title, reason: 'The same kit, listed twice by mistake.' }];
		const r = await admin.request('POST', 'recipes?depth=0', { body });
		if (r.status === 201) recipeId = r.json.doc.id;
		else expect(r.status, r.text.slice(0, 300)).toBe(400); // refused on save: fine for this half
		const recipeSlug = r.json?.doc?.slug;

		test.skip(!product && !recipeId, 'both duplicates refused by the CMS');
		site = await buildAndServe(stack.cmsUrl);
		consoleErrors.allow(/Failed to load resource/); // the preview's own /api 4xx noise is not the point

		const errors = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const targets = [];
		if (product) targets.push({ path: `/products/${product.slug}`, heading: product.name });
		if (recipeId) targets.push({ path: `/recipes/${recipeSlug}`, heading: 'Hunt duplicate extras' });
		for (const t of targets) {
			errors.length = 0;
			await page.goto(site.url + t.path, { waitUntil: 'networkidle' });
			await page.waitForTimeout(500);
			await expect.soft(page.locator('h1'), `${t.path}: the page must still show its heading`).toHaveText(t.heading);
			expect.soft(errors, `${t.path}: uncaught errors while hydrating`).toEqual([]);
		}
	} finally {
		consoleErrors.clear();
		if (site) await site.close();
		if (product) await deleteProduct(admin, product.id);
		if (recipeId) await admin.request('DELETE', `recipes/${recipeId}`);
	}
});
