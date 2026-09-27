/*
 * Card lists for pages that used to hard-code their catalog copy: the home
 * page's "Shop Bestsellers" and "Fresh from the Wefeasto Kitchen" rows and the
 * /shop grid. Each call returns fresh arrays with exactly the fields (and key
 * order) the markup already reads, so swapping the literals for these calls
 * changes no rendered HTML. Which products/recipes appear on the home page is
 * the snapshot's `homeFeatured` flag; order is catalog order.
 */
import { products, recipes } from 'virtual:cms-snapshot/catalog'; // cms-snapshot.json minus the recipe bodies (vite.config.js)
import { buildHomeBestsellers, buildKitchenRecipes, buildShopItems } from './derive.js';

const same = (list) => list;

/**
 * `[{url, aria, image, alt, cat, priceLine, title, starLine}]` — src/routes/+page.svelte `bestsellers`.
 * `overlay` maps the snapshot products first: pass `withLivePrices` from
 * $lib/live.js to re-derive the price lines from the live catalog.
 * @param {(products: any[]) => any[]} [overlay]
 */
export function homeBestsellers(overlay = same) {
	return buildHomeBestsellers({ products: overlay(products) });
}

/** `[{url, aria, image, alt, cat, title, iconColor, iconSrc, iconAlt}]` — src/routes/+page.svelte `kitchenRecipes`. */
export function kitchenRecipes() {
	return buildKitchenRecipes({ recipes });
}

/**
 * `[{slug, name, category, terms, image, alt, viewAria, priceLine, starsAria, starsRating, pack}]` — src/routes/shop/+page.svelte `items`.
 * @param {(products: any[]) => any[]} [overlay] as for homeBestsellers()
 */
export function shopItems(overlay = same) {
	return buildShopItems({ products: overlay(products) });
}
