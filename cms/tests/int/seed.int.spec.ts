import { execFile } from 'child_process'
import http from 'http'
import type { AddressInfo } from 'net'
import path from 'path'
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { seedAdmin, SeedError, seedCatalog } from '@/seed/seedCatalog'

import {
  createProduct,
  loadCommittedSnapshot,
  loadPolicyDrafts,
  restoreStoreSettings,
  reviewedPage,
  seedCommittedCatalog,
  serializeSnapshot,
  validatePolicyDrafts,
  validateSnapshot,
} from './helpers/catalogFactories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/** `npm run seed` / seedCatalog(): idempotent import of the committed snapshot + the policy drafts. (cms-catalog) */

let payload: Payload
const CTX = { context: { skipDeployHook: true } }
/** Absolute stock writes need context.allowStockSet (src/lib/productStock.ts); the admin/API adjust by ±N. */
const STOCK_CTX = { context: { skipDeployHook: true, allowStockSet: true } }
const COLLECTIONS = ['products', 'recipes', 'pages'] as const
/** What `npm run seed` passes (minus the admin): the committed snapshot's validator and the policy drafts. */
const opts = () => ({
  validate: validateSnapshot,
  policyDrafts: loadPolicyDrafts(),
  validateDrafts: validatePolicyDrafts,
  deployHook: false,
  stock: 100,
})
const NO_DRAFTS = { created: 0, kept: 3 }

/** Everything a no-op seed must leave untouched: ids, updatedAt, status, stock and version counts. */
async function fingerprint() {
  const out: Record<string, unknown> = {}
  for (const collection of COLLECTIONS) {
    const docs = (await payload.find({ collection, depth: 0, pagination: false, overrideAccess: true, sort: 'id' })).docs as Record<string, any>[]
    out[collection] = docs.map((d) => [d.id, d.slug, d.updatedAt, d._status, d.stock ?? null, d.published ?? null])
    out[`${collection}Versions`] = (await payload.countVersions({ collection, overrideAccess: true })).totalDocs
  }
  out.settings = await payload.findGlobal({ slug: 'store-settings', overrideAccess: true })
  return out
}

async function bySlug(collection: 'products' | 'recipes' | 'pages', slug: string) {
  const res = await payload.find({ collection, where: { slug: { equals: slug } }, limit: 1, depth: 0, overrideAccess: true })
  return res.docs[0] as Record<string, any>
}

const expectRoundTrip = async (expected = loadCommittedSnapshot()) => {
  const body = (await restGet('store/snapshot')).body
  expect(body).toStrictEqual({ ...expected, generatedAt: body.generatedAt })
  expect(validateSnapshot(body)).toEqual({ ok: true, errors: [] })
  expect(serializeSnapshot(body)).toBe(serializeSnapshot({ ...expected, generatedAt: body.generatedAt }))
}

const pageRows = async () =>
  ((await payload.find({ collection: 'pages', depth: 0, pagination: false, overrideAccess: true, sort: 'sortOrder' })).docs as Record<string, any>[]).map(
    (p) => [p.slug, p._status, p.published, p.sortOrder],
  )

beforeAll(async () => {
  payload = await getTestPayload()
})

afterAll(async () => {
  await seedCommittedCatalog(payload)
  await restoreStoreSettings(payload)
})

