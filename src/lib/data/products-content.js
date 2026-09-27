/* Product-page content (PDP hero, chips, "Goes well with", "Recipes using …"),
 * derived from the CMS snapshot — edit products in Payload, not here.
 * Same shape as the file tools/extract.mjs generated from the original HTML. */
import { products, recipes } from 'virtual:cms-snapshot/catalog'; // cms-snapshot.json minus the recipe bodies (vite.config.js)
import { buildProductsContent } from './derive.js';

export const productsContent = buildProductsContent({ products, recipes });
