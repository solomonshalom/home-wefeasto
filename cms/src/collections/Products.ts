import type { CollectionBeforeValidateHook, CollectionConfig, Field } from 'payload'

import { isAdminOrEditor, isAdminOrEditorField, publishedOrAdmin } from '../access'
import {
  checkHomeAlt,
  checkHttpsUrl,
  checkImagePath,
  checkPricePaise,
  checkProductSlug,
  checkRating,
  checkRefList,
  checkStringList,
  daysPerPackFrom,
  fillSlugAndSortOrder,
  guardSlug,
  integerIn,
  MAX_UNIT_PAISE,
  oneOf,
  optional,
  PRODUCT_CATEGORIES,
  requiredToPublish,
  SLUG_MAX,
  SLUG_RE,
} from '../endpoints/catalog/rules'
import { deployHookAfterChange, deployHookAfterDelete } from '../hooks/deployHook'
import { bulkUpdateAllOrNothing } from '../lib/bulkAllOrNothing'
import { draftSafeRestore } from '../lib/draftSafeRestore'
import { duplicateAsDraft, duplicateSlug, emptyOnDuplicate, resetOnDuplicate } from '../lib/duplicateDoc'
import { keepPublishStateOnPlainUpdate } from '../lib/draftSafeUpdate'
import { productStockBeforeChange } from '../lib/productStock'

/**
 * Products: the storefront catalog. Mirrors `products[]` of the catalog snapshot field for field
 * (SCRATCH/contracts/snapshot-schema.md §3) plus server-only stock fields (SPEC §4).
 *
 * - Drafts: the public (REST and GET /api/store/*) only ever sees the published version.
 * - `stock` and `lowStockThreshold` are staff-only: hidden from customers and guests by field access.
 * - `stock` is changed by ±N (virtual `stockAdjust`), never overwritten by a stale form: see src/lib/productStock.ts.
 * - `slug` is the URL and cart key: unique, kebab-case, and immutable once created.
 * - Content fields are required to PUBLISH (enforced by their validators, which match the storefront's
 *   snapshot validator); a draft may be incomplete, so only the identity fields (slug, name) are
 *   `required` in the schema and the generated types. Read published products through
 *   loadServerCatalog() (src/endpoints/catalog/data.ts) for fully typed rows.
 */

const staffOnly = { read: isAdminOrEditorField, create: isAdminOrEditorField, update: isAdminOrEditorField }

const nullableText = (name: string, description: string, width?: string): Field => ({
  name,
  type: 'text',
  admin: { description, ...(width ? { width } : {}) },
})

const nullableInt = (name: string, description: string, label?: string): Field => ({
  name,
  ...(label ? { label } : {}),
  type: 'number',
  min: 1,
  admin: { description, step: 1 },
  validate: optional(integerIn(1)),
})

/** daysPerPack left empty → round(packGrams / servingGrams / 0.8) when both weights are known. */
const fillDaysPerPack: CollectionBeforeValidateHook = ({ data, originalDoc }) => {
  if (!data) return data
  const merged = { ...(originalDoc ?? {}), ...data }
  if (merged.daysPerPack === null || merged.daysPerPack === undefined) {
    const days = daysPerPackFrom(merged.packGrams, merged.servingGrams)
    if (days !== null) data.daysPerPack = days
  }
  return data
}

