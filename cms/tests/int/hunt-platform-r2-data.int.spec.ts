import { commitTransaction, initTransaction, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { lockRow } from '@/commerce/checkout/db'
import { evaluateCoupon } from '@/commerce/shared/coupons.js'
import type { Coupon, Subscriber } from '@/payload-types'
import { ensureWelcomeCoupon } from '@/retention/welcome'

import { createProduct, restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'
import { restGet, restPatch, restPost } from './helpers/rest'

/**
 * Hunt round 2 (cms-platform, data): coupon usedCount lost to a stale whole-document save, a REST stock
 * adjustment unpublishing a product that has a draft, a ₹0 welcome cap, and money settings that are not
 * whole rupees.
 */

let payload: Payload
let adminToken: string
let editorToken: string
const code = () => `R2${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`
const bump = (id: number, req?: Awaited<ReturnType<typeof makeReq>>) =>
  payload.db.updateOne({ collection: 'coupons', where: { id: { equals: id } }, data: { usedCount: { $inc: 1 } }, options: { atomic: true }, ...(req ? { req } : {}) })
const usedCount = async (id: number) => ((await payload.findByID({ collection: 'coupons', id, depth: 0 })) as Coupon).usedCount

beforeAll(async () => {
  payload = await getTestPayload()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
  editorToken = (await login('users', (await createStaff(payload, 'editor')).email)).token
})

afterAll(async () => {
  await restoreStoreSettings(payload)
})

describe('coupon usedCount is server-owned', () => {
  it('a save echoing a stale doc (admin form / REST) keeps the paid use; usedCount itself cannot be written', async () => {
    const created = await restPost('coupons', { token: adminToken, body: { code: code(), type: 'fixed', value: 1000, usageLimit: 1 } })
    expect(created.status).toBe(201)
    const loaded = (await restGet(`coupons/${created.body.doc.id}`, { token: adminToken, query: 'depth=0' })).body
    expect(loaded.usedCount).toBe(0)
    await bump(loaded.id) // markPaid's consumeRedemption
    const saved = await restPatch(`coupons/${loaded.id}`, { token: adminToken, body: { ...loaded, note: 'extended' } })
    expect(saved.status).toBe(200)
    expect(saved.body.doc).toMatchObject({ note: 'extended', usedCount: 1 })
    expect((await restPatch(`coupons/${loaded.id}`, { token: adminToken, body: { usedCount: 0 } })).status).toBe(200)
    expect(await usedCount(loaded.id)).toBe(1)
  })

  it('an admin save overlapping a payment waits for it (row lock) instead of writing the old count back', async () => {
    const c = (await payload.create({ collection: 'coupons', data: { code: code(), type: 'fixed', value: 1000, usageLimit: 5, usedCount: 1 } })) as Coupon
    const loaded = (await restGet(`coupons/${c.id}`, { token: adminToken, query: 'depth=0' })).body
    const req = await makeReq()
    await initTransaction(req)
    await lockRow(req, 'coupons', c.id) // a checkout transaction marking an order paid
    const save = restPatch(`coupons/${c.id}`, { token: adminToken, body: { ...loaded, note: 'during a payment' } })
    await new Promise((r) => setTimeout(r, 300))
    await bump(c.id, req)
    await commitTransaction(req)
    expect((await save).status).toBe(200)
    expect(await usedCount(c.id)).toBe(2)
  })
})

describe('a save without draft / _status never unpublishes a product with a pending draft', () => {
  it('stockAdjust applies to the live row and keeps it published at its published price', async () => {
    const p = await createProduct(payload, { pricePaise: 20000, stock: 20 })
    const draft = await restPatch(`products/${p.id}`, { token: editorToken, query: 'draft=true&depth=0', body: { pricePaise: 26000, _status: 'draft' } })
    expect(draft.status).toBe(200)

    const adj = await restPatch(`products/${p.id}`, { token: editorToken, query: 'depth=0', body: { stockAdjust: 5 } })
    expect(adj.status).toBe(200)
    const live = await payload.findByID({ collection: 'products', id: p.id, depth: 0 })
    expect(live).toMatchObject({ _status: 'published', pricePaise: 20000, stock: 25 })
    const onSale = (await restGet('store/catalog')).body.products.find((x: { slug: string }) => x.slug === p.slug)
    expect(onSale).toMatchObject({ pricePaise: 20000, inStock: true })
    // The draft is still there, with the new stock.
    const latest = await payload.findByID({ collection: 'products', id: p.id, depth: 0, draft: true })
    expect(latest).toMatchObject({ pricePaise: 26000, stock: 25 })

    // Any other change without draft / _status is refused with a clear 409, and nothing changes.
    const other = await restPatch(`products/${p.id}`, { token: editorToken, body: { maxPerOrder: 5 } })
    expect(other.status).toBe(409)
    expect(other.body.errors[0].data).toMatchObject({ code: 'UNPUBLISHED_CHANGES' })
    expect(await payload.findByID({ collection: 'products', id: p.id, depth: 0 })).toMatchObject({ _status: 'published', maxPerOrder: 10 })

    // Publishing the draft (explicit _status) still works.
    const pub = await restPatch(`products/${p.id}`, { token: editorToken, query: 'depth=0', body: { _status: 'published' } })
    expect(pub.status).toBe(200)
    expect(await payload.findByID({ collection: 'products', id: p.id, depth: 0 })).toMatchObject({ _status: 'published', pricePaise: 26000, stock: 25 })
  })

  it('without a pending draft a plain save behaves as before; customers still get 403, not a hint', async () => {
    const p = await createProduct(payload, { stock: 10 })
    expect((await restPatch(`products/${p.id}`, { token: editorToken, body: { stockAdjust: -2, maxPerOrder: 4 } })).status).toBe(200)
    expect(await payload.findByID({ collection: 'products', id: p.id, depth: 0 })).toMatchObject({ _status: 'published', stock: 8, maxPerOrder: 4 })
    await restPatch(`products/${p.id}`, { token: editorToken, query: 'draft=true', body: { pricePaise: 29900, _status: 'draft' } })
    expect((await restPatch(`products/${p.id}`, { body: { maxPerOrder: 1 } })).status).toBe(403)
  })
})

describe('money the shop shows or charges is whole rupees', () => {
  it('store settings: fees, thresholds and the welcome cap refuse paise that are not whole rupees', async () => {
    for (const body of [{ deliveryFeePaise: 4940 }, { codFeePaise: 1050 }, { freeDeliveryThresholdPaise: 49950 }, { codMaxPaise: 99 }]) {
      const res = await restPost('globals/store-settings', { token: adminToken, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    const s = await payload.findGlobal({ slug: 'store-settings' })
    expect((await restPost('globals/store-settings', { token: adminToken, body: { welcomeOffer: { ...s.welcomeOffer, maxDiscountPaise: 7550 } } })).status).toBe(400)
    expect((await restPost('globals/store-settings', { token: adminToken, body: { deliveryFeePaise: 4900 } })).status).toBe(200)
  })

  it('coupons: a fixed value or a cap that is not whole rupees, or a ₹0 cap, is refused', async () => {
    const bad = [
      { type: 'fixed', value: 1050 },
      { type: 'fixed', value: 50 },
      { type: 'percent', value: 10, maxDiscountPaise: 7550 },
      { type: 'percent', value: 10, maxDiscountPaise: 0 },
      { type: 'percent', value: 10, minSubtotalPaise: 49950 },
    ]
    for (const body of bad) expect((await restPost('coupons', { token: adminToken, body: { code: code(), ...body } })).status, JSON.stringify(body)).toBe(400)
    expect((await restPost('coupons', { token: adminToken, body: { code: code(), type: 'fixed', value: 5000, minSubtotalPaise: 49900 } })).status).toBe(201)
  })

  it('welcome offer "Largest discount" 0 = no cap: the code gives the full percent', async () => {
    const s = await payload.findGlobal({ slug: 'store-settings' })
    const saved = await restPost('globals/store-settings', { token: adminToken, body: { welcomeOffer: { ...s.welcomeOffer, percent: 10, maxDiscountPaise: 0 } } })
    expect(saved.status).toBe(200)
    const email = uniqueEmail('r2-cap0')
    const sub = (await payload.create({ collection: 'subscribers', data: { email, status: 'confirmed', source: 'newsletter' } })) as Subscriber
    const coupon = await ensureWelcomeCoupon(payload, sub, new Date())
    expect(coupon.maxDiscountPaise ?? null).toBeNull()
    const r = evaluateCoupon(coupon as never, { subtotalPaise: 100000, now: Date.now(), email, isFirstOrder: true, customerUsageCount: 0 })
    expect(r).toMatchObject({ error: null, discountPaise: 10000 })
  })
})
