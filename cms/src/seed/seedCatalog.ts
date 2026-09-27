import { randomBytes } from 'crypto'
import type { Payload } from 'payload'
import { isDeepStrictEqual } from 'util'

import { refMap, serializePage, serializeProduct, serializeRecipe, type Snapshot } from '../endpoints/catalog/serialize'
import { deployHook } from '../hooks/deployHook'

/**
 * Idempotent import of the storefront catalog snapshot (REPO/src/lib/data/cms-snapshot.json) into
 * Payload — the inverse of GET /api/store/snapshot. Used by `npm run seed` and the integration tests.
 *
 * - Upsert by slug: missing docs are created, docs whose stored content differs from the snapshot are
 *   updated, identical docs are left alone (no write, no new version). Running it twice changes nothing.
 * - Products, recipes and the snapshot's pages are saved PUBLISHED (Payload `_status`). Snapshot pages are
 *   storefront pages (`published: true`): the snapshot holds nothing else (snapshot-schema.md §5).
 * - Policy drafts (REPO/src/lib/data/policy-drafts.server.json, `opts.policyDrafts`): each page whose slug
 *   does not exist yet is CREATED as a Payload draft with `published: false`, for the owner to review and
 *   publish in the admin. An existing page is never updated from the drafts file: the owner's edits win.
 * - `stock` is set only when a product is created (default 100 in dev, 0 in production); re-seeding never
 *   resets stock. The same goes for the "Available for sale" checkbox (`inStock`): the snapshot's value is
 *   derived (checkbox && stock > 0), so it is only applied when the seed creates the product. `lowStockThreshold` gets its default (5).
 * - Store settings: the public keys are set from `snapshot.settings` when they differ; server-only keys
 *   are never touched.
 * - Docs that are not in the snapshot are left alone, unless `reset` wipes the catalog first.
 * - Seed writes skip the per-save deploy hook; one rebuild is requested at the end if anything changed.
 */

type Doc = Record<string, any>
type Collection = 'products' | 'recipes' | 'pages'
type Counts = { created: number; updated: number; unchanged: number }
type Validate = (value: unknown) => { ok: boolean; errors: string[] }

/** policy-drafts.server.json: unpublished policy pages (same page shape as the snapshot, `published: false`). */
export type PolicyDrafts = { version: number; pages: Snapshot['pages'] }

export type SeedOptions = {
  /** Delete every product, recipe and page (and their versions) first. */
  reset?: boolean
  /** Stock for products the seed creates. Default: 100, or 0 when NODE_ENV=production. */
  stock?: number
  /** Validates the snapshot before anything is written (e.g. validateSnapshot from snapshot-schema.js). */
  validate?: Validate
  /**
   * Policy pages to create for review (policy-drafts.server.json). Only slugs that do not exist yet are
   * created, always as a Payload draft with `published: false`. Omitted: no drafts are created.
   */
  policyDrafts?: PolicyDrafts
  /** Validates `policyDrafts` before anything is written (validatePolicyDrafts from snapshot-schema.js). */
  validateDrafts?: Validate
  /** Request a storefront rebuild when something changed (no-op without VERCEL_DEPLOY_HOOK_URL). Default true. */
  deployHook?: boolean
  log?: (msg: string) => void
}

export type SeedReport = {
  reset: boolean
  products: Counts
  recipes: Counts
  pages: Counts
  /** Policy drafts: created now, or kept because a page with that slug already exists (never overwritten). */
  drafts: { created: number; kept: number }
  settings: 'updated' | 'unchanged'
  /** Anything was written (drafts included). The deploy hook only fires for changes the storefront can show. */
  changed: boolean
}

export class SeedError extends Error {
  constructor(message: string, readonly errors: string[] = []) {
    super(errors.length ? `${message}\n  - ${errors.slice(0, 20).join('\n  - ')}` : message)
    this.name = 'SeedError'
  }
}

export const DEV_STOCK = 100
const TEMP_SORT_BASE = 1_000_000_000
const CTX = { skipDeployHook: true }

export const defaultSeedStock = (env: Record<string, string | undefined> = process.env) => (env.NODE_ENV === 'production' ? 0 : DEV_STOCK)

