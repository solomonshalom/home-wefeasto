import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

import {
  effectiveInStock,
  isLivePage,
  lowStockOf,
  refMap,
  resolveImage,
  serializePage,
  serializeProduct,
  serializeRecipe,
  slugRefs,
  toLiveCatalogRow,
  toServerCatalogItem,
  type Snapshot,
} from '@/endpoints/catalog/serialize'
import { pageData, productData, recipeData } from '@/seed/seedCatalog'

import { validateSnapshot } from '../../../src/lib/data/snapshot-schema.js'

/** Payload doc ⇄ snapshot mapping without a database. (cms-catalog) */

const dirname = path.dirname(fileURLToPath(import.meta.url))
const committed = (): Snapshot => JSON.parse(fs.readFileSync(path.resolve(dirname, '../../../src/lib/data/cms-snapshot.json'), 'utf8'))
const policyDrafts = (): { pages: Snapshot['pages'] } =>
  JSON.parse(fs.readFileSync(path.resolve(dirname, '../../../src/lib/data/policy-drafts.server.json'), 'utf8'))
/** A reviewed storefront page (what the owner publishes once the Draft line and placeholders are gone). */
const livePage = { slug: 'terms-of-sale', title: 'Terms of Sale', bodyHtml: '<h2>Orders</h2><p>We accept UPI, cards and COD.</p>', published: true }

/** Fake Payload docs from a snapshot through the seed's own mapping (ids 1…n, rows get ids like Payload). */
function fakeDocs(s: Snapshot) {
  const products = new Map<string, Record<string, any>>()
  s.products.forEach((p, i) => products.set(p.slug, { id: i + 1 }))
  const recipes = new Map<string, Record<string, any>>()
  s.recipes.forEach((r, i) => recipes.set(r.slug, { id: 100 + i }))
  const withRowIds = (rows: Record<string, unknown>[]) => rows.map((r, i) => ({ ...r, id: `row${i}` }))
  const productDocs = s.products.map((p) => {
    const d = productData(p, products)
    return { ...d, id: products.get(p.slug)!.id, partners: withRowIds(d.partners), _status: 'published', stock: 100, lowStockThreshold: 5, createdAt: 'x', updatedAt: 'y' }
  })
  const recipeDocs = s.recipes.map((r) => {
    const d = recipeData(r, products, recipes)
    return { ...d, id: recipes.get(r.slug)!.id, products: withRowIds(d.products), extras: withRowIds(d.extras), _status: 'published' }
  })
  const pageDocs = s.pages.map((p, i) => ({ ...pageData(p, (i + 1) * 10), id: i + 1, _status: 'published' }))
  return { productDocs, recipeDocs, pageDocs }
}

