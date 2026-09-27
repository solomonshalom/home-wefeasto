import type { CollectionConfig, Field } from 'payload'

import { isAdminOrEditor, publishedOrAdmin } from '../access'
import {
  checkHomeAlt,
  checkPathOrUrl,
  checkRecipeSlug,
  checkRefList,
  checkStringList,
  fillSlugAndSortOrder,
  guardSlug,
  integerIn,
  oneOf,
  RATING_STYLES,
  RECIPE_CATEGORIES,
  RECIPE_COLOR_OPTIONS,
  RECIPE_COLORS,
  RECIPE_ICON_OPTIONS,
  RECIPE_ICONS,
  RECIPE_SLUG_RE,
  relId,
  requiredToPublish,
  safeHtml,
  type Check,
} from '../endpoints/catalog/rules'
import { deployHookAfterChange, deployHookAfterDelete } from '../hooks/deployHook'
import { draftSafeRestore } from '../lib/draftSafeRestore'
import { duplicateAsDraft, duplicateSlug, emptyOnDuplicate } from '../lib/duplicateDoc'
import { keepPublishStateOnPlainUpdate } from '../lib/draftSafeUpdate'

/**
 * Recipes: mirrors `recipes[]` of the catalog snapshot (SCRATCH/contracts/snapshot-schema.md §4).
 *
 * - The three HTML sections are stored VERBATIM (code fields, HTML) so the snapshot round trip is
 *   byte-exact; unsafe markup (script, style, frames, forms, on…= handlers, javascript: URLs) is rejected
 *   because the storefront renders them with {@html}.
 * - Route slugs keep the `wf-` prefix: /recipes/wf-<name>. Immutable once created (indexed URLs).
 * - Content fields are required to PUBLISH (enforced by their validators); a draft may be incomplete, so
 *   only the identity fields (slug, title) are `required` in the schema and the generated types.
 */

const requiredText = (
  name: string,
  { description, width, textarea = false, label }: { description?: string; width?: string; textarea?: boolean; label?: string } = {},
): Field =>
  ({
    name,
    ...(label ? { label } : {}),
    type: textarea ? 'textarea' : 'text',
    validate: requiredToPublish(),
    admin: { ...(description ? { description } : {}), ...(width ? { width } : {}) },
  }) as Field

const htmlField = (name: string, label: string, description: string): Field => ({
  name,
  label,
  type: 'code',
  validate: requiredToPublish(safeHtml),
  admin: { language: 'html', description },
})

const colorField = (name: string, description: string): Field => ({
  name,
  type: 'select',
  options: RECIPE_COLOR_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
  validate: requiredToPublish(oneOf(RECIPE_COLORS, 'colour')),
  admin: { description, width: '50%' },
})

const titledReasons = (name: string, description: string): Field => ({
  name,
  type: 'array',
  admin: { description, initCollapsed: true },
  fields: [
    { name: 'title', type: 'text', required: true, validate: requiredToPublish() },
    { name: 'reason', type: 'textarea', required: true, validate: requiredToPublish() },
  ],
})

/** "Products used": each product at most once. */
const checkProductRows: Check = (value) => {
  if (!Array.isArray(value)) return true
  const ids = value.map((row) => relId((row as { product?: unknown })?.product)).filter((id) => id != null).map(String)
  return new Set(ids).size === ids.length ? true : 'Each product can only be listed once.'
}

