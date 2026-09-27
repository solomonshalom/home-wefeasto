import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createProduct,
  createRecipe,
  loadCommittedSnapshot,
  loadPolicyDrafts,
  recipeData,
  reviewedPage,
  seedCommittedCatalog,
  serializeSnapshot,
  validateSnapshot,
} from './helpers/catalogFactories'
import { createCustomer, createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restDelete, restGet, restPatch, restPost } from './helpers/rest'

/**
 * GET /api/store/snapshot and GET /api/store/catalog against the seeded committed snapshot (+ the policy
 * drafts, as `npm run seed` creates them), plus what the public, customers and editors can see and do on
 * products / recipes / pages. (cms-catalog)
 */

let payload: Payload
let editorToken: string
let customerToken: string

const CTX = { context: { skipDeployHook: true } }

async function bySlug(collection: 'products' | 'recipes' | 'pages', slug: string) {
  const res = await payload.find({ collection, where: { slug: { equals: slug } }, limit: 1, depth: 0, overrideAccess: true })
  return res.docs[0] as Record<string, any>
}

async function snapshot() {
  const res = await restGet('store/snapshot')
  expect(res.status).toBe(200)
  return res.body
}

async function catalog() {
  const res = await restGet('store/catalog')
  expect(res.status).toBe(200)
  return res.body
}

/** The committed file vs a response, ignoring generatedAt. */
const expectRoundTrip = (body: any) => expect(body).toStrictEqual({ ...loadCommittedSnapshot(), generatedAt: body.generatedAt })
const slugs = (docs: { slug: string }[]) => docs.map((d) => d.slug)

beforeAll(async () => {
  payload = await getTestPayload()
  await seedCommittedCatalog(payload)
  editorToken = (await login('users', (await createStaff(payload, 'editor')).email)).token
  customerToken = (await login('customers', (await createCustomer(payload)).email)).token
})

describe('GET /api/store/snapshot — the CMS ↔ storefront round trip', () => {
  it('seeding the committed snapshot and reading it back gives the same snapshot (except generatedAt)', async () => {
    const file = loadCommittedSnapshot()
    const before = Date.now()
    const res = await restGet('store/snapshot')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.body).toStrictEqual({ ...file, generatedAt: res.body.generatedAt })
    expect(validateSnapshot(res.body)).toEqual({ ok: true, errors: [] })
    // Byte-identical once written the way the sync writes it.
    expect(serializeSnapshot(res.body)).toBe(serializeSnapshot({ ...file, generatedAt: res.body.generatedAt }))
    expect(new Date(res.body.generatedAt).toISOString()).toBe(res.body.generatedAt)
    expect(Date.parse(res.body.generatedAt)).toBeGreaterThanOrEqual(before - 1000)
    // Exactly the snapshot's keys, in the canonical order (no ids, timestamps, _status, stock …).
    expect(Object.keys(res.body)).toEqual(Object.keys(file))
    expect(Object.keys(res.body.products[0])).toEqual(Object.keys(file.products[0]))
    expect(Object.keys(res.body.recipes[0])).toEqual(Object.keys(file.recipes[0]))
    expect(res.text).not.toMatch(/"(stock|lowStockThreshold|_status|createdAt|updatedAt|id)"/)
  })

  it('is the same for a logged-in editor (never drafts) and for a customer', async () => {
    const draft = await createProduct(payload, { name: 'Editor Only Granola' }, { draft: true })
    try {
      for (const token of [editorToken, customerToken]) {
        const res = await restGet('store/snapshot', { token })
        expect(res.status).toBe(200)
        expectRoundTrip(res.body)
        expect(res.text).not.toContain('Editor Only Granola')
      }
    } finally {
      await payload.delete({ collection: 'products', id: draft.id, ...CTX })
    }
  })
})

