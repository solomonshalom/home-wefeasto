import fs from 'fs'
import path from 'path'
import { type CollectionConfig, type Field, type PayloadRequest, ValidationError } from 'payload'
import { fileURLToPath } from 'url'
import { describe, expect, it, vi } from 'vitest'

import { Pages } from '@/collections/Pages'
import { Products } from '@/collections/Products'
import { Recipes } from '@/collections/Recipes'
import { guardSlug, RESERVED_PAGE_SLUGS, reservedSlugMessage, SLUG_RE } from '@/endpoints/catalog/rules'
import { draftSafeRestore, keepLiveDocOnDraftRestore, recordRestoreRequest, restoreAsPendingDraft } from '@/lib/draftSafeRestore'

const restoreVersion = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('payload', async (importOriginal) => ({ ...(await importOriginal<typeof import('payload')>()), restoreVersionOperation: restoreVersion }))

/**
 * Hunt round 3 (cms-platform): bounded public ?depth (cyclic relations), reserved page slugs, and a restore of
 * a draft version never unpublishing a live document. DB behaviour: tests/int/hunt-r3-platform.int.spec.ts.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(dirname, '../../..')

/** Every field named `name`, at any nesting (tabs, rows, arrays). */
function findFields(fields: Field[], name: string, out: Field[] = []): Field[] {
  for (const f of fields as any[]) {
    if (f.name === name) out.push(f)
    if (Array.isArray(f.fields)) findFields(f.fields, name, out)
    if (Array.isArray(f.tabs)) for (const t of f.tabs) findFields(t.fields, name, out)
  }
  return out
}
const only = (c: CollectionConfig, name: string) => {
  const found = findFields(c.fields, name)
  expect(found, `${c.slug}.${name}`).toHaveLength(1)
  return found[0] as any
}

describe('public ?depth is bounded (products ↔ products and recipes ↔ recipes are cycles)', () => {
  it('the self-referencing and cross-linking relations populate one level at most', () => {
    expect(only(Products, 'goesWith')).toMatchObject({ type: 'relationship', relationTo: 'products', maxDepth: 1 })
    expect(only(Recipes, 'product')).toMatchObject({ type: 'relationship', relationTo: 'products', maxDepth: 1 })
    expect(only(Recipes, 'related')).toMatchObject({ type: 'relationship', relationTo: 'recipes', maxDepth: 1 })
  })

  it('payload.config caps ?depth for every caller at 2 (Payload defaults to 10)', () => {
    const src = fs.readFileSync(path.resolve(dirname, '../../src/payload.config.ts'), 'utf8')
    expect(src).toMatch(/^\s*maxDepth: 2,$/m)
  })
})

describe('reserved page slugs', () => {
  it('mirror the storefront list (src/params/policy.js RESERVED_SLUGS) exactly', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/params/policy.js'), 'utf8')
    const block = /RESERVED_SLUGS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)?.[1]
    expect(block, 'RESERVED_SLUGS literal in src/params/policy.js').toBeTruthy()
    const storefront = [...(block as string).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect([...RESERVED_PAGE_SLUGS].sort()).toEqual(storefront)
  })

  it('cover every top-level storefront route and static entry a slug could collide with', () => {
    const routes = fs.readdirSync(path.join(REPO, 'src/routes'), { withFileTypes: true })
    const staticDir = fs.readdirSync(path.join(REPO, 'static'), { withFileTypes: true })
    const names = [
      ...routes.filter((d) => d.isDirectory() && !/[[(]/.test(d.name)).map((d) => d.name),
      ...staticDir.map((d) => d.name.replace(/\.[^.]+$/, '')),
    ].filter((n) => SLUG_RE.test(n))
    for (const n of names) expect(RESERVED_PAGE_SLUGS, n).toContain(n)
  })

  const guard = guardSlug('pages', SLUG_RE, 'bad slug', RESERVED_PAGE_SLUGS)
  const run = (operation: 'create' | 'update', slug: string, before?: string) =>
    guard({ data: { slug }, operation, originalDoc: before ? { slug: before } : undefined, req: {} as PayloadRequest } as never)

  it.each(['terms', 'privacy', 'shop', 'account', 'checkout', 'api'])('a new page "%s" is refused on path slug', (slug) => {
    let err: unknown
    try {
      run('create', slug)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).data.errors).toEqual([{ path: 'slug', message: reservedSlugMessage(slug) }])
    expect(reservedSlugMessage(slug)).toMatch(new RegExp(`/${slug} .*slug "${slug}".*e\\.g\\. ${slug}-policy`))
  })

  it('other slugs (and existing documents) are unaffected', () => {
    expect(run('create', 'terms-of-sale')).toEqual({ slug: 'terms-of-sale' })
    expect(run('update', 'terms', 'terms')).toEqual({ slug: 'terms' })
  })

  it('only Pages pass the list (product and recipe slugs live under /products and /recipes)', () => {
    const src = fs.readFileSync(path.resolve(dirname, '../../src/collections/Pages.ts'), 'utf8')
    expect(src).toContain('RESERVED_PAGE_SLUGS),')
  })
})