export const Recipes: CollectionConfig = {
  slug: 'recipes',
  labels: { singular: 'Recipe', plural: 'Recipes' },
  admin: {
    useAsTitle: 'title',
    group: 'Content',
    defaultColumns: ['title', 'sortOrder', 'category', 'homeFeatured', '_status', 'updatedAt'],
    listSearchableFields: ['title', 'slug'],
    description: 'Recipes on /recipes and on product pages. Publishing a change rebuilds the storefront.',
  },
  defaultSort: 'sortOrder',
  versions: { drafts: true, maxPerDoc: 20 },
  access: {
    read: publishedOrAdmin,
    // Without this Payload lets ANY logged-in user (customers too) read draft versions.
    readVersions: isAdminOrEditor,
    create: isAdminOrEditor,
    update: isAdminOrEditor,
    delete: isAdminOrEditor,
  },
  hooks: {
    // A save without draft / _status never unpublishes it (src/lib/draftSafeUpdate.ts).
    // Restoring a draft version keeps the live document published (src/lib/draftSafeRestore.ts).
    // Admin Duplicate: a draft copy with a free wf-<slug>-copy slug and the next sortOrder (src/lib/duplicateDoc.ts).
    beforeOperation: [keepPublishStateOnPlainUpdate('recipe'), draftSafeRestore.beforeOperation, duplicateAsDraft],
    beforeValidate: [fillSlugAndSortOrder('recipes', 'title', 'wf-')],
    beforeChange: [draftSafeRestore.beforeChange, guardSlug('recipes', RECIPE_SLUG_RE, 'Recipe slugs start with wf-, e.g. wf-masala-oats.')],
    afterChange: [draftSafeRestore.afterChange, deployHookAfterChange],
    afterDelete: [deployHookAfterDelete],
  },
  fields: [
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: requiredToPublish(checkRecipeSlug),
      hooks: { beforeDuplicate: [duplicateSlug('recipes')] },
      admin: {
        position: 'sidebar',
        description: 'URL: /recipes/<slug>, always starting with wf-. Left empty, it is made from the title. Cannot change later.',
      },
    },
    {
      name: 'sortOrder',
      type: 'number',
      unique: true,
      index: true,
      min: 0,
      validate: requiredToPublish(integerIn(0)),
      hooks: { beforeDuplicate: [emptyOnDuplicate] },
      admin: {
        position: 'sidebar',
        step: 10,
        description: 'Order on /recipes and product pages (smaller first). Unique. Left empty: after the last one.',
      },
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Recipe',
          fields: [
            { name: 'title', type: 'text', required: true, validate: requiredToPublish() },
            {
              name: 'category',
              type: 'select',
              options: RECIPE_CATEGORIES.map((c) => ({ label: c, value: c })),
              validate: requiredToPublish(oneOf(RECIPE_CATEGORIES, 'category')),
              admin: { description: 'The /recipes filter it appears under.' },
            },
            requiredText('description', { description: 'Short blurb on recipe cards.', textarea: true }),
            {
              type: 'row',
              fields: [
                requiredText('prepTime', { description: 'e.g. "10 mins"', width: '33%' }),
                requiredText('cookTime', { description: 'e.g. "No cook"', width: '33%' }),
                requiredText('serves', { description: 'Shown as "Serves …", e.g. "2".', width: '33%' }),
              ],
            },
            requiredText('intro', { description: 'Opening paragraph of the recipe page.', textarea: true }),
            requiredText('authorBio', { description: 'The Wefeasto Kitchen blurb at the end.', textarea: true }),
            {
              name: 'searchTerms',
              type: 'text',
              hasMany: true,
              validate: checkStringList,
              admin: { description: 'Words shoppers might search for (Enter after each).' },
            },
          ],
        },
        {
          label: 'Method',
          description: 'HTML, rendered as written. Use <h2>, <h3>, <p>, <ul role="list">, <li>, <a href="/products/…">.',
          fields: [
            htmlField('ingredientsHtml', 'Ingredients (HTML)', 'The "What you\'ll need" list.'),
            htmlField('directionsHtml', 'Directions (HTML)', 'The steps.'),
            htmlField('whyHtml', 'Why it works (HTML)', 'Why it works / nutrition note.'),
          ],
        },
        {
          label: 'Images & cards',
          fields: [
            {
              name: 'image',
              label: 'Image path',
              type: 'text',
              validate: requiredToPublish(checkPathOrUrl),
              admin: { description: 'Path of the recipe photo in the storefront, e.g. /images/wefeasto/recipe-x.jpg.' },
            },
            requiredText('heroAlt', { description: 'Alt text on the recipe page.', label: 'Recipe page alt text' }),
            requiredText('cardAlt', { description: 'Alt text on recipe cards (/recipes, product pages).', label: 'Card alt text' }),
            {
              type: 'row',
              fields: [
                {
                  name: 'homeFeatured',
                  type: 'checkbox',
                  defaultValue: false,
                  label: 'Show on the home page',
                  admin: { description: '"Fresh from the Wefeasto Kitchen", in recipe order.', width: '40%' },
                },
                {
                  name: 'homeAlt',
                  label: 'Home card alt text',
                  type: 'text',
                  validate: checkHomeAlt,
                  admin: { description: 'Alt text on the home card (required when shown there).', width: '60%' },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                colorField('tagColor', 'Category chip on the recipe page.'),
                colorField('iconColor', 'Icon chip on recipe cards.'),
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'iconSrc',
                  label: 'Card icon',
                  type: 'select',
                  options: RECIPE_ICON_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
                  validate: requiredToPublish(oneOf(RECIPE_ICONS, 'icon')),
                  admin: { description: 'Card category icon.', width: '50%' },
                },
                requiredText('iconAlt', { description: 'e.g. "Breakfast category heart icon".', width: '50%', label: 'Icon alt text' }),
              ],
            },
          ],
        },
        {
          label: 'Products & links',
          fields: [
            {
              name: 'products',
              type: 'array',
              labels: { singular: 'Product used', plural: 'Products used' },
              validate: checkProductRows,
              admin: { description: '"Shop the ingredients" cards, in this order. The recipe also shows on these products’ pages.' },
              fields: [
                {
                  type: 'row',
                  fields: [
                    {
                      name: 'product',
                      type: 'relationship',
                      relationTo: 'products',
                      // Bounded population (products ↔ products "Goes with" is a cycle): see Products.goesWith.
                      maxDepth: 1,
                      required: true,
                      validate: requiredToPublish(),
                      admin: { width: '40%' },
                    },
                    {
                      name: 'ratingStyle',
                      type: 'select',
                      required: true,
                      defaultValue: 'decimal',
                      options: [
                        { label: '"Rated 4.0 out of 5"', value: 'decimal' },
                        { label: '"Rated 4 out of 5"', value: 'plain' },
                      ],
                      validate: requiredToPublish(oneOf(RATING_STYLES, 'rating style')),
                      admin: { width: '25%', description: 'Screen-reader rating wording.' },
                    },
                    {
                      name: 'alt',
                      type: 'text',
                      admin: { width: '35%', description: 'Card alt text. Empty = the product’s own.' },
                    },
                  ],
                },
              ],
            },
            {
              name: 'related',
              label: 'Related recipes',
              type: 'relationship',
              relationTo: 'recipes',
              hasMany: true,
              // Recipes link to each other: bounded population, like Products.goesWith.
              maxDepth: 1,
              validate: checkRefList('recipes'),
              admin: { description: '"Related posts" at the end of the page, in this order.' },
            },
          ],
        },
        {
          label: 'Extras',
          fields: [
            requiredText('extrasHeading', { description: 'e.g. "Make it even easier".' }),
            requiredText('extrasIntro', { textarea: true }),
            titledReasons('extras', 'Handy kit for this recipe.'),
            requiredText('recommendedHeading', { description: 'Not shown on the site today; kept for later.' }),
            requiredText('recommendedIntro', { textarea: true }),
            titledReasons('recommended', 'Not shown on the site today; kept for later.'),
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
