import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createProduct,
  createRecipe,
  loadPolicyDrafts,
  productData,
  recipeData,
  restoreStoreSettings,
  reviewedPage,
  seedCommittedCatalog,
  validateSnapshot,
} from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPatch, restPost, type RestResult } from './helpers/rest'

/**
 * Input rules on products / recipes / pages / store-settings: whatever an editor can publish must be a
 * valid snapshot (sync-cms refuses invalid ones), slugs are immutable, drafts may be incomplete. (cms-catalog)
 */

let payload: Payload
let editorToken: string
let adminToken: string

const CTX = { context: { skipDeployHook: true } }
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function bySlug(collection: 'products' | 'recipes' | 'pages', slug: string) {
  const res = await payload.find({ collection, where: { slug: { equals: slug } }, limit: 1, depth: 0, overrideAccess: true, draft: true })
  return res.docs[0] as Record<string, any>
}

/** A 400 ValidationError naming `path`. */
function expectInvalid(res: RestResult, path: string) {
  expect(res.status, `${path}: ${res.text}`).toBe(400)
  const paths = (res.body?.errors ?? []).flatMap((e: { data?: { errors?: { path: string }[] } }) => (e.data?.errors ?? []).map((x) => x.path))
  expect(paths, res.text).toContain(path)
}

const post = (collection: string, body: Record<string, unknown>, query?: string) =>
  restPost(collection, { token: editorToken, body, ...(query ? { query } : {}) })

beforeAll(async () => {
  payload = await getTestPayload()
  await seedCommittedCatalog(payload)
  editorToken = (await login('users', (await createStaff(payload, 'editor')).email)).token
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
})

afterAll(async () => {
  // Leave the catalog and settings exactly as seeded for whichever spec runs next.
  await seedCommittedCatalog(payload)
  await restoreStoreSettings(payload)
})

describe('slugs', () => {
  it('cannot be changed after create (REST and Local API); resending the same slug is fine', async () => {
    const doc = await bySlug('products', 'muesli')
    expectInvalid(await restPatch(`products/${doc.id}`, { token: editorToken, body: { slug: 'muesli-2' } }), 'slug')
    expect((await bySlug('products', 'muesli')).id).toBe(doc.id)
    await expect(payload.update({ collection: 'products', id: doc.id, data: { slug: 'granola' }, ...CTX })).rejects.toThrow(/slug/i)
    const same = await restPatch(`products/${doc.id}`, { token: editorToken, body: { slug: 'muesli', calories: doc.calories } })
    expect(same.status).toBe(200)

    const recipe = await bySlug('recipes', 'wf-banana-oat-pancakes')
    expectInvalid(await restPatch(`recipes/${recipe.id}`, { token: editorToken, body: { slug: 'wf-pancakes' } }), 'slug')
    const page = await bySlug('pages', 'refunds')
    expectInvalid(await restPatch(`pages/${page.id}`, { token: editorToken, body: { slug: 'returns' } }), 'slug')
  })

  it('are immutable on drafts too', async () => {
    const draft = await createProduct(payload, {}, { draft: true })
    await expect(
      payload.update({ collection: 'products', id: draft.id, data: { slug: `${draft.slug}-x` }, draft: true, ...CTX }),
    ).rejects.toThrow(/slug/i)
  })

  it('must be lower-case kebab-case and unique', async () => {
    for (const bad of ['Bad Slug', 'bad--slug', '-bad', 'bad-', 'bäd', 'bad_slug', 'BAD']) {
      expectInvalid(await post('products', productData({ slug: bad, _status: 'published' })), 'slug')
    }
    // Even as a draft: the slug is fixed at create, so a bad one could never be published.
    expectInvalid(await post('products', { name: 'Draft', slug: 'Bad Slug' }, 'draft=true'), 'slug')
    expectInvalid(await post('products', productData({ slug: 'cornflakes', _status: 'published' })), 'slug')
  })

  it('are made from the name / title when left empty; recipe slugs always start with wf-', async () => {
    const p = await post('products', { ...productData({ name: 'Nutty Crunch Granola!' }), slug: undefined, _status: 'published' })
    expect(p.status, p.text).toBe(201)
    expect(p.body.doc.slug).toBe('nutty-crunch-granola')

    const r = await post('recipes', { ...recipeData({ title: 'Masala Oats Upma' }), slug: undefined, _status: 'published' })
    expect(r.status, r.text).toBe(201)
    expect(r.body.doc.slug).toBe('wf-masala-oats-upma')

    expectInvalid(await post('recipes', recipeData({ slug: 'masala-oats', _status: 'published' })), 'slug')
    await payload.delete({ collection: 'products', id: p.body.doc.id, ...CTX })
    await payload.delete({ collection: 'recipes', id: r.body.doc.id, ...CTX })
  })
})

