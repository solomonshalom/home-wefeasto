import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { expireOrder } from '@/commerce/checkout/expire'
import { onOrderEvent, type OrderEvent } from '@/commerce/events'
import { resetRateLimits } from '@/lib/rateLimit'
import { resetGateway, signWebhook } from '@/payments'
import type { GatewayPayment } from '@/payments/types'

import {
  checkoutBody,
  contactFor,
  deliver,
  failed,
  ok,
  freshMock,
  makeProduct,
  mock,
  orderByNumber,
  placeOrderVia,
  postCheckout,
  postWebhook,
  quoteTotal,
  reload,
  restoreEnv,
  settle,
  stockOf,
  verify,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'
import { createStaff, login } from './helpers/factories'
import { restPatch, restPost } from './helpers/rest'

/**
 * Payment confirmation paths (SPEC §6, razorpay.md §12–13): client verify, the redirect callback, webhooks
 * (dedupe, order, late authorisation, duplicates, mismatches, orphans, signatures), retry attempts, refunds
 * and disputes. Webhooks are the mock's exact signed bytes delivered to the real receiver.
 */

let payload: Payload
const events: OrderEvent[] = []
const unsubscribe: (() => void)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  for (const type of ['order.confirmed', 'order.payment_failed', 'order.refunded', 'order.expired'] as const) {
    unsubscribe.push(onOrderEvent(type, `test:payments:${type}`, (e) => void events.push(e)))
  }
})

