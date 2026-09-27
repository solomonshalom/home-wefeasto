import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CHECKOUT_CONTEXT } from '@/commerce/checkout/db'
import { expireOrder } from '@/commerce/checkout/expire'
import { resetGateway, signWebhook } from '@/payments'

import { deliver, freshMock, makeProduct, mock, orderByNumber, placeOrderVia, postWebhook, reload, settle, stockOf } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPatch } from './helpers/rest'

/**
 * Hunt wave 5 (cms-checkout), admin side:
 *  - a whole-form Save (admin UI, or a REST client sending back the document it read) loaded before a server
 *    write that changes no status (refund.failed, a second chargeback) is refused instead of erasing the
 *    reviewReason alert or releasing the hold (Orders `revision`, adminEdits.ts staleFormEdit);
 *  - a bulk edit (Orders list → Edit, PATCH /api/orders?where=…) where one order is refused saves nothing
 *    (Payload commits the shared transaction otherwise: ordersBulkAllOrNothing).
 */

let payload: Payload
let token: string

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  const admin = await createStaff(payload, 'admin')
  token = (await login('users', admin.email)).token
})
beforeEach(() => void freshMock())
afterEach(async () => {
  await settle()
  resetGateway()
})
afterAll(async () => {
  await restoreStoreSettings(payload)
})

const patch = (id: number, body: Record<string, unknown>) => restPatch(`orders/${id}`, { body, token })
const bulk = (numbers: string[], body: Record<string, unknown>) =>
  restPatch('orders', { body, token, query: { 'where[number][in]': numbers.join(','), depth: '0' } })
/** The admin form as it was loaded (GET), with the admin's own change applied. */
async function form(id: number) {
  const r = await restGet(`orders/${id}`, { token, query: { depth: '0' } })
  expect(r.status, r.text).toBe(200)
  const { id: _i, createdAt: _c, updatedAt: _u, ...doc } = r.body
  return (change: Record<string, unknown>) => ({ ...doc, ...change })
}

async function paidOrder() {
  const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
  expect(res.status, res.text).toBe(201)
  const r = await mock().simulatePayment(res.body.payment.razorpayOrderId, { outcome: 'success' })
  await deliver(r.events)
  const order = await orderByNumber(payload, res.body.order.number)
  expect(order.status).toBe('paid')
  return { order, payment: r.payment }
}

async function dispute(o: { number: string; totalPaise: number }, payment: { id: string }, id: string) {
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_WefeastoMock01',
    event: 'payment.dispute.created',
    contains: ['dispute', 'payment'],
    payload: {
      dispute: { entity: { id, entity: 'dispute', payment_id: payment.id, amount: o.totalPaise, currency: 'INR', reason_code: 'fraud', status: 'open', phase: 'chargeback' } },
      payment: { entity: payment },
    },
    created_at: Math.floor(Date.now() / 1000),
  })
  const res = await postWebhook({ body, signature: signWebhook(body, 'wefeasto-mock-webhook-secret-dev-only'), eventId: `evt_w5_${id}` })
  expect(res.body.outcome).toBe('dispute_flagged')
}

describe('a Save from a form loaded before a server write that changed no status', () => {
  it('refund.failed: packing from the stale form is refused, the alert stays; a reloaded form saves', async () => {
    const { order, payment } = await paidOrder()
    const stale = await form(order.id)
    const rev = (await reload(payload, order.id)).revision as number
    const refund = await mock().refund(payment.id, { amountPaise: 5000, receipt: `${order.number}-r1` })
    await postWebhook(mock().buildWebhook('refund.failed', { refund: { ...refund, status: 'failed' }, payment }))
    const alerted = await reload(payload, order.id)
    expect(alerted).toMatchObject({ status: 'paid', revision: rev + 1 })
    expect(alerted.reviewReason).toContain(`Refund ${refund.id} of payment ${payment.id} FAILED`)

    const res = await patch(order.id, stale({ fulfilmentStatus: 'packed' }))
    expect(res.status, res.text).toBe(400)
    expect(res.text).toContain('new notes were added to Review Reason')
    expect(await reload(payload, order.id)).toMatchObject({ fulfilmentStatus: 'unfulfilled', reviewReason: alerted.reviewReason })

    // Reloaded: packs, keeps the alert; the answer carries the new revision, so the next Save of it works too.
    const fresh = await form(order.id)
    const packed = await patch(order.id, fresh({ fulfilmentStatus: 'packed' }))
    expect(packed.status, packed.text).toBe(200)
    expect(packed.body.doc).toMatchObject({ fulfilmentStatus: 'packed', revision: rev + 2, reviewReason: alerted.reviewReason })
    const { id: _i, createdAt: _c, updatedAt: _u, ...saved } = packed.body.doc
    const again = await patch(order.id, { ...saved, reviewReason: `${alerted.reviewReason}\nPaid back by bank transfer.` })
    expect(again.status, again.text).toBe(200)
    expect((await reload(payload, order.id)).reviewReason).toMatch(/Paid back by bank transfer\.$/)
  })

  it('a second chargeback on an order already on hold: resolving it from the stale form is refused', async () => {
    const { order, payment } = await paidOrder()
    await dispute(order, payment, `disp_W5a${order.id}`)
    const stale = await form(order.id)
    await dispute(order, payment, `disp_W5b${order.id}`)
    const held = await reload(payload, order.id)
    expect(held.status).toBe('needs_review')
    expect(held.reviewReason).toContain(`Chargeback disp_W5b${order.id}`)
    const res = await patch(order.id, stale({ status: 'paid' }))
    expect(res.status, res.text).toBe(400)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', reviewReason: held.reviewReason })
  })

  it('REST calls that send only what they change are never stale', async () => {
    const { order, payment } = await paidOrder()
    await dispute(order, payment, `disp_W5c${order.id}`)
    const res = await patch(order.id, { reviewReason: 'Evidence sent; bank sided with us.' })
    expect(res.status, res.text).toBe(200)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', reviewReason: 'Evidence sent; bank sided with us.' })
  })
})

