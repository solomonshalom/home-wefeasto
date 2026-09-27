import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RECIPE_SLUG_RE, SLUG_MAX, SLUG_RE } from '@/endpoints/catalog/rules'
import { copySlug } from '@/lib/duplicateDoc'

import { createProduct, createRecipe } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

/**
 * HUNT data-cms (round 2): admin ⋯ → Duplicate (POST /api/<collection>/:id/duplicate) failed for every
 * product, recipe and page with "The following field is invalid: slug" (Payload's default "<slug> - Copy").
 * The copy is now a draft with a free `<slug>-copy[-n]` slug and the next free sortOrder (src/lib/duplicateDoc.ts).
 */

type Coll = 'products' | 'recipes' | 'pages'
const CTX = { context: { skipDeployHook: true } }
let payload: Payload
let editorToken: string
const created: Array<[Coll, number | string]> = []

beforeAll(async () => {
  payload = await getTestPayload()
  const editor = await createStaff(payload, 'editor')
  editorToken = (await login('users', editor.email)).token
})

afterAll(async () => {
  for (const [collection, id] of created.reverse()) await payload.delete({ collection, id, ...CTX }).catch(() => undefined)
})

const stamp = () => Date.now().toString(36)

async function duplicate(collection: Coll, id: number | string, opts: { body?: unknown; query?: string } = {}) {
  const res = await restPost(`${collection}/${id}/duplicate`, { token: editorToken, body: opts.body ?? {}, query: opts.query ?? 'depth=0' })
  if (res.body?.doc?.id) created.push([collection, res.body.doc.id])
  return res
}

async function maxSortOrder(collection: Coll): Promise<number> {
  const top = await payload.find({ collection, sort: '-sortOrder', limit: 1, depth: 0, where: { sortOrder: { exists: true } } })
  return (top.docs[0] as { sortOrder: number }).sortOrder
}

async function createPage(slug: string) {
  const doc = await payload.create({
    collection: 'pages',
    data: { slug, title: `Page ${slug}`, bodyHtml: '<p>Reviewed.</p>', published: true, _status: 'published' } as never,
    ...CTX,
  })
  created.push(['pages', doc.id])
  return doc
}

describe('copySlug', () => {
  it('appends -copy / -copy-n, counts on from an earlier copy, keeps wf- and SLUG_MAX', () => {
    expect(copySlug('health-mix', 1)).toBe('health-mix-copy')
    expect(copySlug('health-mix', 2)).toBe('health-mix-copy-2')
    expect(copySlug('health-mix-copy', 1)).toBe('health-mix-copy')
    expect(copySlug('health-mix-copy-7', 3)).toBe('health-mix-copy-3')
    expect(copySlug('wf-masala-oats', 1)).toBe('wf-masala-oats-copy')
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join('-')
    for (const n of [1, 2, 99, 1000]) {
      const s = copySlug(long, n)
      expect(s.length).toBeLessThanOrEqual(SLUG_MAX)
      expect(s).toMatch(SLUG_RE)
    }
    expect(copySlug(`wf-${long}`, 12)).toMatch(RECIPE_SLUG_RE)
  })
})

