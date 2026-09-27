import type { Payload } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CHECKOUT_CONTEXT } from '@/commerce/checkout/db'
import { reconcilePendingOrders } from '@/commerce/checkout/reconcile'
import { issueQueuedRefunds } from '@/commerce/checkout/refunds'
import { resetGateway } from '@/payments'

import { deliver, freshMock, makeProduct, mock, ok, orderByNumber, placeOrderVia, reload, settle } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'

/**
 * Hunt wave 5 round 2 (cms-checkout): a late authorisation on a Razorpay order another payment already paid is
 * refunded BY RAZORPAY (no receipt). Our own duplicate-payment refund of it (<no>-dup-…, queued by markPaid) must
 * be settled by that refund — not left `queued` forever next to a separate row, re-sent by every reconcile run.
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

const DAY = 86_400_000

/** One Razorpay order: a UPI payment the bank authorises late, and a second payment that went through. */
async function lateDuplicate() {
  const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
  expect(res.status, res.text).toBe(201)
  const rzp = res.body.payment.razorpayOrderId as string
  const late = await mock().simulatePayment(rzp, { outcome: 'late' })
  await deliver(late.events)
  await deliver(ok(await mock().simulatePayment(rzp, { outcome: 'success' })).events)
  const order = await orderByNumber(payload, res.body.order.number)
  expect(order.status).toBe('paid')
  const done = await mock().completeLateAuthorization(late.payment.id)
  const [auth, ...refundEvents] = done.events
  const rzpRefund = mock().inspect().refunds.find((r) => r.payment_id === late.payment.id)!
  expect(rzpRefund.receipt).toBeNull()
  return { order, late: late.payment, auth, refundEvents, rzpRefund, receipt: `${order.number}-dup-${late.payment.id.slice(-6)}` }
}

const noticeLog = (refundId: string) =>
  payload.find({ collection: 'message-log', where: { key: { equals: `refund:${refundId}` } }, overrideAccess: true })

describe('Razorpay refunds a late duplicate itself', () => {
  it('our refund call failed first: Razorpay\'s refund webhook settles our queued entry (one row, notice once)', async () => {
    const d = await lateDuplicate()
    mock().failNext('refund', 'network')
    expect((await deliver([d.auth]))[0].body.outcome).toBe('duplicate')
    await settle()
    expect((await reload(payload, d.order.id)).refunds).toEqual([expect.objectContaining({ receipt: d.receipt, status: 'queued', attempts: 1 })])

    await deliver(d.refundEvents)
    await settle()
    const stored = await reload(payload, d.order.id)
    expect(stored.refunds).toEqual([
      expect.objectContaining({ receipt: d.receipt, reason: 'duplicate_payment', refundId: d.rzpRefund.id, status: 'processed', paymentId: d.late.id }),
    ])
    expect(stored).toMatchObject({ status: 'paid', paymentStatus: 'captured' })
    expect((await noticeLog(d.rzpRefund.id)).docs).toHaveLength(1)
    const sweep = await reconcilePendingOrders(payload, { only: [d.order.id] })
    expect(sweep).toMatchObject({ refundOrders: 0, refundsIssued: 0 })
    expect(mock().inspect().refunds).toHaveLength(1)
  })

  it('no fault: our call finds Razorpay\'s refund; the webhook after it changes nothing', async () => {
    const d = await lateDuplicate()
    await deliver([d.auth])
    await settle()
    expect((await deliver(d.refundEvents))[0].body.outcome).toBe('refund_unchanged')
    const stored = await reload(payload, d.order.id)
    expect(stored.refunds).toEqual([expect.objectContaining({ receipt: d.receipt, refundId: d.rzpRefund.id, status: 'processed' })])
    expect((await noticeLog(d.rzpRefund.id)).docs).toHaveLength(1)
  })

  it('a row filed separately before (older data) is merged into ours by the next retry', async () => {
    const d = await lateDuplicate()
    const cur = await reload(payload, d.order.id)
    const rows = [
      { paymentId: d.late.id, amountPaise: d.rzpRefund.amount, receipt: d.receipt, reason: 'duplicate_payment', status: 'queued', attempts: 3, createdAt: new Date().toISOString() },
      { refundId: d.rzpRefund.id, paymentId: d.late.id, amountPaise: d.rzpRefund.amount, reason: 'external', status: 'processed', processedAt: new Date().toISOString() },
    ]
    await payload.update({ collection: 'orders', id: cur.id, data: { refunds: rows } as never, overrideAccess: true, context: { [CHECKOUT_CONTEXT]: true } })
    expect(await issueQueuedRefunds(payload, cur.id)).toBe(1)
    const stored = await reload(payload, cur.id)
    expect(stored.refunds).toEqual([expect.objectContaining({ receipt: d.receipt, refundId: d.rzpRefund.id, status: 'processed', reason: 'duplicate_payment' })])
    expect((await reconcilePendingOrders(payload, { only: [cur.id] })).refundOrders).toBe(0)
  })
})

describe('a duplicate that stays authorised (not_captured)', () => {
  const queuedRow = (paymentId: string, receipt: string, createdAt: string) => ({
    paymentId, amountPaise: 30000, receipt, reason: 'duplicate_payment', status: 'queued', attempts: 11, createdAt,
  })

  async function authorisedDuplicate(ageMs: number) {
    const d = await lateDuplicate()
    // An authorised-only payment of our own (Razorpay refuses to refund it until it is captured).
    const other = await mock().createOrder({ amountPaise: d.order.totalPaise, receipt: `${d.order.number}-a9`, notes: { wf_order: d.order.number } })
    const auth = await mock().simulatePayment(other.id, { outcome: 'authorize_only' })
    const row = queuedRow(auth.payment.id, `${d.order.number}-dup-${auth.payment.id.slice(-6)}`, new Date(Date.now() - ageMs).toISOString())
    await payload.update({ collection: 'orders', id: d.order.id, data: { refunds: [row] } as never, overrideAccess: true, context: { [CHECKOUT_CONTEXT]: true } })
    await issueQueuedRefunds(payload, d.order.id)
    return reload(payload, d.order.id)
  }

  it('keeps waiting for capture within Razorpay\'s auto-refund window', async () => {
    const stored = await authorisedDuplicate(DAY)
    expect(stored.refunds?.[0]).toMatchObject({ status: 'queued', attempts: 12, error: expect.stringContaining('not_captured') })
    expect(stored.reviewReason ?? '').not.toContain('refund it by hand')
  })

  it('gives up and flags a human once that window is long past', async () => {
    const stored = await authorisedDuplicate(8 * DAY)
    expect(stored.refunds?.[0]).toMatchObject({ status: 'failed', attempts: 12 })
    expect(stored.reviewReason).toContain('refund it by hand')
  })
})