export const Products: CollectionConfig = {
  slug: 'products',
  labels: { singular: 'Product', plural: 'Products' },
  admin: {
    useAsTitle: 'name',
    group: 'Catalog',
    defaultColumns: ['name', 'sortOrder', 'pricePaise', 'stockOnHand', 'inStock', '_status', 'updatedAt'],
    listSearchableFields: ['name', 'slug'],
    description:
      'What the shop sells. Drafts can be saved incomplete; every field is checked when you publish. Publishing rebuilds the storefront (price and stock also update live).',
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
    // Admin Duplicate: a draft copy with a free <slug>-copy slug, the next sortOrder and 0 stock (src/lib/duplicateDoc.ts).
    beforeOperation: [keepPublishStateOnPlainUpdate('product'), draftSafeRestore.beforeOperation, duplicateAsDraft],
    beforeValidate: [fillSlugAndSortOrder('products', 'name'), fillDaysPerPack],
    beforeChange: [
      draftSafeRestore.beforeChange,
      // At most SLUG_MAX characters: the slug is the cart key, and checkout refuses a longer one.
      guardSlug('products', SLUG_RE, 'Use lower-case letters, numbers and single hyphens, e.g. rolled-oats.', [], SLUG_MAX),
      productStockBeforeChange,
    ],
    afterChange: [draftSafeRestore.afterChange, deployHookAfterChange],
    afterDelete: [deployHookAfterDelete],
    // Products list → Edit: a bulk edit where any product is refused moves no stock (src/lib/bulkAllOrNothing.ts).
    afterOperation: [bulkUpdateAllOrNothing({ plural: 'products' })],
  },
  fields: [
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: requiredToPublish(checkProductSlug),
      hooks: { beforeDuplicate: [duplicateSlug('products')] },
      admin: {
        position: 'sidebar',
        description: `URL: /products/<slug>. Also the cart key (at most ${SLUG_MAX} characters). Left empty, it is made from the name. Cannot change later.`,
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
        description: 'Catalog order (smaller first). Each product needs its own number. Left empty: after the last one.',
      },
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Product',
          fields: [
            { name: 'name', type: 'text', required: true, validate: requiredToPublish() },
            {
              type: 'row',
              fields: [
                {
                  name: 'category',
                  type: 'select',
                  options: PRODUCT_CATEGORIES.map((c) => ({ label: c, value: c })),
                  validate: requiredToPublish(oneOf(PRODUCT_CATEGORIES, 'category')),
                  admin: { description: 'The /shop filter it appears under.', width: '50%' },
                },
                {
                  name: 'pricePaise',
                  label: 'Price (paise)',
                  type: 'number',
                  min: 100,
                  max: MAX_UNIT_PAISE,
                  validate: requiredToPublish(checkPricePaise),
                  admin: { description: 'In paise: ₹175 = 17500. Whole rupees only.', step: 100, width: '50%' },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                nullableText('packSize', 'Pack label, e.g. "500 g". Leave empty to hide it.', '33%'),
                {
                  name: 'calories',
                  type: 'number',
                  min: 0,
                  validate: requiredToPublish(integerIn(0)),
                  admin: { description: 'kcal per serving.', step: 1, width: '33%' },
                },
                {
                  name: 'rating',
                  type: 'number',
                  min: 0,
                  max: 5,
                  validate: requiredToPublish(checkRating),
                  admin: { description: '0–5, one decimal (e.g. 4.3).', step: 0.1, width: '33%' },
                },
              ],
            },
            nullableText('ratingSource', 'Where the rating comes from, e.g. "Amazon". Leave empty if there is no real source.'),
            {
              name: 'description',
              type: 'textarea',
              validate: requiredToPublish(),
              admin: { description: 'The product page description.' },
            },
            {
              name: 'recipesHeading',
              label: 'Recipes heading',
              type: 'text',
              validate: requiredToPublish(),
              admin: { description: 'Heading above this product’s recipes, e.g. "Recipes using Oats".' },
            },
            {
              name: 'searchTerms',
              label: 'Search terms',
              type: 'text',
              hasMany: true,
              validate: checkStringList,
              admin: { description: 'Words shoppers might search for (Enter after each).' },
            },
          ],
        },
        {
          label: 'Images',
          fields: [
            {
              name: 'image',
              label: 'Image path',
              type: 'text',
              validate: checkImagePath,
              admin: { description: 'Path of the product photo in the storefront, e.g. /images/wefeasto/product-oats.jpg.' },
            },
            {
              name: 'imageUpload',
              label: 'Uploaded image (overrides the path)',
              type: 'upload',
              relationTo: 'media',
              admin: { description: 'Optional. An uploaded photo here replaces the image path above everywhere on the site.' },
            },
            {
              name: 'heroAlt',
              label: 'Product page alt text',
              type: 'text',
              validate: requiredToPublish(),
              admin: { description: 'Alt text on the product page (and the default for small product cards).' },
            },
            {
              name: 'shopAlt',
              label: 'Shop card alt text',
              type: 'text',
              validate: requiredToPublish(),
              admin: { description: 'Alt text on the /shop card.' },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'homeFeatured',
                  type: 'checkbox',
                  defaultValue: false,
                  label: 'Show on the home page',
                  admin: { description: '"Shop Bestsellers", in catalog order.', width: '40%' },
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
          ],
        },
        {
          label: 'Stock & ordering',
          description: 'Stock numbers are never shown to shoppers: the site only says "in stock", "only N left" or "sold out".',
          fields: [
            {
              name: 'inStock',
              type: 'checkbox',
              defaultValue: true,
              label: 'Available for sale',
              admin: { description: 'Untick to stop selling it. It is also sold out whenever stock is 0.' },
            },
            {
              // Stock is never edited as a number in the form (a stale number would undo reservations made
              // while the form was open): the live value is shown read-only and changed by ±N. The rules
              // live in src/lib/productStock.ts (hook productStockBeforeChange).
              type: 'row',
              fields: [
                {
                  name: 'stockOnHand',
                  label: 'Stock (packs)',
                  type: 'number',
                  virtual: true,
                  access: { read: isAdminOrEditorField, create: () => false, update: () => false },
                  hooks: { afterRead: [({ siblingData }) => (siblingData as { stock?: number | null })?.stock ?? 0] },
                  admin: {
                    readOnly: true,
                    description: 'Packs on hand when this page loaded. Orders reserve stock; expired orders give it back.',
                    width: '33%',
                  },
                },
                {
                  name: 'stockAdjust',
                  label: 'Adjust stock by (±N)',
                  type: 'number',
                  virtual: true,
                  access: staffOnly,
                  hooks: { afterRead: [() => null] },
                  admin: {
                    // Payload's sanitizer makes every virtual field read-only in the admin unless this says
                    // otherwise (payload/dist/fields/config/sanitize.js): without it the owner can't restock.
                    readOnly: false,
                    step: 1,
                    placeholder: 'e.g. 20 or -3',
                    description:
                      'Packs to add (20) or remove (-3). Applied on save, also when saving a draft; stock never goes below 0.',
                    width: '33%',
                  },
                },
                {
                  name: 'lowStockThreshold',
                  label: 'Low-stock threshold',
                  type: 'number',
                  defaultValue: 5,
                  min: 0,
                  access: staffOnly,
                  validate: integerIn(0),
                  admin: { description: 'At or below this, the site says "only N left".', step: 1, width: '33%' },
                },
              ],
            },
            {
              // The stored number. Not in the admin form (see above); the API accepts an absolute value only
              // on create, or with context.allowStockSet (seed, tests). Orders change it atomically.
              name: 'stock',
              label: 'Stock (packs)',
              type: 'number',
              defaultValue: 0,
              min: 0,
              access: staffOnly,
              validate: integerIn(0, Number.MAX_SAFE_INTEGER, 'Enter a whole number of packs (0 or more).'),
              // A copy is a new product: it starts with no packs, not the original's.
              hooks: { beforeDuplicate: [resetOnDuplicate(0)] },
              admin: { disabled: true },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'maxPerOrder',
                  label: 'Max per order',
                  type: 'number',
                  defaultValue: 10,
                  min: 1,
                  validate: integerIn(1),
                  admin: { description: 'Most packs one order may contain.', step: 1, width: '50%' },
                },
                {
                  name: 'codAllowed',
                  type: 'checkbox',
                  defaultValue: true,
                  label: 'Cash on delivery allowed',
                  admin: { width: '50%' },
                },
              ],
            },
          ],
        },
        {
          label: 'Related',
          fields: [
            {
              name: 'goesWith',
              label: 'Goes well with',
              type: 'relationship',
              relationTo: 'products',
              hasMany: true,
              // Products link to each other: without a cap, ?depth=N re-populates the cycle N times (an
              // anonymous /api/products?depth=10 built a > 512 MB response). One level is all anyone reads.
              maxDepth: 1,
              validate: checkRefList('products'),
              admin: { description: '"Goes well with" cards on the product page, in this order.' },
            },
            {
              name: 'partners',
              type: 'array',
              labels: { singular: 'Marketplace', plural: 'Marketplaces' },
              admin: { description: '"Also available at" links.', initCollapsed: true },
              fields: [
                {
                  type: 'row',
                  fields: [
                    { name: 'name', type: 'text', required: true, validate: requiredToPublish(), admin: { width: '30%' } },
                    { name: 'url', type: 'text', required: true, validate: requiredToPublish(checkHttpsUrl), admin: { width: '70%' } },
                  ],
                },
              ],
            },
          ],
        },
        {
          label: 'Facts & servings',
          fields: [
            {
              type: 'row',
              fields: [
                nullableInt('packGrams', 'Pack weight in grams.', 'Pack weight (g)'),
                nullableInt('servingGrams', 'One serving in grams.', 'Serving (g)'),
                nullableInt('daysPerPack', 'Days one person takes to finish a pack (refill reminders). Empty = worked out from the two weights.'),
              ],
            },
            {
              name: 'facts',
              type: 'group',
              admin: { description: 'The "Product facts" panel. Only filled-in facts are shown.' },
              fields: [
                nullableText('netQuantity', 'Legal net quantity, e.g. "500 g".'),
                { name: 'ingredients', type: 'textarea' },
                {
                  name: 'allergens',
                  type: 'text',
                  hasMany: true,
                  validate: checkStringList,
                  admin: { description: 'e.g. Nuts, Milk, Gluten (Enter after each).' },
                },
                nullableText('bestBefore', 'e.g. "9 months from packing".'),
                { name: 'manufacturer', type: 'textarea', admin: { description: 'Manufacturer / packer name and address.' } },
                { name: 'countryOfOrigin', type: 'text', defaultValue: 'India' },
              ],
            },
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
