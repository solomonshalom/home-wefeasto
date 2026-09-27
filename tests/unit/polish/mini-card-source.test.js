/*
 * Where each MiniProductCard add says it came from (the `source` on
 * wf:cart-add and add_to_cart): AddToCart is swapped for a probe that prints
 * the props it gets, so the server render shows the wiring.
 *   PDP "Goes well with" → goes-with, recipe "Shop the Ingredients" →
 *   recipe-ingredients, the error page's bestsellers → not-found
 *   ('404' would be dropped: cart.js only keeps /^[a-z][a-z0-9_-]{0,31}$/).
 * Browser behaviour: e2e/ui/polish.spec.js.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';

vi.mock('$lib/components/AddToCart.svelte', async () => await import('./fixtures/AddToCartProbe.svelte'));
const route = vi.hoisted(() => ({ status: 404, url: new URL('http://localhost/nope') }));
vi.mock('$app/state', () => ({ page: route }));

import MiniProductCard from '$lib/components/MiniProductCard.svelte';
import CardSourceHost from './fixtures/CardSourceHost.svelte';
import ErrorPage from '../../../src/routes/+error.svelte';
import ProductPage from '../../../src/routes/products/[slug]/+page.svelte';
import RecipePage from '../../../src/routes/recipes/[slug]/+page.svelte';
import { load as loadProduct } from '../../../src/routes/products/[slug]/+page.js';
import { load as loadRecipe } from '../../../src/routes/recipes/[slug]/+page.js';
import { productsContent } from '$lib/data/products-content.js';
import { recipesContent } from '$lib/data/recipes-content.js';
import { createCart, CART_ADD_EVENT } from '$lib/cart.js';
import { products as snapshotProducts } from '$lib/data/cms-snapshot.json';

const html = (C, props) => render(C, { props }).body;
/** `[[slug, source], …]` for every AddToCart in the markup, in order. */
const probes = (markup) => [...markup.matchAll(/<i data-probe-slug="([^"]+)" data-probe-source="([^"]*)">/g)].map((m) => [m[1], m[2]]);

const card = productsContent.cornflakes.goesWith[0];

describe('MiniProductCard → AddToCart source', () => {
	it('defaults to card (AddToCart’s own default)', () => {
		expect(probes(html(MiniProductCard, { card }))).toEqual([[card.slug, 'card']]);
	});

	it.each(['goes-with', 'recipe-ingredients', 'not-found'])('passes source=%j through', (source) => {
		expect(probes(html(MiniProductCard, { card, source }))).toEqual([[card.slug, source]]);
	});

	it('setMiniCardSource() sets the default for cards below; an explicit source still wins', () => {
		expect(probes(html(CardSourceHost, { inherited: 'not-found', card, explicit: 'goes-with' }))).toEqual([
			[card.slug, 'not-found'],
			[card.slug, 'goes-with']
		]);
	});

	it('without setMiniCardSource() the default stays card', () => {
		expect(probes(html(CardSourceHost, { inherited: undefined, card, explicit: 'recipe-ingredients' }))).toEqual([
			[card.slug, 'card'],
			[card.slug, 'recipe-ingredients']
		]);
	});
});

describe('the pages that render MiniProductCards', () => {
	it.each(Object.keys(productsContent))('PDP %s: main button pdp, every "Goes well with" card goes-with', (slug) => {
		const out = probes(html(ProductPage, { data: loadProduct({ params: { slug } }) }));
		const goesWith = productsContent[slug].goesWith.map((c) => [c.slug, 'goes-with']);
		expect(goesWith.length).toBeGreaterThan(0);
		expect(out).toEqual([[slug, 'pdp'], ...goesWith]);
	});

	it.each(Object.keys(recipesContent))('recipe %s: rail recipe, every "Shop the Ingredients" card recipe-ingredients', (slug) => {
		const out = probes(html(RecipePage, { data: loadRecipe({ params: { slug } }) }));
		const ingredients = recipesContent[slug].shopIngredients.map((c) => [c.slug, 'recipe-ingredients']);
		expect(ingredients.length).toBeGreaterThan(0);
		expect(out).toEqual([[ingredients[0][0], 'recipe'], ...ingredients]);
	});

	it.each([404, 500])('error page (status %i): the three bestsellers say not-found', (status) => {
		route.status = status;
		const out = probes(html(ErrorPage, {}));
		expect(out).toHaveLength(3);
		for (const [, source] of out) expect(source).toBe('not-found');
		route.status = 404;
	});

	it('the cart keeps these sources on wf:cart-add ("404" would be dropped to null)', () => {
		const events = new EventTarget();
		const seen = [];
		events.addEventListener(CART_ADD_EVENT, (e) => seen.push(e.detail.source));
		const { Cart } = createCart({ getStorage: () => null, events, catalog: () => snapshotProducts });
		for (const source of ['goes-with', 'recipe-ingredients', 'not-found', '404']) Cart.add('muesli', 1, { source });
		expect(seen).toEqual(['goes-with', 'recipe-ingredients', 'not-found', null]);
	});
});