beforeEach(() => {
  freshMock()
  events.length = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  await settle()
  restoreEnv(['PAYMENTS_MODE', 'RATE_LIMIT_DISABLED', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_OLD'])
  resetGateway()
  resetRateLimits()
})

afterAll(async () => {
  for (const u of unsubscribe) u()
  await restoreStoreSettings(payload)
})

const eventsFor = (number: string, type?: string) => events.filter((e) => e.order.number === number && (!type || e.type === type))

/** An online order with its PaymentInit (fresh product, stock 10 unless given). */
async function onlineOrder(opts: { stock?: number; pricePaise?: number; qty?: number; overrides?: Record<string, unknown> } = {}) {
  const p = await makeProduct(payload, { stock: opts.stock ?? 10, pricePaise: opts.pricePaise ?? 25000 })
  const { res, body } = await placeOrderVia([{ slug: p.slug as string, qty: opts.qty ?? 2 }], opts.overrides ?? {})
  expect(res.status, res.text).toBe(201)
  const { order, payment } = res.body
  return { product: p, number: order.number as string, token: order.token as string, rzpOrderId: payment.razorpayOrderId as string, total: order.totalPaise as number, body }
}

describe('POST /api/store/checkout/verify', () => {
  it('happy path: signature + fetchPayment → paid (client), coupon consumed, stock committed, order.confirmed once', async () => {
    const c = await payload.create({ collection: 'coupons', data: { code: `VER${Date.now().toString(36).toUpperCase()}`, type: 'percent', value: 10, usedCount: 0, active: true } as never })
    const o = await onlineOrder({ overrides: { couponCode: c.code } })
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success', method: 'upi' })
    expect(r.ok).toBe(true)
    const res = await verify(o.number, o.token, ok(r).response)
    expect(res.status, res.text).toBe(200)
    expect(res.body.order).toMatchObject({ number: o.number, status: 'paid', paymentStatus: 'captured', isConfirmed: true, canRetryPayment: false })
    const stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'paid', paidVia: 'client', stockState: 'committed', razorpay: { paymentId: r.payment.id, method: 'upi' } })
    expect(stored.paidAt).toBeTruthy()
    expect(stored.razorpay?.attempts?.[0].status).toBe('paid')
    expect(stored.statusHistory?.at(-1)).toMatchObject({ field: 'paymentStatus', to: 'captured', source: 'client' })
    expect(stored.statusHistory?.find((h) => h.to === 'paid')).toMatchObject({ from: 'pending_payment', source: 'client' })
    expect(await stockOf(payload, o.product.slug as string)).toBe(8)
    expect((await payload.findByID({ collection: 'coupons', id: c.id })).usedCount).toBe(1)
    const red = await payload.find({ collection: 'coupon-redemptions', where: { order: { equals: stored.id } }, overrideAccess: true })
    expect(red.docs[0]).toMatchObject({ status: 'consumed' })
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
    expect(eventsFor(o.number, 'order.confirmed')[0]).toMatchObject({ previousStatus: 'pending_payment', source: 'client' })

    // Replay of the same triple: 200, nothing new.
    const again = await verify(o.number, o.token, ok(r).response)
    expect(again.status).toBe(200)
    expect(again.body.order.status).toBe('paid')
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
    expect((await payload.findByID({ collection: 'coupons', id: c.id })).usedCount).toBe(1)
  })

  it('bad signature → 400 SIGNATURE_INVALID and no state change', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }))
    const tampered = { ...r.response, razorpay_signature: r.response.razorpay_signature.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a')) }
    const res = await verify(o.number, o.token, tampered)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('SIGNATURE_INVALID')
    expect(res.body.error.message).not.toMatch(/fail/i)
    expect((await orderByNumber(payload, o.number)).status).toBe('pending_payment')
  })

  it('someone else\'s order, a wrong token or an unknown Razorpay order → the same 404', async () => {
    const mine = await onlineOrder()
    const theirs = await onlineOrder()
    const r = ok(await mock().simulatePayment(theirs.rzpOrderId, { outcome: 'success' }))
    const cross = await verify(mine.number, mine.token, r.response)
    const wrongToken = await verify(theirs.number, mine.token, r.response)
    const unknown = await verify(theirs.number, theirs.token, { ...r.response, razorpay_order_id: 'order_Unknown00000000001' })
    for (const res of [cross, wrongToken, unknown]) {
      expect(res.status).toBe(404)
      expect(res.text).toBe(cross.text)
    }
    expect((await orderByNumber(payload, theirs.number)).status).toBe('pending_payment')
    expect((await orderByNumber(payload, mine.number)).status).toBe('pending_payment')
  })

  it('malformed input → 400 VALIDATION', async () => {
    const o = await onlineOrder()
    for (const body of [{}, { number: o.number, token: o.token, razorpay_order_id: 'x', razorpay_payment_id: 'y', razorpay_signature: 'z' }]) {
      const res = await restPost('store/checkout/verify', { body })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION')
    }
  })

  it('an authorized (not yet captured) payment confirms the order; the capture webhook upgrades paymentStatus', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'authorize_only' }))
    const res = await verify(o.number, o.token, r.response)
    expect(res.body.order).toMatchObject({ status: 'paid', paymentStatus: 'authorized' })
    const cap = await mock().capturePayment(r.payment.id)
    const d = await deliver(cap.events)
    expect(d.map((x) => x.body.outcome)).toEqual(['already_paid', 'already_paid'])
    const stored = await orderByNumber(payload, o.number)
    expect(stored.paymentStatus).toBe('captured')
    expect(stored.razorpay?.capturedAt).toBeTruthy()
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
  })

  it('gateway down during fetchPayment → 202 with the unchanged order; the webhook settles it later', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }))
    mock().failNext('fetchPayment', 'timeout')
    const res = await verify(o.number, o.token, r.response)
    expect(res.status).toBe(202)
    expect(res.body.order).toMatchObject({ status: 'pending_payment', isConfirmed: false })
    const d = await deliver(r.events)
    expect(d[0].body.outcome).toBe('paid')
    expect((await orderByNumber(payload, o.number)).paidVia).toBe('webhook')
  })

  it('webhook before verify: verify answers 200 with the paid order (not an error)', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }))
    const d = await deliver(r.events)
    expect(d.map((x) => x.status)).toEqual([200, 200, 200])
    expect(d.map((x) => x.body.outcome)).toEqual(['paid', 'already_paid', 'already_paid'])
    const res = await verify(o.number, o.token, r.response)
    expect(res.status).toBe(200)
    expect(res.body.order.status).toBe('paid')
    const stored = await orderByNumber(payload, o.number)
    expect(stored.paidVia).toBe('webhook')
    expect(stored.paymentStatus).toBe('captured')
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
  })
})

