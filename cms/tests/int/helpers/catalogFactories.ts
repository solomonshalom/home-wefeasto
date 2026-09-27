import fs from 'fs'
import path from 'path'
import type { Payload } from 'payload'
import { fileURLToPath } from 'url'

import { SERVER_SETTINGS_DEFAULTS } from '@/commerce/settings'
import type { Snapshot, SnapshotPage } from '@/endpoints/catalog/serialize'
import { type PolicyDrafts, seedCatalog, type SeedOptions } from '@/seed/seedCatalog'

// The storefront's validators (pure ESM): what scripts/sync-cms.mjs runs before accepting a snapshot.
import { serializeSnapshot, validatePolicyDrafts, validateSnapshot } from '../../../../src/lib/data/snapshot-schema.js'

/**
 * Catalog test data (OWNER: cms-catalog). Products, recipes and pages have many fields that are
 * required to publish; build them here instead of by hand:
 *
 *   const p = await createProduct(payload)                        // published, unique slug + sortOrder, stock 100
 *   const d = await createProduct(payload, { name: 'X' }, { draft: true })
 *   await payload.create({ collection: 'products', data: productData({ slug: 'my-oats' }) })
 *   await seedCommittedCatalog(payload)                           // wipe + import REPO/src/lib/data/cms-snapshot.json
 *                                                                 //   + the policy drafts (Payload drafts, off the storefront)
 *   reviewedPage(loadPolicyDrafts().pages[0])                     // a draft made publishable (published: true)
 */

const dirname = path.dirname(fileURLToPath(import.meta.url))
export const SNAPSHOT_FILE = path.resolve(dirname, '../../../../src/lib/data/cms-snapshot.json')
export const DRAFTS_FILE = path.resolve(dirname, '../../../../src/lib/data/policy-drafts.server.json')

export { serializeSnapshot, validatePolicyDrafts, validateSnapshot }

/** A fresh copy of the committed snapshot (safe to mutate). */
export function loadCommittedSnapshot(): Snapshot {
  return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot
}

/** A fresh copy of policy-drafts.server.json: the unpublished policy pages the seed creates for review. */
export function loadPolicyDrafts(): PolicyDrafts {
  return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')) as PolicyDrafts
}

/** The Draft line every policy draft opens with. */
export const DRAFT_LINE_RE = /<p><strong>Draft\s*[—–-]+\s*to be reviewed[^<]*<\/strong><\/p>/

/**
 * What the owner does before ticking "Show on the storefront": drop the Draft line and fill every
 * "[to be added]". The result is a valid snapshot page (published: true).
 */
export function reviewedPage(page: SnapshotPage, fill = 'Wefeasto Foods Pvt Ltd'): SnapshotPage {
  return { ...page, bodyHtml: page.bodyHtml.replace(DRAFT_LINE_RE, '').replace(/\[\s*to be added\s*\]/gi, fill), published: true }
}

let seq = 0
const unique = (tag: string) => `${tag}-${Date.now().toString(36)}-${(++seq).toString(36)}`

/** Complete, valid product data. sortOrder is left to the collection (max + 10) unless given. */
export function productData(overrides: Record<string, unknown> = {}): Record<string, any> {
  const slug = (overrides.slug as string) ?? unique('test-product')
  const name = (overrides.name as string) ?? `Test Product ${slug}`
  return {
    slug,
    name,
    category: 'Oats',
    pricePaise: 19900,
    inStock: true,
    maxPerOrder: 10,
    codAllowed: true,
    packSize: '500 g',
    calories: 110,
    rating: 4.5,
    ratingSource: null,
    description: `${name}: a test product.`,
    image: '/images/wefeasto/product-rolled-oats.jpg',
    heroAlt: `${name} in a bowl`,
    shopAlt: `${name} on the shop`,
    homeFeatured: false,
    homeAlt: null,
    recipesHeading: `Recipes using ${name}`,
    partners: [],
    searchTerms: ['test'],
    goesWith: [],
    packGrams: 500,
    servingGrams: 40,
    facts: { netQuantity: '500 g', ingredients: null, allergens: [], bestBefore: null, manufacturer: null, countryOfOrigin: 'India' },
    stock: 100,
    lowStockThreshold: 5,
    ...overrides,
  }
}

export async function createProduct(payload: Payload, overrides: Record<string, unknown> = {}, opts: { draft?: boolean } = {}) {
  return payload.create({
    collection: 'products',
    data: { ...productData(overrides), _status: opts.draft ? 'draft' : 'published' } as never,
    ...(opts.draft ? { draft: true } : {}),
    context: { skipDeployHook: true },
  })
}

/** Complete, valid recipe data (slug keeps the wf- prefix). `products` rows need real product ids. */
export function recipeData(overrides: Record<string, unknown> = {}): Record<string, any> {
  const slug = (overrides.slug as string) ?? unique('wf-test-recipe')
  const title = (overrides.title as string) ?? `Test Recipe ${slug}`
  return {
    slug,
    title,
    category: 'Breakfast',
    description: `${title}: a test recipe.`,
    image: '/images/wefeasto/recipe-berry-overnight-steel-cut-oats.jpg',
    heroAlt: `${title} hero`,
    cardAlt: `${title} card`,
    homeFeatured: false,
    homeAlt: null,
    tagColor: '#ff8d5e',
    iconColor: '#ff8d5e',
    iconSrc: '/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg',
    iconAlt: 'Breakfast category heart icon',
    prepTime: '5 mins',
    cookTime: 'No cook',
    serves: '2',
    intro: 'A test intro.',
    ingredientsHtml: '<h2>What you’ll need</h2><ul role="list"><li>Oats</li></ul>',
    directionsHtml: '<h3>1. Mix</h3><p>Mix it.</p>',
    whyHtml: '<p>Because.</p>',
    authorBio: 'The Wefeasto Kitchen team.',
    products: [],
    extrasHeading: 'Make it even easier',
    extrasIntro: 'Some kit.',
    extras: [{ title: 'A spoon', reason: 'For stirring.' }],
    recommendedHeading: 'Recommended',
    recommendedIntro: 'Some bowls.',
    recommended: [{ title: 'A bowl', reason: 'For eating.' }],
    related: [],
    searchTerms: ['test'],
    ...overrides,
  }
}

export async function createRecipe(payload: Payload, overrides: Record<string, unknown> = {}, opts: { draft?: boolean } = {}) {
  return payload.create({
    collection: 'recipes',
    data: { ...recipeData(overrides), _status: opts.draft ? 'draft' : 'published' } as never,
    ...(opts.draft ? { draft: true } : {}),
    context: { skipDeployHook: true },
  })
}

/**
 * Wipe the catalog and import the committed snapshot plus the policy drafts, exactly like `npm run seed`
 * on an empty database (stock 100, validated, no deploy hook). Integration test files share one
 * database, so catalog specs call this in beforeAll.
 */
export function seedCommittedCatalog(payload: Payload, opts: SeedOptions = {}) {
  return seedCatalog(payload, loadCommittedSnapshot(), {
    reset: true,
    stock: 100,
    validate: validateSnapshot,
    policyDrafts: loadPolicyDrafts(),
    validateDrafts: validatePolicyDrafts,
    deployHook: false,
    ...opts,
  })
}

/** Store settings back to the committed snapshot's public values + the server-only defaults. */
export async function restoreStoreSettings(payload: Payload) {
  await payload.updateGlobal({
    slug: 'store-settings',
    data: { ...loadCommittedSnapshot().settings, ...SERVER_SETTINGS_DEFAULTS } as never,
    context: { skipDeployHook: true },
  })
}