/** Deep equality that ignores key order (Payload and the JSON file order keys differently). */
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b)
const emptyCounts = (): Counts => ({ created: 0, updated: 0, unchanged: 0 })

/* ----------------------------------------------- snapshot → Payload data */

const idsFor = (slugs: string[], bySlug: Map<string, Doc>): (number | string)[] =>
  slugs.map((s) => bySlug.get(s)?.id).filter((id): id is number | string => id != null)

/** Payload data for a snapshot product (relationships resolved against the docs that exist so far). */
export function productData(p: Snapshot['products'][number], products: Map<string, Doc>): Doc {
  const { goesWith, ...rest } = p
  return { ...rest, goesWith: idsFor(goesWith, products), partners: p.partners.map((r) => ({ ...r })) }
}

export function recipeData(r: Snapshot['recipes'][number], products: Map<string, Doc>, recipes: Map<string, Doc>): Doc {
  const { products: rows, related, ...rest } = r
  return {
    ...rest,
    products: rows
      .filter((row) => products.has(row.slug))
      .map((row) => ({ product: products.get(row.slug)!.id, alt: row.alt, ratingStyle: row.ratingStyle })),
    related: idsFor(related, recipes),
    extras: r.extras.map((x) => ({ ...x })),
    recommended: r.recommended.map((x) => ({ ...x })),
  }
}

export function pageData(p: Snapshot['pages'][number], sortOrder: number): Doc {
  return { ...p, sortOrder }
}

/* --------------------------------------------------------------- helpers */

async function all(payload: Payload, collection: Collection): Promise<Doc[]> {
  const res = await payload.find({ collection, depth: 0, pagination: false, draft: false, overrideAccess: true })
  return res.docs as Doc[]
}

const bySlug = (docs: Doc[]) => new Map(docs.map((d) => [d.slug as string, d]))

/** Stored content of every doc, in snapshot shape, with ALL docs as relationship targets. */
function storedRefs(products: Doc[], recipes: Doc[]) {
  return { products: refMap(products), recipes: refMap(recipes) }
}

export async function wipeCatalog(payload: Payload): Promise<void> {
  for (const collection of ['recipes', 'pages', 'products'] as const) {
    // Repeat until empty: bulk delete works on a page of docs at a time.
    for (let round = 0; round < 50; round++) {
      const { totalDocs } = await payload.count({ collection, overrideAccess: true })
      if (!totalDocs) break
      await payload.delete({ collection, where: { id: { exists: true } }, overrideAccess: true, context: CTX })
    }
  }
}

/**
 * sortOrder is unique, so reordering A↔B in one pass would collide. Snapshot docs whose sortOrder is
 * about to change are first parked on unique temporary values (a raw column write: no hooks, no
 * version), then the normal update sets the real value. Docs outside the snapshot are never moved; if
 * one sits on a sortOrder the snapshot needs, the seed stops before writing anything.
 */
async function parkSortOrders(payload: Payload, collection: 'products' | 'recipes', wanted: { slug: string; sortOrder: number }[]) {
  const docs = await all(payload, collection)
  const want = new Map(wanted.map((w) => [w.slug, w.sortOrder]))
  const targets = new Set(wanted.map((w) => w.sortOrder))
  const blockers = docs.filter((d) => !want.has(d.slug) && targets.has(d.sortOrder))
  if (blockers.length) {
    throw new SeedError(
      `${collection}: a sortOrder the snapshot needs is used by an entry that is not in the snapshot (change it, or seed with --reset)`,
      blockers.map((b) => `${b.slug} has sortOrder ${b.sortOrder}`),
    )
  }
  let i = 0
  for (const d of docs) {
    const target = want.get(d.slug)
    if (target === undefined || d.sortOrder === target) continue
    await payload.db.updateOne({ collection, id: d.id, data: { sortOrder: TEMP_SORT_BASE + i++ } })
  }
}

/* ------------------------------------------------------------------ seed */