describe('POST /api/payments/razorpay/webhook', () => {
  it('signature: missing / tampered / re-serialised body → 400 and nothing stored; the _OLD secret still verifies', async () => {
    const o = await onlineOrder()
    // '/' and non-ASCII are escaped PHP-style in Razorpay's bytes, so re-serialising changes them.
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success', description: 'Wefeasto — oats / muesli ₹' })
    const built = mock().buildWebhook(r.events[2].event, r.events[2].entities)
    expect(JSON.stringify(JSON.parse(built.body))).not.toBe(built.body)
    const missing = await restPost('payments/razorpay/webhook', { rawBody: built.body, contentType: 'application/json', headers: { 'x-razorpay-event-id': built.eventId } })
    const tampered = await postWebhook({ ...built, body: built.body.replace('"captured"', '"authorized"') })
    const reserialised = await postWebhook({ ...built, body: JSON.stringify(JSON.parse(built.body)) })
    for (const res of [missing, tampered, reserialised]) {
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('SIGNATURE_INVALID')
    }
    expect(await payload.count({ collection: 'payment-events', where: { eventId: { equals: built.eventId } }, overrideAccess: true })).toEqual({ totalDocs: 0 })
    expect((await orderByNumber(payload, o.number)).status).toBe('pending_payment')

    // Secret rotation: the previous secret is accepted too.
    process.env.RAZORPAY_WEBHOOK_SECRET = 'rotated-webhook-secret-new-0001'
    process.env.RAZORPAY_WEBHOOK_SECRET_OLD = 'rotated-webhook-secret-old-0001'
    resetGateway()
    const res = await postWebhook({ ...built, signature: signWebhook(built.body, 'rotated-webhook-secret-old-0001') })
    expect(res.status, res.text).toBe(200)
    expect(res.body.outcome).toBe('paid')
  })

  it('dedupe: the same event id twice → second is "duplicate" with no side effects', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const first = await deliver([r.events[1]], { eventId: 'evt_dedupe_' + o.number })
    const second = await deliver([r.events[1]], { eventId: 'evt_dedupe_' + o.number })
    expect(first[0].body).toEqual({ ok: true, outcome: 'paid' })
    expect(second[0].body).toEqual({ ok: true, outcome: 'duplicate' })
    const rows = await payload.find({ collection: 'payment-events', where: { eventId: { equals: 'evt_dedupe_' + o.number } }, overrideAccess: true })
    expect(rows.docs).toHaveLength(1)
    expect(rows.docs[0]).toMatchObject({ event: 'payment.captured', outcome: 'paid', entityId: r.payment.id })
    expect(rows.docs[0].processedAt).toBeTruthy()
    // The stored copy carries ids and statuses only (no email / phone).
    expect(JSON.stringify(rows.docs[0].payload)).not.toContain('@')
    expect(JSON.stringify(rows.docs[0].payload)).not.toContain(o.body.contact.phone)
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
  })

  it('an event claimed but never finished (crash / DB error → 500) is processed on redelivery', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const eventId = 'evt_retry_' + o.number
    const realUpdate = payload.update.bind(payload)
    const spy = vi.spyOn(payload, 'update').mockImplementation((async (args: any) => {
      if (args.collection === 'orders') throw new Error('connection terminated unexpectedly')
      return realUpdate(args)
    }) as never)
    const failed = await deliver([r.events[1]], { eventId })
    expect(failed[0].status).toBe(500)
    expect(failed[0].body.error.code).toBe('INTERNAL')
    spy.mockRestore()
    expect((await orderByNumber(payload, o.number)).status).toBe('pending_payment')
    const retried = await deliver([r.events[1]], { eventId })
    expect(retried[0].body).toEqual({ ok: true, outcome: 'paid' })
    expect((await orderByNumber(payload, o.number)).status).toBe('paid')
  })

  it('out of order: order.paid/payment.captured before payment.authorized → paid once, captured never downgraded', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const d = await deliver([...r.events].reverse())
    expect(d.map((x) => x.body.outcome)).toEqual(['paid', 'already_paid', 'already_paid'])
    const stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'paid', paymentStatus: 'captured' })
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
  })

  it('payment.failed → payment_failed (+ event); a failed attempt delivered after another attempt paid changes nothing', async () => {
    const o = await onlineOrder()
    const fail = await mock().simulatePayment(o.rzpOrderId, { outcome: 'fail', reason: 'card_declined', method: 'card' })
    const d1 = await deliver(fail.events)
    expect(d1[0].body.outcome).toBe('payment_failed')
    let stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'payment_failed', paymentStatus: 'failed' })
    expect(stored.razorpay?.payments?.[0]).toMatchObject({ paymentId: fail.payment.id, status: 'failed', errorReason: 'card_declined', via: 'webhook' })
    await settle()
    expect(eventsFor(o.number, 'order.payment_failed')).toHaveLength(1)
    // Same failure again (Razorpay retry with a new event id): no second event.
    await deliver(fail.events)
    await settle()
    expect(eventsFor(o.number, 'order.payment_failed')).toHaveLength(1)

    // In-modal retry on the same Razorpay order succeeds.
    const ok = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    await deliver(ok.events)
    stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'paid', paymentStatus: 'captured' })
    // A late copy of the first failure: still paid.
    const late = await deliver(fail.events)
    expect(late[0].body.outcome).toBe('payment_failed_duplicate')
    expect((await orderByNumber(payload, o.number)).status).toBe('paid')
  })

  it('late authorisation of a failed payment while still pending → paid', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'late' })
    await deliver(r.events)
    expect((await orderByNumber(payload, o.number)).status).toBe('payment_failed')
    const late = await mock().completeLateAuthorization(r.payment.id)
    const d = await deliver(late.events)
    expect(d[0].body.outcome).toBe('paid')
    const stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'paid', stockState: 'committed', razorpay: { paymentId: r.payment.id } })
  })

  it('late authorisation after expiry, stock available → paid, stock re-reserved', async () => {
    const o = await onlineOrder({ stock: 5, qty: 2 })
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'late' })
    await deliver(r.events)
    const id = (await orderByNumber(payload, o.number)).id
    expect((await expireOrder(payload, id, { now: Date.now() + 31 * 60_000 })).outcome).toBe('expired')
    expect(await stockOf(payload, o.product.slug as string)).toBe(5)
    const late = await mock().completeLateAuthorization(r.payment.id)
    const d = await deliver(late.events)
    expect(d[0].body.outcome).toBe('paid')
    const stored = await reload(payload, id)
    expect(stored).toMatchObject({ status: 'paid', stockState: 'committed' })
    expect(await stockOf(payload, o.product.slug as string)).toBe(3)
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')[0]).toMatchObject({ previousStatus: 'expired', source: 'webhook' })
  })

  it('late authorisation after expiry, stock gone → needs_review + automatic full refund (<no>-oos-…)', async () => {
    const o = await onlineOrder({ stock: 2, qty: 2 })
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'late' })
    const id = (await orderByNumber(payload, o.number)).id
    await expireOrder(payload, id, { now: Date.now() + 31 * 60_000 })
    // Someone else buys the released stock.
    const other = await postCheckout(checkoutBody([{ slug: o.product.slug as string, qty: 2 }], o.total))
    expect(other.status).toBe(201)
    const late = await mock().completeLateAuthorization(r.payment.id)
    const d = await deliver(late.events)
    expect(d[0].body.outcome).toBe('refund_out_of_stock')
    await settle()
    const stored = await reload(payload, id)
    expect(stored.status).toBe('refunded')
    expect(stored.reviewReason).toContain('out of stock')
    expect(stored.refunds?.[0]).toMatchObject({ reason: 'out_of_stock', status: 'processed', receipt: `${o.number}-oos-${r.payment.id.slice(-6)}`, paymentId: r.payment.id })
    expect(stored.statusHistory?.map((h) => (h.field === 'status' ? h.to : null)).filter(Boolean)).toEqual(['pending_payment', 'expired', 'needs_review', 'refunded'])
    expect(await stockOf(payload, o.product.slug as string)).toBe(0)
    expect(mock().inspect().refunds.map((x) => x.payment_id)).toEqual([r.payment.id])
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(0)
    expect(eventsFor(o.number, 'order.refunded')).toHaveLength(1)
  })

  it('two Razorpay orders both paid → the second payment is refunded automatically (<no>-dup-…); the order stays paid', async () => {
    const o = await onlineOrder()
    const a1 = await mock().simulatePayment(o.rzpOrderId, { outcome: 'fail' })
    await deliver(a1.events)
    const retry = await restPost('store/checkout/retry', { body: { number: o.number, token: o.token } })
    expect(retry.status, retry.text).toBe(200)
    const a2Id = retry.body.payment.razorpayOrderId
    expect(a2Id).not.toBe(o.rzpOrderId)
    const pay2 = await mock().simulatePayment(a2Id, { outcome: 'success' })
    await deliver(pay2.events)
    // The first window was still open in another tab and gets paid too.
    const pay1 = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const d = await deliver(pay1.events)
    expect(d.map((x) => x.body.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate'])
    await settle()
    const stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'paid', paymentStatus: 'captured', razorpay: { paymentId: pay2.payment.id } })
    expect(stored.refunds).toHaveLength(1)
    expect(stored.refunds?.[0]).toMatchObject({
      paymentId: pay1.payment.id,
      receipt: `${o.number}-dup-${pay1.payment.id.slice(-6)}`,
      reason: 'duplicate_payment',
      status: 'processed',
      amountPaise: o.total,
    })
    expect(mock().inspect().refunds).toHaveLength(1)
    expect(mock().inspect().refunds[0]).toMatchObject({ payment_id: pay1.payment.id, amount: o.total })
    // The refund.processed webhook for it later changes nothing about the order.
    const refundEvt = mock().buildWebhook('refund.processed', { refund: mock().inspect().refunds[0], payment: mock().inspect().payments.find((p) => p.id === pay1.payment.id)! })
    const res = await postWebhook(refundEvt)
    expect(res.body.outcome).toBe('refund_unchanged')
    expect((await orderByNumber(payload, o.number)).status).toBe('paid')
    await settle()
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
    expect(eventsFor(o.number, 'order.refunded')).toHaveLength(0)
  })

  it('amount / currency mismatch (incl. a partial payment) → never paid: needs_review + alert', async () => {
    for (const change of [{ amount: 100 }, { currency: 'USD' }]) {
      const o = await onlineOrder()
      const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
      const payment = { ...r.payment, ...change }
      const res = await postWebhook(mock().buildWebhook('payment.captured', { payment }))
      expect(res.status).toBe(200)
      expect(res.body.outcome).toBe('amount_mismatch')
      const stored = await orderByNumber(payload, o.number)
      expect(stored.status).toBe('needs_review')
      expect(stored.razorpay?.paymentId ?? null).toBeNull()
      expect(stored.reviewReason).toContain('Amount mismatch')
      expect(stored.paidAt ?? null).toBeNull()
      await settle()
      expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(0)
    }
  })

  it('unknown Razorpay order → 200 "orphan" (logged, never refunded)', async () => {
    const stray = await mock().createOrder({ amountPaise: 12345, receipt: `OTHER-${Date.now()}`, notes: {} })
    const r = await mock().simulatePayment(stray.id, { outcome: 'success' })
    const d = await deliver(r.events)
    expect(d.map((x) => [x.status, x.body.outcome])).toEqual([
      [200, 'orphan'],
      [200, 'orphan'],
      [200, 'orphan'],
    ])
    expect(mock().inspect().refunds).toEqual([])
    const row = await payload.find({ collection: 'payment-events', where: { eventId: { equals: d[0].delivery.eventId } }, overrideAccess: true })
    expect(row.docs[0].outcome).toBe('orphan')
  })

  it('an orphan payment that carries our notes + receipt (lost createOrder response) is attached and marks the order paid', async () => {
    const p = await makeProduct(payload)
    const items = [{ slug: p.slug as string, qty: 2 }]
    mock().failNext('createOrder', 'network', { commit: true })
    const res = await postCheckout(checkoutBody(items, await quoteTotal(items)))
    expect(res.status).toBe(503)
    const number = res.body.error.details.order.number
    const [rzp] = mock().inspect().orders
    expect(rzp.receipt).toBe(`${number}-a1`)
    const r = await mock().simulatePayment(rzp.id, { outcome: 'success' })
    const d = await deliver(r.events)
    expect(d[0].body.outcome).toBe('paid')
    const stored = await orderByNumber(payload, number)
    expect(stored).toMatchObject({ status: 'paid', paidVia: 'webhook' })
    expect(stored.razorpay?.attempts?.map((a) => a.orderId)).toEqual([rzp.id])
  })

  it('non-event JSON with a valid signature → 200 "ignored"; unknown event types → "ignored"', async () => {
    const body = JSON.stringify({ hello: 'world' })
    const res = await postWebhook({ body, signature: signWebhook(body, 'wefeasto-mock-webhook-secret-dev-only'), eventId: 'evt_nonevent' })
    expect(res.body).toEqual({ ok: true, outcome: 'ignored' })
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'authorize_only' })
    const other = await postWebhook(mock().buildWebhook('payment.downtime.started', { payment: r.payment }))
    expect(other.body).toEqual({ ok: true, outcome: 'ignored' })
  })

  it('an old event (created_at 30 days ago) is processed normally: no age-based rejection, idempotency does the work', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const old = mock().buildWebhook(r.events[1].event, r.events[1].entities, { createdAt: Math.floor(Date.now() / 1000) - 30 * 86_400 })
    const res = await postWebhook(old)
    expect(res.body).toEqual({ ok: true, outcome: 'paid' })
  })

  it('responds well within Razorpay\'s 5 s budget', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const started = Date.now()
    await deliver(r.events)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('refund and dispute webhooks', () => {
  async function paidOrder() {
    const o = await onlineOrder({ pricePaise: 30000, qty: 2 })
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    await deliver(r.events)
    return { ...o, payment: r.payment }
  }

  it('a partial refund from the Dashboard → partially_refunded; the rest → refunded (+ order.refunded each time)', async () => {
    const o = await paidOrder()
    const part = await mock().refund(o.payment.id, { amountPaise: 20000, receipt: `${o.number}-r1` })
    const pay = () => mock().inspect().payments.find((p) => p.id === o.payment.id)!
    const d1 = await postWebhook(mock().buildWebhook('refund.processed', { refund: part, payment: pay() }))
    expect(d1.body.outcome).toBe('refund_recorded')
    let stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'partially_refunded', paymentStatus: 'partially_refunded' })
    expect(stored.refunds?.[0]).toMatchObject({ refundId: part.id, amountPaise: 20000, status: 'processed', reason: 'external' })
    const rest = await mock().refund(o.payment.id, { receipt: `${o.number}-r2` })
    await postWebhook(mock().buildWebhook('refund.processed', { refund: rest, payment: pay() }))
    stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'refunded', paymentStatus: 'refunded' })
    await settle()
    expect(eventsFor(o.number, 'order.refunded').map((e) => e.order.status)).toEqual(['partially_refunded', 'refunded'])
    // refund.created arriving late never downgrades a processed refund.
    const lateCreated = await postWebhook(mock().buildWebhook('refund.created', { refund: { ...rest, status: 'pending' }, payment: pay() }))
    expect(lateCreated.body.outcome).toBe('refund_unchanged')
  })

  it('refund.failed → the refund is marked failed and the order flagged for a human', async () => {
    const o = await paidOrder()
    const refund = await mock().refund(o.payment.id, { amountPaise: 10000, receipt: `${o.number}-r1` })
    const res = await postWebhook(mock().buildWebhook('refund.failed', { refund: { ...refund, status: 'failed' }, payment: o.payment }))
    expect(res.body.outcome).toBe('refund_recorded')
    const stored = await orderByNumber(payload, o.number)
    expect(stored.refunds?.[0]).toMatchObject({ refundId: refund.id, status: 'failed' })
    expect(stored.reviewReason).toContain('FAILED')
    expect(stored.status).toBe('paid')
  })

  it('payment.dispute.created → needs_review (fulfilment on hold) + dispute details', async () => {
    const o = await paidOrder()
    const body = JSON.stringify({
      entity: 'event',
      account_id: 'acc_WefeastoMock01',
      event: 'payment.dispute.created',
      contains: ['dispute', 'payment'],
      payload: {
        dispute: { entity: { id: 'disp_Mock0000000001', entity: 'dispute', payment_id: o.payment.id, amount: o.total, currency: 'INR', reason_code: 'chargeback', status: 'open', phase: 'chargeback' } },
        payment: { entity: o.payment },
      },
      created_at: Math.floor(Date.now() / 1000),
    })
    const res = await postWebhook({ body, signature: signWebhook(body, 'wefeasto-mock-webhook-secret-dev-only'), eventId: `evt_disp_${o.number}` })
    expect(res.body.outcome).toBe('dispute_flagged')
    const stored = await orderByNumber(payload, o.number)
    expect(stored.status).toBe('needs_review')
    expect(stored.dispute).toMatchObject({ disputeId: 'disp_Mock0000000001', status: 'open', phase: 'chargeback', reasonCode: 'chargeback', amountPaise: o.total })
    expect(stored.reviewReason).toContain('Chargeback')
    // Packing is refused while in review (the admin guard uses canFulfil).
    const admin = await createStaff(payload, 'admin')
    const { token } = await login('users', admin.email)
    const pack = await restPatch(`orders/${stored.id}`, { body: { fulfilmentStatus: 'packed' }, token })
    expect(pack.status).toBe(400)
    expect((await orderByNumber(payload, o.number)).fulfilmentStatus).toBe('unfulfilled')
  })
})

