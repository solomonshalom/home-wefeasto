import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getGateway, getMockGateway, MOCK_DEFAULT_KEY_ID, MOCK_DEFAULT_KEY_SECRET, MockGateway, resetGateway, setGatewayForTests } from '@/payments'
import type { WebhookDelivery } from '@/payments/mock'
import { verifyPaymentSignature } from '@/payments/signatures'
import { parseWebhookBody } from '@/payments/webhookPayload'
import { resetRateLimits } from '@/lib/rateLimit'

import { getTestPayload } from './helpers/payload'
import { restDelete, restGet, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * The mock payment endpoints through the real Payload REST stack (SPEC §6):
 *   GET /api/payments/mock/checkout.js, POST /api/payments/mock/pay — mock mode only.
 * Webhooks go to an in-process sink (never HTTP: other servers may own localhost:3000).
 */

const SAVED = { ...process.env }
let deliveries: WebhookDelivery[] = []

const mock = (): MockGateway => {
  const m = getMockGateway()
  if (!m) throw new Error('expected mock mode')
  return m
}

let receiptSeq = 0
const newOrder = (amountPaise = 47400) =>
  mock().createOrder({ amountPaise, receipt: `WF-INT-${Date.now() % 1e8}-${++receiptSeq}`, notes: { wf_order: 'WF-INT' } })

const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const pay = (body: Record<string, unknown>, opts: { contentType?: string; rawBody?: string } = {}) =>
  restPost('payments/mock/pay', { body, origin: STOREFRONT_ORIGIN, ...opts })

beforeAll(async () => {
  await getTestPayload()
  process.env.MOCK_WEBHOOK_DELAY_MS = '30'
  resetGateway()
})

beforeEach(() => {
  process.env.PAYMENTS_MODE = 'mock'
  mock().reset()
  deliveries = []
  mock().setWebhookSink((d) => {
    deliveries.push(d)
    return { status: 200 }
  })
})

afterEach(() => {
  for (const k of ['PAYMENTS_MODE', 'RATE_LIMIT_DISABLED', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
  resetRateLimits()
})

afterAll(() => {
  getMockGateway()?.reset()
  if (SAVED.MOCK_WEBHOOK_DELAY_MS === undefined) delete process.env.MOCK_WEBHOOK_DELAY_MS
  else process.env.MOCK_WEBHOOK_DELAY_MS = SAVED.MOCK_WEBHOOK_DELAY_MS
  resetGateway()
})

describe('GET /api/payments/mock/checkout.js', () => {
  it('serves the window.Razorpay stand-in as uncached JavaScript', async () => {
    const res = await restGet('payments/mock/checkout.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.text).toContain('window.Razorpay = Razorpay')
    expect(res.text).toContain(`"keyId":"${MOCK_DEFAULT_KEY_ID}"`)
    expect(res.text).toContain('"payPath":"/api/payments/mock/pay"')
    expect(() => new Function(res.text)).not.toThrow()
    expect(res.text).not.toContain(MOCK_DEFAULT_KEY_SECRET)
  })
})

describe('mock endpoints outside mock mode', () => {
  it('both answer the standard 404 when PAYMENTS_MODE=razorpay', async () => {
    process.env.PAYMENTS_MODE = 'razorpay'
    process.env.RAZORPAY_KEY_ID = 'rzp_test_IntRazorpayMode1'
    process.env.RAZORPAY_KEY_SECRET = 'int-secret'
    process.env.RAZORPAY_WEBHOOK_SECRET = 'int-wh'
    const script = await restGet('payments/mock/checkout.js')
    expect(script.status).toBe(404)
    expect(script.body).toEqual({ error: { code: 'NOT_FOUND', message: "We couldn't find that." } })
    const payRes = await pay({ razorpayOrderId: 'order_MockABCDEF0001', outcome: 'success' })
    expect(payRes.status).toBe(404)
    expect(payRes.body.error.code).toBe('NOT_FOUND')
    expect(getGateway().provider).toBe('razorpay')
  })
})

describe('POST /api/payments/mock/pay', () => {
  it('success → a triple that verifyPaymentSignature accepts, a captured payment, and three signed webhooks', async () => {
    const order = await newOrder(47400)
    const res = await pay({ razorpayOrderId: order.id, outcome: 'success', method: 'upi', email: 'int@example.com', contact: '+919876543210' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.body).toMatchObject({
      ok: true,
      response: { razorpay_order_id: order.id, razorpay_payment_id: expect.stringMatching(/^pay_Mock/), razorpay_signature: expect.stringMatching(/^[0-9a-f]{64}$/) },
      paymentStatus: 'captured',
      webhooks: ['payment.authorized', 'payment.captured', 'order.paid'],
    })
    const { razorpay_payment_id: paymentId, razorpay_signature: signature } = res.body.response
    expect(res.body.paymentId).toBe(paymentId)

    // what checkout-backend's verify does: timing-safe HMAC against OUR stored order id, then fetchPayment
    expect(verifyPaymentSignature({ orderId: order.id, paymentId, signature, keySecret: MOCK_DEFAULT_KEY_SECRET })).toBe(true)
    expect(getGateway().verifyPaymentSignature({ orderId: order.id, paymentId, signature })).toBe(true)
    expect(getGateway().verifyPaymentSignature({ orderId: 'order_MockOTHER00000001', paymentId, signature })).toBe(false)
    const payment = await getGateway().fetchPayment(paymentId)
    expect(payment).toMatchObject({ order_id: order.id, amount: 47400, currency: 'INR', status: 'captured', email: 'int@example.com', contact: '+919876543210' })
    expect(await getGateway().fetchOrder(order.id)).toMatchObject({ status: 'paid', amount_paid: 47400 })

    await waitFor(() => deliveries.length === 3)
    expect(deliveries.map((d) => d.event)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    for (const d of deliveries) {
      expect(getGateway().verifyWebhookSignature(d.body, d.headers['x-razorpay-signature'])).toBe(true)
      expect(parseWebhookBody(d.body)?.payment?.id).toBe(paymentId)
      expect(d.url).toBe('') // test env: sink only, no HTTP target
    }
    expect(new Set(deliveries.map((d) => d.headers['x-razorpay-event-id'])).size).toBe(3)
  })

  it('fail → the Razorpay error object, a failed payment, and a payment.failed webhook', async () => {
    const order = await newOrder()
    const res = await pay({ razorpayOrderId: order.id, outcome: 'fail', reason: 'card_declined', method: 'card' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'BAD_REQUEST_ERROR',
        description: expect.any(String),
        source: 'bank',
        step: 'payment_authorization',
        reason: 'card_declined',
        metadata: { order_id: order.id, payment_id: res.body.paymentId },
      },
      paymentId: expect.stringMatching(/^pay_Mock/),
      paymentStatus: 'failed',
      webhooks: ['payment.failed'],
    })
    await waitFor(() => deliveries.length === 1)
    expect(parseWebhookBody(deliveries[0].body)).toMatchObject({ event: 'payment.failed', payment: { status: 'failed', error_reason: 'card_declined' } })
    // in-modal retry on the same order then succeeds
    const retry = await pay({ razorpayOrderId: order.id, outcome: 'success' })
    expect(retry.body.ok).toBe(true)
    expect((await getGateway().fetchOrder(order.id)).attempts).toBe(2)
  })

  it('authorize_only → the triple with an authorized (uncaptured) payment', async () => {
    const order = await newOrder()
    const res = await pay({ razorpayOrderId: order.id, outcome: 'authorize_only', webhook: false })
    expect(res.body).toMatchObject({ ok: true, paymentStatus: 'authorized', webhooks: [] })
    expect(await getGateway().fetchOrder(order.id)).toMatchObject({ status: 'attempted' })
  })

  it('late → fails now; authorised + captured after lateAuthDelayMs, with webhooks in that order', async () => {
    const order = await newOrder()
    const res = await pay({ razorpayOrderId: order.id, outcome: 'late', lateAuthDelayMs: 120 })
    expect(res.body).toMatchObject({ ok: false, error: { reason: 'payment_timed_out' }, paymentStatus: 'failed', webhooks: ['payment.failed'] })
    await waitFor(() => deliveries.length === 4)
    expect(deliveries.map((d) => d.event)).toEqual(['payment.failed', 'payment.authorized', 'payment.captured', 'order.paid'])
    expect(await getGateway().fetchPayment(res.body.paymentId)).toMatchObject({ status: 'captured' })
    expect(await getGateway().fetchOrder(order.id)).toMatchObject({ status: 'paid' })
  })

  it('webhook:false suppresses every webhook (late authorisation still happens)', async () => {
    const order = await newOrder()
    const a = await pay({ razorpayOrderId: order.id, outcome: 'late', webhook: false, lateAuthDelayMs: 40 })
    expect(a.body.webhooks).toEqual([])
    await waitFor(() => mock().inspect().pendingLateAuth.length === 0)
    await new Promise((r) => setTimeout(r, 150))
    expect(deliveries).toEqual([])
    expect(mock().webhookLog).toEqual([])
    expect(await getGateway().fetchPayment(a.body.paymentId)).toMatchObject({ status: 'captured' })
  })

  it('a second payment on a paid order is declined with order_already_paid', async () => {
    const order = await newOrder()
    await pay({ razorpayOrderId: order.id, outcome: 'success', webhook: false })
    const again = await pay({ razorpayOrderId: order.id, outcome: 'success', webhook: false })
    expect(again.body).toMatchObject({ ok: false, error: { reason: 'order_already_paid', metadata: { order_id: order.id } } })
  })

  it('validates input: 400 VALIDATION with field codes, 404 for an unknown order', async () => {
    const empty = await pay({})
    expect(empty.status).toBe(400)
    expect(empty.body).toEqual({
      error: { code: 'VALIDATION', message: 'Some details need fixing.', details: { fields: { razorpayOrderId: 'required', outcome: 'required' } } },
    })
    const bad = await pay({ razorpayOrderId: 'order_x', outcome: 'refund', method: 'cash', webhook: 1 })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details.fields).toEqual({ razorpayOrderId: 'invalid', outcome: 'invalid', method: 'invalid', webhook: 'invalid' })
    const order = await newOrder(47400)
    const mismatch = await pay({ razorpayOrderId: order.id, outcome: 'success', amount: 100 })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('does not match the order amount'), details: { fields: { amount: 'mismatch' } } })
    expect((await pay({ razorpayOrderId: order.id, outcome: 'success', amount: '47400' })).body.error.details.fields).toEqual({ amount: 'invalid' })
    expect((await pay({ razorpayOrderId: order.id, outcome: 'success', amount: 47400, webhook: false })).body.ok).toBe(true)
    const unknown = await pay({ razorpayOrderId: 'order_MockZZZZZZ9999', outcome: 'success' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toEqual({ code: 'NOT_FOUND', message: 'The id provided does not exist.' })
  })

  it('rejects non-JSON, malformed JSON, arrays and oversize bodies', async () => {
    const form = await pay({}, { rawBody: 'razorpayOrderId=x', contentType: 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(415)
    const broken = await pay({}, { rawBody: '{"razorpayOrderId":', contentType: 'application/json' })
    expect(broken.status).toBe(400)
    expect(broken.body.error.code).toBe('INVALID_JSON')
    const arr = await pay({}, { rawBody: '[]', contentType: 'application/json' })
    expect(arr.status).toBe(400)
    const huge = await pay({ razorpayOrderId: 'order_MockABCDEF0001', outcome: 'success', description: 'x'.repeat(4000) })
    expect(huge.status).toBe(413)
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('an injected gateway fault surfaces as 503 PAYMENTS_UNAVAILABLE', async () => {
    const order = await newOrder()
    mock().failNext('simulatePayment', 'server')
    const res = await pay({ razorpayOrderId: order.id, outcome: 'success' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE')
    expect((await pay({ razorpayOrderId: order.id, outcome: 'success', webhook: false })).body.ok).toBe(true)
  })

  it('is rate limited per client (60/min)', async () => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    const headers = { 'x-real-ip': '203.0.113.77' }
    for (let i = 0; i < 60; i++) {
      const r = await restPost('payments/mock/pay', { body: {}, headers })
      expect(r.status).toBe(400)
    }
    const limited = await restPost('payments/mock/pay', { body: {}, headers })
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // another client is unaffected
    expect((await restPost('payments/mock/pay', { body: {}, headers: { 'x-real-ip': '203.0.113.78' } })).status).toBe(400)
  })

  it('without a sink, webhooks are dropped in the test env instead of POSTed to PAYLOAD_PUBLIC_SERVER_URL', async () => {
    mock().setWebhookSink(null)
    const order = await newOrder()
    await pay({ razorpayOrderId: order.id, outcome: 'fail' })
    await waitFor(() => mock().webhookLog.length === 1)
    expect(mock().webhookLog[0]).toMatchObject({ event: 'payment.failed', target: 'dropped', delivered: false })
  })

  it('uses an injected MockGateway (setGatewayForTests) with its own state', async () => {
    const isolated = new MockGateway({ runId: 'INTISO' })
    setGatewayForTests(isolated)
    try {
      const order = await isolated.createOrder({ amountPaise: 100, receipt: 'WF-ISO-a1' })
      const res = await pay({ razorpayOrderId: order.id, outcome: 'success', webhook: false })
      expect(res.body.ok).toBe(true)
      expect(res.body.paymentId).toMatch(/^pay_MockINTISO/)
      expect(isolated.verifyPaymentSignature({ orderId: order.id, paymentId: res.body.paymentId, signature: res.body.response.razorpay_signature })).toBe(true)
    } finally {
      resetGateway()
    }
  })
})

describe('POST/DELETE /api/payments/mock/fault (e2e-1)', () => {
  const fault = (body: Record<string, unknown>) => restPost('payments/mock/fault', { body })

  it('arms MockGateway.failNext through the REST stack; the running gateway then fails; DELETE disarms', async () => {
    expect((await fault({ probe: true })).body).toEqual({ ok: true, probe: true, armed: [] })
    const armed = await fault({ op: 'createOrder', kind: 'server' })
    expect(armed.status, armed.text).toBe(200)
    expect(armed.headers.get('cache-control')).toBe('no-store')
    expect(armed.body).toEqual({ ok: true, armed: [{ op: 'createOrder', kind: 'server', remaining: 1, commit: false }] })
    await expect(newOrder()).rejects.toMatchObject({ kind: 'server' })
    expect((await newOrder()).id).toMatch(/^order_/)

    await fault({ op: 'fetchPayment', kind: 'timeout', times: 3 })
    expect(mock().armedFaults()).toEqual([{ op: 'fetchPayment', kind: 'timeout', remaining: 3, commit: false }])
    const cleared = await restDelete('payments/mock/fault')
    expect(cleared.status, cleared.text).toBe(200)
    expect(cleared.body).toEqual({ ok: true, armed: [] })
    expect(mock().armedFaults()).toEqual([])
  })

  it('400 VALIDATION for an unknown op/kind or times out of 1..20; 404 outside mock mode', async () => {
    const bad = await fault({ op: 'dropDatabase', kind: 'server', times: 50 })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'VALIDATION', details: { fields: { op: 'invalid', times: 'invalid' } } })
    expect(mock().armedFaults()).toEqual([])

    process.env.PAYMENTS_MODE = 'razorpay'
    process.env.RAZORPAY_KEY_ID = 'rzp_test_IntFaultGate01'
    process.env.RAZORPAY_KEY_SECRET = 'int-secret'
    process.env.RAZORPAY_WEBHOOK_SECRET = 'int-wh'
    resetGateway()
    const post = await fault({ op: 'createOrder', kind: 'server' })
    expect(post.status).toBe(404)
    expect(post.body).toEqual({ error: { code: 'NOT_FOUND', message: "We couldn't find that." } })
    expect((await fault({ probe: true })).status).toBe(404)
    expect((await restDelete('payments/mock/fault')).status).toBe(404)
    process.env.PAYMENTS_MODE = 'mock'
    resetGateway()
  })
})