describe('publishing requires a complete, snapshot-valid product', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['price not in whole rupees', { pricePaise: 17550 }, 'pricePaise'],
    ['price below ₹1', { pricePaise: 50 }, 'pricePaise'],
    ['fractional paise', { pricePaise: 175.5 }, 'pricePaise'],
    ['missing price', { pricePaise: null }, 'pricePaise'],
    ['rating with two decimals', { rating: 4.25 }, 'rating'],
    ['rating above 5', { rating: 5.5 }, 'rating'],
    ['unknown category', { category: 'Cereal' }, 'category'],
    ['blank name', { name: '   ' }, 'name'],
    ['missing description', { description: null }, 'description'],
    ['home card without alt text', { homeFeatured: true, homeAlt: '' }, 'homeAlt'],
    ['marketplace link over http', { partners: [{ name: 'Shop', url: 'http://shop.example/x' }] }, 'partners.0.url'],
    ['protocol-relative image', { image: '//cdn.example/x.jpg' }, 'image'],
    ['no image at all', { image: '' }, 'image'],
    ['empty search term', { searchTerms: ['oats', ' '] }, 'searchTerms'],
    ['negative stock', { stock: -1 }, 'stock'],
    ['fractional stock', { stock: 1.5 }, 'stock'],
    ['maxPerOrder 0', { maxPerOrder: 0 }, 'maxPerOrder'],
    ['negative sortOrder', { sortOrder: -10 }, 'sortOrder'],
    ['calories not whole', { calories: 12.5 }, 'calories'],
    ['packGrams 0', { packGrams: 0 }, 'packGrams'],
  ]
  for (const [label, override, path] of cases) {
    it(label, async () => expectInvalid(await post('products', productData({ ...override, _status: 'published' })), path))
  }

  it('sortOrder must be unique', async () => {
    expectInvalid(await post('products', productData({ sortOrder: 10, _status: 'published' })), 'sortOrder')
  })

  it('goesWith cannot list the product itself or the same product twice', async () => {
    const doc = await bySlug('products', 'rolled-oats')
    const other = await bySlug('products', 'muesli')
    expectInvalid(await restPatch(`products/${doc.id}`, { token: editorToken, body: { goesWith: [doc.id] } }), 'goesWith')
    expectInvalid(await restPatch(`products/${doc.id}`, { token: editorToken, body: { goesWith: [other.id, other.id] } }), 'goesWith')
  })

  it('a valid product publishes and keeps the snapshot valid', async () => {
    const res = await post('products', productData({ _status: 'published' }))
    expect(res.status, res.text).toBe(201)
    const snap = (await restGet('store/snapshot')).body
    expect(snap.products.at(-1).slug).toBe(res.body.doc.slug)
    expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
    await payload.delete({ collection: 'products', id: res.body.doc.id, ...CTX })
  })
})

describe('drafts may be incomplete', () => {
  it('saves a bare draft, refuses to publish it until complete', async () => {
    const draft = await post('products', { name: 'Half-done Flakes' }, 'draft=true')
    expect(draft.status, draft.text).toBe(201)
    expect(draft.body.doc).toMatchObject({ slug: 'half-done-flakes', _status: 'draft' })
    expect(Number.isInteger(draft.body.doc.sortOrder)).toBe(true)
    // A REST create that only marks the body as draft behaves the same.
    const marked = await post('products', { name: 'Marked Draft', _status: 'draft' })
    expect(marked.status, marked.text).toBe(201)

    const publish = await restPatch(`products/${draft.body.doc.id}`, { token: editorToken, body: { _status: 'published' } })
    expect(publish.status).toBe(400)
    const complete = productData({ name: 'Half-done Flakes', slug: 'half-done-flakes' })
    delete complete.stock
    const ok = await restPatch(`products/${draft.body.doc.id}`, { token: editorToken, body: { ...complete, _status: 'published' } })
    expect(ok.status, ok.text).toBe(200)
    expect((await restGet('store/catalog')).body.products.map((p: { slug: string }) => p.slug)).toContain('half-done-flakes')

    await payload.delete({ collection: 'products', id: draft.body.doc.id, ...CTX })
    await payload.delete({ collection: 'products', id: marked.body.doc.id, ...CTX })
  })
})