describe('POST /api/payments/razorpay/callback (redirect mode, no cookies)', () => {
  const callback = (no: string, t: string, form: Record<string, string>) =>
    restPost('payments/razorpay/callback', { rawBody: new URLSearchParams(form), contentType: 'application/x-www-form-urlencoded', query: { no, t }, origin: 'https://api.razorpay.com' })

  it('success fields → verified + paid (callback) → 303 to /order?no=&t=', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }))
    const res = await callback(o.number, o.token, r.response)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`http://localhost:5173/order?no=${o.number}&t=${o.token}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.text).toBe('')
    expect(await orderByNumber(payload, o.number)).toMatchObject({ status: 'paid', paidVia: 'callback' })
  })

  it('error[...] fields → 303 with &payment=failed&reason=…; the failure is recorded after the gateway confirms it', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'fail', reason: 'card_declined' })
    const e = failed(r).error
    const res = await callback(o.number, o.token, {
      'error[code]': e.code,
      'error[description]': e.description,
      'error[source]': e.source,
      'error[step]': e.step,
      'error[reason]': e.reason,
      'error[metadata]': JSON.stringify(e.metadata),
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`http://localhost:5173/order?no=${o.number}&t=${o.token}&payment=failed&reason=card_declined`)
    const stored = await orderByNumber(payload, o.number)
    expect(stored).toMatchObject({ status: 'payment_failed' })
    expect(stored.razorpay?.payments?.[0]).toMatchObject({ status: 'failed', via: 'callback', errorReason: 'card_declined' })
  })

  it('forged error POST (payment not failed at the gateway) records nothing; odd reasons are dropped from the URL', async () => {
    const o = await onlineOrder()
    const res = await callback(o.number, o.token, {
      'error[code]': 'BAD_REQUEST_ERROR',
      'error[reason]': '<script>',
      'error[metadata]': JSON.stringify({ order_id: o.rzpOrderId, payment_id: 'pay_Forged00000000001' }),
    })
    expect(res.headers.get('location')).toBe(`http://localhost:5173/order?no=${o.number}&t=${o.token}&payment=failed`)
    expect((await orderByNumber(payload, o.number)).status).toBe('pending_payment')
  })

  it('bad signature, unknown order, wrong token, junk → a plain 303 to /order, no state change', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }))
    const bad = await callback(o.number, o.token, { ...r.response, razorpay_signature: '0'.repeat(64) })
    expect(bad.status).toBe(303)
    expect(bad.headers.get('location')).toBe(`http://localhost:5173/order?no=${o.number}&t=${o.token}`)
    const unknown = await callback('WF-99998', o.token, r.response)
    expect(unknown.headers.get('location')).toBe(`http://localhost:5173/order?no=WF-99998&t=${o.token}`)
    const junk = await callback('javascript:alert(1)', '"><script>', {})
    expect(junk.headers.get('location')).toBe('http://localhost:5173/order')
    const json = await restPost('payments/razorpay/callback', { body: { a: 1 }, query: { no: o.number, t: o.token } })
    expect(json.status).toBe(303)
    expect((await orderByNumber(payload, o.number)).status).toBe('pending_payment')
  })
})

