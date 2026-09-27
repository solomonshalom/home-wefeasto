/*
 * The snapshot adapters must export exactly what the hand-written/generated
 * data files did (SPEC §3): same names, same shapes, same values, same key
 * order — compared field by field against the frozen legacy fixtures.
 */
import { describe, it, expect } from 'vitest';
import * as productsModule from '$lib/data/products.js';
import * as productsContentModule from '$lib/data/products-content.js';
import * as recipesContentModule from '$lib/data/recipes-content.js';
import * as catalogViews from '$lib/data/catalog-views.js';
import * as snapshot from '$lib/data/cms-snapshot.json';
import { legacy } from './fixtures.js';

const { products, recipes, productBySlug, formatINR } = productsModule;
const { productsContent } = productsContentModule;
const { recipesContent } = recipesContentModule;

const L = {
	products: legacy('products'),
	recipes: legacy('recipes'),
	productsContent: legacy('productsContent'),
	recipesContent: legacy('recipesContent'),
	bestsellers: legacy('home-bestsellers'),
	kitchenRecipes: legacy('home-kitchenRecipes'),
	shopItems: legacy('shop-items'),
	formatINR: legacy('formatINR'),
	productBySlug: legacy('productBySlug')
};

/** Deep equality AND identical key order (JSON text), so shapes match exactly. */
function expectSame(actual, expected) {
	expect(actual).toStrictEqual(expected);
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

/** One test per record and field, so a regression names exactly what drifted. */
function fieldCases(expectedRecords) {
	return Object.entries(expectedRecords).flatMap(([key, record]) =>
		Object.keys(record).map((field) => [key, field])
	);
}

describe('module surface', () => {
	it('keeps the legacy export names', () => {
		expect(Object.keys(productsModule).sort()).toEqual(['formatINR', 'productBySlug', 'products', 'recipes']);
		expect(Object.keys(productsContentModule)).toEqual(['productsContent']);
		expect(Object.keys(recipesContentModule)).toEqual(['recipesContent']);
		expect(Object.keys(catalogViews).sort()).toEqual(['homeBestsellers', 'kitchenRecipes', 'shopItems']);
	});
});

describe('products.js', () => {
	it('products deep-equals the legacy export (values, order, key order)', () => {
		expectSame(products, L.products);
	});

	it.each(fieldCases(L.products))('products[%s].%s', (i, field) => {
		expect(products[i][field]).toStrictEqual(L.products[i][field]);
	});

	it('recipes deep-equals the legacy export', () => {
		expectSame(recipes, L.recipes);
	});

	it.each(fieldCases(L.recipes))('recipes[%s].%s', (i, field) => {
		expect(recipes[i][field]).toStrictEqual(L.recipes[i][field]);
	});

	it('prices stay rupee numbers (the cart and search maths read them)', () => {
		for (const p of products) expect(Number.isInteger(p.price)).toBe(true);
	});

	it.each(L.productBySlug)('productBySlug(%j) → %j', (slug, expected) => {
		const hit = productBySlug(slug);
		expect(hit?.slug ?? null).toBe(expected);
		if (hit) expect(hit).toBe(products.find((p) => p.slug === slug)); // same object, like the legacy find
	});

	it('productBySlug(undefined) and prototype keys → null', () => {
		expect(productBySlug(undefined)).toBeNull();
		expect(productBySlug('constructor')).toBeNull();
		expect(productBySlug('__proto__')).toBeNull();
	});

	it.each(L.formatINR)('formatINR(%j) → %s', (input, expected) => {
		expect(formatINR(input === '__undefined__' ? undefined : input)).toBe(expected);
	});
});

describe('products-content.js', () => {
	it('deep-equals the legacy export, including its (alphabetical) key order', () => {
		expectSame(productsContent, L.productsContent);
	});

	it.each(fieldCases(L.productsContent))('productsContent[%s].%s', (slug, field) => {
		expect(productsContent[slug][field]).toStrictEqual(L.productsContent[slug][field]);
	});

	it('has an entry for every product slug (the PDP 404s otherwise)', () => {
		expect(Object.keys(productsContent).sort()).toEqual(products.map((p) => p.slug).sort());
	});
});

describe('recipes-content.js', () => {
	it('deep-equals the legacy export', () => {
		expectSame(recipesContent, L.recipesContent);
	});

	it('keeps key order = /recipes card order (recipes/[slug] entries() and the list page iterate it)', () => {
		expect(Object.keys(recipesContent)).toEqual(Object.keys(L.recipesContent));
	});

	it.each(fieldCases(L.recipesContent))('recipesContent[%s].%s', (slug, field) => {
		expect(recipesContent[slug][field]).toStrictEqual(L.recipesContent[slug][field]);
	});
});

describe('catalog-views.js (home + shop card lists)', () => {
	it('homeBestsellers() deep-equals the +page.svelte bestsellers literal', () => {
		expectSame(catalogViews.homeBestsellers(), L.bestsellers);
	});

	it('kitchenRecipes() deep-equals the +page.svelte kitchenRecipes literal', () => {
		expectSame(catalogViews.kitchenRecipes(), L.kitchenRecipes);
	});

	it('shopItems() deep-equals the shop/+page.svelte items literal', () => {
		expectSame(catalogViews.shopItems(), L.shopItems);
	});

	it.each(['homeBestsellers', 'kitchenRecipes', 'shopItems'])('%s() returns fresh arrays each call', (name) => {
		const first = catalogViews[name]();
		first[0].alt = 'mutated';
		first.pop();
		expect(catalogViews[name]()).toStrictEqual(
			{ homeBestsellers: L.bestsellers, kitchenRecipes: L.kitchenRecipes, shopItems: L.shopItems }[name]
		);
	});
});

describe('isolation between exports', () => {
	it('derived records never alias the snapshot or each other (mutation cannot leak)', () => {
		const sp = snapshot.products[0];
		const p = products[0];
		expect(p.partners).not.toBe(sp.partners);
		expect(p.partners[0]).not.toBe(sp.partners[0]);
		expect(p.searchTerms).not.toBe(sp.searchTerms);
		expect(p.partners).not.toBe(productsContent[p.slug].partners);

		const sr = snapshot.recipes[0];
		const rc = recipesContent[sr.slug];
		expect(rc.extras).not.toBe(sr.extras);
		expect(rc.extras[0]).not.toBe(sr.extras[0]);
		expect(rc.recommended[0]).not.toBe(sr.recommended[0]);
		expect(rc.related).not.toBe(sr.related);
		expect(recipes[0].searchTerms).not.toBe(sr.searchTerms);
	});
});
