/**
 * Payload docs → catalog snapshot shapes (SCRATCH/contracts/snapshot-schema.md §3–§5).
 *
 * Every object is built in the snapshot's canonical key order, holds ONLY stored snapshot fields
 * (no ids, timestamps, _status, row ids, stock) and normalises Payload's nulls the snapshot way:
 * nullable strings → null when blank, lists → [] when empty, relationships → slugs in stored order.
 * Relationships that point at documents missing from `refs` (unpublished, deleted) are dropped, so a
 * snapshot built from published docs only never has a dangling reference.
 */
import { nullableText, relId } from './rules'

type Id = number | string
type Doc = Record<string, any>

export type SnapshotProduct = {
  slug: string
  name: string
  sortOrder: number
  category: string
  pricePaise: number
  inStock: boolean
  maxPerOrder: number
  codAllowed: boolean
  packSize: string | null
  calories: number
  rating: number
  ratingSource: string | null
  description: string
  image: string
  heroAlt: string
  shopAlt: string
  homeFeatured: boolean
  homeAlt: string | null
  recipesHeading: string
  partners: { name: string; url: string }[]
  searchTerms: string[]
  goesWith: string[]
  packGrams: number | null
  servingGrams: number | null
  daysPerPack: number | null
  facts: {
    netQuantity: string | null
    ingredients: string | null
    allergens: string[]
    bestBefore: string | null
    manufacturer: string | null
    countryOfOrigin: string | null
  }
}

export type SnapshotRecipeProductRow = { slug: string; alt: string | null; ratingStyle: string }
export type TitledReason = { title: string; reason: string }

export type SnapshotRecipe = {
  slug: string
  title: string
  sortOrder: number
  category: string
  description: string
  image: string
  heroAlt: string
  cardAlt: string
  homeFeatured: boolean
  homeAlt: string | null
  tagColor: string
  iconColor: string
  iconSrc: string
  iconAlt: string
  prepTime: string
  cookTime: string
  serves: string
  intro: string
  ingredientsHtml: string
  directionsHtml: string
  whyHtml: string
  authorBio: string
  products: SnapshotRecipeProductRow[]
  extrasHeading: string
  extrasIntro: string
  extras: TitledReason[]
  recommendedHeading: string
  recommendedIntro: string
  recommended: TitledReason[]
  related: string[]
  searchTerms: string[]
}

export type SnapshotPage = { slug: string; title: string; bodyHtml: string; published: boolean }

export type Snapshot = {
  version: 1
  generatedAt: string
  settings: Record<string, unknown>
  products: SnapshotProduct[]
  recipes: SnapshotRecipe[]
  pages: SnapshotPage[]
}

/** id → slug of every document a relationship may point at. */
export type RefMaps = { products: Map<string, string>; recipes: Map<string, string> }

export type SerializeOptions = {
  refs: RefMaps
  /**
   * The product's effective `image`. Default: the stored path. The snapshot endpoint passes a resolver
   * that prefers the optional upload override (see resolveImage).
   */
  image?: (doc: Doc) => string
  /**
   * The published `inStock`. Default: the stored checkbox. The snapshot endpoint passes
   * `inStock && stock > 0` so a sold-out product is built as sold out.
   */
  inStock?: (doc: Doc) => boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : (v as string))
const list = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const strings = (v: unknown): string[] => list(v).map((s) => (s && typeof s === 'object' && 'value' in s ? (s as { value: string }).value : (s as string)))
const nullableInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean => v === true

export const mapKey = (id: Id | null | undefined): string => String(id)

/** Relationship ids → slugs, keeping order, dropping unknown targets, self references and duplicates. */
export function slugRefs(value: unknown, map: Map<string, string>, self?: string): string[] {
  const out: string[] = []
  for (const ref of list(value)) {
    const id = relId(ref)
    const slug = id == null ? undefined : map.get(mapKey(id))
    if (!slug || slug === self || out.includes(slug)) continue
    out.push(slug)
  }
  return out
}

