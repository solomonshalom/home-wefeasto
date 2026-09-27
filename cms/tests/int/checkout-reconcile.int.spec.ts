import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { expireOrder } from '@/commerce/checkout/expire'
import { reconcilePendingOrders } from '@/commerce/checkout/reconcile'
import { onOrderEvent, type OrderEvent } from '@/commerce/events'
import { resetRateLimits } from '@/lib/rateLimit'

import {
  checkoutBody,
  contactFor,
  deliver,
  freshMock,
  makeProduct,
  mock,
  orderByNumber,
  placeOrderVia,
  postCheckout,
  quoteTotal,
  reload,
  restoreEnv,
  settle,
  stockOf,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { deleteMessagesTo, settleAndList, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

/**
 * reconcilePendingOrders (the 5-minute cron): lost payments, expiry + release, late authorisations,
 * confirmation retries, queued refunds; the cron endpoint's auth and the Payload task. A fake clock is
 * passed as `now`; runs are scoped to the test's own orders with `only`.
 */

let payload: Payload
const events: OrderEvent[] = []
const unsubscribe: (() => void)[] = []
const MIN = 60_000

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  for (const type of ['order.confirmed', 'order.expired'] as const) {
    unsubscribe.push(onOrderEvent(type, `test:reconcile:${type}`, (e) => void events.push(e)))
  }
})

beforeEach(() => {
  freshMock()
  events.length = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  await settle()
  restoreEnv(['PAYMENTS_MODE'])
  resetRateLimits()
})

afterAll(async () => {
  for (const u of unsubscribe) u()
  await restoreStoreSettings(payload)
})

const eventsFor = (number: string, type?: string) => events.filter((e) => e.order.number === number && (!type || e.type === type))

async function pending(opts: { stock?: number; qty?: number; overrides?: Record<string, unknown> } = {}) {
  const p = await makeProduct(payload, { stock: opts.stock ?? 10 })
  const { res } = await placeOrderVia([{ slug: p.slug as string, qty: opts.qty ?? 2 }], opts.overrides ?? {})
  expect(res.status, res.text).toBe(201)
  const order = await orderByNumber(payload, res.body.order.number)
  return { product: p, order, rzpOrderId: res.body.payment.razorpayOrderId as string, token: res.body.order.token as string }
}