describe('GET /api/store/catalog — live overlay', () => {
  it('lists every published product with public settings, CDN-cacheable', async () => {
    const file = loadCommittedSnapshot()
    const res = await restGet('store/catalog')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=15, s-maxage=30')
    expect(Object.keys(res.body)).toEqual(['settings', 'products'])
    expect(res.body.settings).toStrictEqual(file.settings)
    expect(res.body.products).toStrictEqual(
      file.products.map((p) => ({
        slug: p.slug,
        name: p.name,
        pricePaise: p.pricePaise,
        inStock: true,
        lowStock: null,
        maxPerOrder: p.maxPerOrder,
        codAllowed: p.codAllowed,
      })),
    )
    expect(res.text).not.toMatch(/"stock"|lowStockThreshold|reservationMinutes|PinPrefixes|codMaxOpenPerPhone/)
  })

  describe('inStock / lowStock', () => {
    const slug = 'rolled-oats'
    // Absolute stock writes need context.allowStockSet (src/lib/productStock.ts).
    const STOCK_CTX = { context: { ...CTX.context, allowStockSet: true } }
    afterEach(async () => {
      const doc = await bySlug('products', slug)
      await payload.update({ collection: 'products', id: doc.id, data: { stock: 100, lowStockThreshold: 5, inStock: true }, ...STOCK_CTX })
    })

    const cases: [string, { stock: number; lowStockThreshold?: number; inStock?: boolean }, { inStock: boolean; lowStock: number | null }][] = [
      ['plenty', { stock: 100 }, { inStock: true, lowStock: null }],
      ['one above the threshold', { stock: 6 }, { inStock: true, lowStock: null }],
      ['exactly the threshold', { stock: 5 }, { inStock: true, lowStock: 5 }],
      ['below the threshold', { stock: 3 }, { inStock: true, lowStock: 3 }],
      ['last unit', { stock: 1 }, { inStock: true, lowStock: 1 }],
      ['sold out', { stock: 0 }, { inStock: false, lowStock: null }],
      ['threshold 0 never says "only N left"', { stock: 1, lowStockThreshold: 0 }, { inStock: true, lowStock: null }],
      ['custom threshold', { stock: 12, lowStockThreshold: 20 }, { inStock: true, lowStock: 12 }],
      ['"available for sale" unticked, stock left', { stock: 50, inStock: false }, { inStock: false, lowStock: null }],
      ['"available for sale" unticked, low stock', { stock: 2, inStock: false }, { inStock: false, lowStock: null }],
    ]
    for (const [label, data, expected] of cases) {
      it(label, async () => {
        const doc = await bySlug('products', slug)
        await payload.update({ collection: 'products', id: doc.id, data, ...STOCK_CTX })
        const row = (await catalog()).products.find((p: { slug: string }) => p.slug === slug)
        expect(row).toMatchObject(expected)
        // The build-time snapshot agrees on availability; lowStock is live-only.
        const snap = await snapshot()
        expect(snap.products.find((p: { slug: string }) => p.slug === slug).inStock).toBe(expected.inStock)
        expect(validateSnapshot(snap).ok).toBe(true)
      })
    }
  })

  it('is not paginated (more than 10 products)', async () => {
    const extra = []
    for (let i = 0; i < 6; i++) extra.push(await createProduct(payload))
    try {
      const body = await catalog()
      expect(body.products).toHaveLength(12)
      // Catalog order: sortOrder ascending, new products (max + 10) last.
      expect(body.products.slice(0, 6).map((p: { slug: string }) => p.slug)).toEqual(loadCommittedSnapshot().products.map((p) => p.slug))
      expect(body.products.slice(6).map((p: { slug: string }) => p.slug)).toEqual(extra.map((p) => p.slug))
      const snap = await snapshot()
      expect(snap.products).toHaveLength(12)
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
    } finally {
      for (const p of extra) await payload.delete({ collection: 'products', id: p.id, ...CTX })
    }
  })
})