describe('products: computed defaults', () => {
  it('fills daysPerPack from the pack and serving weights when left empty; keeps an explicit value', async () => {
    const auto = await createProduct(payload, { packGrams: 1000, servingGrams: 40 })
    expect(auto.daysPerPack).toBe(31) // round(1000 / 40 / 0.8)
    const manual = await createProduct(payload, { packGrams: 1000, servingGrams: 40, daysPerPack: 7 })
    expect(manual.daysPerPack).toBe(7)
    const unknown = await createProduct(payload, { packGrams: null, servingGrams: 30 })
    expect(unknown.daysPerPack).toBeNull()
    for (const p of [auto, manual, unknown]) await payload.delete({ collection: 'products', id: p.id, ...CTX })
  })

  it('an uploaded image overrides the image path in the snapshot', async () => {
    const media = await payload.create({
      collection: 'media',
      data: { alt: 'Test bowl' },
      file: { data: PNG_1PX, mimetype: 'image/png', name: `bowl-${Date.now()}.png`, size: PNG_1PX.length },
    })
    const product = await createProduct(payload, { imageUpload: media.id, image: '' })
    try {
      const snap = (await restGet('store/snapshot')).body
      const row = snap.products.find((p: { slug: string }) => p.slug === product.slug)
      expect(row.image).toBe(`/api/media/file/${media.filename}`)
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
    } finally {
      await payload.delete({ collection: 'products', id: product.id, ...CTX })
      await payload.delete({ collection: 'media', id: media.id })
    }
  })
})

describe('recipes', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['a colour outside the recipe palette', { tagColor: '#f9f4ef' }, 'tagColor'],
    ['an ink colour', { iconColor: '#333333' }, 'iconColor'],
    ['an unknown icon', { iconSrc: '/images/other.svg' }, 'iconSrc'],
    ['unknown category', { category: 'Lunch' }, 'category'],
    ['script in the HTML', { directionsHtml: '<p>Hi</p><script>alert(1)</script>' }, 'directionsHtml'],
    ['an event handler in the HTML', { ingredientsHtml: '<ul><li onclick="x()">Oats</li></ul>' }, 'ingredientsHtml'],
    ['a javascript: link', { whyHtml: '<a href="javascript:alert(1)">x</a>' }, 'whyHtml'],
    ['an inline style block', { whyHtml: '<style>body{}</style>' }, 'whyHtml'],
    ['empty HTML', { whyHtml: '' }, 'whyHtml'],
    ['home card without alt text', { homeFeatured: true, homeAlt: null }, 'homeAlt'],
    ['an extra without a reason', { extras: [{ title: 'Spoon', reason: '' }] }, 'extras.0.reason'],
  ]
  for (const [label, override, path] of cases) {
    it(`rejects ${label}`, async () => expectInvalid(await post('recipes', recipeData({ ...override, _status: 'published' })), path))
  }

  it('accepts every legacy colour spelling used by the snapshot', async () => {
    const r = await post('recipes', recipeData({ tagColor: 'hsla(141, 70.74%, 51.53%, 1.00)', iconColor: '#d498eb', _status: 'published' }))
    expect(r.status, r.text).toBe(201)
    await payload.delete({ collection: 'recipes', id: r.body.doc.id, ...CTX })
  })

  it('stores the HTML sections byte for byte', async () => {
    const html = '<h2>What you’ll need</h2>\n<ul role="list">\r\n  <li>1&nbsp;cup <a href="/products/muesli">Muesli</a> &amp; curd</li>\t</ul>  '
    const r = await createRecipe(payload, { ingredientsHtml: html })
    expect((await payload.findByID({ collection: 'recipes', id: r.id })).ingredientsHtml).toBe(html)
    const snap = (await restGet('store/snapshot')).body
    expect(snap.recipes.find((x: { slug: string }) => x.slug === r.slug).ingredientsHtml).toBe(html)
    await payload.delete({ collection: 'recipes', id: r.id, ...CTX })
  })

  it('lists each product once and cannot relate a recipe to itself', async () => {
    const muesli = await bySlug('products', 'muesli')
    expectInvalid(
      await post('recipes', recipeData({ products: [{ product: muesli.id }, { product: muesli.id }], _status: 'published' })),
      'products',
    )
    const doc = await bySlug('recipes', 'wf-savoury-masala-oats')
    expectInvalid(await restPatch(`recipes/${doc.id}`, { token: editorToken, body: { related: [doc.id] } }), 'related')
  })
})

