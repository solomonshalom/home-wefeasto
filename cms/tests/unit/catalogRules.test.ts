import fs from 'fs'
import path from 'path'
import type { CollectionConfig, Field, GlobalConfig, PayloadRequest } from 'payload'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

import { Pages } from '@/collections/Pages'
import { Products } from '@/collections/Products'
import { Recipes } from '@/collections/Recipes'
import { PUBLIC_SETTINGS_DEFAULTS, SERVER_SETTINGS_DEFAULTS } from '@/commerce/settings'
import {
  allOf,
  checkHomeAlt,
  checkHttpsUrl,
  checkImagePath,
  checkPricePaise,
  checkRating,
  checkRecipeSlug,
  checkRefList,
  checkReviewed,
  checkSlug,
  checkStringList,
  daysPerPackFrom,
  E164_RE,
  EMAIL_RE,
  FSSAI_RE,
  GSTIN_RE,
  integerIn,
  livePageWhere,
  nullableText,
  PATH_OR_URL_RE,
  PRODUCT_CATEGORIES,
  RATING_STYLES,
  RECIPE_CATEGORIES,
  RECIPE_COLORS,
  RECIPE_ICONS,
  requiredToPublish,
  safeHtml,
  slugify,
  UNREVIEWED_TEXT_RE,
} from '@/endpoints/catalog/rules'
import { StoreSettings } from '@/globals/StoreSettings'
import { deployHookAfterChange, deployHookAfterDelete, deployHookGlobalAfterChange } from '@/hooks/deployHook'

import * as storefront from '../../../src/lib/data/snapshot-schema.js'

/**
 * The CMS input rules must accept exactly what the storefront snapshot validator accepts (the sync refuses
 * anything else), and the collections must mirror the snapshot field for field. (cms-catalog)
 */

const dirname = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_FILE = path.resolve(dirname, '../../../src/lib/data/cms-snapshot.json')
const DRAFTS_FILE = path.resolve(dirname, '../../../src/lib/data/policy-drafts.server.json')
const committed = () => JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))
/** policy-drafts.server.json: the unpublished policy pages (the snapshot's pages[] is empty until one is reviewed). */
const drafts = () => JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8'))
/** A storefront page (published: true) with this title and body, the way it would sit in the snapshot. */
const withPage = (title: string, bodyHtml: string) => (s: any) => {
  s.pages = [{ slug: 'shipping', title, bodyHtml, published: true }]
}
const validAfter = (mutate: (s: any) => void) => {
  const s = committed()
  mutate(s)
  return storefront.validateSnapshot(s).ok
}
const published = { data: { _status: 'published' }, siblingData: {} }
const draft = { data: { _status: 'draft' }, siblingData: {} }
const ok = (r: true | string) => r === true

/** Replace a string value everywhere in the snapshot (renaming a slug and every reference to it). */
function renameEverywhere(node: any, from: string, to: string): any {
  if (node === from) return to
  if (Array.isArray(node)) return node.map((n) => renameEverywhere(n, from, to))
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renameEverywhere(v, from, to)]))
  return node
}

describe('constants match the storefront schema', () => {
  it('categories, colours, rating styles', () => {
    expect([...PRODUCT_CATEGORIES]).toEqual(storefront.PRODUCT_CATEGORIES)
    expect([...RECIPE_CATEGORIES]).toEqual(storefront.RECIPE_CATEGORIES)
    expect(RECIPE_COLORS).toEqual(storefront.RECIPE_COLORS)
    expect([...RATING_STYLES]).toEqual(storefront.RATING_STYLES)
  })

  it('the unreviewed-text marker (Draft line, [to be added]) is the same pattern', () => {
    expect(UNREVIEWED_TEXT_RE.source).toBe(storefront.UNREVIEWED_TEXT_RE.source)
    expect(UNREVIEWED_TEXT_RE.flags).toBe(storefront.UNREVIEWED_TEXT_RE.flags)
  })

  it('every colour and icon used by the committed snapshot is selectable', () => {
    const s = committed()
    for (const r of s.recipes) {
      expect(RECIPE_COLORS).toContain(r.tagColor)
      expect(RECIPE_COLORS).toContain(r.iconColor)
      expect(RECIPE_ICONS).toContain(r.iconSrc)
    }
  })

  it('the site background / ink hexes are not recipe colours (the snapshot validator rejects them)', () => {
    for (const hex of ['#f9f4ef', '#fff6e7', '#ffdede', '#fffdfa', '#333333']) {
      expect(RECIPE_COLORS).not.toContain(hex)
      expect(validAfter((s) => (s.recipes[0].tagColor = hex))).toBe(false)
    }
  })
})