describe('drafts never reach the public', () => {
  it('a never-published product is not in the snapshot, the catalog or public REST', async () => {
    const draft = await createProduct(payload, { name: 'Secret Muesli', pricePaise: 99900 }, { draft: true })
    try {
      const snap = await snapshot()
      expect(snap.products.map((p: { slug: string }) => p.slug)).not.toContain(draft.slug)
      expectRoundTrip(snap)
      expect((await catalog()).products.map((p: { slug: string }) => p.slug)).not.toContain(draft.slug)
      for (const token of [undefined, customerToken]) {
        const list = await restGet('products', { token, query: 'limit=100&depth=0' })
        expect(list.status).toBe(200)
        expect(list.text).not.toContain('Secret Muesli')
        expect((await restGet(`products/${draft.id}`, { token })).status).toBe(404)
        expect((await restGet('products', { token, query: 'draft=true&limit=100' })).text).not.toContain('Secret Muesli')
      }
      const staff = await restGet(`products/${draft.id}`, { token: editorToken, query: 'draft=true' })
      expect(staff.status).toBe(200)
      expect(staff.body.name).toBe('Secret Muesli')
    } finally {
      await payload.delete({ collection: 'products', id: draft.id, ...CTX })
    }
  })

  it('a draft edit of a published product leaves the published version live', async () => {
    const doc = await bySlug('products', 'muesli')
    const published = doc.pricePaise
    await payload.update({ collection: 'products', id: doc.id, data: { pricePaise: 100, name: 'Muesli (draft rename)' }, draft: true, ...CTX })
    try {
      expectRoundTrip(await snapshot())
      const row = (await catalog()).products.find((p: { slug: string }) => p.slug === 'muesli')
      expect(row).toMatchObject({ pricePaise: published, name: 'Muesli' })
      for (const token of [undefined, customerToken]) {
        const one = await restGet(`products/${doc.id}`, { token })
        expect(one.body.pricePaise).toBe(published)
        expect((await restGet(`products/${doc.id}`, { token, query: 'draft=true' })).text).not.toContain('draft rename')
      }
      const staff = await restGet(`products/${doc.id}`, { token: editorToken, query: 'draft=true' })
      expect(staff.body).toMatchObject({ pricePaise: 100, name: 'Muesli (draft rename)' })
    } finally {
      // Publishing the original values again discards the draft.
      await payload.update({ collection: 'products', id: doc.id, data: { pricePaise: published, name: 'Muesli', _status: 'published' }, ...CTX })
    }
    expectRoundTrip(await snapshot())
  })

  it('draft recipes, Payload-draft pages and pages not shown on the storefront are all excluded', async () => {
    const recipe = await createRecipe(payload, { title: 'Hidden Porridge' }, { draft: true })
    const page = await payload.create({
      collection: 'pages',
      data: { slug: `draft-page-${Date.now()}`, title: 'Hidden Page', bodyHtml: '<p>Hidden</p>', published: true, _status: 'draft' } as never,
      draft: true,
      ...CTX,
    })
    // Published in Payload, "Show on the storefront" unticked: still staff-only.
    const unticked = await payload.create({
      collection: 'pages',
      data: { slug: `unticked-${Date.now()}`, title: 'Unticked Page', bodyHtml: '<p>Unticked</p>', published: false, _status: 'published' } as never,
      ...CTX,
    })
    expect(unticked._status).toBe('published')
    try {
      const snap = await snapshot()
      expect(slugs(snap.recipes)).not.toContain(recipe.slug)
      // The three seeded policy drafts and both pages above: none is on the storefront.
      expect(snap.pages).toEqual([])
      expectRoundTrip(snap)
      for (const token of [undefined, customerToken]) {
        expect((await restGet('recipes', { token, query: 'limit=100' })).text).not.toContain('Hidden Porridge')
        const pages = await restGet('pages', { token, query: 'limit=100' })
        expect(pages.status).toBe(200)
        expect(pages.body.totalDocs).toBe(0)
        expect(pages.text).not.toMatch(/Hidden Page|Unticked Page/)
        expect((await restGet(`pages/${unticked.id}`, { token })).status).toBe(404)
      }
      const staff = await restGet('pages', { token: editorToken, query: 'limit=100&draft=true' })
      expect(slugs(staff.body.docs)).toEqual(expect.arrayContaining([page.slug, unticked.slug, 'shipping', 'refunds', 'grievances']))
    } finally {
      await payload.delete({ collection: 'recipes', id: recipe.id, ...CTX })
      await payload.delete({ collection: 'pages', id: page.id, ...CTX })
      await payload.delete({ collection: 'pages', id: unticked.id, ...CTX })
    }
  })
})