describe('POST /api/<collection>/:id/duplicate', () => {
  it('products: a draft copy with <slug>-copy, then -copy-2; next sortOrder; no stock; original untouched', async () => {
    const original = await createProduct(payload, { slug: `dup-${stamp()}`, pricePaise: 23400 })
    created.push(['products', original.id])

    const first = await duplicate('products', original.id)
    expect(first.status, first.text.slice(0, 300)).toBe(200)
    expect(first.body.doc).toMatchObject({ slug: `${original.slug}-copy`, _status: 'draft', name: original.name, pricePaise: 23400 })
    expect(first.body.doc.sortOrder).toBe(await maxSortOrder('products'))
    expect(first.body.doc.sortOrder).toBeGreaterThan(original.sortOrder as number)
    const stored = await payload.findByID({ collection: 'products', id: first.body.doc.id, depth: 0, draft: true })
    expect(stored).toMatchObject({ _status: 'draft', stock: 0 })

    const second = await duplicate('products', original.id)
    expect(second.status, second.text.slice(0, 300)).toBe(200)
    expect(second.body.doc).toMatchObject({ slug: `${original.slug}-copy-2`, _status: 'draft' })
    // Duplicating the copy counts on from the stem.
    const third = await duplicate('products', first.body.doc.id)
    expect(third.status, third.text.slice(0, 300)).toBe(200)
    expect(third.body.doc.slug).toBe(`${original.slug}-copy-3`)

    // Drafts never reach the public API; the original stays as it was.
    expect((await restGet(`products/${first.body.doc.id}`)).status).toBe(404)
    const live = await payload.findByID({ collection: 'products', id: original.id, depth: 0 })
    expect(live).toMatchObject({ slug: original.slug, _status: 'published', sortOrder: original.sortOrder, stock: 100 })
  })

  it('a copy is a draft even when the request asks to publish it', async () => {
    const original = await createProduct(payload, { slug: `dup-pub-${stamp()}` })
    created.push(['products', original.id])
    const res = await duplicate('products', original.id, { query: 'depth=0&draft=false', body: { _status: 'published' } })
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect(res.body.doc).toMatchObject({ slug: `${original.slug}-copy`, _status: 'draft' })
    const row = await payload.findByID({ collection: 'products', id: res.body.doc.id, depth: 0 })
    expect(row._status).toBe('draft')
  })

  it('a slug sent with the request wins, and is still checked', async () => {
    const original = await createProduct(payload, { slug: `dup-own-${stamp()}` })
    created.push(['products', original.id])
    const own = await duplicate('products', original.id, { body: { slug: `${original.slug}-1kg` } })
    expect(own.status, own.text.slice(0, 300)).toBe(200)
    expect(own.body.doc.slug).toBe(`${original.slug}-1kg`)
    const bad = await duplicate('products', original.id, { body: { slug: 'Not A Slug' } })
    expect(bad.status).toBe(400)
  })

  it('recipes: keeps the wf- prefix and gets the next sortOrder', async () => {
    const original = await createRecipe(payload, { slug: `wf-dup-${stamp()}` })
    created.push(['recipes', original.id])
    const res = await duplicate('recipes', original.id)
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect(res.body.doc).toMatchObject({ slug: `${original.slug}-copy`, _status: 'draft', title: original.title })
    expect(res.body.doc.slug).toMatch(RECIPE_SLUG_RE)
    expect(res.body.doc.sortOrder).toBe(await maxSortOrder('recipes'))
  })

  it('pages: a draft copy with a free slug', async () => {
    const original = await createPage(`dup-page-${stamp()}`)
    const res = await duplicate('pages', original.id)
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect(res.body.doc).toMatchObject({ slug: `${original.slug}-copy`, _status: 'draft', bodyHtml: '<p>Reviewed.</p>' })
    expect(res.body.doc.sortOrder).toBe(await maxSortOrder('pages'))
    const snapshot = (await restGet('store/snapshot')).body
    expect(snapshot.pages.map((p: { slug: string }) => p.slug)).not.toContain(`${original.slug}-copy`)
  })

  it('a long slug copies within SLUG_MAX', async () => {
    const slug = `dup-${stamp()}-${'a'.repeat(SLUG_MAX)}`.slice(0, SLUG_MAX).replace(/-+$/, '')
    const original = await createProduct(payload, { slug })
    created.push(['products', original.id])
    const res = await duplicate('products', original.id)
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect(res.body.doc.slug.length).toBeLessThanOrEqual(SLUG_MAX)
    expect(res.body.doc.slug).toMatch(/-copy$/)
    expect(res.body.doc.slug).toMatch(SLUG_RE)
  })
})