describe('bulk edit (Orders list → Edit) is all-or-nothing', () => {
  /** Online order, expired (stock and coupon use released), then put to needs_review by a human. */
  async function releasedReview(overrides: Record<string, unknown> = {}) {
    const p = await makeProduct(payload, { stock: 20 })
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], overrides)
    expect(res.status, res.text).toBe(201)
    const o = await orderByNumber(payload, res.body.order.number)
    await expireOrder(payload, o.id, { now: Date.now() + 31 * 60_000 })
    await payload.update({ collection: 'orders', id: o.id, data: { status: 'needs_review' }, overrideAccess: true, context: { [CHECKOUT_CONTEXT]: true } })
    expect(await reload(payload, o.id)).toMatchObject({ status: 'needs_review', stockState: 'released' })
    return { order: o, slug: p.slug as string, productId: p.id }
  }
  const confirmations = async (number: string) =>
    (await payload.find({ collection: 'message-log', where: { key: { equals: `confirm:${number}` } }, overrideAccess: true })).totalDocs

  it('→ paid with the stock gone: 400 naming the reason, and neither selected order changes', async () => {
    const a = await releasedReview()
    const b = await releasedReview()
    await payload.db.updateOne({ collection: 'products', id: a.productId, data: { stock: 0 }, returning: false })
    const res = await bulk([a.order.number, b.order.number], { status: 'paid' })
    expect(res.status, res.text).toBe(400)
    expect(res.text).toContain(`Nothing was saved: 1 of 2 orders could not be updated. ${a.order.number}: ${a.slug} is out of stock`)
    expect(res.body.errors[0].data.errors).toEqual([{ path: 'status', message: expect.stringContaining('out of stock') }])
    await settle()
    for (const x of [a, b]) {
      expect(await reload(payload, x.order.id)).toMatchObject({ status: 'needs_review', stockState: 'released', paidAt: null, paidVia: null })
      expect(await confirmations(x.order.number)).toBe(0)
    }
    expect(await stockOf(payload, a.slug)).toBe(0)
    expect(await stockOf(payload, b.slug)).toBe(20) // b's re-take was rolled back with the rest
  })

  it('→ paid with the offer used up: nothing re-taken, the offer is not over-used', async () => {
    const c = await payload.create({
      collection: 'coupons',
      data: { code: `W5B${Date.now().toString(36).toUpperCase()}`, type: 'fixed', value: 5000, usageLimit: 1, usedCount: 0, active: true } as never,
      overrideAccess: true,
    })
    const a = await releasedReview({ couponCode: c.code })
    const other = await makeProduct(payload, { stock: 20 })
    const taken = await placeOrderVia([{ slug: other.slug as string, qty: 1 }], { method: 'cod', couponCode: c.code })
    expect(taken.res.status, taken.res.text).toBe(201)
    const used = (await payload.findByID({ collection: 'coupons', id: c.id, overrideAccess: true })).usedCount
    const res = await bulk([a.order.number], { status: 'paid' })
    expect(res.status, res.text).toBe(400)
    expect(res.text).toContain('has no uses left')
    expect(await reload(payload, a.order.id)).toMatchObject({ status: 'needs_review', stockState: 'released' })
    expect(await stockOf(payload, a.slug)).toBe(20)
    expect((await payload.findByID({ collection: 'coupons', id: c.id, overrideAccess: true })).usedCount).toBe(used)
  })

  it('a bulk edit every order accepts still saves', async () => {
    const [x, y] = [await paidOrder(), await paidOrder()]
    const res = await bulk([x.order.number, y.order.number], { fulfilmentStatus: 'packed' })
    expect(res.status, res.text).toBe(200)
    for (const o of [x, y]) {
      expect(await reload(payload, o.order.id)).toMatchObject({ fulfilmentStatus: 'packed', revision: (o.order.revision as number) + 1 })
    }
  })
})
