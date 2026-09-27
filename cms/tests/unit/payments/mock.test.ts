import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MOCK_DEFAULT_KEY_ID, MOCK_DEFAULT_KEY_SECRET, MOCK_DEFAULT_WEBHOOK_SECRET } from '@/payments/config'
import { destroySharedMockState, MockGateway, type WebhookDelivery } from '@/payments/mock'
import { isRazorpayOrderId, isRazorpayPaymentId, isRazorpayRefundId, verifyPaymentSignature, verifyWebhookSignature } from '@/payments/signatures'
import { GatewayError } from '@/payments/types'
import { parseWebhookBody } from '@/payments/webhookPayload'

const KEY_SECRET = 'mock-unit-key-secret'
const WH = 'mock-unit-webhook-secret'
const WH_OLD = 'mock-unit-webhook-secret-old'

const T0 = Date.UTC(2026, 8, 26, 6, 0, 0)

function makeMock(over: ConstructorParameters<typeof MockGateway>[0] = {}) {
  let now = T0
  const mock = new MockGateway({
    keyId: 'rzp_test_MockUnit000001',
    keySecret: KEY_SECRET,
    webhookSecrets: [WH, WH_OLD],
    runId: 'UNIT01',
    now: () => now,
    ...over,
  })
  return { mock, tick: (ms: number) => (now += ms) }
}

async function rejection(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError)
    return err as GatewayError
  }
  throw new Error('expected a rejection')
}

const newOrder = (mock: MockGateway, amountPaise = 47400, receipt = `WF-${Math.floor(Math.random() * 1e9)}-a1`) =>
  mock.createOrder({ amountPaise, receipt, notes: { wf_order: receipt.slice(0, 8) } })

afterEach(() => {
  destroySharedMockState()
  vi.useRealTimers()
})

describe('MockGateway: orders', () => {
  it('creates Razorpay-shaped orders with readable, valid, unique ids', async () => {
    const { mock } = makeMock()
    const a = await mock.createOrder({ amountPaise: 47400, receipt: 'WF-10001-a1', notes: { wf_order: 'WF-10001' } })
    const b = await mock.createOrder({ amountPaise: 100, receipt: 'WF-10002-a1' })
    expect(a).toEqual({
      id: 'order_MockUNIT010001',
      entity: 'order',
      amount: 47400,
      amount_paid: 0,
      amount_due: 47400,
      currency: 'INR',
      receipt: 'WF-10001-a1',
      offer_id: null,
      status: 'created',
      attempts: 0,
      notes: { wf_order: 'WF-10001' },
      created_at: Math.floor(T0 / 1000),
    })
    expect(b.id).toBe('order_MockUNIT010002')
    expect(isRazorpayOrderId(a.id) && isRazorpayOrderId(b.id)).toBe(true)
    expect(b.notes).toEqual({})
    expect(await mock.fetchOrder(a.id)).toEqual(a)
  })

  it('is idempotent per receipt; a different amount for the same receipt is a RECEIPT_CONFLICT', async () => {
    const { mock } = makeMock()
    const a = await mock.createOrder({ amountPaise: 47400, receipt: 'WF-10001-a1' })
    expect(await mock.createOrder({ amountPaise: 47400, receipt: 'WF-10001-a1' })).toEqual(a)
    expect(await rejection(mock.createOrder({ amountPaise: 47500, receipt: 'WF-10001-a1' }))).toMatchObject({ code: 'RECEIPT_CONFLICT', kind: 'bad_request' })
    expect(await mock.findOrdersByReceipt('WF-10001-a1')).toEqual([a])
    expect(await mock.findOrdersByReceipt('WF-nope')).toEqual([])
    expect(mock.inspect().orders).toHaveLength(1)
  })

  it('validates input like the API (amount ≥ 100 integer, receipt ≤ 40 ASCII, notes ≤ 15 × 256)', async () => {
    const { mock } = makeMock()
    for (const input of [
      { amountPaise: 99, receipt: 'r' },
      { amountPaise: 150.5, receipt: 'r' },
      { amountPaise: Number.NaN, receipt: 'r' },
      { amountPaise: 100, receipt: 'x'.repeat(41) },
      { amountPaise: 100, receipt: 'WF-é' },
      { amountPaise: 100, receipt: 'r', notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) },
      { amountPaise: 100, receipt: 'r', notes: { k: 'v'.repeat(257) } },
    ]) {
      expect(await rejection(mock.createOrder(input))).toMatchObject({ kind: 'bad_request', retryable: false })
    }
    expect(mock.inspect().orders).toHaveLength(0)
  })

  it('unknown ids are not_found ("The id provided does not exist"), malformed ones bad_request', async () => {
    const { mock } = makeMock()
    expect(await rejection(mock.fetchOrder('order_MockUNIT019999'))).toMatchObject({ kind: 'not_found', statusCode: 400, description: 'The id provided does not exist' })
    expect(await rejection(mock.fetchPayment('pay_MockUNIT019999'))).toMatchObject({ kind: 'not_found' })
    expect(await rejection(mock.fetchOrder('nope'))).toMatchObject({ kind: 'bad_request' })
    expect(await rejection(mock.simulatePayment('order_MockUNIT019999', { outcome: 'success' }))).toMatchObject({ kind: 'not_found' })
  })

  it('returns copies: mutating a result never changes the mock state', async () => {
    const { mock } = makeMock()
    const o = await newOrder(mock)
    o.status = 'paid'
    o.notes.x = 'y'
    expect(await mock.fetchOrder(o.id)).toMatchObject({ status: 'created', notes: { wf_order: expect.any(String) } })
    expect((await mock.fetchOrder(o.id)).notes.x).toBeUndefined()
  })
})