describe('seedCatalog', () => {
  it('imports the committed snapshot into an empty catalog: everything published; the policy drafts as drafts', async () => {
    await restoreStoreSettings(payload)
    await payload.updateGlobal({ slug: 'store-settings', data: { deliveryFeePaise: 5900 } as never, ...CTX })
    const report = await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), reset: true, stock: 25 })
    expect(report).toEqual({
      reset: true,
      products: { created: 6, updated: 0, unchanged: 0 },
      recipes: { created: 12, updated: 0, unchanged: 0 },
      pages: { created: 0, updated: 0, unchanged: 0 }, // the committed snapshot has no storefront page yet
      drafts: { created: 3, kept: 0 },
      settings: 'updated',
      changed: true,
    })
    for (const collection of ['products', 'recipes'] as const) {
      const docs = (await payload.find({ collection, depth: 0, pagination: false, overrideAccess: true })).docs as Record<string, any>[]
      expect(docs.every((d) => d._status === 'published'), collection).toBe(true)
    }
    const products = (await payload.find({ collection: 'products', depth: 0, pagination: false, overrideAccess: true })).docs
    expect(products.map((p) => p.stock)).toEqual([25, 25, 25, 25, 25, 25])
    expect(products.map((p) => p.lowStockThreshold)).toEqual([5, 5, 5, 5, 5, 5])
    // The three policy drafts, for the owner to review: Payload drafts, not shown on the storefront.
    expect(await pageRows()).toEqual([
      ['shipping', 'draft', false, 10],
      ['refunds', 'draft', false, 20],
      ['grievances', 'draft', false, 30],
    ])
    for (const d of loadPolicyDrafts().pages) expect(await bySlug('pages', d.slug), d.slug).toMatchObject({ title: d.title, bodyHtml: d.bodyHtml })
    // …which keeps them out of the snapshot (the round trip is exact) and away from the public.
    await expectRoundTrip()
    expect((await restGet('pages', { query: 'limit=100' })).body.totalDocs).toBe(0)
  })

  it('running it again changes nothing (no writes, no new versions, same updatedAt)', async () => {
    const before = await fingerprint()
    const report = await seedCatalog(payload, loadCommittedSnapshot(), opts())
    expect(report).toEqual({
      reset: false,
      products: { created: 0, updated: 0, unchanged: 6 },
      recipes: { created: 0, updated: 0, unchanged: 12 },
      pages: { created: 0, updated: 0, unchanged: 0 },
      drafts: NO_DRAFTS,
      settings: 'unchanged',
      changed: false,
    })
    expect(await fingerprint()).toEqual(before)
    // …and a third time for good measure.
    await seedCatalog(payload, loadCommittedSnapshot(), opts())
    expect(await fingerprint()).toEqual(before)
  })

  it('brings drifted content back to the snapshot, but never resets stock', async () => {
    const muesli = await bySlug('products', 'muesli')
    await payload.update({ collection: 'products', id: muesli.id, data: { pricePaise: 99900, stock: 7, goesWith: [] }, ...STOCK_CTX })
    const recipe = await bySlug('recipes', 'wf-banana-oat-pancakes')
    await payload.delete({ collection: 'recipes', id: recipe.id, ...CTX })
    await payload.updateGlobal({ slug: 'store-settings', data: { announcement: { enabled: true, text: 'Sale!', href: '' } } as never, ...CTX })

    const report = await seedCatalog(payload, loadCommittedSnapshot(), opts())
    expect(report.products).toEqual({ created: 0, updated: 1, unchanged: 5 })
    // Recreated, plus wf-honey-nut-cornflake-clusters whose `related` lost the deleted recipe.
    expect(report.recipes).toEqual({ created: 1, updated: 1, unchanged: 10 })
    expect(report.pages).toEqual({ created: 0, updated: 0, unchanged: 0 })
    expect(report.drafts).toEqual(NO_DRAFTS)
    expect(report.settings).toBe('updated')
    expect((await bySlug('products', 'muesli')).stock).toBe(7)
    await expectRoundTrip()
  })

  it('re-seeding a snapshot synced while a product was sold out leaves it sellable after a restock', async () => {
    await seedCatalog(payload, loadCommittedSnapshot(), opts())
    const health = await bySlug('products', 'health-mix')
    await payload.update({ collection: 'products', id: health.id, data: { stock: 0 }, ...STOCK_CTX })

    // The storefront syncs while the item is sold out: the snapshot now says inStock:false (derived).
    const soldOut = (await restGet('store/snapshot')).body
    expect(soldOut.products.find((p: { slug: string }) => p.slug === 'health-mix').inStock).toBe(false)

    const report = await seedCatalog(payload, soldOut, opts())
    expect(report.products).toEqual({ created: 0, updated: 0, unchanged: 6 })
    expect((await bySlug('products', 'health-mix')).inStock).toBe(true)

    await payload.update({ collection: 'products', id: health.id, data: { stock: 40 }, ...STOCK_CTX })
    const catalog = (await restGet('store/catalog')).body
    expect(catalog.products.find((p: { slug: string }) => p.slug === 'health-mix').inStock).toBe(true)
    await payload.update({ collection: 'products', id: health.id, data: { stock: 100 }, ...STOCK_CTX })
  })

  it('a newly created product takes the snapshot value of "Available for sale"', async () => {
    const snap = loadCommittedSnapshot()
    const muesli = snap.products.find((p: { slug: string }) => p.slug === 'muesli')!
    const existing = await bySlug('products', 'muesli')
    await payload.delete({ collection: 'products', id: existing.id, ...CTX })
    const report = await seedCatalog(payload, { ...snap, products: snap.products.map((p: typeof muesli) => (p.slug === 'muesli' ? { ...p, inStock: false } : p)) }, opts())
    expect(report.products.created).toBe(1)
    expect((await bySlug('products', 'muesli')).inStock).toBe(false)
    await payload.update({ collection: 'products', id: (await bySlug('products', 'muesli')).id, data: { inStock: true }, ...CTX })
    await seedCatalog(payload, snap, opts())
  })

  it('never overwrites a policy page the owner has edited; recreates one that was deleted', async () => {
    const refunds = await bySlug('pages', 'refunds')
    const edited = '<p>Our own refunds text, still under review.</p>'
    // The owner edits the draft and publishes it in Payload, box unticked (not on the storefront).
    await payload.update({ collection: 'pages', id: refunds.id, data: { bodyHtml: edited, title: 'Returns', _status: 'published' }, ...CTX })
    const grievances = await bySlug('pages', 'grievances')
    await payload.delete({ collection: 'pages', id: grievances.id, ...CTX })

    const report = await seedCatalog(payload, loadCommittedSnapshot(), opts())
    expect(report.drafts).toEqual({ created: 1, kept: 2 })
    expect(report.changed).toBe(true)
    expect(await bySlug('pages', 'refunds')).toMatchObject({ id: refunds.id, title: 'Returns', bodyHtml: edited, _status: 'published', published: false })
    expect(await bySlug('pages', 'grievances')).toMatchObject({ _status: 'draft', published: false, bodyHtml: loadPolicyDrafts().pages[2].bodyHtml })
    await expectRoundTrip()

    // The seed's drafts are never the storefront's: even a file claiming `published: true` (unvalidated) is created unticked.
    const gone = await bySlug('pages', 'grievances')
    await payload.delete({ collection: 'pages', id: gone.id, ...CTX })
    const forged = loadPolicyDrafts()
    forged.pages[2].published = true
    await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), policyDrafts: forged, validateDrafts: undefined })
    expect(await bySlug('pages', 'grievances')).toMatchObject({ _status: 'draft', published: false })
    await expectRoundTrip()
  })

  it('round trip with a storefront page in the snapshot and the drafts present', async () => {
    const drafts = loadPolicyDrafts()
    // What a sync writes once the owner has reviewed and published the shipping policy.
    const withPage = { ...loadCommittedSnapshot(), pages: [reviewedPage(drafts.pages[0])] }
    expect(validateSnapshot(withPage)).toEqual({ ok: true, errors: [] })

    const report = await seedCatalog(payload, withPage, { ...opts(), reset: true })
    expect(report.pages).toEqual({ created: 1, updated: 0, unchanged: 0 })
    // shipping exists (from the snapshot, live), so only refunds and grievances come from the drafts file.
    expect(report.drafts).toEqual({ created: 2, kept: 1 })
    expect(await pageRows()).toEqual([
      ['shipping', 'published', true, 10],
      ['refunds', 'draft', false, 20],
      ['grievances', 'draft', false, 30],
    ])
    await expectRoundTrip(withPage)
    const pub = await restGet('pages', { query: 'limit=100&depth=0' })
    expect(pub.body.docs.map((d: { slug: string }) => d.slug)).toEqual(['shipping'])
    expect(pub.text).not.toMatch(/to be reviewed|to be added/)

    // Idempotent with the page too.
    const before = await fingerprint()
    const again = await seedCatalog(payload, withPage, opts())
    expect(again).toMatchObject({ pages: { created: 0, updated: 0, unchanged: 1 }, drafts: NO_DRAFTS, changed: false })
    expect(await fingerprint()).toEqual(before)

    // A drifted live page is brought back to the snapshot.
    const shipping = await bySlug('pages', 'shipping')
    await payload.update({ collection: 'pages', id: shipping.id, data: { title: 'Shipping (edited)' }, ...CTX })
    expect((await seedCatalog(payload, withPage, opts())).pages).toEqual({ created: 0, updated: 1, unchanged: 0 })
    await expectRoundTrip(withPage)

    // Back to the committed catalog for the rest of the file.
    await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), reset: true })
    await expectRoundTrip()
  })

  it('reorders without tripping the unique sortOrder', async () => {
    const a = await bySlug('products', 'cornflakes')
    const b = await bySlug('products', 'steel-cut-oats')
    // Swap 10 ↔ 20 through a temporary value.
    await payload.update({ collection: 'products', id: a.id, data: { sortOrder: 999 }, ...CTX })
    await payload.update({ collection: 'products', id: b.id, data: { sortOrder: 10 }, ...CTX })
    await payload.update({ collection: 'products', id: a.id, data: { sortOrder: 20 }, ...CTX })
    const r1 = await bySlug('recipes', 'wf-berry-overnight-steel-cut-oats')
    const r2 = await bySlug('recipes', 'wf-warm-health-mix-porridge')
    await payload.update({ collection: 'recipes', id: r1.id, data: { sortOrder: 5000 }, ...CTX })
    await payload.update({ collection: 'recipes', id: r2.id, data: { sortOrder: 10 }, ...CTX })

    const report = await seedCatalog(payload, loadCommittedSnapshot(), opts())
    expect(report.products.updated).toBe(2)
    expect(report.recipes.updated).toBe(2)
    await expectRoundTrip()
  })

  it('leaves products that are not in the snapshot alone; --reset removes them', async () => {
    const extra = await createProduct(payload, { sortOrder: 700 })
    const report = await seedCatalog(payload, loadCommittedSnapshot(), opts())
    expect(report.changed).toBe(false)
    expect(await bySlug('products', extra.slug)).toBeTruthy()

    await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), reset: true })
    expect(await bySlug('products', extra.slug)).toBeUndefined()
    expect((await payload.countVersions({ collection: 'products', where: { parent: { equals: extra.id } }, overrideAccess: true })).totalDocs).toBe(0)
    await expectRoundTrip()
  })

  it('stops before writing anything when a foreign product holds a sortOrder the snapshot needs', async () => {
    const cornflakes = await bySlug('products', 'cornflakes')
    await payload.update({ collection: 'products', id: cornflakes.id, data: { sortOrder: 15 }, ...CTX })
    const squatter = await createProduct(payload, { sortOrder: 10 })
    const before = await fingerprint()
    await expect(seedCatalog(payload, loadCommittedSnapshot(), opts())).rejects.toThrow(new RegExp(`${squatter.slug} has sortOrder 10`))
    expect(await fingerprint()).toEqual(before)
    await payload.delete({ collection: 'products', id: squatter.id, ...CTX })
    await seedCatalog(payload, loadCommittedSnapshot(), opts())
    await expectRoundTrip()
  })

  it('refuses an invalid snapshot without writing anything', async () => {
    const bad = loadCommittedSnapshot()
    bad.products[0].pricePaise = 17550
    ;(bad.products[1] as Record<string, unknown>).stock = 5
    const before = await fingerprint()
    const err = await seedCatalog(payload, bad, opts()).catch((e) => e)
    expect(err).toBeInstanceOf(SeedError)
    expect(err.message).toMatch(/products\[0\]\.pricePaise: must be a multiple of 100/)
    expect(err.message).toMatch(/products\[1\]\.stock: server-only/)
    await expect(seedCatalog(payload, { nope: true } as never, { ...opts(), validate: undefined })).rejects.toThrow(SeedError)
    await expect(seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), stock: -1 })).rejects.toThrow(/stock/)
    // An unreviewed page in the SNAPSHOT (e.g. a hand-edited file) is refused: the snapshot is public.
    const leaky = loadCommittedSnapshot()
    leaky.pages = [{ ...loadPolicyDrafts().pages[0] }]
    const leak = await seedCatalog(payload, leaky, opts()).catch((e) => e)
    expect(leak).toBeInstanceOf(SeedError)
    expect(leak.message).toMatch(/pages\[0\]\.published: must be true/)
    expect(leak.message).toMatch(/pages\[0\]\.bodyHtml: still contains "Draft — to be reviewed"/)
    expect(await fingerprint()).toEqual(before)
  })

  it('refuses an invalid policy drafts file without writing anything', async () => {
    const before = await fingerprint()
    const bad = loadPolicyDrafts()
    bad.pages[0].published = true
    bad.pages[1].slug = 'shipping'
    const err = await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), reset: true, policyDrafts: bad }).catch((e) => e)
    expect(err).toBeInstanceOf(SeedError)
    expect(err.message).toMatch(/policy drafts file is invalid/)
    expect(err.message).toMatch(/pages\[0\]\.published: must be false/)
    expect(err.message).toMatch(/pages\[1\]\.slug: duplicate slug "shipping"/)
    await expect(
      seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), policyDrafts: { version: 1 } as never, validateDrafts: undefined }),
    ).rejects.toThrow(/policy drafts/)
    // Even with --reset nothing was deleted.
    expect(await fingerprint()).toEqual(before)
  })

  it('without policyDrafts (library use) no drafts are created', async () => {
    const report = await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), policyDrafts: undefined, reset: true })
    expect(report.drafts).toEqual({ created: 0, kept: 0 })
    expect(await pageRows()).toEqual([])
    await expectRoundTrip()
    await seedCommittedCatalog(payload)
  })

  it('requests one storefront rebuild when something changed, none when nothing did', async () => {
    const hits: string[] = []
    const server = http.createServer((req, res) => {
      hits.push(req.method ?? '')
      res.writeHead(201).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const saved = process.env.VERCEL_DEPLOY_HOOK_URL
    process.env.VERCEL_DEPLOY_HOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
    try {
      await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), deployHook: true })
      expect(hits).toEqual([]) // in sync: nothing to rebuild
      // A recreated policy draft is not on the storefront: written, but no rebuild.
      const refunds = await bySlug('pages', 'refunds')
      await payload.delete({ collection: 'pages', id: refunds.id, ...CTX })
      const drafted = await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), deployHook: true })
      expect(drafted).toMatchObject({ drafts: { created: 1, kept: 2 }, changed: true })
      expect(hits).toEqual([])
      const doc = await bySlug('products', 'health-mix')
      await payload.update({ collection: 'products', id: doc.id, data: { calories: 1 }, ...CTX })
      await seedCatalog(payload, loadCommittedSnapshot(), { ...opts(), deployHook: true })
      expect(hits).toEqual(['POST']) // once, immediately, not per document
    } finally {
      process.env.VERCEL_DEPLOY_HOOK_URL = saved ?? ''
      await new Promise((r) => server.close(r))
    }
  })
})

