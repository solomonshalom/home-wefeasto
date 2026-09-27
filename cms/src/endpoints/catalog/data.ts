import type { Payload, PayloadRequest, Where } from 'payload'

import { getStoreSettings } from '../../commerce/settings'
import { getEnv } from '../../env'
import { livePageWhere } from './rules'
import {
  effectiveInStock,
  isLivePage,
  mapKey,
  refMap,
  resolveImage,
  serializePage,
  serializeProduct,
  serializeRecipe,
  type LiveCatalogRow,
  type ServerCatalogItem,
  type Snapshot,
  toLiveCatalogRow,
  toServerCatalogItem,
} from './serialize'

/**
 * Readers behind GET /api/store/snapshot and GET /api/store/catalog, exported for server code
 * (checkout/quote pricing uses loadServerCatalog). All reads use overrideAccess with an explicit
 * `_status = published` filter: the endpoints must return the same public content whoever calls them
 * (staff included — a logged-in editor must not get drafts in a snapshot).
 * Pages additionally need "Show on the storefront" (livePageWhere): the policy drafts never leave the CMS.
 */

const PUBLISHED: Where = { _status: { equals: 'published' } }

type Src = PayloadRequest | Payload
const isPayload = (from: Src): from is Payload => typeof (from as Payload).findGlobal === 'function'
const payloadOf = (from: Src): Payload => (isPayload(from) ? from : from.payload)
const reqOf = (from: Src): { req?: PayloadRequest } => (isPayload(from) ? {} : { req: from })

async function findPublished(
  from: Src,
  collection: 'products' | 'recipes' | 'pages',
  sort: string | string[],
  where: Where = PUBLISHED,
) {
  const res = await payloadOf(from).find({
    collection,
    where,
    sort,
    depth: 0,
    pagination: false,
    draft: false,
    overrideAccess: true,
    ...reqOf(from),
  })
  return res.docs as Record<string, any>[]
}

async function mediaUrls(from: Src, docs: Record<string, any>[]) {
  const ids = [...new Set(docs.map((d) => d.imageUpload).filter((v) => v != null).map((v) => (typeof v === 'object' ? v.id : v)))]
  if (!ids.length) return new Map<string, { url?: string | null }>()
  const res = await payloadOf(from).find({
    collection: 'media',
    where: { id: { in: ids } },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    ...reqOf(from),
  })
  return new Map(res.docs.map((m) => [mapKey(m.id), { url: m.url }]))
}

/**
 * The full catalog snapshot (snapshot-schema.md) from published content. `generatedAt` = now.
 * Pages: only those on the storefront (published + "Show on the storefront"), footer order.
 */
export async function buildSnapshot(from: Src, now: Date = new Date()): Promise<Snapshot> {
  const [published, recipes, pages, settings] = await Promise.all([
    findPublished(from, 'products', 'sortOrder'),
    findPublished(from, 'recipes', 'sortOrder'),
    findPublished(from, 'pages', ['sortOrder', 'createdAt'], livePageWhere()),
    getStoreSettings(from),
  ])
  const media = await mediaUrls(from, published)
  const serverUrl = getEnv().serverUrl
  const imageOf = (d: Record<string, any>) => resolveImage(d, media, serverUrl)
  // Last line of defence (the Media delete guard is the first): a published product whose only image is gone
  // cannot be shown, so it is left out like an unpublished one, and references to it are dropped with it.
  const products = published.filter((doc) => imageOf(doc).trim() !== '')
  if (products.length < published.length) {
    const lost = published.filter((doc) => !products.includes(doc)).map((doc) => doc.slug)
    payloadOf(from).logger.warn(`snapshot: left out published product(s) with no image: ${lost.join(', ')}`)
  }
  const refs = { products: refMap(products), recipes: refMap(recipes) }
  return {
    version: 1,
    generatedAt: now.toISOString(),
    settings: settings.public as Record<string, unknown>,
    products: products.map((doc) => serializeProduct(doc, { refs, image: imageOf, inStock: effectiveInStock })),
    recipes: recipes.map((doc) => serializeRecipe(doc, { refs })),
    pages: pages.filter(isLivePage).map(serializePage),
  }
}

/**
 * Every product that can be sold right now (published), in catalog order, with the exact stock.
 * SERVER ONLY — `stock`/`lowStockThreshold` must never reach a response; use toLiveCatalogRow for that.
 */
export async function loadServerCatalog(from: Src): Promise<ServerCatalogItem[]> {
  const products = await findPublished(from, 'products', 'sortOrder')
  const media = await mediaUrls(from, products)
  const serverUrl = getEnv().serverUrl
  return products.map((doc) => toServerCatalogItem(doc, resolveImage(doc, media, serverUrl)))
}

/** Body of GET /api/store/catalog. */
export async function buildLiveCatalog(from: Src): Promise<{ settings: Record<string, unknown>; products: LiveCatalogRow[] }> {
  const [products, settings] = await Promise.all([findPublished(from, 'products', 'sortOrder'), getStoreSettings(from)])
  return { settings: settings.public as Record<string, unknown>, products: products.map(toLiveCatalogRow) }
}
