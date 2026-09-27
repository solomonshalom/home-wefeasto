import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetGateway, signWebhook } from '@/payments'

import { deliver, freshMock, makeProduct, mock, orderByNumber, placeOrderVia, postWebhook, reload, settle, stockOf } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restPatch } from './helpers/rest'

/**
 * HUNT-CONC-R3-3 (cms-checkout, Orders.ts guardAdminTransitions): every admin step INTO packed or shipped
 * needs canFulfil(status) (paid, cod_confirmed, partially_refunded), not only the first one out of
 * `unfulfilled`. A packed order that then goes on hold (chargeback → needs_review), is refunded in full or is
 * cancelled (stock given back) must not ship. Recording what already happened (shipped → delivered / rto,
 * delivered → returned) stays allowed whatever the status.
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

async function paidOrder() {
  const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
  expect(res.status, res.text).toBe(201)
  const r = await mock().simulatePayment(res.body.payment.razorpayOrderId, { outcome: 'success' })
  await deliver(r.events)
  const order = await orderByNumber(payload, res.body.order.number)
  expect(order.status).toBe('paid')
  return { order, payment: r.payment, slug: p.slug as string }
}

async function refundInFull(paymentId: string, number: string) {
  const refund = await mock().refund(paymentId, { receipt: `${number}-r1` })
  const payment = mock().inspect().payments.find((x) => x.id === paymentId)!
  const res = await postWebhook(mock().buildWebhook('refund.processed', { refund, payment }))
  expect(res.body.outcome).toBe('refund_recorded')
}

async function dispute(o: { number: string; totalPaise: number }, payment: { id: string }) {
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_WefeastoMock01',
    event: 'payment.dispute.created',
    contains: ['dispute', 'payment'],
    payload: {
      dispute: { entity: { id: `disp_R3${o.number.replace(/\D/g, '')}`, entity: 'dispute', payment_id: payment.id, amount: o.totalPaise, currency: 'INR', reason_code: 'chargeback', status: 'open', phase: 'chargeback' } },
      payment: { entity: payment },
    },
    created_at: Math.floor(Date.now() / 1000),
  })
  const res = await postWebhook({ body, signature: signWebhook(body, 'wefeasto-mock-webhook-secret-dev-only'), eventId: `evt_r3disp_${o.number}` })
  expect(res.body.outcome).toBe('dispute_flagged')
}

describe('a packed order ships only while it may be fulfilled', () => {
  it('chargeback after packing (needs_review = hold): shipping is refused', async () => {
    const { order, payment } = await paidOrder()
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    await dispute(order, payment)
    expect((await reload(payload, order.id)).status).toBe('needs_review')
    const ship = await patch(order.id, { fulfilmentStatus: 'shipped' })
    expect(ship.status, ship.text).toBe(400)
    expect(ship.text).toMatch(/needs_review/)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', fulfilmentStatus: 'packed' })
  })

  it('refunded in full after packing: shipping is refused', async () => {
    const { order, payment } = await paidOrder()
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    await refundInFull(payment.id, order.number)
    expect((await reload(payload, order.id)).status).toBe('refunded')
    expect((await patch(order.id, { fulfilmentStatus: 'shipped' })).status).toBe(400)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'refunded', fulfilmentStatus: 'packed' })
  })

  it('a packed COD order cancelled (stock back): shipping is refused, stock stays counted once', async () => {
    const p = await makeProduct(payload, { stock: 20 })
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { method: 'cod' })
    expect(res.status, res.text).toBe(201)
    const order = await orderByNumber(payload, res.body.order.number)
    expect((await patch(order.id, { status: 'cod_confirmed' })).status).toBe(200)
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    expect((await patch(order.id, { status: 'cancelled' })).status).toBe(200)
    await settle()
    expect(await stockOf(payload, p.slug as string)).toBe(20)
    expect((await patch(order.id, { fulfilmentStatus: 'shipped' })).status).toBe(400)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'cancelled', fulfilmentStatus: 'packed', stockState: 'released' })
  })

  it('a cancel and a ship in ONE save are refused together', async () => {
    const p = await makeProduct(payload, { stock: 20 })
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { method: 'cod' })
    const order = await orderByNumber(payload, res.body.order.number)
    expect((await patch(order.id, { status: 'cod_confirmed' })).status).toBe(200)
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    expect((await patch(order.id, { status: 'cancelled', fulfilmentStatus: 'shipped' })).status).toBe(400)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'cod_confirmed', fulfilmentStatus: 'packed' })
  })

  it('still allowed: paid → packed → shipped, and delivered / returned after a later full refund (facts)', async () => {
    const a = await paidOrder()
    expect((await patch(a.order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    expect((await patch(a.order.id, { fulfilmentStatus: 'shipped' })).status).toBe(200)
    // Refunded after it left: the parcel's fate is still recorded.
    await refundInFull(a.payment.id, a.order.number)
    expect((await reload(payload, a.order.id)).status).toBe('refunded')
    expect((await patch(a.order.id, { fulfilmentStatus: 'delivered' })).status).toBe(200)
    expect((await patch(a.order.id, { fulfilmentStatus: 'returned' })).status).toBe(200)
  })

  it('still allowed: a partially refunded packed order ships', async () => {
    const b = await paidOrder()
    expect((await patch(b.order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    const part = await mock().refund(b.payment.id, { amountPaise: 10000, receipt: `${b.order.number}-r1` })
    const pay = mock().inspect().payments.find((x) => x.id === b.payment.id)!
    await postWebhook(mock().buildWebhook('refund.processed', { refund: part, payment: pay }))
    expect((await reload(payload, b.order.id)).status).toBe('partially_refunded')
    expect((await patch(b.order.id, { fulfilmentStatus: 'shipped' })).status).toBe(200)
  })
})