describe('MockGateway: payments', () => {
  it('success: authorized → captured, order paid, handler triple with a REAL signature', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock, 47400)
    const r = await mock.simulatePayment(order.id, { outcome: 'success', method: 'card', email: 'a@example.com', contact: '+919876543210' })
    if (!r.ok) throw new Error('expected success')
    expect(isRazorpayPaymentId(r.response.razorpay_payment_id)).toBe(true)
    expect(r.response.razorpay_order_id).toBe(order.id)
    expect(verifyPaymentSignature({ orderId: order.id, paymentId: r.response.razorpay_payment_id, signature: r.response.razorpay_signature, keySecret: KEY_SECRET })).toBe(true)
    expect(mock.verifyPaymentSignature({ orderId: order.id, paymentId: r.response.razorpay_payment_id, signature: r.response.razorpay_signature })).toBe(true)

    const payment = await mock.fetchPayment(r.response.razorpay_payment_id)
    expect(payment).toMatchObject({
      entity: 'payment',
      amount: 47400,
      currency: 'INR',
      status: 'captured',
      captured: true,
      order_id: order.id,
      method: 'card',
      email: 'a@example.com',
      contact: '+919876543210',
      amount_refunded: 0,
      refund_status: null,
      error_code: null,
      created_at: Math.floor(T0 / 1000),
    })
    expect(payment.card).toMatchObject({ last4: '1111', network: 'Visa' })
    expect(payment.fee).toBeGreaterThan(0)
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'paid', amount_paid: 47400, amount_due: 0, attempts: 1 })
    expect(r.events.map((e) => e.event)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    // webhook payloads are snapshots at event time
    expect(r.events[0].entities.payment).toMatchObject({ status: 'authorized', captured: false })
    expect(r.events[1].entities.payment).toMatchObject({ status: 'captured', captured: true })
    expect(r.events[2].entities.order).toMatchObject({ status: 'paid', amount_paid: 47400 })
  })

  it('fail: a Razorpay-shaped error, payment failed, order attempted; a retry on the same order can succeed', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const f = await mock.simulatePayment(order.id, { outcome: 'fail', reason: 'insufficient_funds' })
    if (f.ok) throw new Error('expected failure')
    expect(f.error).toEqual({
      code: 'BAD_REQUEST_ERROR',
      description: "Payment failed due to insufficient balance in the customer's account",
      source: 'customer',
      step: 'payment_authorization',
      reason: 'insufficient_funds',
      metadata: { order_id: order.id, payment_id: f.payment.id },
    })
    expect(f.payment).toMatchObject({ status: 'failed', error_reason: 'insufficient_funds', error_code: 'BAD_REQUEST_ERROR', captured: false })
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'attempted', attempts: 1, amount_paid: 0 })
    expect(f.events.map((e) => e.event)).toEqual(['payment.failed'])

    const s = await mock.simulatePayment(order.id, { outcome: 'success' })
    expect(s.ok).toBe(true)
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'paid', attempts: 2 })
    const payments = await mock.fetchOrderPayments(order.id)
    expect(payments.map((p) => p.status)).toEqual(['captured', 'failed']) // newest first
    expect(payments[1].method).toBe('upi')
    expect(payments[1].vpa).toBeTruthy()
  })

  it('a default failure uses reason payment_failed; unknown reasons keep the reason with generic text', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const a = await mock.simulatePayment(order.id, { outcome: 'fail' })
    const b = await mock.simulatePayment(order.id, { outcome: 'fail', reason: 'upi_app_technical_error' })
    expect(!a.ok && a.error.reason).toBe('payment_failed')
    expect(!b.ok && b.error).toMatchObject({ reason: 'upi_app_technical_error', description: 'Payment failed' })
  })

  it('a payment on an already paid order is declined with reason order_already_paid', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    await mock.simulatePayment(order.id, { outcome: 'success' })
    const again = await mock.simulatePayment(order.id, { outcome: 'success' })
    expect(again.ok).toBe(false)
    expect(!again.ok && again.error).toMatchObject({ reason: 'order_already_paid', source: 'business', step: 'payment_initiation' })
    expect(again.events.map((e) => e.event)).toEqual(['payment.failed'])
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'paid', attempts: 2, amount_paid: order.amount })
  })

  it('authorize_only: authorized (order attempted) until capturePayment()', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const r = await mock.simulatePayment(order.id, { outcome: 'authorize_only', method: 'netbanking' })
    if (!r.ok) throw new Error('expected success')
    expect(r.payment).toMatchObject({ status: 'authorized', captured: false, bank: 'HDFC' })
    expect(r.events.map((e) => e.event)).toEqual(['payment.authorized'])
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'attempted' })
    // not capturable → cannot refund yet
    expect(await rejection(mock.refund(r.payment.id, { receipt: 'r1' }))).toMatchObject({ condition: 'not_captured' })

    const c = await mock.capturePayment(r.payment.id)
    expect(c.payment).toMatchObject({ status: 'captured', captured: true })
    expect(c.events.map((e) => e.event)).toEqual(['payment.captured', 'order.paid'])
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'paid' })
    expect(await rejection(mock.capturePayment(r.payment.id))).toMatchObject({ kind: 'bad_request' })
  })

  it('late authorisation: failed now, authorized + captured later (order becomes paid)', async () => {
    const { mock, tick } = makeMock()
    const order = await newOrder(mock)
    const r = await mock.simulatePayment(order.id, { outcome: 'late' })
    if (r.ok) throw new Error('expected failure first')
    expect(r.error.reason).toBe('payment_timed_out')
    expect(mock.inspect().pendingLateAuth).toEqual([r.payment.id])
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'attempted' })

    tick(3 * 60_000)
    const late = await mock.completeLateAuthorization(r.payment.id)
    expect(late.events.map((e) => e.event)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    expect(late.payment).toMatchObject({ id: r.payment.id, status: 'captured', captured: true, error_code: null, error_reason: null })
    expect(late.order).toMatchObject({ status: 'paid', amount_paid: order.amount })
    expect(mock.inspect().pendingLateAuth).toEqual([])
    // only once
    expect(await rejection(mock.completeLateAuthorization(r.payment.id))).toMatchObject({ kind: 'bad_request' })
    // an ordinary failure is not late-authorisable
    const order2 = await newOrder(mock)
    const f = await mock.simulatePayment(order2.id, { outcome: 'fail' })
    expect(await rejection(mock.completeLateAuthorization(f.payment.id))).toMatchObject({ kind: 'bad_request' })
  })

  it('late authorisation on an order paid meanwhile is refunded immediately (Razorpay behaviour)', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const late = await mock.simulatePayment(order.id, { outcome: 'late' })
    await mock.simulatePayment(order.id, { outcome: 'success' })
    const done = await mock.completeLateAuthorization(late.payment.id)
    expect(done.events.map((e) => e.event)).toEqual(['payment.authorized', 'refund.processed'])
    expect(done.payment).toMatchObject({ status: 'refunded', amount_refunded: order.amount, refund_status: 'full' })
    expect(await mock.fetchRefunds(late.payment.id)).toHaveLength(1)
  })

  it('late authorisation with capture:false leaves the payment authorized', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const late = await mock.simulatePayment(order.id, { outcome: 'late', reason: 'payment_pending' })
    const done = await mock.completeLateAuthorization(late.payment.id, { capture: false })
    expect(done.payment.status).toBe('authorized')
    expect(done.events.map((e) => e.event)).toEqual(['payment.authorized'])
  })

  it('a Checkout amount different from the order amount is refused (order_amount_mismatch), nothing recorded', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock, 47400)
    expect(await rejection(mock.simulatePayment(order.id, { outcome: 'success', amount: 100 }))).toMatchObject({ kind: 'bad_request', field: 'amount' })
    expect(await mock.fetchOrderPayments(order.id)).toEqual([])
    expect((await mock.fetchOrder(order.id)).attempts).toBe(0)
    expect((await mock.simulatePayment(order.id, { outcome: 'success', amount: 47400 })).ok).toBe(true)
  })

  it('rejects bad simulatePayment options', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    expect(await rejection(mock.simulatePayment(order.id, { outcome: 'explode' as 'success' }))).toMatchObject({ kind: 'bad_request' })
    expect(await rejection(mock.simulatePayment(order.id, { outcome: 'fail', reason: 'Bad Reason!' }))).toMatchObject({ kind: 'bad_request' })
    expect(await rejection(mock.simulatePayment(order.id, { outcome: 'success', method: '<script>' }))).toMatchObject({ kind: 'bad_request' })
  })
})