describe('validators agree with validateSnapshot()', () => {
  it('product slugs', () => {
    for (const v of ['cornflakes', 'a', 'a-b', 'a1-b2-c3', '9-lives', 'Bad', 'a--b', '-a', 'a-', 'a_b', 'bäd', 'a b', ' a', '']) {
      const cms = ok(requiredToPublish(checkSlug)(v, published))
      const sync = (() => {
        const s = renameEverywhere(committed(), 'cornflakes', v)
        return storefront.validateSnapshot(s).ok
      })()
      expect(cms, JSON.stringify(v)).toBe(sync)
    }
  })

  it('recipe slugs: the CMS is stricter (wf- prefix) but never accepts what the sync rejects', () => {
    for (const v of ['wf-a', 'wf-oats-2', 'oats', 'wf-', 'wf--a', 'WF-a', 'wf_a', 'wf-a-']) {
      if (ok(checkRecipeSlug(v, published))) {
        expect(storefront.validateSnapshot(renameEverywhere(committed(), 'wf-banana-oat-pancakes', v)).ok, v).toBe(true)
      }
    }
    expect(ok(checkRecipeSlug('oats', published))).toBe(false)
    expect(storefront.validateSnapshot(renameEverywhere(committed(), 'wf-banana-oat-pancakes', 'oats')).ok).toBe(true)
  })

  it('image paths', () => {
    for (const v of ['/images/x.jpg', '/', 'https://cdn.example/y.jpg', 'https://', '//cdn/x', 'http://x/y', 'images/x.jpg', '/a b', '', ' ']) {
      expect(ok(checkImagePath(v, published)), JSON.stringify(v)).toBe(validAfter((s) => (s.products[0].image = v)))
    }
  })

  it('marketplace links', () => {
    for (const v of ['https://amazon.in/x', 'http://amazon.in/x', 'https://', 'amazon.in', 'https://a b']) {
      expect(ok(checkHttpsUrl(v, published)), v).toBe(validAfter((s) => (s.products[0].partners[0].url = v)))
    }
  })

  it('prices', () => {
    for (const v of [17500, 100, 200, 17550, 99, 50, 0, -100, 175.5, Number.NaN, Infinity, '17500', null]) {
      expect(ok(requiredToPublish(checkPricePaise)(v, published)), String(v)).toBe(validAfter((s) => (s.products[0].pricePaise = v)))
    }
  })

  it('ratings', () => {
    for (const v of [5, 4.3, 0, 1.1, 2.7, 4.25, 5.5, -1, 0.05, '4', Number.NaN]) {
      expect(ok(requiredToPublish(checkRating)(v, published)), String(v)).toBe(validAfter((s) => (s.products[0].rating = v)))
    }
  })

  it('integers (calories, sortOrder, maxPerOrder, pack weights)', () => {
    for (const v of [0, 1, 120, -1, 1.5, '3']) {
      expect(ok(integerIn(0)(v, published)), `calories ${v}`).toBe(validAfter((s) => (s.products[0].calories = v)))
      expect(ok(integerIn(1)(v, published)), `maxPerOrder ${v}`).toBe(validAfter((s) => (s.products[0].maxPerOrder = v)))
    }
  })

  it('search terms / allergens', () => {
    for (const v of [[], ['a'], ['a', 'b c'], ['a', ''], [' '], null]) {
      const sync = validAfter((s) => (s.products[0].searchTerms = v ?? []))
      expect(ok(checkStringList(v, published)), JSON.stringify(v)).toBe(sync)
    }
  })

  it('HTML sections', () => {
    const samples = [
      '<p>Fine</p>',
      '<h2>What you’ll need</h2><ul role="list"><li><a href="/products/muesli">Muesli</a></li></ul>',
      '<script>alert(1)</script>',
      '<SCRIPT src=x>',
      '< iframe src=x>',
      '<object>',
      '<embed>',
      '<style>p{}</style>',
      '<link rel=x>',
      '<meta http-equiv=x>',
      '<base href=x>',
      '<form>',
      '<p onclick="x()">x</p>',
      '<img src=x onerror=alert(1)>',
      '<p>onion=1</p>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JavaScript:x">x</a>',
      '<a href="data:text/html,x">x</a>',
      '<p>scripted</p>',
      // Handlers after "/" or a closing quote, and javascript: spelled with character references / tab / LF.
      '<svg/onload=alert(1)>',
      '<details/open/ontoggle=alert(1)>',
      '<img src="x"onerror="alert(1)">',
      "<img src='x'/onerror=alert(1)>",
      '<a href="jav&#x61;script:alert(1)">x</a>',
      '<a href="&#0000106;avascript:x">x</a>',
      '<a href="javascript&colon;x">x</a>',
      '<a href="javascript&#58;x">x</a>',
      '<a href="java&#x09;script:x">x</a>',
      '<a href="java&Tab;script:x">x</a>',
      '<a href="java\tscript:x">x</a>',
      '<a href="java\r\nscript:x">x</a>',
      '<a href="JaVa&#X53;cRiPt:x">x</a>',
      // Upper-case letters as references (schemes are case-insensitive): &#74; / &#x4A; are "J".
      '<a href="&#74;avascript:x">x</a>',
      '<a href="&#x4A;avascript:x">x</a>',
      '<a href="jav&#65;script:x">x</a>',
      '<a href="JAV&#x41;SCRIPT:x">x</a>',
      '<a href="&#00074;&#x41;&#86;&#65;&#x53;&#67;&#82;&#73;&#80;&#84;:x">x</a>',
      // Still fine: a link, text mentioning "online" / "onion", an entity-bearing heading.
      '<p>Order online. <a href="https://wefeasto.com/shop">Shop</a> — onion optional.</p>',
      '<h2>What you&#39;ll need</h2><p>Java &amp; script: two words.</p>',
    ]
    for (const v of samples) {
      expect(ok(safeHtml(v, published)), v).toBe(validAfter((s) => (s.recipes[0].whyHtml = v)))
    }
  })

  it('HTML gate verdicts: obfuscated handlers and javascript: URLs are refused, ordinary markup is kept', () => {
    const refused = [
      '<svg/onload=alert(1)>',
      '<details/open/ontoggle=alert(1)>',
      '<img src="x"onerror="alert(1)">',
      '<a href="jav&#x61;script:alert(1)">x</a>',
      '<a href="&#0000106;avascript:x">x</a>',
      '<a href="javascript&colon;x">x</a>',
      '<a href="java&#x09;script:x">x</a>',
      '<a href="java&NewLine;script:x">x</a>',
      '<a href="java\nscript:x">x</a>',
      '<svg><a xlink:href="javascript:x"><text>x</text></a></svg>',
      '<a href="&#74;avascript:x">x</a>',
      '<a href="&#x4a;avascript:x">x</a>',
      '<a href="java&#83;cript:x">x</a>',
      '<a href="JAVASCRIPT&#58;x">x</a>',
    ]
    for (const v of refused) expect(safeHtml(`<p>Soak.</p>${v}`, published), v).not.toBe(true)
    const kept = [
      '<p>Order online. <a href="https://wefeasto.com/shop">Shop</a> — onion optional.</p>',
      '<h2>What you&#39;ll need</h2><p>Java &amp; script: two words.</p>',
      '<ul role="list"><li><a href="/products/steel-cut-oats">Oats</a></li></ul>',
    ]
    for (const v of kept) expect(safeHtml(v, published), v).toBe(true)
  })

  it('storefront pages: title and body may not carry the Draft line or a [to be added] placeholder', () => {
    const live = { data: { _status: 'published' }, siblingData: { published: true } }
    const samples = [
      'Shipping Policy',
      '<p>Draft — to be reviewed by Wefeasto before publishing.</p>',
      '<p><strong>Draft — to be reviewed by Wefeasto before publishing.</strong></p><h2>Where we deliver</h2>',
      'draft - to be reviewed',
      'DRAFT–TO BE REVIEWED',
      'Draft ——  to be reviewed',
      'Name: [to be added]',
      '[ To Be Added ]',
      '[to be added ]',
      'Draft policy, reviewed by the owner',
      'to be reviewed',
      'to be added',
      '[added]',
      '<p>Our draft beer — to be reviewed? No.</p>',
    ]
    for (const v of samples) {
      const titleSync = validAfter(withPage(v, '<p>Reviewed.</p>'))
      const bodySync = validAfter(withPage('Shipping Policy', v))
      expect(ok(requiredToPublish(checkReviewed)(v, live)), `title ${v}`).toBe(titleSync)
      expect(ok(requiredToPublish(allOf(safeHtml, checkReviewed))(v, live)), `body ${v}`).toBe(bodySync)
    }
  })

  it('the unreviewed-text rule applies only to pages shown on the storefront, and not to draft saves', () => {
    const text = '<p><strong>Draft — to be reviewed by Wefeasto before publishing.</strong></p>'
    expect(checkReviewed(text, { data: { _status: 'published' }, siblingData: { published: true } })).toMatch(/Draft — to be reviewed/)
    expect(checkReviewed(text, { data: { _status: 'published' }, siblingData: { published: false } })).toBe(true)
    expect(checkReviewed(text, { data: { _status: 'published' }, siblingData: {} })).toBe(true)
    expect(checkReviewed(text, { data: { _status: 'draft' }, siblingData: { published: true } })).toBe(true)
    expect(checkReviewed(null, { data: { _status: 'published' }, siblingData: { published: true } })).toBe(true)
    // The snapshot never carries a page that is not shown: the validator refuses published:false outright.
    expect(validAfter((s) => (s.pages = [{ slug: 'shipping', title: 'Shipping', bodyHtml: '<p>Fine</p>', published: false }]))).toBe(false)
  })

  it('every committed policy draft is refused as a storefront page until the owner reviews it', () => {
    const live = { data: { _status: 'published' }, siblingData: { published: true } }
    const d = drafts()
    expect(storefront.validatePolicyDrafts(d)).toEqual({ ok: true, errors: [] })
    expect(d.pages.map((p: { slug: string }) => p.slug)).toEqual(['shipping', 'refunds', 'grievances'])
    for (const page of d.pages) {
      expect(page.published, page.slug).toBe(false)
      expect(checkReviewed(page.bodyHtml, live), page.slug).not.toBe(true)
      expect(validAfter((s) => (s.pages = [{ ...page, published: true }])), page.slug).toBe(false)
      // Reviewed (Draft line gone, placeholders filled), it is a valid storefront page on both sides.
      const bodyHtml = page.bodyHtml
        .replace(/<p><strong>Draft\s*[—–-]+\s*to be reviewed[^<]*<\/strong><\/p>/, '')
        .replace(/\[\s*to be added\s*\]/gi, 'Wefeasto Foods')
      expect(checkReviewed(bodyHtml, live), page.slug).toBe(true)
      expect(safeHtml(bodyHtml, live), page.slug).toBe(true)
      expect(validAfter((s) => (s.pages = [{ ...page, bodyHtml, published: true }])), page.slug).toBe(true)
    }
  })

  it('homeAlt is required while featured (products and recipes)', () => {
    for (const [featured, alt] of [
      [true, null],
      [true, ''],
      [true, 'Bowl'],
      [false, null],
    ] as const) {
      const cms = ok(checkHomeAlt(alt, { data: { _status: 'published' }, siblingData: { homeFeatured: featured } }))
      // The snapshot stores blank as null (nullableText), exactly what the endpoint emits.
      expect(cms, `${featured} ${alt}`).toBe(
        validAfter((s) => {
          s.products[0].homeFeatured = featured
          s.products[0].homeAlt = nullableText(alt)
        }),
      )
    }
  })

  it('settings patterns', () => {
    const table: [RegExp, (s: any, v: string) => void, string[]][] = [
      [FSSAI_RE, (s, v) => (s.settings.legal.fssaiLicence = v), ['12345678901234', '1234567890123', '123456789012345', 'abcdefghijklmn']],
      [GSTIN_RE, (s, v) => (s.settings.legal.gstin = v), ['29ABCDE1234F1Z5', '29abcde1234f1z5', '29ABCDE1234F0Z5', '29ABCDE1234F1X5']],
      [E164_RE, (s, v) => (s.settings.supportWhatsappE164 = v), ['+919845262777', '919845262777', '+0123456789', '+1234567']],
      [EMAIL_RE, (s, v) => (s.settings.legal.grievanceOfficer.email = v), ['a@b.co', 'a@b', 'a b@c.d', '@b.co']],
      [PATH_OR_URL_RE, (s, v) => (s.settings.announcement.href = v), ['/shop', 'https://x.y', '//evil', 'http://x.y', 'shop']],
    ]
    for (const [re, set, values] of table) {
      for (const v of values) expect(re.test(v), `${re} ${v}`).toBe(validAfter((s) => set(s, v)))
      expect(validAfter((s) => set(s, '')), `${re} ''`).toBe(true) // every one of these may be empty
    }
  })
})