describe('pages', () => {
  const DRAFT_LINE = '<p><strong>Draft — to be reviewed by Wefeasto before publishing.</strong></p>'
  const created: (number | string)[] = []
  afterEach(async () => {
    for (const id of created.splice(0)) await payload.delete({ collection: 'pages', id, ...CTX })
  })

  it('reject unsafe HTML; a page reaches the snapshot only with "Show on the storefront" ticked', async () => {
    expectInvalid(await post('pages', { slug: 'x-page', title: 'X', bodyHtml: '<form action="/x"></form>', _status: 'published' }), 'bodyHtml')
    const page = await post('pages', { title: 'Terms of Sale', bodyHtml: '<p>Terms</p>', _status: 'published' })
    expect(page.status, page.text).toBe(201)
    created.push(page.body.doc.id)
    expect(page.body.doc).toMatchObject({ slug: 'terms-of-sale', published: false, _status: 'published' })
    expect((await restGet('store/snapshot')).body.pages).toEqual([]) // published in Payload, but not shown

    const shown = await restPatch(`pages/${page.body.doc.id}`, { token: editorToken, body: { published: true } })
    expect(shown.status, shown.text).toBe(200)
    const snap = (await restGet('store/snapshot')).body
    expect(snap.pages).toEqual([{ slug: 'terms-of-sale', title: 'Terms of Sale', bodyHtml: '<p>Terms</p>', published: true }])
    expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
    expect((await restPatch(`pages/${page.body.doc.id}`, { token: editorToken, body: { published: false } })).status).toBe(200)
  })

  it('a page shown on the storefront may not keep the Draft line or a [to be added] placeholder', async () => {
    const live = { slug: `live-${Date.now()}`, title: 'Delivery', bodyHtml: '<p>Reviewed.</p>', published: true, _status: 'published' }
    expectInvalid(await post('pages', { ...live, bodyHtml: `${DRAFT_LINE}<p>Text</p>` }), 'bodyHtml')
    expectInvalid(await post('pages', { ...live, bodyHtml: '<p>GSTIN: [to be added]</p>' }), 'bodyHtml')
    expectInvalid(await post('pages', { ...live, bodyHtml: '<p>draft - To Be Reviewed</p>' }), 'bodyHtml')
    expectInvalid(await post('pages', { ...live, title: 'Grievances [to be added]' }), 'title')
    const ok = await post('pages', live)
    expect(ok.status, ok.text).toBe(201)
    created.push(ok.body.doc.id)
    // Editing the live page back to unreviewed text is refused too.
    expectInvalid(await restPatch(`pages/${ok.body.doc.id}`, { token: editorToken, body: { bodyHtml: `${DRAFT_LINE}<p>x</p>` } }), 'bodyHtml')
    expect((await restGet(`pages/${ok.body.doc.id}`)).body.bodyHtml).toBe('<p>Reviewed.</p>')
  })

  it('a seeded policy draft cannot be put live as it is; reviewed, it can', async () => {
    const doc = await bySlug('pages', 'grievances')
    const original = loadPolicyDrafts().pages[2]
    expect(doc).toMatchObject({ _status: 'draft', published: false, bodyHtml: original.bodyHtml })
    try {
      // Ticking the box and publishing: refused. The text is not in the request; the stored text is checked.
      expectInvalid(await restPatch(`pages/${doc.id}`, { token: editorToken, body: { published: true, _status: 'published' } }), 'bodyHtml')
      // Ticking the box while the page stays a draft is fine: drafts never go live …
      for (const query of ['draft=true', undefined]) {
        const ticked = await restPatch(`pages/${doc.id}`, { token: editorToken, body: { published: true }, ...(query ? { query } : {}) })
        expect(ticked.status, ticked.text).toBe(200)
        expect(ticked.body.doc).toMatchObject({ _status: 'draft', published: true })
        expect((await restGet('store/snapshot')).body.pages).toEqual([])
        expect((await restGet(`pages/${doc.id}`)).status).toBe(404)
      }
      // … but publishing it (box already ticked) is refused while the text is unreviewed.
      expectInvalid(await restPatch(`pages/${doc.id}`, { token: editorToken, body: { _status: 'published' } }), 'bodyHtml')
      // Removing only the Draft line is not enough: the grievance officer is still "[to be added]".
      const halfDone = original.bodyHtml.replace(DRAFT_LINE, '')
      expect(halfDone).not.toBe(original.bodyHtml)
      expectInvalid(
        await restPatch(`pages/${doc.id}`, { token: editorToken, body: { bodyHtml: halfDone, published: true, _status: 'published' } }),
        'bodyHtml',
      )
      expect((await restGet('store/snapshot')).body.pages).toEqual([])
      // Publishing it unticked is fine (still staff-only).
      const unticked = await restPatch(`pages/${doc.id}`, { token: editorToken, body: { published: false, _status: 'published' } })
      expect(unticked.status, unticked.text).toBe(200)
      expect(unticked.body.doc).toMatchObject({ _status: 'published', published: false })
      expect((await restGet('store/snapshot')).body.pages).toEqual([])
      expect((await restGet(`pages/${doc.id}`)).status).toBe(404)

      const reviewed = reviewedPage(original)
      const live = await restPatch(`pages/${doc.id}`, {
        token: editorToken,
        body: { bodyHtml: reviewed.bodyHtml, published: true, _status: 'published' },
      })
      expect(live.status, live.text).toBe(200)
      const snap = (await restGet('store/snapshot')).body
      expect(snap.pages).toStrictEqual([reviewed])
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
    } finally {
      await payload.update({ collection: 'pages', id: doc.id, data: { ...original, _status: 'draft' } as never, ...CTX })
    }
  })
})