const titledReasons = (v: unknown): TitledReason[] =>
  list<Doc>(v).map((row) => ({ title: str(row?.title), reason: str(row?.reason) }))

export function serializeProduct(doc: Doc, opts: SerializeOptions): SnapshotProduct {
  const facts: Doc = doc.facts && typeof doc.facts === 'object' ? doc.facts : {}
  return {
    slug: str(doc.slug),
    name: str(doc.name),
    sortOrder: doc.sortOrder,
    category: str(doc.category),
    pricePaise: doc.pricePaise,
    inStock: opts.inStock ? opts.inStock(doc) : doc.inStock !== false,
    maxPerOrder: doc.maxPerOrder,
    codAllowed: doc.codAllowed !== false,
    packSize: nullableText(doc.packSize),
    calories: doc.calories,
    rating: doc.rating,
    ratingSource: nullableText(doc.ratingSource),
    description: str(doc.description),
    image: opts.image ? opts.image(doc) : str(doc.image),
    heroAlt: str(doc.heroAlt),
    shopAlt: str(doc.shopAlt),
    homeFeatured: bool(doc.homeFeatured),
    homeAlt: nullableText(doc.homeAlt),
    recipesHeading: str(doc.recipesHeading),
    partners: list<Doc>(doc.partners).map((row) => ({ name: str(row?.name), url: str(row?.url) })),
    searchTerms: strings(doc.searchTerms),
    goesWith: slugRefs(doc.goesWith, opts.refs.products, doc.slug),
    packGrams: nullableInt(doc.packGrams),
    servingGrams: nullableInt(doc.servingGrams),
    daysPerPack: nullableInt(doc.daysPerPack),
    facts: {
      netQuantity: nullableText(facts.netQuantity),
      ingredients: nullableText(facts.ingredients),
      allergens: strings(facts.allergens),
      bestBefore: nullableText(facts.bestBefore),
      manufacturer: nullableText(facts.manufacturer),
      countryOfOrigin: nullableText(facts.countryOfOrigin),
    },
  }
}

export function serializeRecipe(doc: Doc, opts: SerializeOptions): SnapshotRecipe {
  const rows: SnapshotRecipeProductRow[] = []
  for (const row of list<Doc>(doc.products)) {
    const id = relId(row?.product)
    const slug = id == null ? undefined : opts.refs.products.get(mapKey(id))
    if (!slug || rows.some((r) => r.slug === slug)) continue
    rows.push({ slug, alt: nullableText(row.alt), ratingStyle: row.ratingStyle === 'plain' ? 'plain' : 'decimal' })
  }
  return {
    slug: str(doc.slug),
    title: str(doc.title),
    sortOrder: doc.sortOrder,
    category: str(doc.category),
    description: str(doc.description),
    image: str(doc.image),
    heroAlt: str(doc.heroAlt),
    cardAlt: str(doc.cardAlt),
    homeFeatured: bool(doc.homeFeatured),
    homeAlt: nullableText(doc.homeAlt),
    tagColor: str(doc.tagColor),
    iconColor: str(doc.iconColor),
    iconSrc: str(doc.iconSrc),
    iconAlt: str(doc.iconAlt),
    prepTime: str(doc.prepTime),
    cookTime: str(doc.cookTime),
    serves: str(doc.serves),
    intro: str(doc.intro),
    ingredientsHtml: str(doc.ingredientsHtml),
    directionsHtml: str(doc.directionsHtml),
    whyHtml: str(doc.whyHtml),
    authorBio: str(doc.authorBio),
    products: rows,
    extrasHeading: str(doc.extrasHeading),
    extrasIntro: str(doc.extrasIntro),
    extras: titledReasons(doc.extras),
    recommendedHeading: str(doc.recommendedHeading),
    recommendedIntro: str(doc.recommendedIntro),
    recommended: titledReasons(doc.recommended),
    related: slugRefs(doc.related, opts.refs.recipes, doc.slug),
    searchTerms: strings(doc.searchTerms),
  }
}