describe('MockGateway: refunds', () => {
  async function capturedPayment(mock: MockGateway, amount = 50000) {
    const order = await newOrder(mock, amount)
    const r = await mock.simulatePayment(order.id, { outcome: 'success' })
    return r.payment
  }

  it('partial then full refunds; payment amount_refunded / refund_status / status follow', async () => {
    const { mock } = makeMock()
    const p = await capturedPayment(mock, 50000)
    const r1 = await mock.refund(p.id, { amountPaise: 12500, receipt: 'WF-1-r1', notes: { reason: 'oversell' } })
    expect(r1).toMatchObject({ entity: 'refund', amount: 12500, currency: 'INR', payment_id: p.id, receipt: 'WF-1-r1', status: 'processed', speed_requested: 'normal', notes: { reason: 'oversell' } })
    expect(isRazorpayRefundId(r1.id)).toBe(true)
    expect(await mock.fetchPayment(p.id)).toMatchObject({ status: 'captured', amount_refunded: 12500, refund_status: 'partial' })
    const r2 = await mock.refund(p.id, { receipt: 'WF-1-r2' }) // rest
    expect(r2.amount).toBe(37500)
    expect(await mock.fetchPayment(p.id)).toMatchObject({ status: 'refunded', amount_refunded: 50000, refund_status: 'full' })
    expect((await mock.fetchRefunds(p.id)).map((r) => r.receipt)).toEqual(['WF-1-r2', 'WF-1-r1'])
  })

  it('is idempotent per (payment, receipt); a different amount is a RECEIPT_CONFLICT', async () => {
    const { mock } = makeMock()
    const p = await capturedPayment(mock)
    const r1 = await mock.refund(p.id, { amountPaise: 1000, receipt: 'WF-1-r1' })
    expect(await mock.refund(p.id, { amountPaise: 1000, receipt: 'WF-1-r1' })).toEqual(r1)
    expect(await mock.refund(p.id, { receipt: 'WF-1-r1' })).toEqual(r1)
    expect(await rejection(mock.refund(p.id, { amountPaise: 2000, receipt: 'WF-1-r1' }))).toMatchObject({ code: 'RECEIPT_CONFLICT' })
    expect((await mock.fetchPayment(p.id)).amount_refunded).toBe(1000)
  })

  it('mirrors Razorpay refund errors', async () => {
    const { mock } = makeMock()
    const p = await capturedPayment(mock, 50000)
    expect(await rejection(mock.refund(p.id, { amountPaise: 50001, receipt: 'a' }))).toMatchObject({
      kind: 'bad_request',
      description: 'The refund amount provided is greater than amount captured.',
      condition: 'amount_exceeds_captured',
    })
    await mock.refund(p.id, { amountPaise: 40000, receipt: 'b' })
    expect(await rejection(mock.refund(p.id, { amountPaise: 10001, receipt: 'c' }))).toMatchObject({ condition: 'amount_exceeds_captured' })
    await mock.refund(p.id, { receipt: 'd' })
    expect(await rejection(mock.refund(p.id, { receipt: 'e' }))).toMatchObject({ condition: 'already_refunded', description: 'The payment has been fully refunded already.' })
    const order = await newOrder(mock)
    const failed = await mock.simulatePayment(order.id, { outcome: 'fail' })
    expect(await rejection(mock.refund(failed.payment.id, { receipt: 'f' }))).toMatchObject({ condition: 'not_captured' })
    expect(await rejection(mock.refund(p.id, { amountPaise: 0, receipt: 'g' }))).toMatchObject({ kind: 'bad_request' })
    expect(await rejection(mock.refund('pay_MockUNIT019999', { receipt: 'h' }))).toMatchObject({ kind: 'not_found' })
  })
})