describe('policy pages (snapshot-schema.md §5.2): nothing unreviewed goes live', () => {
  it('the seeded policy drafts are staff-only: not in the snapshot, not readable by guests or customers', async () => {
    const drafts = loadPolicyDrafts().pages
    const docs = await Promise.all(drafts.map((d) => bySlug('pages', d.slug)))
    expect(docs.map((d) => [d.slug, d._status, d.published])).toEqual([
      ['shipping', 'draft', false],
      ['refunds', 'draft', false],
      ['grievances', 'draft', false],
    ])
    for (const [i, d] of drafts.entries()) expect(docs[i]).toMatchObject({ title: d.title, bodyHtml: d.bodyHtml })
    expectRoundTrip(await snapshot())

    for (const token of [undefined, customerToken]) {
      for (const query of ['limit=100&depth=0', 'draft=true&limit=100', 'where[published][equals]=false', 'where[slug][equals]=refunds&draft=true']) {
        const res = await restGet('pages', { token, query })
        expect(res.status, query).toBe(200)
        expect(res.body.totalDocs, query).toBe(0)
        expect(res.text, query).not.toMatch(/to be reviewed|to be added|Grievance/)
      }
      for (const d of docs) {
        expect((await restGet(`pages/${d.id}`, { token })).status, d.slug).toBe(404)
        expect((await restGet(`pages/${d.id}`, { token, query: 'draft=true' })).status, d.slug).toBe(404)
      }
      expect((await restGet('pages/versions', { token })).status).toBe(403)
    }
    // Staff review them in the admin.
    const staff = await restGet('pages', { token: editorToken, query: 'draft=true&limit=100&sort=sortOrder' })
    expect(staff.status).toBe(200)
    expect(slugs(staff.body.docs)).toEqual(['shipping', 'refunds', 'grievances'])
    expect(staff.text).toContain('Draft — to be reviewed')
  })

  it('a reviewed page goes live (snapshot + public REST); its newer drafts stay private; unticking takes it off', async () => {
    const doc = await bySlug('pages', 'refunds')
    const original = loadPolicyDrafts().pages[1]
    const reviewed = reviewedPage(original)
    try {
      const live = await restPatch(`pages/${doc.id}`, {
        token: editorToken,
        body: { bodyHtml: reviewed.bodyHtml, published: true, _status: 'published' },
      })
      expect(live.status, live.text).toBe(200)

      const snap = await snapshot()
      expect(snap).toStrictEqual({ ...loadCommittedSnapshot(), pages: [reviewed], generatedAt: snap.generatedAt })
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
      for (const token of [undefined, customerToken]) {
        const list = await restGet('pages', { token, query: 'limit=100&depth=0' })
        expect(slugs(list.body.docs)).toEqual(['refunds'])
        const one = await restGet(`pages/${doc.id}`, { token })
        expect(one.status).toBe(200)
        expect(one.body).toMatchObject({ slug: 'refunds', bodyHtml: reviewed.bodyHtml, published: true })
      }

      // The owner starts a new draft of the live page: the live version keeps being served.
      const wip = await restPatch(`pages/${doc.id}`, {
        token: editorToken,
        body: { bodyHtml: '<p>Work in progress: [to be added]</p>' },
        query: 'draft=true',
      })
      expect(wip.status, wip.text).toBe(200)
      expect((await snapshot()).pages).toStrictEqual([reviewed])
      for (const token of [undefined, customerToken]) {
        expect((await restGet(`pages/${doc.id}`, { token })).body.bodyHtml).toBe(reviewed.bodyHtml)
        expect((await restGet(`pages/${doc.id}`, { token, query: 'draft=true' })).text).not.toContain('Work in progress')
        expect((await restGet('pages', { token, query: 'draft=true&limit=100' })).text).not.toContain('Work in progress')
      }
      expect((await restGet(`pages/${doc.id}`, { token: editorToken, query: 'draft=true' })).body.bodyHtml).toContain('Work in progress')

      // Unticking "Show on the storefront" (and publishing that) takes it off the site and out of public REST.
      const off = await restPatch(`pages/${doc.id}`, {
        token: editorToken,
        body: { bodyHtml: reviewed.bodyHtml, published: false, _status: 'published' },
      })
      expect(off.status, off.text).toBe(200)
      expectRoundTrip(await snapshot())
      for (const token of [undefined, customerToken]) {
        expect((await restGet('pages', { token })).body.totalDocs).toBe(0)
        expect((await restGet(`pages/${doc.id}`, { token })).status).toBe(404)
      }
    } finally {
      // Back to the seeded draft for the rest of the file.
      await payload.update({ collection: 'pages', id: doc.id, data: { ...original, published: false, _status: 'draft' } as never, ...CTX })
    }
    expectRoundTrip(await snapshot())
  })
})