describe('draft-aware validation', () => {
  it('required-to-publish fields may be blank in a draft; formats are still checked', () => {
    const check = requiredToPublish(checkSlug)
    expect(check('', published)).toMatch(/required/i)
    expect(check(null, published)).toMatch(/required/i)
    expect(check('', draft)).toBe(true)
    expect(check(undefined, draft)).toBe(true)
    expect(check('Bad Slug', draft)).not.toBe(true)
    expect(checkImagePath('', draft)).toBe(true)
    expect(checkImagePath('', { ...published, siblingData: { imageUpload: 3 } })).toBe(true)
    expect(checkImagePath('', { ...published, siblingData: { imageUpload: { id: 3 } } })).toBe(true)
    expect(checkImagePath('', published)).not.toBe(true)
  })

  it('relationship lists: no self, no duplicates', () => {
    const check = checkRefList('products')
    expect(check([1, 2], { id: 3 })).toBe(true)
    expect(check([{ id: 1 }, 2], { id: 3 })).toBe(true)
    expect(check(null, {})).toBe(true)
    expect(check([1, 3], { id: 3 })).toMatch(/itself/)
    expect(check([1, { id: 1 }], { id: 3 })).toMatch(/once/)
  })
})

describe('helpers', () => {
  it('slugify', () => {
    expect(slugify("Choco's Flakes!")).toBe('chocos-flakes')
    expect(slugify('  Crème Brûlée & Oats ')).toBe('creme-brulee-and-oats')
    expect(slugify('Masala   Oats -- Upma')).toBe('masala-oats-upma')
    expect(slugify('')).toBe('')
    expect(slugify(null)).toBe('')
    for (const s of ['Hello World', 'x', 'Ünïcödé 2']) expect(SLUG_OK(slugify(s))).toBe(true)
  })

  it('nullableText', () => {
    expect(nullableText(null)).toBeNull()
    expect(nullableText(undefined)).toBeNull()
    expect(nullableText('')).toBeNull()
    expect(nullableText(' \n ')).toBeNull()
    expect(nullableText(' 500 g ')).toBe(' 500 g ')
    expect(nullableText(5)).toBeNull()
  })

  it('daysPerPackFrom reproduces the committed values', () => {
    for (const p of committed().products) expect(daysPerPackFrom(p.packGrams, p.servingGrams), p.slug).toBe(p.daysPerPack)
    expect(daysPerPackFrom(10, 400)).toBe(1) // never 0
    expect(daysPerPackFrom(0, 30)).toBeNull()
    expect(daysPerPackFrom(500, 0)).toBeNull()
    expect(daysPerPackFrom(500.5, 30)).toBeNull()
  })
})
const SLUG_OK = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)

