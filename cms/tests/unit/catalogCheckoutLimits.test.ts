import fs from 'fs'
import path from 'path'
import type { PayloadRequest } from 'payload'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

import { Products } from '@/collections/Products'
import { quote } from '@/commerce/shared/pricing.js'
import { isSlug } from '@/commerce/shared/validate.js'
import {
  checkPricePaise,
  checkProductSlug,
  fillSlugAndSortOrder,
  guardSlug,
  MAX_UNIT_PAISE,
  requiredToPublish,
  SLUG_MAX,
  SLUG_RE,
  truncateSlug,
} from '@/endpoints/catalog/rules'

import * as storefront from '../../../src/lib/data/snapshot-schema.js'

/**
 * The CMS never publishes a product the checkout can't sell (hunt r4 long-slug-unsellable): the product slug
 * is the cart key, capped at SLUG_MAX by $shared/validate.js isSlug, and a unit price above MAX_UNIT_PAISE is
 * UNAVAILABLE in $shared/pricing.js. Both limits come from the shared modules, so they can't drift.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url))
const committed = () => JSON.parse(fs.readFileSync(path.resolve(dirname, '../../../src/lib/data/cms-snapshot.json'), 'utf8'))
const published = { data: { _status: 'published' } }
const ok = (r: true | string) => r === true
const long = (n: number) => Array.from({ length: n }, (_, i) => 'abcdefgh'[i % 8]).join('')

describe('product slug ≤ SLUG_MAX', () => {
  const samples = ['cornflakes', 'a', 'a-b', '9-lives', long(63), long(64), long(65), `${long(59)}-abcd`, `${long(59)}-abcde`, 'Bad', 'a--b', '-a', '']

  it('the CMS accepts exactly the slugs checkout accepts (and never one the sync rejects)', () => {
    expect(SLUG_MAX).toBe(64)
    for (const v of samples) {
      const cms = ok(requiredToPublish(checkProductSlug)(v, published))
      expect(cms, `${v.length}: ${v}`).toBe(isSlug(v))
      if (cms) {
        const s = committed()
        s.products[0].slug = v
        s.products[0].goesWith = []
        for (const p of s.products) p.goesWith = (p.goesWith ?? []).filter((g: string) => g !== 'cornflakes')
        for (const r of s.recipes) r.products = r.products.filter((x: { slug: string }) => x.slug !== 'cornflakes')
        expect(storefront.validateSnapshot(s).ok, v).toBe(true)
      }
    }
    expect(requiredToPublish(checkProductSlug)(long(65), published)).toMatch(/64 characters or fewer/)
  })

  it('the Products slug field uses the capped rule', () => {
    const field = Products.fields.find((f) => (f as { name?: string }).name === 'slug') as unknown as {
      validate: (value: unknown, args: unknown) => true | string
    }
    expect(field.validate(long(64), published)).toBe(true)
    expect(field.validate(long(65), published)).toMatch(/64 characters/)
  })

  it('guardSlug refuses an over-long slug on create (drafts too), and keeps other collections uncapped by default', () => {
    const guard = guardSlug('products', SLUG_RE, 'bad slug', [], SLUG_MAX)
    const run = (g: typeof guard, slug: string) =>
      g({ data: { slug, _status: 'draft' }, operation: 'create', req: {} as PayloadRequest } as never)
    expect(() => run(guard, long(64))).not.toThrow()
    expect(() => run(guard, long(65))).toThrow()
    expect(() => run(guardSlug('pages', SLUG_RE, 'bad slug'), long(65))).not.toThrow()
  })

  it('truncateSlug cuts at a hyphen and always returns a valid slug', () => {
    expect(truncateSlug('short')).toBe('short')
    expect(truncateSlug(`${long(59)}-abcd`)).toBe(`${long(59)}-abcd`) // exactly 64
    expect(truncateSlug(`${long(59)}-abcde`)).toBe(long(59))
    expect(truncateSlug(`${long(55)}-abc-defghijk`)).toBe(`${long(55)}-abc`)
    expect(truncateSlug(`wf-${long(80)}`)).toBe(`wf-${long(61)}`) // not just "wf"
    expect(truncateSlug(long(80))).toBe(long(64))
    expect(truncateSlug('aa-bb-cc', 5)).toBe('aa-bb')
    expect(truncateSlug('aa-bb-cc', 6)).toBe('aa-bb')
    for (const n of [1, 2, 5, 17, 40, 64]) {
      const s = truncateSlug('wefeasto-crunchy-muesli-with-real-almonds-honey-and-raisins-family-pack-muim0ym4', n)
      expect(s.length).toBeLessThanOrEqual(n)
      expect(SLUG_RE.test(s), s).toBe(true)
    }
  })

  it('a slug made from a long product name is a sellable cart key', async () => {
    const hook = fillSlugAndSortOrder('products', 'name')
    const req = { payload: { find: async () => ({ docs: [{ sortOrder: 40 }] }) } } as unknown as PayloadRequest
    const data = await hook({
      data: { name: 'Wefeasto Crunchy Muesli with Real Almonds Honey and Raisins Family Pack muim0ym4' },
      operation: 'create',
      req,
    } as never)
    expect(data!.slug).toBe('wefeasto-crunchy-muesli-with-real-almonds-honey-and-raisins')
    expect(isSlug(data!.slug)).toBe(true)
    expect(data!.sortOrder).toBe(50)
    // Recipes keep their prefix and the cap.
    const r = await fillSlugAndSortOrder('recipes', 'title', 'wf-')({ data: { title: long(90), sortOrder: 1 }, operation: 'create', req } as never)
    expect(r!.slug).toBe(`wf-${long(61)}`)
  })
})

describe('product price ≤ MAX_UNIT_PAISE', () => {
  const item = (pricePaise: number) => ({ slug: 'x', name: 'X', pricePaise, published: true })

  it('the CMS accepts a price exactly when checkout would sell it', () => {
    for (const v of [100, 17500, MAX_UNIT_PAISE - 100, MAX_UNIT_PAISE, MAX_UNIT_PAISE + 100, 1_000_000_100, 2 ** 40]) {
      const cms = ok(requiredToPublish(checkPricePaise)(v, published))
      const q = quote({ items: [{ slug: 'x', qty: 1 }], catalog: [item(v)], settings: { maxOrderPaise: Number.MAX_SAFE_INTEGER } } as never) as {
        lines: unknown[]
      }
      expect(cms, String(v)).toBe(q.lines.length === 1)
    }
    expect(checkPricePaise(1_000_000_100, published)).toMatch(/at most ₹1,00,00,000/)
  })
})
