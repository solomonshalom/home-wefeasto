// @vitest-environment jsdom
/*
 * CMS lists that may repeat a value must still mount (hunt round 4, data-cms:
 * "two marketplace links with the same URL blank the whole product page").
 *
 * Svelte throws each_key_duplicate for a keyed each block with a repeated
 * key, in production builds too, and during hydration that tears down the
 * whole prerendered page. Neither the CMS nor the snapshot validator makes
 * these values unique, so the storefront must key them by position:
 * product partners (two names on one listing URL), the PDP chips (packSize
 * can read like the calories chip) and a recipe's extras (a copy-pasted row).
 *
 * The real route components are mounted in jsdom with the client build of
 * svelte ('svelte' resolves to the server build under vitest's node
 * conditions, so it is mocked to the client entry for every importer).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, flushSync } from '../../../node_modules/svelte/src/index-client.js';
import PartnersDropdown from '$lib/components/PartnersDropdown.svelte';
import RecipePage from '../../../src/routes/recipes/[slug]/+page.svelte';
import ProductPage from '../../../src/routes/products/[slug]/+page.svelte';
import { recipesContent } from '$lib/data/recipes-content.js';
import { products } from '$lib/data/products.js';
import { productsContent } from '$lib/data/products-content.js';

vi.mock('svelte', async () => await import('../../../node_modules/svelte/src/index-client.js'));

const mounted = [];
function render(Component, props) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	mounted.push({ c: mount(Component, { target, props }), target });
	flushSync();
	return target;
}
afterEach(() => {
	for (const { c, target } of mounted.splice(0)) {
		unmount(c);
		target.remove();
	}
});

const URL_ = 'https://www.amazon.in/dp/B0HUNTDUP1';

describe('CMS rows with repeated values still render (keyed by position)', () => {
	it('PartnersDropdown: two partners on the same URL', () => {
		const el = render(PartnersDropdown, { partners: [{ name: 'Amazon', url: URL_ }, { name: 'Amazon Fresh', url: URL_ }] });
		const rows = [...el.querySelectorAll('.wf-partner-row')];
		expect(rows.map((a) => [a.textContent.replace('Buy ↗', '').trim(), a.getAttribute('href')])).toEqual([
			['Amazon', URL_],
			['Amazon Fresh', URL_]
		]);
	});

	it('product page: duplicate partner URLs and a chip repeated', () => {
		const product = products[0];
		const content = structuredClone(productsContent[product.slug]);
		content.partners = [{ name: 'Amazon', url: URL_ }, { name: 'Amazon Fresh', url: URL_ }];
		content.chips = ['120 cal per serving', '120 cal per serving'];
		const el = render(ProductPage, { data: { product, content } });
		expect(el.querySelector('h1')?.textContent).toBe(content.h1);
		expect(el.querySelectorAll('.wf-partner-row')).toHaveLength(2);
		expect([...el.querySelectorAll('.grid-3 .wf-chip-small')].map((c) => c.textContent)).toEqual(content.chips);
		expect(el.querySelector(`[data-wf-add="${product.slug}"]`)).not.toBeNull();
	});

	it('recipe page: two extras with the same title', () => {
		const slug = Object.keys(recipesContent)[0];
		const recipe = structuredClone(recipesContent[slug]);
		const extra = recipe.extras[0];
		recipe.extras = [extra, { title: extra.title, reason: 'The same kit, listed twice by mistake.' }];
		const el = render(RecipePage, { data: { slug, recipe } });
		expect(el.querySelector('h1')?.textContent).toBe(recipe.display);
		expect([...el.querySelectorAll('.wf-rec-card .heading-11')].map((h) => h.textContent)).toEqual([extra.title, extra.title]);
		expect([...el.querySelectorAll('.wf-rec-reason')].map((p) => p.textContent)).toEqual([extra.reason, 'The same kit, listed twice by mistake.']);
	});
});