/* ------------------------------------------------------------ configs */

type Named = Field & { name: string; access?: Record<string, (a: unknown) => unknown>; unique?: boolean; options?: unknown[]; defaultValue?: unknown }
function flatten(fields: Field[]): Named[] {
  const out: Named[] = []
  for (const f of fields) {
    if ('name' in f && f.name) out.push(f as Named)
    if ('fields' in f && Array.isArray(f.fields) && !('name' in f && f.name)) out.push(...flatten(f.fields as Field[]))
    if (f.type === 'tabs') for (const t of f.tabs) out.push(...flatten(t.fields))
  }
  return out
}
const fieldOf = (c: { fields: Field[] }, name: string) => flatten(c.fields).find((f) => f.name === name)
const subFields = (f: Named | undefined) => flatten(((f as { fields?: Field[] })?.fields ?? []) as Field[]).map((x) => x.name)
const optionValues = (f: Named | undefined) => (f?.options ?? []).map((o) => (typeof o === 'string' ? o : (o as { value: string }).value))
const reqAs = (user: unknown) => ({ req: { user, headers: new Headers() } as unknown as PayloadRequest })
const admin = { id: 1, collection: 'users', role: 'admin' }
const editor = { id: 2, collection: 'users', role: 'editor' }
const customer = { id: 1, collection: 'customers' }

