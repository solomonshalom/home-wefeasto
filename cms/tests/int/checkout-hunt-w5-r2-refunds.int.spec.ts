import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetGateway, signWebhook } from '@/payments'
import type { GatewayPayment, GatewayRefund } from '@/payments/types'

import { deliver, freshMock, makeProduct, mock, ok, orderByNumber, placeOrderVia, postWebhook, reload, settle, stockOf } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restPatch } from './helpers/rest'

/**
 * Hunt wave 5 round 2 (cms-checkout), refunds:
 *  - only a human releases a hold: a partial refund settling after a chargeback (or an admin's hold) leaves the
 *    order in needs_review (not packable); the human releases it to partially_refunded ("paid" would hide it);
 *  - a full refund of an order that never shipped gives its stock back (webhook / Dashboard and admin Status);
 *  - reconcile's twin: see checkout-hunt-w5-r2-latedup.int.spec.ts.
 */

let payload: Payload
let token: string

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  token = (await login('users', (await createStaff(payload, 'admin')).email)).token
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
const pay = (id: string, refunded?: number): GatewayPayment => {
  const p = mock().inspect().payments.find((x) => x.id === id)!
  return refunded === undefined ? p : { ...p, amount_refunded: refunded, refund_status: refunded ? 'partial' : null }
}
const refundHook = (event: 'refund.created' | 'refund.processed' | 'refund.failed', refund: GatewayRefund, payment: GatewayPayment) =>
  postWebhook(mock().buildWebhook(event, { refund, payment }))

async function paidOrder(qty = 1) {
  const p = await makeProduct(payload, { stock: 10, pricePaise: 30000 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty }])
  expect(res.status, res.text).toBe(201)
  const r = ok(await mock().simulatePayment(res.body.payment.razorpayOrderId, { outcome: 'success' }))
  await deliver(r.events)
  const order = await orderByNumber(payload, res.body.order.number)
  expect(order).toMatchObject({ status: 'paid', stockState: 'committed' })
  expect(await stockOf(payload, p.slug as string)).toBe(10 - qty)
  return { order, payment: r.payment, slug: p.slug as string }
}

async function dispute(o: { number: string; totalPaise: number }, payment: GatewayPayment, id: string) {
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_WefeastoMock01',
    event: 'payment.dispute.created',
    contains: ['dispute', 'payment'],
    payload: {
      dispute: { entity: { id, entity: 'dispute', payment_id: payment.id, amount: o.totalPaise, currency: 'INR', reason_code: 'goods_not_received', status: 'open', phase: 'chargeback' } },
      payment: { entity: payment },
    },
    created_at: Math.floor(Date.now() / 1000),
  })
  const res = await postWebhook({ body, signature: signWebhook(body, 'wefeasto-mock-webhook-secret-dev-only'), eventId: `evt_r2_${id}` })
  expect(res.body.outcome).toBe('dispute_flagged')
}

