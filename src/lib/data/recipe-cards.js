/*
 * The /recipes grid's cards, from the lean catalog (virtual:cms-snapshot/catalog:
 * the snapshot minus the recipe bodies). recipes-content.js has the same
 * `.card`s, but it merges in every recipe body (~14 KB gz), which the list
 * page never shows, so the list page reads this instead and the bodies load
 * only with a recipe page.
 */
import { recipes } from 'virtual:cms-snapshot/catalog';
import { buildRecipeCards } from './derive.js';

/** `[{slug, card}]` in /recipes card order; each `card` deep-equals `recipesContent[slug].card`. Fresh arrays each call. */
export function recipeCards() {
	return buildRecipeCards({ recipes });
}
