/*
 * Wefeasto shared catalog data — an adapter over the CMS snapshot
 * (cms-snapshot.json, synced from Payload; see snapshot-schema.js).
 * Same exports and shapes as the hand-written port of js/products-data.js:
 * image paths are absolute (/images/…), URLs live in the SvelteKit route space,
 * and prices are numbers in INR — format for display with formatINR (e.g. ₹175).
 * Money maths that matters happens server-side in paise.
 */
import { products as snapshotProducts, recipes as snapshotRecipes } from 'virtual:cms-snapshot/catalog'; // cms-snapshot.json minus the recipe bodies (vite.config.js)
import { buildProducts, buildRecipes, formatINR } from './derive.js';

export const products = buildProducts({ products: snapshotProducts });

export const recipes = buildRecipes({ recipes: snapshotRecipes });

export function productBySlug(slug) {
	return products.find((p) => p.slug === slug) || null;
}

export { formatINR };
