/* Recipe-page content keyed by route slug (wf-…; key order = /recipes card order),
 * derived from the CMS snapshot — edit recipes in Payload, not here.
 * Same shape as the file tools/extract.mjs generated from the original HTML.
 * The long-form bodies (intro, ingredients, directions, …) come from their own
 * module (vite.config.js snapshotSplit), so they load only with this file —
 * the recipe pages — and not in the chunk every page shares. */
import { products, recipes as catalogRecipes } from 'virtual:cms-snapshot/catalog';
import { recipeBodies } from 'virtual:cms-snapshot/recipe-bodies';
import { buildRecipesContent } from './derive.js';
import { withLiveLinks } from './site-paths.js';

/* A body may still link a product (or page) that is no longer published:
 * those links are unwrapped to plain text (site-links.js), so the page never
 * points at a 404 and the prerender crawler never fails the build on one. */
const BODY_HTML = ['ingredientsHtml', 'directionsHtml', 'whyHtml'];
const recipes = catalogRecipes.map((r) => {
	const body = { ...recipeBodies[r.slug] };
	for (const key of BODY_HTML) if (typeof body[key] === 'string') body[key] = withLiveLinks(body[key], `/recipes/${r.slug}`);
	return { ...r, ...body };
});

export const recipesContent = buildRecipesContent({ products, recipes });