describe('seed mapping and serializer are inverses', () => {
  it('snapshot → Payload data → snapshot is exact (key order included)', () => {
    const s = committed()
    const { productDocs, recipeDocs, pageDocs } = fakeDocs(s)
    const refs = { products: refMap(productDocs), recipes: refMap(recipeDocs) }
    const out = {
      ...s,
      products: productDocs.map((d) => serializeProduct(d, { refs })),
      recipes: recipeDocs.map((d) => serializeRecipe(d, { refs })),
      pages: pageDocs.map(serializePage),
    }
    expect(out).toStrictEqual(s)
    expect(JSON.stringify(out)).toBe(JSON.stringify(s))
    expect(validateSnapshot(out).ok).toBe(true)
  })

  it('pages: only storefront pages are serialised, and they round-trip exactly', () => {
    const s = { ...committed(), pages: [livePage] }
    const drafts = policyDrafts().pages
    // What the CMS holds after `npm run seed` + the owner publishing one page: the seeded drafts (Payload
    // drafts, published:false), a draft published without the storefront box, and the live page.
    const docs = [
      ...drafts.map((p, i) => ({ ...pageData(p, (i + 1) * 10), id: i + 1, _status: 'draft' })),
      { ...pageData({ ...drafts[0], slug: 'faq' }, 40), id: 4, _status: 'published', published: false },
      { ...pageData({ ...livePage, published: true }, 50), id: 5, _status: 'draft' }, // box ticked, not published
      { ...pageData(livePage, 60), id: 6, _status: 'published', createdAt: 'x', updatedAt: 'y' },
    ]
    const pages = docs.filter(isLivePage).map(serializePage)
    expect(pages).toStrictEqual([livePage])
    expect(JSON.stringify(pages)).toBe(JSON.stringify(s.pages))
    expect(validateSnapshot({ ...s, pages }).ok).toBe(true)
    // Were the filter missing, the snapshot would carry the drafts and the sync would refuse it.
    expect(validateSnapshot({ ...s, pages: docs.map(serializePage) }).ok).toBe(false)
  })

  it('isLivePage: Payload-published AND "Show on the storefront"', () => {
    expect(isLivePage({ _status: 'published', published: true })).toBe(true)
    for (const doc of [
      { _status: 'published', published: false },
      { _status: 'published', published: null },
      { _status: 'published' },
      { _status: 'published', published: 'true' },
      { _status: 'draft', published: true },
      { published: true },
      null,
      undefined,
    ]) {
      expect(isLivePage(doc as never), JSON.stringify(doc)).toBe(false)
    }
  })

  it('the Payload data never carries snapshot-only shapes (relationships become ids)', () => {
    const s = committed()
    const products = new Map(s.products.map((p, i) => [p.slug, { id: i + 1 }]))
    const d = productData(s.products[0], products)
    expect(d.goesWith).toEqual([2, 4, 5])
    const r = recipeData(s.recipes[3], products, new Map(s.recipes.map((x, i) => [x.slug, { id: 100 + i }])))
    expect(r.products).toEqual([{ product: 6, alt: 'Wefeasto Health Mix multigrain porridge in a bowl', ratingStyle: 'plain' }])
    expect(r.related).toEqual([104, 105, 100])
  })
})

describe('serializeProduct normalisation', () => {
  const refs = { products: new Map([['1', 'a'], ['2', 'b'], ['3', 'c']]), recipes: new Map() }
  const base = { id: 1, slug: 'a', name: 'A', sortOrder: 10, category: 'Oats', pricePaise: 100, maxPerOrder: 10, calories: 1, rating: 4, description: 'd', image: '/x.jpg', heroAlt: 'h', shopAlt: 's', recipesHeading: 'r' }

  it('nullable strings: null / undefined / whitespace → null, other text untouched', () => {
    const p = serializeProduct({ ...base, packSize: '  ', ratingSource: undefined, homeAlt: ' Bowl ', facts: { netQuantity: '', ingredients: 'Oats ', manufacturer: null } }, { refs })
    expect(p.packSize).toBeNull()
    expect(p.ratingSource).toBeNull()
    expect(p.homeAlt).toBe(' Bowl ')
    expect(p.facts).toEqual({ netQuantity: null, ingredients: 'Oats ', allergens: [], bestBefore: null, manufacturer: null, countryOfOrigin: null })
  })

  it('lists: missing → [], row ids dropped; booleans are real booleans', () => {
    const p = serializeProduct({ ...base, partners: [{ id: 'x', name: 'N', url: 'https://n' }], searchTerms: null, homeFeatured: null, inStock: null, codAllowed: undefined }, { refs })
    expect(p.partners).toEqual([{ name: 'N', url: 'https://n' }])
    expect(p.searchTerms).toEqual([])
    expect(p.homeFeatured).toBe(false)
    expect(p.inStock).toBe(true) // default "available for sale"
    expect(p.codAllowed).toBe(true)
    expect(serializeProduct({ ...base, inStock: false, codAllowed: false }, { refs })).toMatchObject({ inStock: false, codAllowed: false })
  })

  it('relationships → slugs in stored order; unknown (unpublished), duplicate and self references dropped', () => {
    expect(slugRefs([3, { id: 2 }, 99, 3, 1], refs.products, 'a')).toEqual(['c', 'b'])
    expect(serializeProduct({ ...base, goesWith: [2, 1, 99, 2, 3] }, { refs }).goesWith).toEqual(['b', 'c'])
    const r = serializeRecipe(
      { slug: 'wf-x', products: [{ product: 9 }, { product: 2, alt: '', ratingStyle: 'plain' }, { product: { id: 2 } }, { product: 3, ratingStyle: 'weird' }], related: null },
      { refs },
    )
    expect(r.products).toEqual([
      { slug: 'b', alt: null, ratingStyle: 'plain' },
      { slug: 'c', alt: null, ratingStyle: 'decimal' },
    ])
    expect(r.related).toEqual([])
  })

  it('published inStock can be overridden (stock-aware) and image resolved', () => {
    const p = serializeProduct({ ...base, inStock: true, stock: 0 }, { refs, inStock: effectiveInStock, image: () => '/api/media/file/x.png' })
    expect(p.inStock).toBe(false)
    expect(p.image).toBe('/api/media/file/x.png')
    expect(Object.keys(p)).not.toContain('stock')
  })
})

