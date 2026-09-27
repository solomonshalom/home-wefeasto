/*
 * Recipe cards for the products in an order (/order "Make something with
 * it"). Built from the lean catalog (no recipe bodies — vite.config.js
 * snapshotSplit), in exactly the shape recipes-content.js gives
 * RecipeListCard (`recipesContent[slug].card`), so /order doesn't pull every
 * recipe body into its bundle. Keys are the route slugs (wf-…).
 */
import { recipes as catalogRecipes } from 'virtual:cms-snapshot/catalog';
import { prepLine, servesLine } from '$lib/data/derive.js';

/** The RecipeListCard `card` prop for a snapshot recipe. */
export function recipeCard(r) {
	return {
		category: r.category,
		catLabel: r.category,
		title: r.title,
		image: r.image,
		cardAlt: r.cardAlt,
		iconColor: r.iconColor,
		iconSrc: r.iconSrc,
		iconAlt: r.iconAlt,
		serves: servesLine(r),
		prepLine: prepLine(r),
		coverAria: `Open recipe: ${r.title}`
	};
}

/**
 * Up to `limit` recipes that use the ordered products, spread across them:
 * each product's first recipe, then each product's second, … (recipe order).
 * @param {string[]} slugs  ordered product slugs, in order
 * @returns {{slug: string, card: ReturnType<typeof recipeCard>}[]}
 */
export function recipeCardsFor(slugs, { limit = 2, recipes = catalogRecipes } = {}) {
	const list = Array.isArray(recipes) ? recipes : [];
	const wanted = [...new Set((Array.isArray(slugs) ? slugs : []).filter((s) => typeof s === 'string'))];
	const perProduct = wanted.map((slug) => list.filter((r) => Array.isArray(r.products) && r.products.some((x) => x && x.slug === slug)));
	const picked = [];
	const seen = new Set();
	for (let round = 0; picked.length < limit && perProduct.some((l) => l.length > round); round++) {
		for (const l of perProduct) {
			const r = l[round];
			if (r && !seen.has(r.slug)) {
				seen.add(r.slug);
				picked.push(r);
				if (picked.length >= limit) break;
			}
		}
	}
	return picked.map((r) => ({ slug: r.slug, card: recipeCard(r) }));
}