describe('collections mirror the snapshot', () => {
  const s = committed()

  it('products: a field for every snapshot key (facts as a group)', () => {
    for (const key of Object.keys(s.products[0])) expect(fieldOf(Products, key), key).toBeTruthy()
    expect(subFields(fieldOf(Products, 'facts')).sort()).toEqual(Object.keys(s.products[0].facts).sort())
    expect(subFields(fieldOf(Products, 'partners')).sort()).toEqual(['name', 'url'])
    expect(optionValues(fieldOf(Products, 'category'))).toEqual([...PRODUCT_CATEGORIES])
    for (const name of ['stock', 'lowStockThreshold', 'imageUpload']) expect(fieldOf(Products, name), name).toBeTruthy()
  })

  it('recipes: a field for every snapshot key; product rows reference products', () => {
    for (const key of Object.keys(s.recipes[0])) expect(fieldOf(Recipes, key), key).toBeTruthy()
    expect(subFields(fieldOf(Recipes, 'products')).sort()).toEqual(['alt', 'product', 'ratingStyle'])
    expect(subFields(fieldOf(Recipes, 'extras')).sort()).toEqual(['reason', 'title'])
    expect(subFields(fieldOf(Recipes, 'recommended')).sort()).toEqual(['reason', 'title'])
    expect(optionValues(fieldOf(Recipes, 'tagColor'))).toEqual(RECIPE_COLORS)
    expect(optionValues(fieldOf(Recipes, 'iconColor'))).toEqual(RECIPE_COLORS)
    expect(optionValues(fieldOf(Recipes, 'iconSrc'))).toEqual(RECIPE_ICONS)
    expect(optionValues(fieldOf(Recipes, 'category'))).toEqual([...RECIPE_CATEGORIES])
    for (const name of ['ingredientsHtml', 'directionsHtml', 'whyHtml']) expect(fieldOf(Recipes, name)?.type, name).toBe('code')
  })

  it('pages: slug, title, bodyHtml (verbatim code field), published', () => {
    // The committed snapshot has no pages until one is reviewed; the drafts file has the same page shape.
    expect(s.pages).toEqual([])
    const page = drafts().pages[0]
    expect(Object.keys(page)).toEqual(['slug', 'title', 'bodyHtml', 'published'])
    for (const key of Object.keys(page)) expect(fieldOf(Pages, key), key).toBeTruthy()
    expect(fieldOf(Pages, 'bodyHtml')?.type).toBe('code')
    expect(fieldOf(Pages, 'published')?.type).toBe('checkbox')
    expect(fieldOf(Pages, 'published')?.defaultValue).toBe(false)
  })

  it('pages: customers and guests read only storefront pages (published + "Show on the storefront")', () => {
    const where = { and: [{ _status: { equals: 'published' } }, { published: { equals: true } }] }
    expect(livePageWhere()).toEqual(where)
    expect(livePageWhere()).not.toBe(livePageWhere()) // fresh object: Payload combines it into its query
    for (const u of [customer, null]) expect(Pages.access!.read!(reqAs(u) as never)).toEqual(where)
    for (const u of [admin, editor]) expect(Pages.access!.read!(reqAs(u) as never)).toBe(true)
  })

  it('drafts, staff-only versions, unique slugs and sort orders, admin sorted by sortOrder', () => {
    for (const c of [Products, Recipes, Pages] as CollectionConfig[]) {
      expect(c.versions, c.slug).toMatchObject({ drafts: true })
      expect(c.access!.readVersions!(reqAs(customer) as never), c.slug).toBe(false)
      expect(c.access!.readVersions!(reqAs(null) as never), c.slug).toBe(false)
      expect(c.access!.readVersions!(reqAs(editor) as never), c.slug).toBe(true)
      for (const op of ['create', 'update', 'delete'] as const) {
        expect([admin, editor, customer, null].map((u) => c.access![op]!(reqAs(u) as never)), `${c.slug} ${op}`).toEqual([true, true, false, false])
      }
      if (c.slug !== 'pages') expect(c.access!.read!(reqAs(customer) as never), c.slug).toEqual({ _status: { equals: 'published' } })
      expect(c.access!.read!(reqAs(editor) as never), c.slug).toBe(true)
      expect(fieldOf(c, 'slug')?.unique, c.slug).toBe(true)
      expect(c.defaultSort, c.slug).toBe('sortOrder')
      expect(c.hooks?.afterChange, c.slug).toContain(deployHookAfterChange)
      expect(c.hooks?.afterDelete, c.slug).toContain(deployHookAfterDelete)
    }
    expect(fieldOf(Products, 'sortOrder')?.unique).toBe(true)
    expect(fieldOf(Recipes, 'sortOrder')?.unique).toBe(true)
  })

  it('stock and lowStockThreshold are readable by staff only', () => {
    for (const name of ['stock', 'lowStockThreshold']) {
      const f = fieldOf(Products, name)!
      expect([admin, editor, customer, null].map((u) => f.access?.read?.(reqAs(u))), name).toEqual([true, true, false, false])
    }
    // Everything the snapshot publishes stays publicly readable.
    for (const key of Object.keys(s.products[0])) expect(fieldOf(Products, key)?.access?.read, key).toBeUndefined()
  })
})