describe('resolveImage', () => {
  const media = new Map<string, { url?: string | null }>([
    ['1', { url: 'http://localhost:3000/api/media/file/a.png' }],
    ['2', { url: '/api/media/file/b.png' }],
    ['3', { url: 'https://blob.vercel-storage.com/c.png' }],
    ['4', { url: 'http://elsewhere.example/d.png' }],
    ['5', { url: null }],
    ['6', { url: '//cdn/e.png' }],
  ])
  const doc = (imageUpload: unknown) => ({ image: '/images/path.jpg', imageUpload })
  it.each([
    [null, '/images/path.jpg'],
    [1, '/api/media/file/a.png'],
    [{ id: 1, url: 'ignored' }, '/api/media/file/a.png'],
    [2, '/api/media/file/b.png'],
    [3, 'https://blob.vercel-storage.com/c.png'],
    [4, '/images/path.jpg'],
    [5, '/images/path.jpg'],
    [6, '/images/path.jpg'],
    [99, '/images/path.jpg'],
  ])('upload %j → %s', (upload, expected) => {
    expect(resolveImage(doc(upload), media, 'http://localhost:3000/')).toBe(expected)
  })
})

describe('live catalog rows', () => {
  const doc = (over: Record<string, unknown>) => ({ id: 7, slug: 'oats', name: 'Oats', pricePaise: 24900, maxPerOrder: 10, codAllowed: true, inStock: true, stock: 100, lowStockThreshold: 5, ...over })
  it.each([
    [{ stock: 100 }, true, null],
    [{ stock: 6 }, true, null],
    [{ stock: 5 }, true, 5],
    [{ stock: 1 }, true, 1],
    [{ stock: 0 }, false, null],
    [{ stock: null }, false, null],
    [{ stock: -3 }, false, null],
    [{ stock: 2, lowStockThreshold: 0 }, true, null],
    [{ stock: 2, lowStockThreshold: null }, true, null],
    [{ stock: 50, inStock: false }, false, null],
    [{ stock: 2, inStock: false }, false, null],
    [{ stock: 3, inStock: null }, true, 3],
  ])('%j → inStock %s, lowStock %s', (over, inStock, lowStock) => {
    const row = toLiveCatalogRow(doc(over))
    expect(row).toEqual({ slug: 'oats', name: 'Oats', pricePaise: 24900, inStock, lowStock, maxPerOrder: 10, codAllowed: true })
    expect(Object.keys(row)).toEqual(['slug', 'name', 'pricePaise', 'inStock', 'lowStock', 'maxPerOrder', 'codAllowed'])
    expect(effectiveInStock(doc(over))).toBe(inStock)
    expect(lowStockOf(doc(over))).toBe(lowStock)
  })

  it('server items add the exact stock, threshold, image and id', () => {
    expect(toServerCatalogItem(doc({ stock: 3, codAllowed: false }), '/img.jpg')).toEqual({
      slug: 'oats',
      name: 'Oats',
      pricePaise: 24900,
      inStock: true,
      lowStock: 3,
      maxPerOrder: 10,
      codAllowed: false,
      id: 7,
      stock: 3,
      lowStockThreshold: 5,
      image: '/img.jpg',
    })
  })
})