describe('unpublishing', () => {
  it('removes a product from the snapshot (and every reference to it) and from the catalog; republishing restores it', async () => {
    const doc = await bySlug('products', 'cornflakes')
    await payload.update({ collection: 'products', id: doc.id, data: { _status: 'draft' }, ...CTX })
    try {
      const snap = await snapshot()
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
      expect(snap.products.map((p: { slug: string }) => p.slug)).toEqual(['steel-cut-oats', 'rolled-oats', 'muesli', 'choco-flakes', 'health-mix'])
      expect(JSON.stringify(snap.products.map((p: { goesWith: string[] }) => p.goesWith))).not.toContain('cornflakes')
      for (const slug of ['wf-masala-cornflakes-chivda', 'wf-honey-nut-cornflake-clusters']) {
        // Their only product is gone; the recipes stay.
        expect(snap.recipes.find((r: { slug: string }) => r.slug === slug).products).toEqual([])
      }
      expect(JSON.stringify(snap.recipes.map((r: { products: { slug: string }[] }) => r.products))).not.toContain('"cornflakes"')

      // The live overlay no longer lists it: the storefront treats a missing product as not sold.
      const live = await catalog()
      expect(live.products.map((p: { slug: string }) => p.slug)).not.toContain('cornflakes')
      expect(live.products).toHaveLength(5)
      expect((await restGet(`products/${doc.id}`)).status).toBe(404)
    } finally {
      await payload.update({ collection: 'products', id: doc.id, data: { _status: 'published' }, ...CTX })
    }
    expectRoundTrip(await snapshot())
  })

  it('unpublishing a recipe drops it from other recipes’ related lists', async () => {
    const doc = await bySlug('recipes', 'wf-muesli-yogurt-parfait')
    await payload.update({ collection: 'recipes', id: doc.id, data: { _status: 'draft' }, ...CTX })
    try {
      const snap = await snapshot()
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
      expect(snap.recipes).toHaveLength(11)
      expect(JSON.stringify(snap.recipes.map((r: { related: string[] }) => r.related))).not.toContain('wf-muesli-yogurt-parfait')
    } finally {
      await payload.update({ collection: 'recipes', id: doc.id, data: { _status: 'published' }, ...CTX })
    }
    expectRoundTrip(await snapshot())
  })
})

