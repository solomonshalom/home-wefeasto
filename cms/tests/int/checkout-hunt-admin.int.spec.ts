import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CHECKOUT_CONTEXT } from '@/commerce/checkout/db'
import { expireOrder } from '@/commerce/checkout/expire'
import { resetGateway } from '@/payments'

import { contactFor, deliver, freshMock, makeProduct, mock, orderByNumber, placeOrderVia, reload, settle, stockOf } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restPatch } from './helpers/rest'

/**
 * Hunt round 1 (cms-checkout) regressions, admin side: admin order edits are serialised with the checkout
 * code on the order row (HUNT-CONC-2), a stale admin form can't undo a status change, and an order whose own
 * payment is being refunded can't be resolved to paid; a released coupon use is re-counted (HUNT-CONC-7).
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

async function placed(method: 'upi' | 'cod', overrides: Record<string, unknown> = {}) {
  const p = await makeProduct(payload, { stock: 20 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { method, ...overrides })
  expect(res.status, res.text).toBe(201)
  const order = await orderByNumber(payload, res.body.order.number)
  return { slug: p.slug as string, order, rzpOrderId: res.body.payment?.razorpayOrderId as string | undefined }
}

describe('admin edits are serialised with the checkout code', () => {
  it('two simultaneous cancels of a COD order: both answer, the stock is given back once', async () => {
    for (let i = 0; i < 3; i++) {
      const { slug, order } = await placed('cod')
      expect(await stockOf(payload, slug)).toBe(19)
      const rs = await Promise.all([patch(order.id, { status: 'cancelled' }), patch(order.id, { status: 'cancelled' })])
      expect(rs.map((r) => r.status)).toContain(200)
      await settle()
      expect(await reload(payload, order.id)).toMatchObject({ status: 'cancelled', stockState: 'released' })
      expect(await stockOf(payload, slug)).toBe(20)
    }
  })

  it('a cancel racing the reservation expiry gives the stock back once', async () => {
    for (const offset of [0, 2, 5]) {
      const { slug, order } = await placed('upi')
      const later = Date.now() + 31 * 60_000
      const [, adm] = await Promise.all([
        expireOrder(payload, order.id, { now: later }),
        new Promise((r) => setTimeout(r, offset)).then(() => patch(order.id, { status: 'cancelled' })),
      ])
      expect([200, 400]).toContain(adm.status)
      expect((await reload(payload, order.id)).stockState).toBe('released')
      expect(await stockOf(payload, slug)).toBe(20)
    }
  })

  it('a Save from a form loaded before the status changed is refused (the form would undo it)', async () => {
    const { order } = await placed('cod')
    const loaded = order.statusHistory ?? [] // the admin opens the order (1 row: cod_pending)
    expect((await patch(order.id, { status: 'cod_confirmed' })).status).toBe(200) // another admin confirms it
    // The first admin's form still says cod_pending: saving it would undo the confirmation.
    const stale = await patch(order.id, { status: 'cod_pending', fulfilmentStatus: 'unfulfilled', statusHistory: loaded, reviewReason: 'note' })
    expect(stale.status, stale.text).toBe(400)
    expect(stale.text).toContain('changed while you had it open')
    expect((await reload(payload, order.id)).status).toBe('cod_confirmed')
    // A form that leaves the status fields as they now are saves fine; so does a reloaded form.
    const same = await patch(order.id, { status: 'cod_confirmed', statusHistory: loaded, reviewReason: 'note' })
    expect(same.status, same.text).toBe(200)
    const fresh = (await reload(payload, order.id)).statusHistory ?? []
    const packed = await patch(order.id, { status: 'cod_confirmed', fulfilmentStatus: 'packed', statusHistory: fresh })
    expect(packed.status, packed.text).toBe(200)
  })
})

describe('resolving a review to paid', () => {
  it('refused while the order\'s own payment is being refunded automatically', async () => {
    const contact = contactFor('resolve')
    const p = await makeProduct(payload, { stock: 20 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await placeOrderVia(items, { contact })
    const ref = { number: online.res.body.order.number, token: online.res.body.order.token }
    const cod = await placeOrderVia(items, { contact, method: 'cod', supersede: ref }) // supersedes the online order
    expect(cod.res.status, cod.res.text).toBe(201)
    const id = (await orderByNumber(payload, online.res.body.order.number)).id
    expect((await reload(payload, id)).status).toBe('cancelled')
    const pay = await mock().simulatePayment(online.res.body.payment.razorpayOrderId, { outcome: 'authorize_only' })
    await deliver(pay.events)
    await settle()
    const review = await reload(payload, id)
    expect(review.status).toBe('needs_review')
    expect(review.refunds?.[0]).toMatchObject({ paymentId: review.razorpay?.paymentId, status: 'queued' })

    const res = await patch(id, { status: 'paid' })
    expect(res.status, res.text).toBe(400)
    expect(res.text).toContain('being refunded automatically')
    expect(await reload(payload, id)).toMatchObject({ status: 'needs_review', stockState: 'released' })
  })

  it('a released coupon use taken by another order meanwhile → refused, nothing re-taken', async () => {
    const c = await payload.create({
      collection: 'coupons',
      data: { code: `HA${Date.now().toString(36).toUpperCase()}`, type: 'fixed', value: 5000, usageLimit: 1, usedCount: 0, active: true } as never,
      overrideAccess: true,
    })
    const a = await placed('upi', { couponCode: c.code })
    await expireOrder(payload, a.order.id, { now: Date.now() + 31 * 60_000 })
    const b = await placed('cod', { couponCode: c.code }) // takes the only use
    expect(b.order.coupon?.code).toBe(c.code)
    // A's money arrived and a human is to decide (needs_review, no refund queued).
    await payload.update({ collection: 'orders', id: a.order.id, data: { status: 'needs_review' }, overrideAccess: true, context: { [CHECKOUT_CONTEXT]: true } })
    const res = await patch(a.order.id, { status: 'paid' })
    expect(res.status, res.text).toBe(400)
    expect(res.text).toContain('has no uses left')
    expect(await reload(payload, a.order.id)).toMatchObject({ status: 'needs_review', stockState: 'released' })
    expect(await stockOf(payload, a.slug)).toBe(20)
  })
})
