import { randomBytes } from 'node:crypto'

import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { onOrderEvent, type OrderEvent } from '@/commerce/events'
import { resetGateway } from '@/payments'
import type { GatewayPayment, GatewayRefund } from '@/payments/types'

import { deliver, freshMock, makeProduct, mock, ok, orderByNumber, placeOrderVia, postWebhook, reload, settle } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restPatch } from './helpers/rest'

/**
 * Verify pass 2 (cms-checkout): a Razorpay refund counted while pending (payment.amount_refunded includes it) that
 * then FAILS gave nothing back. The order's money state comes from what IS refunded: a partly refunded order goes
 * back to paid/captured (no order.refunded event, the ALERT stays); on hold it stays on hold but its payment status
 * is corrected, so resolving the review to paid ends paid/captured. Another refund still on its way keeps it partly
 * refunded. And "paid" is refused next to a (partially_) refunded payment status, whatever the refund rows say.
 */

let payload: Payload
let token: string
const refunded: OrderEvent[] = []
let unsubscribe: () => void

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  token = (await login('users', (await createStaff(payload, 'admin')).email)).token
  unsubscribe = onOrderEvent('order.refunded', 'test:p2-failed-refund', (e) => void refunded.push(e))
})
beforeEach(() => {
  freshMock()
  refunded.length = 0
})
afterEach(async () => {
  await settle()
  resetGateway()
})
afterAll(async () => {
  unsubscribe()
  await restoreStoreSettings(payload)
})

const patch = (id: number, body: Record<string, unknown>) => restPatch(`orders/${id}`, { body, token })
/** A Dashboard refund (no receipt), as Razorpay's refund.* webhooks carry it. */
const rzRefund = (paymentId: string, amount: number, status: GatewayRefund['status'], id = `rfnd_P2${randomBytes(5).toString('hex')}`): GatewayRefund => ({
  id,
  entity: 'refund',
  amount,
  currency: 'INR',
  payment_id: paymentId,
  notes: {},
  receipt: null,
  acquirer_data: { arn: null },
  created_at: Math.floor(Date.now() / 1000),
  batch_id: null,
  status,
  speed_processed: 'normal',
  speed_requested: 'normal',
})
const pay = (id: string, amountRefunded: number): GatewayPayment => {
  const p = mock().inspect().payments.find((x) => x.id === id)!
  return { ...p, amount_refunded: amountRefunded, refund_status: amountRefunded ? 'partial' : null }
}
const hook = async (event: 'refund.created' | 'refund.processed' | 'refund.failed', refund: GatewayRefund, payment: GatewayPayment) => {
  const res = await postWebhook(mock().buildWebhook(event, { refund, payment }))
  expect(res.status, res.text).toBe(200)
  return res.body.outcome as string
}
const statusRows = (o: { statusHistory?: { field: string; from?: string | null; to: string; note?: string | null }[] | null }) =>
  (o.statusHistory ?? []).filter((h) => h.field === 'status')

