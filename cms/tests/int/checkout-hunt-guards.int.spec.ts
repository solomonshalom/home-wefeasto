import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { expireOrder } from '@/commerce/checkout/expire'
import { resetGateway } from '@/payments'

import { checkoutBody, contactFor, deliver, freshMock, makeProduct, mock, ok, orderByNumber, placeOrderVia, postCheckout, quoteTotal, reload, settle, stockOf } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * Hunt round 1 (cms-checkout) regressions, customer side:
 *   - retry after expiry re-checks what expiry gave back (product on sale, coupon use still free);
 *   - first-order-only offers can't be held by two overlapping orders of one email/phone;
 *   - the open-COD cap holds under parallel checkouts (per-phone advisory lock + in-transaction recount);
 *   - a verified supersede ref naming this bag's order that was paid meanwhile → 409 ALREADY_PAID.
 */

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
})
beforeEach(() => void freshMock())
afterEach(async () => {
  await settle()
  resetGateway()
})
afterAll(async () => {
  await restoreStoreSettings(payload)
})

const retry = (number: string, token: string) => restPost('store/checkout/retry', { body: { number, token } })
const code = () => `HG${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const coupon = (data: Record<string, unknown>) =>
  payload.create({ collection: 'coupons', data: { code: code(), type: 'fixed', value: 5000, usedCount: 0, active: true, ...data } as never, overrideAccess: true })

async function placeAndExpire(slug: string, qty: number, overrides: Record<string, unknown> = {}) {
  const { res } = await placeOrderVia([{ slug, qty }], overrides)
  expect(res.status, res.text).toBe(201)
  const { number, token } = res.body.order
  const id = (await orderByNumber(payload, number)).id
  await expireOrder(payload, id, { now: Date.now() + 31 * 60_000 })
  expect((await reload(payload, id)).status).toBe('expired')
  return { number: number as string, token: token as string, id }
}

describe('retry after expiry re-checks what expiry gave back', () => {
  it('a product taken off sale, unpublished or over its new per-order limit → 4xx, the order stays expired, no stock taken', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ inStock: false }, 'OUT_OF_STOCK'],
      [{ _status: 'draft' }, 'UNAVAILABLE'],
      [{ maxPerOrder: 1 }, 'QTY_LIMIT'],
    ]
    for (const [patch, expected] of cases) {
      const p = await makeProduct(payload, { stock: 20 })
      const o = await placeAndExpire(p.slug as string, 2)
      await payload.update({ collection: 'products', id: p.id, data: patch as never, overrideAccess: true })
      const before = await stockOf(payload, p.slug as string)
      const res = await retry(o.number, o.token)
      expect(res.status, `${JSON.stringify(patch)} → ${res.text}`).toBe(409)
      expect(res.body.error.code).toBe(expected)
      expect(res.body.error.details.issues[0]).toMatchObject({ slug: p.slug, code: expected })
      expect(await reload(payload, o.id)).toMatchObject({ status: 'expired', stockState: 'released' })
      expect(await stockOf(payload, p.slug as string)).toBe(before)
    }
  })

  it('a single-use code taken by another order meanwhile → 422 COUPON_INVALID USAGE_LIMIT, stock given back, use not re-reserved', async () => {
    const c = await coupon({ usageLimit: 1 })
    const p = await makeProduct(payload, { stock: 20 })
    const a = await placeAndExpire(p.slug as string, 1, { couponCode: c.code })
    const b = await placeOrderVia([{ slug: p.slug as string, qty: 2 }], { couponCode: c.code })
    expect(b.res.status, b.res.text).toBe(201)
    const before = await stockOf(payload, p.slug as string)
    const res = await retry(a.number, a.token)
    expect(res.status, res.text).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'USAGE_LIMIT' } })
    expect(await stockOf(payload, p.slug as string)).toBe(before) // the re-taken stock was rolled back
    expect(await reload(payload, a.id)).toMatchObject({ status: 'expired', stockState: 'released' })
    const red = await payload.find({ collection: 'coupon-redemptions', where: { order: { equals: a.id } }, overrideAccess: true })
    expect(red.docs[0].status).toBe('released')
  })

  it('a first-order code after the same phone has ordered with another email → FIRST_ORDER_ONLY; a code still free is honoured', async () => {
    const c = await coupon({ firstOrderOnly: true })
    const p = await makeProduct(payload, { stock: 20 })
    const contact = contactFor('fo-retry')
    const a = await placeAndExpire(p.slug as string, 1, { couponCode: c.code, contact })
    const cod = await placeOrderVia([{ slug: p.slug as string, qty: 3 }], { method: 'cod', contact: { ...contactFor('fo-other'), phone: contact.phone } })
    expect(cod.res.status, cod.res.text).toBe(201)
    const refused = await retry(a.number, a.token)
    expect(refused.status, refused.text).toBe(422)
    expect(refused.body.error.details.reason).toBe('FIRST_ORDER_ONLY')

    const free = await coupon({ usageLimit: 5 })
    const d = await placeAndExpire(p.slug as string, 1, { couponCode: free.code })
    const res = await retry(d.number, d.token)
    expect(res.status, res.text).toBe(200)
    expect(await reload(payload, d.id)).toMatchObject({ status: 'pending_payment', stockState: 'reserved' })
  })
})

describe('first-order-only offers and overlapping orders', () => {
  it('a second online order of the same phone (other email, other bag) is refused while the first holds the offer', async () => {
    const c = await coupon({ firstOrderOnly: true, perCustomerLimit: 1 })
    const p = await makeProduct(payload, { stock: 20 })
    const phone = contactFor().phone
    const a = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { couponCode: c.code, contact: { ...contactFor('fo-a'), phone } })
    expect(a.res.status, a.res.text).toBe(201)
    const b = await placeOrderVia([{ slug: p.slug as string, qty: 2 }], { couponCode: c.code, contact: { ...contactFor('fo-b'), phone } })
    expect(b.res.status, b.res.text).toBe(422)
    expect(b.res.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'FIRST_ORDER_ONLY' } })

    // Another first-order offer is refused as well; once A has expired (use released) the offer is free again.
    const other = await coupon({ firstOrderOnly: true })
    const b2 = await placeOrderVia([{ slug: p.slug as string, qty: 2 }], { couponCode: other.code, contact: { ...contactFor('fo-b2'), phone } })
    expect(b2.res.status, b2.res.text).toBe(422)
    await expireOrder(payload, (await orderByNumber(payload, a.res.body.order.number)).id, { now: Date.now() + 31 * 60_000 })
    const b3 = await placeOrderVia([{ slug: p.slug as string, qty: 2 }], { couponCode: c.code, contact: { ...contactFor('fo-b3'), phone } })
    expect(b3.res.status, b3.res.text).toBe(201)
  })

  it('the same bag again (supersede) may carry the offer: the replaced order does not count', async () => {
    const c = await coupon({ firstOrderOnly: true })
    const p = await makeProduct(payload, { stock: 20 })
    const contact = contactFor('fo-sup')
    const a = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { couponCode: c.code, contact })
    expect(a.res.status, a.res.text).toBe(201)
    const ref = { number: a.res.body.order.number, token: a.res.body.order.token }
    const b = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { couponCode: c.code, contact, method: 'cod', supersede: ref })
    expect(b.res.status, b.res.text).toBe(201)
    expect((await orderByNumber(payload, a.res.body.order.number)).status).toBe('cancelled')
  })
})

describe('open-COD cap under parallel checkouts', () => {
  it('four parallel COD checkouts of one phone → exactly codMaxOpenPerPhone placed, the rest TOO_MANY_OPEN', async () => {
    const phone = contactFor().phone
    const products = []
    for (let i = 0; i < 4; i++) products.push(await makeProduct(payload, { stock: 20 }))
    const bodies = await Promise.all(
      products.map(async (p) => {
        const items = [{ slug: p.slug as string, qty: 1 }]
        return checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact: { ...contactFor('cap'), phone } })
      }),
    )
    const rs = await Promise.all(bodies.map((b) => postCheckout(b)))
    expect(rs.map((r) => r.status).sort()).toEqual([201, 201, 422, 422])
    for (const r of rs.filter((x) => x.status === 422)) expect(r.body.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'TOO_MANY_OPEN' } })
    const stocks = await Promise.all(products.map((p) => stockOf(payload, p.slug as string)))
    expect(stocks.sort()).toEqual([19, 19, 20, 20]) // refused checkouts took nothing
  })
})

describe('supersede ref naming an order that was paid meanwhile', () => {
  it('same bag → 409 ALREADY_PAID {order}, nothing placed; another bag with the same ref → placed as usual', async () => {
    const p = await makeProduct(payload, { stock: 20 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const contact = contactFor('sup-paid')
    const online = await placeOrderVia(items, { contact })
    expect(online.res.status, online.res.text).toBe(201)
    const ref = { number: online.res.body.order.number, token: online.res.body.order.token }
    const pay = ok(await mock().simulatePayment(online.res.body.payment.razorpayOrderId, { outcome: 'success' }))
    await deliver(pay.events)
    expect((await orderByNumber(payload, ref.number)).status).toBe('paid')

    const count = async () => (await payload.count({ collection: 'orders', where: { 'contact.phone': { equals: contact.phone } }, overrideAccess: true })).totalDocs
    const before = await count()
    const cod = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact, supersede: ref }))
    expect(cod.status, cod.text).toBe(409)
    expect(cod.body.error).toMatchObject({ code: 'ALREADY_PAID', details: { order: { number: ref.number, status: 'paid' } } })
    expect(await count()).toBe(before)

    const otherItems = [{ slug: p.slug as string, qty: 2 }]
    const other = await postCheckout(checkoutBody(otherItems, await quoteTotal(otherItems, { method: 'cod' }), { method: 'cod', contact, supersede: ref }))
    expect(other.status, other.text).toBe(201)
  })
})