describe('restoring a draft version keeps a live document published', () => {
  it('is registered on products, recipes and pages (beforeChange first)', () => {
    for (const c of [Products, Recipes, Pages]) {
      expect(c.hooks?.beforeOperation, c.slug).toContain(draftSafeRestore.beforeOperation)
      expect(c.hooks?.beforeChange?.[0], c.slug).toBe(draftSafeRestore.beforeChange)
      expect(c.hooks?.afterChange, c.slug).toContain(draftSafeRestore.afterChange)
    }
  })

  const LIVE = { id: 5, slug: 'oats', pricePaise: 26000, _status: 'published', createdAt: 'c', updatedAt: 'u', stockOnHand: 3 }
  const setup = (liveStatus: 'published' | 'draft', draft = false) => {
    const findOne = vi.fn(async () => ({ id: 5, _status: liveStatus }))
    // Like a Local API call with req (createLocalReq): req.context is replaced with a copy.
    const findByID = vi.fn(async ({ req: r }: { req: PayloadRequest }) => {
      r.context = { ...r.context }
      return { ...LIVE }
    })
    restoreVersion.mockClear()
    const products = { config: { slug: 'products' } }
    const req = { context: {}, payload: { db: { findOne }, findByID, collections: { products } } } as unknown as PayloadRequest
    recordRestoreRequest({ args: { id: 77, draft }, operation: 'restoreVersion', req } as never)
    req.context.isRestoringVersion = true
    return { req, findByID, products }
  }
  const change = (req: PayloadRequest, status: string) =>
    keepLiveDocOnDraftRestore({
      collection: { slug: 'products' },
      data: { slug: 'oats', pricePaise: 30000, _status: status },
      operation: 'update',
      originalDoc: { id: 5 },
      req,
    } as never)
  const after = (req: PayloadRequest) => restoreAsPendingDraft({ collection: { slug: 'products' }, doc: { id: 5 }, req } as never)

  it('a non-draft restore of a DRAFT version onto a published doc rewrites the live doc, then restores as a draft', async () => {
    const { req, products } = setup('published')
    expect(await change(req, 'draft')).toEqual({ slug: 'oats', pricePaise: 26000, _status: 'published' })
    await after(req)
    expect(restoreVersion).toHaveBeenCalledWith(expect.objectContaining({ collection: products, id: 77, draft: true, overrideAccess: true, req }))
    // Consumed: a second afterChange in the same request does nothing more.
    await after(req)
    expect(restoreVersion).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a published version', 'published', 'published', false],
    ['onto a document that is not published', 'draft', 'draft', false],
    ['already as a draft (?draft=true)', 'draft', 'published', true],
  ] as const)('leaves Payload alone when restoring %s', async (_label, versionStatus, live, draft) => {
    const { req, findByID } = setup(live, draft)
    const data = await change(req, versionStatus)
    expect(data).toMatchObject({ pricePaise: 30000, _status: versionStatus })
    await after(req)
    expect(findByID).not.toHaveBeenCalled()
    expect(restoreVersion).not.toHaveBeenCalled()
  })

  it('ordinary updates (no restore in progress) are untouched', async () => {
    const req = { context: {}, payload: {} } as unknown as PayloadRequest
    const data = { pricePaise: 1, _status: 'draft' }
    expect(await keepLiveDocOnDraftRestore({ collection: { slug: 'products' }, data, operation: 'update', req } as never)).toBe(data)
  })
})