describe('MockGateway: fault injection and latency', () => {
  it('failNext throws a GatewayError of the requested kind once, then the op works again', async () => {
    const { mock } = makeMock()
    mock.failNext('createOrder', 'network')
    const err = await rejection(mock.createOrder({ amountPaise: 100, receipt: 'r1' }))
    expect(err).toMatchObject({ kind: 'network', statusCode: 0, retryable: true, op: 'createOrder' })
    expect(err.outcomeUnknown).toBe(true)
    expect(mock.inspect().orders).toHaveLength(0) // nothing was created
    await expect(mock.createOrder({ amountPaise: 100, receipt: 'r1' })).resolves.toMatchObject({ receipt: 'r1' })
  })

  it.each([
    ['timeout', 0],
    ['rate_limited', 429],
    ['server', 502],
    ['bad_request', 400],
    ['auth', 401],
    ['not_found', 400],
  ] as const)('kind %s has Razorpay-like statusCode %i', async (kind, statusCode) => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    mock.failNext('fetchOrder', kind)
    expect(await rejection(mock.fetchOrder(order.id))).toMatchObject({ kind, statusCode })
  })

  it('times, "*" and custom descriptions', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    mock.failNext('*', 'server', { times: 2 })
    await rejection(mock.fetchOrder(order.id))
    await rejection(mock.findOrdersByReceipt('x'))
    await expect(mock.fetchOrder(order.id)).resolves.toMatchObject({ id: order.id })
    mock.failNext('refund', 'bad_request', { description: 'Your account does not have enough balance to carry out the refund operation.' })
    const p = (await mock.simulatePayment(order.id, { outcome: 'success' })).payment
    expect(await rejection(mock.refund(p.id, { receipt: 'r' }))).toMatchObject({ condition: 'insufficient_balance' })
  })

  it('commit: the order is created but the response is "lost"; the retry with the same receipt returns it', async () => {
    const { mock } = makeMock()
    mock.failNext('createOrder', 'timeout', { commit: true })
    await rejection(mock.createOrder({ amountPaise: 47400, receipt: 'WF-10009-a1' }))
    expect(mock.inspect().orders).toHaveLength(1)
    const again = await mock.createOrder({ amountPaise: 47400, receipt: 'WF-10009-a1' })
    expect(again.id).toBe(mock.inspect().orders[0].id)
  })

  it('setLatency delays every call', async () => {
    const { mock } = makeMock()
    mock.setLatency(60)
    const started = Date.now()
    await mock.createOrder({ amountPaise: 100, receipt: 'r' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    mock.setLatency(0)
  })

  it('reset() clears state, faults, latency and sink, but ids keep counting', async () => {
    const { mock } = makeMock()
    const first = await newOrder(mock)
    mock.failNext('fetchOrder', 'network', { times: 5 })
    mock.setLatency(1000)
    mock.setWebhookSink(() => ({ status: 200 }))
    mock.reset()
    expect(mock.inspect()).toEqual({ orders: [], payments: [], refunds: [], pendingLateAuth: [] })
    const started = Date.now()
    const second = await newOrder(mock)
    expect(Date.now() - started).toBeLessThan(500)
    await expect(mock.fetchOrder(second.id)).resolves.toBeTruthy()
    expect(second.id).not.toBe(first.id)
    expect((await mock.emitWebhook('payment.captured', {})).target).toBe('dropped') // sink cleared; NODE_ENV=test → no HTTP
  })
})