describe('POST /api/store/checkout/retry', () => {
  const retry = (number: string, token: string) => restPost('store/checkout/retry', { body: { number, token } })

  it('opens a new Razorpay order <no>-a2, extends the reservation', async () => {
    const o = await onlineOrder()
    const before = await orderByNumber(payload, o.number)
    await new Promise((r) => setTimeout(r, 20))
    const res = await retry(o.number, o.token)
    expect(res.status, res.text).toBe(200)
    expect(res.body.order).toMatchObject({ number: o.number, token: o.token, status: 'pending_payment' })
    expect(res.body.payment.razorpayOrderId).not.toBe(o.rzpOrderId)
    const stored = await orderByNumber(payload, o.number)
    expect(stored.razorpay?.attempts?.map((a) => a.receipt)).toEqual([`${o.number}-a1`, `${o.number}-a2`])
    expect(Date.parse(stored.reservedUntil as string)).toBeGreaterThan(Date.parse(before.reservedUntil as string))
  })

  it('unknown order / wrong token → the same 404; COD → 409 NOT_RETRYABLE; paid → 409 ALREADY_PAID {order}', async () => {
    const o = await onlineOrder()
    const other = await onlineOrder()
    const a = await retry(o.number, other.token)
    const b = await retry('WF-99997', o.token)
    expect([a.status, b.status]).toEqual([404, 404])
    expect(a.text).toBe(b.text)
    const p = await makeProduct(payload)
    const cod = await placeOrderVia([{ slug: p.slug as string, qty: 2 }], { method: 'cod' })
    const c = await retry(cod.res.body.order.number, cod.res.body.order.token)
    expect(c.status).toBe(409)
    expect(c.body.error.code).toBe('NOT_RETRYABLE')
    const pay = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    await deliver(pay.events)
    const d = await retry(o.number, o.token)
    expect(d.status).toBe(409)
    expect(d.body.error.code).toBe('ALREADY_PAID')
    expect(d.body.error.details.order).toMatchObject({ number: o.number, status: 'paid', isConfirmed: true })
  })

  it('finds a payment whose webhook hasn\'t arrived ("paid in my UPI app") → 409 ALREADY_PAID, order paid', async () => {
    const o = await onlineOrder()
    await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }) // no webhook, no verify
    const res = await retry(o.number, o.token)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ALREADY_PAID')
    expect(await orderByNumber(payload, o.number)).toMatchObject({ status: 'paid', paidVia: 'reconcile' })
  })

  it('expired: re-reserves stock and coupon, or 409 OUT_OF_STOCK when it\'s gone', async () => {
    const c = await payload.create({ collection: 'coupons', data: { code: `RET${Date.now().toString(36).toUpperCase()}`, type: 'percent', value: 10, usedCount: 0, active: true } as never })
    const o = await onlineOrder({ stock: 4, qty: 2, overrides: { couponCode: c.code } })
    const id = (await orderByNumber(payload, o.number)).id
    await expireOrder(payload, id, { now: Date.now() + 31 * 60_000 })
    expect(await stockOf(payload, o.product.slug as string)).toBe(4)
    const res = await retry(o.number, o.token)
    expect(res.status, res.text).toBe(200)
    expect(await reload(payload, id)).toMatchObject({ status: 'pending_payment', stockState: 'reserved' })
    expect(await stockOf(payload, o.product.slug as string)).toBe(2)
    const red = await payload.find({ collection: 'coupon-redemptions', where: { order: { equals: id } }, overrideAccess: true })
    expect(red.docs[0].status).toBe('reserved')

    const o2 = await onlineOrder({ stock: 2, qty: 2 })
    const id2 = (await orderByNumber(payload, o2.number)).id
    await expireOrder(payload, id2, { now: Date.now() + 31 * 60_000 })
    await payload.db.updateOne({ collection: 'products', where: { id: { equals: o2.product.id } }, data: { stock: { $inc: -1 } }, options: { atomic: true } })
    const gone = await retry(o2.number, o2.token)
    expect(gone.status).toBe(409)
    expect(gone.body.error.code).toBe('OUT_OF_STOCK')
    expect(gone.body.error.details.issues[0]).toMatchObject({ slug: o2.product.slug, available: 1, code: 'OUT_OF_STOCK' })
    expect((await reload(payload, id2)).status).toBe('expired')
  })

  it('gateway down → 503 PAYMENTS_UNAVAILABLE {order}; ten attempts max → NOT_RETRYABLE', async () => {
    const o = await onlineOrder()
    mock().failNext('createOrder', 'server')
    const down = await retry(o.number, o.token)
    expect(down.status).toBe(503)
    expect(down.body.error).toMatchObject({ code: 'PAYMENTS_UNAVAILABLE', details: { order: { number: o.number, token: o.token } } })
    for (let i = 0; i < 9; i++) expect((await retry(o.number, o.token)).status).toBe(200)
    const stored = await orderByNumber(payload, o.number)
    expect(stored.razorpay?.attempts).toHaveLength(10)
    const last = await retry(o.number, o.token)
    expect(last.status).toBe(409)
    expect(last.body.error.code).toBe('NOT_RETRYABLE')
  })
})

describe('exactly once under concurrency', () => {
  it('verify + callback + three webhooks at the same time → one transition, one order.confirmed, one confirmation', async () => {
    const o = await onlineOrder()
    const r = ok(await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' }))
    const webhookDeliveries = r.events.map((e: { event: string; entities: object }) => mock().buildWebhook(e.event, e.entities))
    const results = await Promise.all([
      verify(o.number, o.token, r.response),
      restPost('payments/razorpay/callback', { rawBody: new URLSearchParams(r.response), contentType: 'application/x-www-form-urlencoded', query: { no: o.number, t: o.token } }),
      ...webhookDeliveries.map((d) => postWebhook(d)),
    ])
    expect(results.map((x) => x.status)).toEqual([200, 303, 200, 200, 200])
    await settle()
    const stored = await orderByNumber(payload, o.number)
    expect(stored.status).toBe('paid')
    expect(stored.statusHistory?.filter((h) => h.field === 'status' && h.to === 'paid')).toHaveLength(1)
    expect(eventsFor(o.number, 'order.confirmed')).toHaveLength(1)
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: `confirm:${o.number}` } }, overrideAccess: true })
    expect(log.docs).toHaveLength(1)
  })
})