describe('server-only product fields', () => {
  it('stock and lowStockThreshold are hidden from guests and customers, visible to staff', async () => {
    const doc = await bySlug('products', 'health-mix')
    for (const token of [undefined, customerToken]) {
      const list = await restGet('products', { token, query: 'limit=100&depth=0' })
      expect(list.status).toBe(200)
      expect(list.body.docs).toHaveLength(6)
      for (const d of list.body.docs) {
        expect(d).not.toHaveProperty('stock')
        expect(d).not.toHaveProperty('lowStockThreshold')
      }
      const one = await restGet(`products/${doc.id}`, { token })
      expect(one.status).toBe(200)
      expect(one.body).not.toHaveProperty('stock')
      expect(one.body).not.toHaveProperty('lowStockThreshold')
      // Nor can they be probed by filtering, or selected explicitly.
      const probe = await restGet('products', { token, query: 'where[stock][equals]=100' })
      expect(probe.status).toBe(400) // "The following path cannot be queried: stock"
      expect(probe.body).not.toHaveProperty('docs')
      const sorted = await restGet('products', { token, query: 'where[stock][greater_than]=0&limit=1' })
      expect(sorted.status).toBe(400)
      const sel = await restGet(`products/${doc.id}`, { token, query: 'select[stock]=true&select[slug]=true' })
      expect(sel.text).not.toContain('"stock"')
    }
    const staff = await restGet(`products/${doc.id}`, { token: editorToken })
    expect(staff.body).toMatchObject({ stock: 100, lowStockThreshold: 5 })
  })

  it('versions are staff-only', async () => {
    for (const c of ['products', 'recipes', 'pages']) {
      for (const token of [undefined, customerToken]) expect((await restGet(`${c}/versions`, { token })).status, c).toBe(403)
      expect((await restGet(`${c}/versions`, { token: editorToken })).status, c).toBe(200)
    }
  })
})

describe('who can change the catalog', () => {
  it('editors can edit products (price, stock) but cannot read orders or change settings', async () => {
    const doc = await bySlug('products', 'choco-flakes')
    // Stock changes by ±N (stockAdjust); an absolute number is refused (cms-hardening: no lost updates).
    const res = await restPatch(`products/${doc.id}`, { token: editorToken, body: { pricePaise: 26900, stockAdjust: 42 - doc.stock } })
    expect(res.status).toBe(200)
    expect(res.body.doc).toMatchObject({ pricePaise: 26900, stock: 42 })
    expect((await restPatch(`products/${doc.id}`, { token: editorToken, body: { stock: 43 } })).status).toBe(400)
    expect((await catalog()).products.find((p: { slug: string }) => p.slug === 'choco-flakes').pricePaise).toBe(26900)
    const restore = await restPatch(`products/${doc.id}`, { token: editorToken, body: { pricePaise: doc.pricePaise, stockAdjust: doc.stock - 42 } })
    expect(restore.status).toBe(200)
    expect(restore.body.doc.stock).toBe(doc.stock)

    expect((await restGet('orders', { token: editorToken })).status).toBe(403)
    expect((await restPost('globals/store-settings', { token: editorToken, body: { deliveryFeePaise: 1 } })).status).toBe(403)
    expectRoundTrip(await snapshot())
  })

  it('editors can create and delete recipes', async () => {
    const product = await bySlug('products', 'muesli')
    const created = await restPost('recipes', {
      token: editorToken,
      body: { ...recipeData({ products: [{ product: product.id, ratingStyle: 'decimal' }] }), _status: 'published' },
    })
    expect(created.status).toBe(201)
    expect((await snapshot()).recipes.map((r: { slug: string }) => r.slug)).toContain(created.body.doc.slug)
    expect((await restDelete(`recipes/${created.body.doc.id}`, { token: editorToken })).status).toBe(200)
    expectRoundTrip(await snapshot())
  })

  it('customers and guests cannot create, update or delete products, recipes or pages', async () => {
    const product = await bySlug('products', 'muesli')
    const recipe = await bySlug('recipes', 'wf-muesli-yogurt-parfait')
    const page = await bySlug('pages', 'shipping')
    for (const token of [undefined, customerToken]) {
      expect((await restPost('products', { token, body: { name: 'X', slug: `x-${Date.now()}` } })).status).toBe(403)
      expect((await restPatch(`products/${product.id}`, { token, body: { pricePaise: 100 } })).status).toBe(403)
      expect((await restDelete(`products/${product.id}`, { token })).status).toBe(403)
      expect((await restPatch(`recipes/${recipe.id}`, { token, body: { title: 'Hacked' } })).status).toBe(403)
      expect((await restPatch(`pages/${page.id}`, { token, body: { published: true } })).status).toBe(403)
    }
    expectRoundTrip(await snapshot())
  })
})