describe('MockGateway: shared state and defaults', () => {
  it('shared instances see the same orders (globalThis), isolated ones do not', async () => {
    const a = new MockGateway({ shared: true })
    const b = new MockGateway({ shared: true })
    const c = new MockGateway()
    const order = await a.createOrder({ amountPaise: 100, receipt: 'shared-1' })
    await expect(b.fetchOrder(order.id)).resolves.toMatchObject({ id: order.id })
    await expect(c.fetchOrder(order.id)).rejects.toMatchObject({ kind: 'not_found' })
    expect(a.runId).toBe(b.runId)
    expect(a.runId).toMatch(/^[A-Z0-9]{6}$/)
  })

  it('uses the documented dev defaults when no secrets are given', async () => {
    const mock = new MockGateway()
    expect(mock.keyId).toBe(MOCK_DEFAULT_KEY_ID)
    expect(mock.checkoutScriptUrl).toBe('/api/payments/mock/checkout.js')
    const order = await mock.createOrder({ amountPaise: 100, receipt: 'd' })
    const r = await mock.simulatePayment(order.id, { outcome: 'success' })
    if (!r.ok) throw new Error('expected success')
    expect(verifyPaymentSignature({ orderId: order.id, paymentId: r.payment.id, signature: r.response.razorpay_signature, keySecret: MOCK_DEFAULT_KEY_SECRET })).toBe(true)
    const w = mock.buildWebhook('payment.captured', { payment: r.payment })
    expect(verifyWebhookSignature(w.body, w.signature, MOCK_DEFAULT_WEBHOOK_SECRET)).toBe(true)
    expect(JSON.stringify(mock)).toBe(JSON.stringify({ provider: 'mock', keyId: MOCK_DEFAULT_KEY_ID }))
  })

  it('rejects a malformed runId', () => {
    expect(() => new MockGateway({ runId: 'bad' })).toThrow(/runId/)
  })
})