describe('store-settings global', () => {
  const g = StoreSettings as GlobalConfig

  /** Rebuild the default document from the field tree (groups → nested objects). */
  function defaults(fields: Field[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of flattenTop(fields)) {
      if (f.type === 'group') out[f.name] = defaults((f as { fields: Field[] }).fields)
      else if (f.type !== 'ui') out[f.name] = (f as { defaultValue?: unknown }).defaultValue
    }
    return out
  }
  function flattenTop(fields: Field[]): Named[] {
    const out: Named[] = []
    for (const f of fields) {
      if ('name' in f && f.name) out.push(f as Named)
      else if (f.type === 'tabs') for (const t of f.tabs) out.push(...flattenTop(t.fields))
      else if ('fields' in f && Array.isArray(f.fields)) out.push(...flattenTop(f.fields as Field[]))
    }
    return out
  }

  it('has every public and server-only key, with the canonical defaults', () => {
    expect(defaults(g.fields)).toEqual({ ...PUBLIC_SETTINGS_DEFAULTS, ...SERVER_SETTINGS_DEFAULTS })
    expect(defaults(g.fields)).toEqual({ ...storefront.PUBLIC_SETTINGS_DEFAULTS, ...storefront.SERVER_ONLY_SETTINGS_DEFAULTS })
  })

  it('rebuilds the storefront on change', () => {
    expect(g.hooks?.afterChange).toContain(deployHookGlobalAfterChange)
  })
})