describe('only a human releases a hold', () => {
  it('a partial refund settled after a chargeback keeps the order on hold; a human releases it to partially_refunded', async () => {
    const { order, payment } = await paidOrder()
    const refund = await mock().refund(payment.id, { amountPaise: 5000, receipt: `${order.number}-r1` })
    await refundHook('refund.created', { ...refund, status: 'pending' }, pay(payment.id))
    expect((await reload(payload, order.id)).status).toBe('partially_refunded')
    await dispute(order, pay(payment.id), `disp_R2a${order.id}`)
    expect((await reload(payload, order.id)).status).toBe('needs_review')

    expect((await refundHook('refund.processed', refund, pay(payment.id))).body.outcome).toBe('refund_recorded')
    const held = await reload(payload, order.id)
    expect(held).toMatchObject({ status: 'needs_review', paymentStatus: 'partially_refunded', fulfilmentStatus: 'unfulfilled' })
    expect(held.refunds).toEqual([expect.objectContaining({ refundId: refund.id, status: 'processed' })])
    expect(held.reviewReason).toContain(`Chargeback disp_R2a${order.id}`)
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(400)

    // The human decides: "paid" would hide the refund; "partially refunded" releases the hold.
    const asPaid = await patch(order.id, { status: 'paid' })
    expect(asPaid.status).toBe(400)
    expect(asPaid.text).toContain('partially refunded')
    const release = await patch(order.id, { status: 'partially_refunded' })
    expect(release.status, release.text).toBe(200)
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', fulfilmentStatus: 'packed', stockState: 'committed' })
  })

  it('a refund that fails, its events delivered after the chargeback: still on hold', async () => {
    const { order, payment } = await paidOrder()
    await dispute(order, pay(payment.id), `disp_R2b${order.id}`)
    const refund = await mock().refund(payment.id, { amountPaise: 2000, receipt: `${order.number}-r1` })
    await refundHook('refund.created', { ...refund, status: 'pending' }, pay(payment.id, 2000))
    await refundHook('refund.failed', { ...refund, status: 'failed' }, pay(payment.id, 0))
    const held = await reload(payload, order.id)
    expect(held.status).toBe('needs_review')
    expect(held.reviewReason).toContain(`Chargeback disp_R2b${order.id}`)
    expect(held.reviewReason).toContain('FAILED')
  })

  it('an admin\'s hold survives a partial Dashboard refund; a full refund ends the order (refunded, restocked)', async () => {
    const { order, payment, slug } = await paidOrder(2)
    expect((await patch(order.id, { status: 'needs_review', reviewReason: 'Address looks wrong' })).status).toBe(200)
    const part = await mock().refund(payment.id, { amountPaise: 5000, receipt: `${order.number}-r1` })
    await refundHook('refund.processed', part, pay(payment.id))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', paymentStatus: 'partially_refunded' })
    const rest = await mock().refund(payment.id, { receipt: `${order.number}-r2` })
    await refundHook('refund.processed', rest, pay(payment.id))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'refunded', paymentStatus: 'refunded', stockState: 'released' })
    expect(await stockOf(payload, slug)).toBe(10)
  })
})

describe('a full refund before shipping gives the stock back', () => {
  it('Dashboard full refund (webhook) of a paid, unshipped order: stock back once, noted in the history', async () => {
    const { order, payment, slug } = await paidOrder(2)
    const refund = await mock().refund(payment.id, { receipt: `${order.number}-r1` })
    expect((await refundHook('refund.processed', refund, pay(payment.id))).body.outcome).toBe('refund_recorded')
    const done = await reload(payload, order.id)
    expect(done).toMatchObject({ status: 'refunded', paymentStatus: 'refunded', fulfilmentStatus: 'unfulfilled', stockState: 'released' })
    expect(done.statusHistory?.filter((h) => h.field === 'status').at(-1)?.note).toContain('stock given back')
    expect(await stockOf(payload, slug)).toBe(10)
    // Redelivered (a new event id), and the admin re-saving the status: nothing more comes back.
    expect((await refundHook('refund.processed', refund, pay(payment.id))).body.outcome).toBe('refund_unchanged')
    expect((await patch(order.id, { status: 'refunded' })).status).toBe(200)
    await settle()
    expect(await stockOf(payload, slug)).toBe(10)
  })

  it('packed counts as unshipped; a shipped order refunded in full keeps its stock out', async () => {
    const a = await paidOrder(2)
    expect((await patch(a.order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    await refundHook('refund.processed', await mock().refund(a.payment.id, { receipt: `${a.order.number}-r1` }), pay(a.payment.id))
    expect(await reload(payload, a.order.id)).toMatchObject({ status: 'refunded', fulfilmentStatus: 'packed', stockState: 'released' })
    expect(await stockOf(payload, a.slug)).toBe(10)

    const b = await paidOrder(2)
    expect((await patch(b.order.id, { fulfilmentStatus: 'shipped' })).status).toBe(200)
    await refundHook('refund.processed', await mock().refund(b.payment.id, { receipt: `${b.order.number}-r1` }), pay(b.payment.id))
    expect(await reload(payload, b.order.id)).toMatchObject({ status: 'refunded', fulfilmentStatus: 'shipped', stockState: 'committed' })
    expect(await stockOf(payload, b.slug)).toBe(8)
  })

  it('admin Status → refunded on a paid, unshipped order gives its stock back', async () => {
    const { order, slug } = await paidOrder(2)
    const res = await patch(order.id, { status: 'refunded' })
    expect(res.status, res.text).toBe(200)
    await settle()
    expect(await reload(payload, order.id)).toMatchObject({ status: 'refunded', stockState: 'released' })
    expect(await stockOf(payload, slug)).toBe(10)
  })
})