describe('MockGateway: webhooks', () => {
  it('builds Razorpay-shaped, signed payloads (razorpay.md §6.4)', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock, 47400)
    const r = await mock.simulatePayment(order.id, { outcome: 'success' })
    const paid = r.events.find((e) => e.event === 'order.paid')!
    const w = mock.buildWebhook(paid.event, paid.entities)
    const body = JSON.parse(w.body)
    expect(body).toMatchObject({
      entity: 'event',
      account_id: 'acc_WefeastoMock01',
      event: 'order.paid',
      contains: ['payment', 'order'],
      created_at: Math.floor(T0 / 1000),
      payload: {
        payment: { entity: { id: r.payment.id, entity: 'payment', status: 'captured', order_id: order.id, amount: 47400, currency: 'INR' } },
        order: { entity: { id: order.id, entity: 'order', status: 'paid', amount_paid: 47400 } },
      },
    })
    expect(w.headers).toMatchObject({ 'content-type': 'application/json', 'x-razorpay-signature': w.signature, 'x-razorpay-event-id': w.eventId })
    expect(w.eventId).toMatch(/^MockEvtUNIT01\d{4}$/)
    expect(verifyWebhookSignature(w.body, w.signature, WH)).toBe(true)
    expect(mock.verifyWebhookSignature(w.body, w.signature)).toBe(true)
    expect(verifyWebhookSignature(JSON.stringify(body), w.signature, WH)).toBe(!w.body.includes('\\/'))
  })

  it('serialises like PHP: empty notes as [], "/" as "\\/", non-ASCII as \\uXXXX', async () => {
    const { mock } = makeMock()
    const order = await mock.createOrder({ amountPaise: 100, receipt: 'WF-1/a1' })
    const r = await mock.simulatePayment(order.id, { outcome: 'fail', description: 'Wefeasto order ₹1' })
    const w = mock.buildWebhook('payment.failed', { payment: r.payment })
    expect(w.body).toContain('"notes":[]')
    expect(w.body).toContain('"description":"Wefeasto order \\u20b91"')
    expect(w.body).not.toContain('₹')
    const orderEvent = mock.buildWebhook('order.paid', { order: await mock.fetchOrder(order.id) })
    expect(orderEvent.body).toContain('"receipt":"WF-1\\/a1"')
    // re-serialised JSON no longer matches the signature
    expect(verifyWebhookSignature(JSON.stringify(JSON.parse(orderEvent.body)), orderEvent.signature, WH)).toBe(false)
    const parsed = parseWebhookBody(w.body)!
    expect(parsed.payment).toMatchObject({ id: r.payment.id, notes: {}, description: 'Wefeasto order ₹1' })
  })

  it('refund.processed lists the refund first and carries the updated payment', async () => {
    const { mock } = makeMock({ autoWebhooks: false })
    const order = await newOrder(mock, 5000)
    const p = (await mock.simulatePayment(order.id, { outcome: 'success' })).payment
    const refund = await mock.refund(p.id, { amountPaise: 2000, receipt: 'r1' })
    const w = mock.buildWebhook('refund.processed', { refund, payment: await mock.fetchPayment(p.id) })
    const body = JSON.parse(w.body)
    expect(body.contains).toEqual(['refund', 'payment'])
    expect(body.payload.refund.entity).toMatchObject({ id: refund.id, amount: 2000, status: 'processed', payment_id: p.id })
    expect(body.payload.payment.entity).toMatchObject({ amount_refunded: 2000, refund_status: 'partial' })
  })

  it('delivers to a sink in order after the delay, and logs each delivery', async () => {
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const r = await mock.simulatePayment(order.id, { outcome: 'success' })
    const got: WebhookDelivery[] = []
    const started = Date.now()
    const results = await mock.emitWebhooks(r.events, {
      delayMs: 80,
      sink: (d) => {
        got.push(d)
        return { status: 200 }
      },
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(75)
    expect(got.map((d) => d.event)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    expect(new Set(got.map((d) => d.eventId)).size).toBe(3)
    for (const d of got) {
      expect(verifyWebhookSignature(d.body, d.headers['x-razorpay-signature'], WH)).toBe(true)
      expect(d.headers['x-razorpay-event-id']).toBe(d.eventId)
    }
    expect(results.every((x) => x.target === 'sink' && x.delivered && x.status === 200)).toBe(true)
    expect(mock.webhookLog.map((l) => l.event)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
  })

  it('sink failures and non-2xx statuses are recorded, never thrown', async () => {
    const { mock } = makeMock()
    const a = await mock.emitWebhook('payment.failed', {}, { sink: () => { throw new Error('receiver down') } })
    expect(a).toMatchObject({ target: 'sink', delivered: false, error: 'receiver down' })
    const b = await mock.emitWebhook('payment.failed', {}, { sink: async () => ({ status: 500 }) })
    expect(b).toMatchObject({ target: 'sink', delivered: false, status: 500 })
    const c = await mock.emitWebhook('payment.failed', {}, { eventId: 'SameEventId000001', sink: () => undefined })
    expect(c).toMatchObject({ eventId: 'SameEventId000001', delivered: true, status: 200 })
  })

  it('reset() cancels scheduled deliveries', async () => {
    const { mock } = makeMock()
    const sink = vi.fn(() => ({ status: 200 }))
    const pending = mock.emitWebhook('order.paid', {}, { delayMs: 5_000, sink })
    mock.reset()
    expect(await pending).toMatchObject({ target: 'cancelled', delivered: false })
    expect(sink).not.toHaveBeenCalled()
  })

  it('never POSTs under NODE_ENV=test without a sink or MOCK_WEBHOOK_URL (no cross-talk with dev servers)', async () => {
    const fetchSpy = vi.fn()
    const { mock } = makeMock({ webhookUrl: 'http://localhost:3000/api/payments/razorpay/webhook', fetch: fetchSpy as unknown as typeof fetch })
    expect(process.env.NODE_ENV).toBe('test')
    expect(await mock.emitWebhook('order.paid', {})).toMatchObject({ target: 'dropped', delivered: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs the exact signed bytes over HTTP to MOCK_WEBHOOK_URL / an explicit url', async () => {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = []
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/payments/razorpay/webhook`
    try {
      const { mock } = makeMock()
      const order = await newOrder(mock)
      const r = await mock.simulatePayment(order.id, { outcome: 'fail' })
      const res = await mock.emitWebhook('payment.failed', r.events[0].entities, { url })
      expect(res).toMatchObject({ target: 'http', delivered: true, status: 200 })
      expect(received).toHaveLength(1)
      expect(received[0].body).toBe(res.body)
      expect(received[0].headers['x-razorpay-signature']).toBe(res.signature)
      expect(received[0].headers['x-razorpay-event-id']).toBe(res.eventId)
      expect(received[0].headers['content-type']).toBe('application/json')
      expect(verifyWebhookSignature(received[0].body, String(received[0].headers['x-razorpay-signature']), [WH])).toBe(true)

      process.env.MOCK_WEBHOOK_URL = url
      expect(await mock.emitWebhook('payment.failed', r.events[0].entities)).toMatchObject({ target: 'http', delivered: true })
      expect(received).toHaveLength(2)
    } finally {
      delete process.env.MOCK_WEBHOOK_URL
      await new Promise((r) => srv.close(r))
    }
  })

  it('autoWebhooks: refunds and captures deliver their own events', async () => {
    const got: string[] = []
    const { mock } = makeMock({ autoWebhooks: true, webhookDelayMs: 0 })
    mock.setWebhookSink((d) => {
      got.push(d.event)
    })
    const order = await newOrder(mock)
    const r = await mock.simulatePayment(order.id, { outcome: 'authorize_only' })
    expect(got).toEqual([]) // simulatePayment never delivers by itself
    await mock.capturePayment(r.payment.id)
    await mock.refund(r.payment.id, { receipt: 'r1', amountPaise: 100 })
    await vi.waitFor(() => expect(got).toEqual(['payment.captured', 'order.paid', 'refund.processed']))
  })

  it('scheduleLateAuthorization completes the payment and delivers its webhooks after the delay', async () => {
    const got: string[] = []
    const { mock } = makeMock()
    const order = await newOrder(mock)
    const r = await mock.simulatePayment(order.id, { outcome: 'late' })
    const results = await mock.scheduleLateAuthorization(r.payment.id, 50, { sink: (d) => void got.push(d.event) })
    expect(results?.map((x) => x.event)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    expect(got).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    expect(await mock.fetchOrder(order.id)).toMatchObject({ status: 'paid' })
  })

  it('scheduleLateAuthorization(…, false) completes silently; reset() cancels a pending one', async () => {
    const { mock } = makeMock()
    const sink = vi.fn()
    mock.setWebhookSink(sink)
    const order = await newOrder(mock)
    const r = await mock.simulatePayment(order.id, { outcome: 'late' })
    expect(await mock.scheduleLateAuthorization(r.payment.id, 10, false)).toEqual([])
    expect(sink).not.toHaveBeenCalled()
    expect(mock.webhookLog).toEqual([])
    expect((await mock.fetchPayment(r.payment.id)).status).toBe('captured')

    const order2 = await newOrder(mock)
    const r2 = await mock.simulatePayment(order2.id, { outcome: 'late' })
    const pending = mock.scheduleLateAuthorization(r2.payment.id, 5_000)
    mock.reset()
    expect(await pending).toBeNull()
  })
})

describe('parseWebhookBody', () => {
  it('returns null for non-events and normalises notes', () => {
    expect(parseWebhookBody('not json')).toBeNull()
    expect(parseWebhookBody('[]')).toBeNull()
    expect(parseWebhookBody('{"entity":"order"}')).toBeNull()
    const parsed = parseWebhookBody(
      '{"entity":"event","account_id":"acc_1","event":"refund.processed","contains":["refund"],"payload":{"refund":{"entity":{"id":"rfnd_ABCDEFGHIJKLMN","notes":[]}}},"created_at":1}',
    )
    expect(parsed).toMatchObject({ event: 'refund.processed', accountId: 'acc_1', createdAt: 1, contains: ['refund'], payment: null, order: null })
    expect(parsed?.refund).toMatchObject({ id: 'rfnd_ABCDEFGHIJKLMN', notes: {} })
  })
})