export async function seedCatalog(payload: Payload, snapshot: Snapshot, opts: SeedOptions = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {})
  if (opts.validate) {
    const { ok, errors } = opts.validate(snapshot)
    if (!ok) throw new SeedError('The snapshot is invalid; nothing was written', errors)
  }
  if (!snapshot || !Array.isArray(snapshot.products) || !Array.isArray(snapshot.recipes) || !Array.isArray(snapshot.pages)) {
    throw new SeedError('Not a catalog snapshot (expected products[], recipes[] and pages[])')
  }
  const drafts = opts.policyDrafts
  if (drafts !== undefined) {
    if (opts.validateDrafts) {
      const { ok, errors } = opts.validateDrafts(drafts)
      if (!ok) throw new SeedError('The policy drafts file is invalid; nothing was written', errors)
    }
    if (!drafts || !Array.isArray(drafts.pages)) throw new SeedError('Not a policy drafts file (expected pages[])')
  }
  const stock = opts.stock ?? defaultSeedStock()
  if (!Number.isSafeInteger(stock) || stock < 0) throw new SeedError(`Invalid stock ${stock}`)

  const report: SeedReport = {
    reset: Boolean(opts.reset),
    products: emptyCounts(),
    recipes: emptyCounts(),
    pages: emptyCounts(),
    drafts: { created: 0, kept: 0 },
    settings: 'unchanged',
    changed: false,
  }

  if (opts.reset) {
    log('reset: deleting all products, recipes and pages')
    await wipeCatalog(payload)
  }

  /* products: create what is missing, then bring every doc in line (goesWith needs all ids) */
  await parkSortOrders(payload, 'products', snapshot.products)
  let products = bySlug(await all(payload, 'products'))
  const createdProducts = new Set<string>()
  for (const p of snapshot.products) {
    if (products.has(p.slug)) continue
    const doc = await payload.create({
      collection: 'products',
      data: { ...productData(p, products), stock, _status: 'published' } as never,
      overrideAccess: true,
      context: CTX,
    })
    products.set(p.slug, doc as Doc)
    createdProducts.add(p.slug)
    report.products.created++
    log(`products: created ${p.slug}`)
  }
  let productDocs = await all(payload, 'products')
  products = bySlug(productDocs)
  let recipeDocs = await all(payload, 'recipes')
  for (const p of snapshot.products) {
    const current = products.get(p.slug)!
    const stored = serializeProduct(current, { refs: storedRefs(productDocs, recipeDocs) })
    // `inStock` in a snapshot is derived (checkbox && stock > 0), so for an existing product it is
    // operator state like `stock`: never compared, never written back. Otherwise seeding a snapshot
    // synced while an item was sold out would untick "Available for sale" for good.
    const { inStock: _storedInStock, ...storedContent } = stored as Doc
    const { inStock: _snapshotInStock, ...snapshotContent } = p
    if (same(storedContent, snapshotContent) && current._status === 'published') {
      if (!createdProducts.has(p.slug)) report.products.unchanged++
      continue
    }
    const { inStock: _derived, ...updateData } = productData(p, products)
    await payload.update({
      collection: 'products',
      id: current.id,
      data: { ...updateData, _status: 'published' } as never,
      overrideAccess: true,
      context: CTX,
    })
    if (!createdProducts.has(p.slug)) {
      report.products.updated++
      log(`products: updated ${p.slug}`)
    }
  }
  productDocs = await all(payload, 'products')
  products = bySlug(productDocs)

  /* recipes: same two passes (related needs all recipe ids) */
  await parkSortOrders(payload, 'recipes', snapshot.recipes)
  let recipes = bySlug(await all(payload, 'recipes'))
  const createdRecipes = new Set<string>()
  for (const r of snapshot.recipes) {
    if (recipes.has(r.slug)) continue
    const doc = await payload.create({
      collection: 'recipes',
      data: { ...recipeData(r, products, recipes), _status: 'published' } as never,
      overrideAccess: true,
      context: CTX,
    })
    recipes.set(r.slug, doc as Doc)
    createdRecipes.add(r.slug)
    report.recipes.created++
    log(`recipes: created ${r.slug}`)
  }
  recipeDocs = await all(payload, 'recipes')
  recipes = bySlug(recipeDocs)
  for (const r of snapshot.recipes) {
    const current = recipes.get(r.slug)!
    const stored = serializeRecipe(current, { refs: storedRefs(productDocs, recipeDocs) })
    if (same(stored, r) && current._status === 'published') {
      if (!createdRecipes.has(r.slug)) report.recipes.unchanged++
      continue
    }
    await payload.update({
      collection: 'recipes',
      id: current.id,
      data: { ...recipeData(r, products, recipes), _status: 'published' } as never,
      overrideAccess: true,
      context: CTX,
    })
    if (!createdRecipes.has(r.slug)) {
      report.recipes.updated++
      log(`recipes: updated ${r.slug}`)
    }
  }

  /* pages: the snapshot's (storefront) pages, published in Payload with `published` as in the snapshot */
  const pages = bySlug(await all(payload, 'pages'))
  for (const [i, p] of snapshot.pages.entries()) {
    const sortOrder = (i + 1) * 10
    const current = pages.get(p.slug)
    if (!current) {
      await payload.create({
        collection: 'pages',
        data: { ...pageData(p, sortOrder), _status: 'published' } as never,
        overrideAccess: true,
        context: CTX,
      })
      report.pages.created++
      log(`pages: created ${p.slug}`)
      continue
    }
    if (same(serializePage(current), p) && current._status === 'published' && current.sortOrder === sortOrder) {
      report.pages.unchanged++
      continue
    }
    await payload.update({
      collection: 'pages',
      id: current.id,
      data: { ...pageData(p, sortOrder), _status: 'published' } as never,
      overrideAccess: true,
      context: CTX,
    })
    report.pages.updated++
    log(`pages: updated ${p.slug}`)
  }

  /* policy drafts: create the missing ones for review (Payload draft, off the storefront); never update */
  if (drafts) {
    const existing = new Set((await all(payload, 'pages')).map((d) => d.slug as string))
    for (const d of drafts.pages) {
      if (existing.has(d.slug)) {
        report.drafts.kept++
        continue
      }
      await payload.create({
        collection: 'pages',
        // `published: false` whatever the file says: a page reaches the storefront only once the owner has
        // reviewed it and ticked "Show on the storefront" in the admin.
        data: { slug: d.slug, title: d.title, bodyHtml: d.bodyHtml, published: false, _status: 'draft' } as never,
        draft: true,
        overrideAccess: true,
        context: CTX,
      })
      existing.add(d.slug)
      report.drafts.created++
      log(`pages: created draft ${d.slug} (to review)`)
    }
  }

  /* settings: public keys only */
  const raw = await payload.findGlobal({ slug: 'store-settings', depth: 0, overrideAccess: true })
  if (!same(pickPublic(raw, snapshot.settings), snapshot.settings)) {
    await payload.updateGlobal({ slug: 'store-settings', data: snapshot.settings as never, overrideAccess: true, context: CTX })
    report.settings = 'updated'
    log('settings: updated')
  }

  const c = (x: Counts) => x.created + x.updated
  // New drafts are not on the storefront, so they need no rebuild.
  const siteChanged = c(report.products) + c(report.recipes) + c(report.pages) > 0 || report.settings === 'updated' || report.reset
  report.changed = siteChanged || report.drafts.created > 0
  if (siteChanged && opts.deployHook !== false) await deployHook.flush({ force: true, reason: 'seed' })
  return report
}

/** The stored global restricted to the snapshot's settings keys (nested), to catch nulls the normaliser would hide. */
function pickPublic(raw: unknown, shape: unknown): unknown {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return raw
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return Object.fromEntries(Object.keys(shape as object).map((k) => [k, pickPublic(src[k], (shape as Record<string, unknown>)[k])]))
}

/* ------------------------------------------------------------ admin user */

export type SeedAdminResult = { email: string; created: boolean; password?: string; generated?: boolean }

/**
 * Creates a staff admin when no user has this email. Never changes an existing user (or its password).
 * Without a password one is generated and returned (print it once; it is not stored anywhere else).
 */
export async function seedAdmin(payload: Payload, { email, password }: { email: string; password?: string }): Promise<SeedAdminResult> {
  const normalized = email.trim().toLowerCase()
  const existing = await payload.find({
    collection: 'users',
    where: { email: { equals: normalized } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (existing.docs.length) return { email: normalized, created: false }
  const generated = !password
  const pass = password || randomBytes(18).toString('base64url')
  await payload.create({
    collection: 'users',
    data: { email: normalized, password: pass, role: 'admin', name: 'Wefeasto admin' } as never,
    overrideAccess: true,
  })
  return { email: normalized, created: true, password: pass, generated }
}