describe('A. unpaid online orders', () => {
  it('a captured payment nobody told us about (lost handler, no webhook) → paid via reconcile', async () => {
    const o = await pending()
    await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const summary = await reconcilePendingOrders(payload, { now: Date.now() + 11 * MIN, only: [o.order.id] })
    expect(summary).toMatchObject({ checked: 1, paid: 1, expired: 0, gatewayErrors: 0 })
    await settle()
    const stored = await reload(payload, o.order.id)
    expect(stored).toMatchObject({ status: 'paid', paidVia: 'reconcile', stockState: 'committed' })
    expect(stored.reconciledAt).toBeTruthy()
    expect(eventsFor(o.order.number, 'order.confirmed')).toHaveLength(1)
  })

  it('no payment and past reservedUntil → expired, stock and coupon released, order.expired', async () => {
    const c = await payload.create({ collection: 'coupons', data: { code: `REC${Date.now().toString(36).toUpperCase()}`, type: 'percent', value: 10, usedCount: 0, active: true, usageLimit: 1 } as never })
    const o = await pending({ stock: 3, qty: 2, overrides: { couponCode: c.code } })
    const failed = await mock().simulatePayment(o.rzpOrderId, { outcome: 'fail' })
    expect(await stockOf(payload, o.product.slug as string)).toBe(1)
    // Not yet: 10 minutes in, the reservation still holds.
    expect((await reconcilePendingOrders(payload, { now: Date.now() + 11 * MIN, only: [o.order.id] })).expired).toBe(0)
    expect((await reload(payload, o.order.id)).status).toBe('payment_failed') // the failed payment was logged
    const summary = await reconcilePendingOrders(payload, { now: Date.now() + 31 * MIN, only: [o.order.id] })
    expect(summary).toMatchObject({ expired: 1, paid: 0 })
    await settle()
    const stored = await reload(payload, o.order.id)
    expect(stored).toMatchObject({ status: 'expired', stockState: 'released' })
    expect(stored.razorpay?.payments?.[0]).toMatchObject({ paymentId: failed.payment.id, status: 'failed', via: 'reconcile' })
    expect(await stockOf(payload, o.product.slug as string)).toBe(3)
    const red = await payload.find({ collection: 'coupon-redemptions', where: { order: { equals: o.order.id } }, overrideAccess: true })
    expect(red.docs[0].status).toBe('released')
    expect(eventsFor(o.order.number, 'order.expired')).toHaveLength(1)
    // The code can be used by someone else now.
    const p = await makeProduct(payload, { pricePaise: 30000 })
    const again = await postCheckout(checkoutBody([{ slug: p.slug as string, qty: 2 }], 54000, { couponCode: c.code }))
    expect(again.status, again.text).toBe(201)
    // Idempotent: a second run changes nothing.
    const rerun = await reconcilePendingOrders(payload, { now: Date.now() + 31 * MIN, only: [o.order.id] })
    expect(rerun).toMatchObject({ checked: 0, expired: 0 })
  })

  it('never expires an order it could not check with the gateway', async () => {
    const o = await pending()
    mock().failNext('fetchOrderPayments', 'timeout')
    const summary = await reconcilePendingOrders(payload, { now: Date.now() + 31 * MIN, only: [o.order.id] })
    expect(summary).toMatchObject({ gatewayErrors: 1, expired: 0 })
    expect((await reload(payload, o.order.id)).status).toBe('pending_payment')
  })

  it('a Razorpay order the gateway doesn\'t know (keys switched) counts as unpaid; an order without attempts expires too', async () => {
    const o = await pending()
    mock().reset() // Razorpay forgot the order
    const p = await makeProduct(payload, { stock: 5 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    mock().failNext('createOrder', 'network')
    const noAttempt = await postCheckout(checkoutBody(items, await quoteTotal(items)))
    expect(noAttempt.status).toBe(503)
    const id2 = (await orderByNumber(payload, noAttempt.body.error.details.order.number)).id
    const summary = await reconcilePendingOrders(payload, { now: Date.now() + 31 * MIN, only: [o.order.id, id2] })
    expect(summary).toMatchObject({ checked: 2, expired: 2, gatewayErrors: 0 })
    expect(await stockOf(payload, p.slug as string)).toBe(5)
  })

  it('an authorized-only payment is found too (paymentStatus authorized, confirmed)', async () => {
    const o = await pending()
    await mock().simulatePayment(o.rzpOrderId, { outcome: 'authorize_only' })
    await reconcilePendingOrders(payload, { now: Date.now() + 31 * MIN, only: [o.order.id] })
    expect(await reload(payload, o.order.id)).toMatchObject({ status: 'paid', paymentStatus: 'authorized' })
  })
})

describe('B. late authorisations on expired orders', () => {
  it('an expired order whose late payment was captured without a webhook → paid, stock re-reserved', async () => {
    const o = await pending({ stock: 4, qty: 2 })
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'late' })
    await expireOrder(payload, o.order.id, { now: Date.now() + 31 * MIN })
    await mock().completeLateAuthorization(r.payment.id) // webhooks never delivered
    const summary = await reconcilePendingOrders(payload, { now: Date.now() + 40 * MIN, only: [o.order.id] })
    expect(summary).toMatchObject({ lateChecked: 1, latePaid: 1 })
    expect(await reload(payload, o.order.id)).toMatchObject({ status: 'paid', stockState: 'committed', paidVia: 'reconcile' })
    expect(await stockOf(payload, o.product.slug as string)).toBe(2)
    // Checked at most hourly.
    const again = await reconcilePendingOrders(payload, { now: Date.now() + 50 * MIN, only: [o.order.id] })
    expect(again.lateChecked).toBe(0)
  })
})

describe('C. confirmation emails that never went out', () => {
  it('re-sends once, stamps confirmationSentAt and re-emits order.confirmed', async () => {
    const p = await makeProduct(payload)
    const contact = contactFor('retry-mail')
    await deleteMessagesTo(contact.email)
    const items = [{ slug: p.slug as string, qty: 2 }]
    const spy = vi.spyOn(payload, 'sendEmail').mockRejectedValue(new Error('SMTP down'))
    const res = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact }))
    expect(res.status).toBe(201)
    await settle()
    spy.mockRestore()
    const order = await orderByNumber(payload, res.body.order.number)
    expect(order.confirmationSentAt ?? null).toBeNull()
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: `confirm:${order.number}` } }, overrideAccess: true })
    expect(log.docs[0].status).toBe('failed')
    // Too recent for the sweep (the normal path gets 2 minutes).
    expect((await reconcilePendingOrders(payload, { now: Date.now(), only: [order.id] })).confirmationsRetried).toBe(0)
    events.length = 0
    const summary = await reconcilePendingOrders(payload, { now: Date.now() + 3 * MIN, only: [order.id] })
    expect(summary.confirmationsRetried).toBe(1)
    await waitForMessages(contact.email, { subject: order.number })
    expect((await reload(payload, order.id)).confirmationSentAt).toBeTruthy()
    expect(eventsFor(order.number, 'order.confirmed')).toHaveLength(1)
    expect((await reconcilePendingOrders(payload, { now: Date.now() + 3 * MIN, only: [order.id] })).confirmationsRetried).toBe(0)
    expect(await settleAndList(contact.email)).toHaveLength(1)
  })
})