describe('seedAdmin', () => {
  it('creates an admin once (generated password works), never touches an existing user', async () => {
    const email = uniqueEmail('seed-admin')
    const first = await seedAdmin(payload, { email: email.toUpperCase() })
    expect(first).toMatchObject({ email, created: true, generated: true })
    expect(first.password!.length).toBeGreaterThanOrEqual(20)
    const login = await restPost('users/login', { body: { email, password: first.password }, origin: STOREFRONT_ORIGIN })
    expect(login.status).toBe(200)
    expect(login.body.user.role).toBe('admin')

    const again = await seedAdmin(payload, { email, password: 'Another-Passw0rd!' })
    expect(again).toEqual({ email, created: false })
    expect((await restPost('users/login', { body: { email, password: first.password }, origin: STOREFRONT_ORIGIN })).status).toBe(200)

    const chosen = await seedAdmin(payload, { email: uniqueEmail('seed-admin2'), password: 'Chosen-Passw0rd!' })
    expect(chosen).toMatchObject({ created: true, generated: false, password: 'Chosen-Passw0rd!' })
  })
})

describe('npm run seed (CLI)', () => {
  const cms = path.resolve(__dirname, '../..')
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        path.join(cms, 'node_modules/.bin/tsx'),
        ['src/seed/index.ts', ...args],
        { cwd: cms, env: { ...process.env, PAYLOAD_LOG_LEVEL: 'fatal', ...env }, timeout: 240_000 },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
      )
    })

  it('seeds the test database idempotently from the committed files', { timeout: 300_000 }, async () => {
    const res = await run(['--no-admin'])
    expect(res.out).toMatch(/seed: done — nothing changed/)
    expect(res.out).toMatch(/products\s+0 created, 0 updated, 6 unchanged/)
    expect(res.out).toMatch(/drafts\s+0 created, 3 kept/)
    expect(res.code).toBe(0)
  })

  it('creates a missing policy draft from the default file; --no-drafts skips them', { timeout: 300_000 }, async () => {
    const refunds = await bySlug('pages', 'refunds')
    await payload.delete({ collection: 'pages', id: refunds.id, ...CTX })
    const skipped = await run(['--no-admin', '--no-drafts'])
    expect(skipped.code).toBe(0)
    expect(skipped.out).toMatch(/drafts\s+0 created, 0 kept/)
    expect(await bySlug('pages', 'refunds')).toBeUndefined()
    const res = await run(['--no-admin'])
    expect(res.code).toBe(0)
    expect(res.out).toMatch(/created draft refunds/)
    expect(res.out).toMatch(/drafts\s+1 created, 2 kept/)
    expect(await bySlug('pages', 'refunds')).toMatchObject({ _status: 'draft', published: false })
    await expectRoundTrip()
  })

  it('rejects bad options and --reset in production', { timeout: 300_000 }, async () => {
    const bad = await run(['--stock=lots'])
    expect(bad.code).toBe(1)
    expect(bad.out).toMatch(/--stock needs a whole number/)
    const prod = await run(['--reset', '--no-admin'], { APP_ENV: 'production' })
    expect(prod.code).toBe(1)
    expect(prod.out).toMatch(/refused in production/)
    const missing = await run(['--no-admin', '--drafts=does-not-exist.json'])
    expect(missing.code).toBe(1)
    expect(missing.out).toMatch(/--drafts: .*does-not-exist\.json not found/)
    expect((await payload.count({ collection: 'products', overrideAccess: true })).totalDocs).toBe(6)
    expect((await payload.count({ collection: 'pages', overrideAccess: true })).totalDocs).toBe(3)
  })
})