async function paidOrder() {
  const p = await makeProduct(payload, { stock: 10, pricePaise: 29900 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
  expect(res.status, res.text).toBe(201)
  const r = ok(await mock().simulatePayment(res.body.payment.razorpayOrderId, { outcome: 'success' }))
  await deliver(r.events)
  const order = await orderByNumber(payload, res.body.order.number)
  expect(order).toMatchObject({ status: 'paid', paymentStatus: 'captured', stockState: 'committed' })
  return { order, payment: r.payment }
}

describe('a partial refund that fails at Razorpay', () => {
  it('no hold: partially_refunded → back to paid/captured, the ALERT stays, no order.refunded for the withdrawal', async () => {
    const { order, payment } = await paidOrder()
    const r = rzRefund(payment.id, 5900, 'pending')
    expect(await hook('refund.created', r, pay(payment.id, 5900))).toBe('refund_recorded')
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded' })
    await settle()
    expect(refunded.map((e) => e.order.id)).toEqual([order.id])

    expect(await hook('refund.failed', { ...r, status: 'failed' }, pay(payment.id, 0))).toBe('refund_recorded')
    await settle()
    const back = await reload(payload, order.id)
    expect(back).toMatchObject({ status: 'paid', paymentStatus: 'captured', stockState: 'committed', fulfilmentStatus: 'unfulfilled' })
    expect(back.refunds).toEqual([expect.objectContaining({ refundId: r.id, status: 'failed' })])
    expect(back.reviewReason).toContain(`Refund ${r.id} of payment ${payment.id} FAILED at Razorpay`)
    expect(statusRows(back).at(-1)).toMatchObject({ from: 'partially_refunded', to: 'paid', note: expect.stringContaining('nothing refunded') })
    expect(refunded.map((e) => e.order.id)).toEqual([order.id])

    // Redelivered: nothing changes. The order may ship; a new partial refund works as before.
    expect(await hook('refund.failed', { ...r, status: 'failed' }, pay(payment.id, 0))).toBe('refund_unchanged')
    expect((await patch(order.id, { fulfilmentStatus: 'packed' })).status).toBe(200)
    const again = rzRefund(payment.id, 5900, 'processed')
    await hook('refund.processed', again, pay(payment.id, 5900))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded', fulfilmentStatus: 'packed' })
  })

  it('refund.failed alone (no payment in hand, created never seen): paid/captured, only the ALERT', async () => {
    const { order, payment } = await paidOrder()
    const r = rzRefund(payment.id, 5900, 'failed')
    const res = await postWebhook(mock().buildWebhook('refund.failed', { refund: r }))
    expect(res.body.outcome, res.text).toBe('refund_recorded')
    const o = await reload(payload, order.id)
    expect(o).toMatchObject({ status: 'paid', paymentStatus: 'captured' })
    expect(o.reviewReason).toContain('FAILED at Razorpay')
  })

  it('admin hold after the refund was created: stays on hold, payment back to captured; resolving → paid ends paid/captured', async () => {
    const { order, payment } = await paidOrder()
    const r = rzRefund(payment.id, 5900, 'pending')
    await hook('refund.created', r, pay(payment.id, 5900))
    expect((await patch(order.id, { status: 'needs_review' })).status).toBe(200)
    await hook('refund.failed', { ...r, status: 'failed' }, pay(payment.id, 0))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', paymentStatus: 'captured' })

    const res = await patch(order.id, { status: 'paid' })
    expect(res.status, res.text).toBe(200)
    await settle()
    const done = await reload(payload, order.id)
    expect(done).toMatchObject({ status: 'paid', paymentStatus: 'captured', stockState: 'committed' })
    expect(done.reviewReason).toContain('FAILED at Razorpay')
  })

  it('admin hold before the refund: the hold stays, payment back to captured', async () => {
    const { order, payment } = await paidOrder()
    expect((await patch(order.id, { status: 'needs_review' })).status).toBe(200)
    const r = rzRefund(payment.id, 3000, 'pending')
    await hook('refund.created', r, pay(payment.id, 3000))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', paymentStatus: 'partially_refunded' })
    await hook('refund.failed', { ...r, status: 'failed' }, pay(payment.id, 0))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', paymentStatus: 'captured' })
    expect((await patch(order.id, { status: 'paid' })).status).toBe(200)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'paid', paymentStatus: 'captured' })
  })

  it('another refund of the payment still pending, or one processed: the order stays partly refunded', async () => {
    const { order, payment } = await paidOrder()
    const a = rzRefund(payment.id, 3000, 'pending')
    const b = rzRefund(payment.id, 2000, 'pending')
    await hook('refund.created', a, pay(payment.id, 3000))
    await hook('refund.created', b, pay(payment.id, 5000))
    // A stale payment snapshot (amount_refunded 0) must not hide b, still on its way.
    await hook('refund.failed', { ...a, status: 'failed' }, pay(payment.id, 0))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded' })
    await hook('refund.processed', { ...b, status: 'processed' }, pay(payment.id, 2000))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded' })

    const c = rzRefund(payment.id, 1000, 'pending')
    await hook('refund.created', c, pay(payment.id, 3000))
    await hook('refund.failed', { ...c, status: 'failed' }, pay(payment.id, 2000))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded' })
  })

  it('a full refund that fails after it ended the order: refunded is terminal, the ALERT asks a human', async () => {
    const { order, payment } = await paidOrder()
    const r = rzRefund(payment.id, order.totalPaise, 'pending')
    await hook('refund.created', r, pay(payment.id, order.totalPaise))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'refunded', paymentStatus: 'refunded', stockState: 'released' })
    await hook('refund.failed', { ...r, status: 'failed' }, pay(payment.id, 0))
    const o = await reload(payload, order.id)
    expect(o).toMatchObject({ status: 'refunded', paymentStatus: 'refunded', stockState: 'released' })
    expect(o.reviewReason).toContain('FAILED at Razorpay')
  })
})

describe('"paid" goes with an authorized/captured payment only', () => {
  it('an order on hold whose payment status says partially refunded (no live refund row) can\'t be resolved to paid', async () => {
    const { order } = await paidOrder()
    expect((await patch(order.id, { status: 'needs_review' })).status).toBe(200)
    // A state the refund code no longer leaves behind, written the way server code writes (Local API).
    await payload.update({ collection: 'orders', id: order.id, data: { paymentStatus: 'partially_refunded' }, overrideAccess: true })
    const res = await patch(order.id, { status: 'paid' })
    expect(res.status).toBe(400)
    expect(res.text).toContain('The payment status is')
    expect((await patch(order.id, { status: 'paid', paymentStatus: 'captured' })).status).toBe(400)
    expect(await reload(payload, order.id)).toMatchObject({ status: 'needs_review', paymentStatus: 'partially_refunded' })
    expect((await patch(order.id, { status: 'partially_refunded' })).status).toBe(200)
  })

  it('partially_refunded → paid by hand: refused while part of the payment is refunded; allowed once nothing is', async () => {
    const { order, payment } = await paidOrder()
    const r = rzRefund(payment.id, 5900, 'processed')
    await hook('refund.processed', r, pay(payment.id, 5900))
    expect(await reload(payload, order.id)).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded' })
    const res = await patch(order.id, { status: 'paid' })
    expect(res.status).toBe(400)
    expect(res.text).toContain('stays')

    // A human released a hold to "partially refunded" although nothing was refunded: they may put it right.
    const other = await paidOrder()
    expect((await patch(other.order.id, { status: 'needs_review' })).status).toBe(200)
    expect((await patch(other.order.id, { status: 'partially_refunded' })).status).toBe(200)
    const fix = await patch(other.order.id, { status: 'paid' })
    expect(fix.status, fix.text).toBe(200)
    await settle()
    expect(await reload(payload, other.order.id)).toMatchObject({ status: 'paid', paymentStatus: 'captured', stockState: 'committed' })
  })
})