describe('store settings validation (matches the snapshot validator)', () => {
  const save = (body: Record<string, unknown>) => restPost('globals/store-settings', { token: adminToken, body })
  afterAll(() => restoreStoreSettings(payload))

  const bad: [string, Record<string, unknown>, string][] = [
    ['FSSAI not 14 digits', { legal: { fssaiLicence: '1234' } }, 'legal.fssaiLicence'],
    ['malformed GSTIN', { legal: { gstin: '29ABCDE1234F1X5' } }, 'legal.gstin'],
    ['WhatsApp without +country code', { supportWhatsappE164: '98452 62777' }, 'supportWhatsappE164'],
    ['grievance email', { legal: { grievanceOfficer: { email: 'not-an-email' } } }, 'legal.grievanceOfficer.email'],
    ['announcement on with no text', { announcement: { enabled: true, text: '  ' } }, 'announcement.text'],
    ['protocol-relative announcement link', { announcement: { href: '//evil.example' } }, 'announcement.href'],
    ['http announcement link', { announcement: { href: 'http://example.com' } }, 'announcement.href'],
    ['announcement too long', { announcement: { text: 'x'.repeat(141) } }, 'announcement.text'],
    ['welcome percent 0', { welcomeOffer: { percent: 0 } }, 'welcomeOffer.percent'],
    ['welcome percent 101', { welcomeOffer: { percent: 101 } }, 'welcomeOffer.percent'],
    ['welcome validity over 10 years', { welcomeOffer: { validDays: 4000 } }, 'welcomeOffer.validDays'],
    ['maxOrderPaise 0', { maxOrderPaise: 0 }, 'maxOrderPaise'],
    ['reservation over a day', { reservationMinutes: 2000 }, 'reservationMinutes'],
  ]
  for (const [label, body, path] of bad) {
    it(`rejects ${label}`, async () => expectInvalid(await save(body), path))
  }

  it('normalises identifiers and stores cleared text as "" (never falls back to the default)', async () => {
    const res = await save({
      legal: { fssaiLicence: '1234 5678 9012 34', gstin: ' 29abcde1234f1z5 ', grievanceOfficer: { email: ' grievance@wefeasto.com ' } },
      supportWhatsappE164: '+91 98452-62777',
      announcement: { enabled: true, text: 'Free delivery this weekend', href: 'https://wefeasto.com/shop' },
      shippingPromiseText: null,
    })
    expect(res.status, res.text).toBe(200)
    const snap = (await restGet('store/snapshot')).body
    expect(snap.settings.legal).toMatchObject({ fssaiLicence: '12345678901234', gstin: '29ABCDE1234F1Z5' })
    expect(snap.settings.legal.grievanceOfficer.email).toBe('grievance@wefeasto.com')
    expect(snap.settings.supportWhatsappE164).toBe('+919845262777')
    expect(snap.settings.shippingPromiseText).toBe('')
    expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })

    const cleared = await save({ supportWhatsappE164: '', announcement: { enabled: false, text: '', href: '' } })
    expect(cleared.status, cleared.text).toBe(200)
    expect((await restGet('store/catalog')).body.settings.supportWhatsappE164).toBe('')
  })
})