export function serializePage(doc: Doc): SnapshotPage {
  return { slug: str(doc.slug), title: str(doc.title), bodyHtml: str(doc.bodyHtml), published: bool(doc.published) }
}

/**
 * On the storefront: Payload-published AND "Show on the storefront" ticked. Only these pages enter the
 * snapshot (snapshot-schema.md §5.2); the query already filters with livePageWhere, this is the backstop.
 */
export const isLivePage = (doc: Doc | null | undefined): boolean => doc?._status === 'published' && doc?.published === true

/** id → slug for a list of docs. */
export function refMap(docs: Doc[]): Map<string, string> {
  return new Map(docs.map((d) => [mapKey(d.id), d.slug as string]))
}

/**
 * The product's effective image: the uploaded override's URL when there is a usable one, else the path.
 * Media on this CMS comes back either root-relative (/api/media/file/x.jpg) or absolute on the CMS
 * origin; both become root-relative, which the storefront serves through its /api proxy/rewrite.
 * Other https URLs (e.g. Vercel Blob) pass through. Anything else falls back to the stored path.
 */
export function resolveImage(doc: Doc, media: Map<string, { url?: string | null }>, serverUrl = ''): string {
  const upload = relId(doc.imageUpload)
  const fromUpload = upload == null ? undefined : media.get(mapKey(upload))?.url
  if (typeof fromUpload === 'string' && fromUpload) {
    const base = serverUrl.replace(/\/+$/, '')
    if (base && fromUpload.startsWith(`${base}/`)) return fromUpload.slice(base.length)
    if (/^\/(?!\/)\S*$/.test(fromUpload) || /^https:\/\/\S+$/.test(fromUpload)) return fromUpload
  }
  return str(doc.image) ?? ''
}

/* -------------------------------------------------------- live catalog */

/** A row of GET /api/store/catalog (SCRATCH/contracts/live-catalog.md §1). */
export type LiveCatalogRow = {
  slug: string
  name: string
  pricePaise: number
  inStock: boolean
  lowStock: number | null
  maxPerOrder: number
  codAllowed: boolean
}

/**
 * Server-side catalog item: the $shared pricing CatalogItem ({slug, name, pricePaise, inStock,
 * maxPerOrder, codAllowed}) plus the exact `stock` (server-only), `lowStock`, `image` and the doc id.
 */
export type ServerCatalogItem = LiveCatalogRow & { id: Id; stock: number; lowStockThreshold: number; image: string }

const stockOf = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0)

/** Sellable now: published (caller's filter), the "available for sale" box ticked, and stock > 0. */
export const effectiveInStock = (doc: Doc): boolean => doc.inStock !== false && stockOf(doc.stock) > 0

/** `stock` when it is at or below the product's low-stock threshold (and > 0), else null. */
export function lowStockOf(doc: Doc): number | null {
  if (!effectiveInStock(doc)) return null
  const stock = stockOf(doc.stock)
  const threshold = Number.isSafeInteger(doc.lowStockThreshold) ? (doc.lowStockThreshold as number) : 0
  return stock <= threshold ? stock : null
}

export function toServerCatalogItem(doc: Doc, image: string = str(doc.image)): ServerCatalogItem {
  return {
    ...toLiveCatalogRow(doc),
    id: doc.id,
    stock: stockOf(doc.stock),
    lowStockThreshold: Number.isSafeInteger(doc.lowStockThreshold) ? doc.lowStockThreshold : 0,
    image,
  }
}

export function toLiveCatalogRow(doc: Doc): LiveCatalogRow {
  return {
    slug: str(doc.slug),
    name: str(doc.name),
    pricePaise: doc.pricePaise,
    inStock: effectiveInStock(doc),
    lowStock: lowStockOf(doc),
    maxPerOrder: doc.maxPerOrder,
    codAllowed: doc.codAllowed !== false,
  }
}