describe('D. queued automatic refunds', () => {
  it('a duplicate that was only authorized can\'t be refunded yet; after capture the sweep refunds it', async () => {
    const o = await pending()
    const pay1 = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    await deliver(pay1.events)
    const retryRzp = await mock().createOrder({ amountPaise: o.order.totalPaise, receipt: `${o.order.number}-a2`, notes: { wf_order: o.order.number } })
    // Record a2 as an attempt the way /retry would (the order is paid, so /retry itself would refuse).
    const cur = await reload(payload, o.order.id)
    await payload.update({
      collection: 'orders',
      id: o.order.id,
      data: { razorpay: { ...cur.razorpay, attempts: [...(cur.razorpay?.attempts ?? []), { orderId: retryRzp.id, receipt: retryRzp.receipt!, amount: retryRzp.amount, status: 'created' }] } } as never,
      context: { wfCheckout: true },
    })
    const pay2 = await mock().simulatePayment(retryRzp.id, { outcome: 'authorize_only' })
    const d = await deliver(pay2.events)
    expect(d[0].body.outcome).toBe('duplicate')
    await settle()
    let stored = await reload(payload, o.order.id)
    expect(stored.refunds?.[0]).toMatchObject({ paymentId: pay2.payment.id, status: 'queued', attempts: 1, error: expect.stringContaining('not_captured') })
    expect((await reconcilePendingOrders(payload, { only: [o.order.id] })).refundsIssued).toBe(0)
    await mock().capturePayment(pay2.payment.id)
    const summary = await reconcilePendingOrders(payload, { only: [o.order.id] })
    expect(summary).toMatchObject({ refundOrders: 1, refundsIssued: 1 })
    stored = await reload(payload, o.order.id)
    expect(stored.refunds?.[0]).toMatchObject({ status: 'processed', receipt: `${o.order.number}-dup-${pay2.payment.id.slice(-6)}` })
    expect(stored.status).toBe('paid')
  })

  it('gives up after repeated gateway errors: refund marked failed, order flagged for a human', async () => {
    const o = await pending()
    const pay1 = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    await deliver(pay1.events)
    const cur = await reload(payload, o.order.id)
    await payload.update({
      collection: 'orders',
      id: o.order.id,
      data: { refunds: [{ paymentId: 'pay_Unrefundable000001', amountPaise: 100, receipt: `${o.order.number}-dup-000001`, reason: 'duplicate_payment', status: 'queued', attempts: 11 }], razorpay: cur.razorpay } as never,
      context: { wfCheckout: true },
    })
    mock().failNext('refund', 'server')
    await reconcilePendingOrders(payload, { only: [o.order.id] })
    const stored = await reload(payload, o.order.id)
    expect(stored.refunds?.[0]).toMatchObject({ status: 'failed', attempts: 12 })
    expect(stored.reviewReason).toContain('refund it by hand')
  })
})

describe('cron endpoint and job', () => {
  it('GET /api/payments/reconcile: 401 without / with a wrong bearer; 200 for Vercel Cron (Bearer CRON_SECRET) or an admin', async () => {
    expect((await restGet('payments/reconcile')).status).toBe(401)
    expect((await restGet('payments/reconcile', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    const cron = await restGet('payments/reconcile', { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, query: { limit: '1', budgetMs: '2000' } })
    expect(cron.status, cron.text).toBe(200)
    expect(cron.body).toMatchObject({ ok: true, checked: expect.any(Number), expired: expect.any(Number) })
    const admin = await createStaff(payload, 'admin')
    const { token } = await login('users', admin.email)
    expect((await restGet('payments/reconcile', { token, query: { limit: '1', budgetMs: '2000' } })).status).toBe(200)
    // "Reconcile now" for one order.
    const o = await pending()
    await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const one = await restGet('payments/reconcile', { token, query: { order: o.order.number } })
    expect(one.body).toMatchObject({ ok: true, checked: 1, paid: 1, expired: 0 })
    expect(await reload(payload, o.order.id)).toMatchObject({ status: 'paid', paidVia: 'reconcile' })
    expect((await restGet('payments/reconcile', { token, query: { order: 'WF-00000' } })).status).toBe(404)
    // Only GET exists.
    expect((await restPost('payments/reconcile', {})).status).toBe(404)
  })

  it('the reconcilePendingOrders Payload task runs from the jobs queue', async () => {
    const job = await payload.jobs.queue({ task: 'reconcilePendingOrders', input: { limit: 1, budgetMs: 2000 } })
    const res = await payload.jobs.run({ limit: 5 })
    expect(res.jobStatus?.[String(job.id)]?.status).toBe('success')
  })
})
