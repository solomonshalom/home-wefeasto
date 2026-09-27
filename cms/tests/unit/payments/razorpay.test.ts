import { inspect } from 'node:util'

import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import Razorpay from 'razorpay'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  configureTransport,
  DEFAULT_TIMEOUT_MS,
  normalizeRazorpayError,
  RazorpayGateway,
  type RazorpayClientLike,
  type RazorpayGatewayOptions,
} from '@/payments/razorpay'
import { signPayment, signWebhook } from '@/payments/signatures'
import { GatewayError } from '@/payments/types'

/**
 * Contract tests of RazorpayGateway against api.razorpay.com mocked with msw (the real SDK and axios run;
 * only the network is fake). razorpay.md §2 lists the SDK defects these guard against.
 */

const API = 'https://api.razorpay.com/v1'
const KEY_ID = 'rzp_test_UnitGateway0001'
const KEY_SECRET = 'unit-key-secret-DO-NOT-LEAK-7f3a'
const WH_SECRET = 'unit-webhook-secret'
const WH_OLD = 'unit-webhook-secret-old'

const ORDER_ID = 'order_UNITAAAAAAAAAA'
const PAY_ID = 'pay_UNITBBBBBBBBBBB'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

type Hits = { count: number; bodies: unknown[]; urls: string[]; headers: Headers[] }
const hits = (): Hits => ({ count: 0, bodies: [], urls: [], headers: [] })

async function record(h: Hits, request: Request) {
  h.count += 1
  h.urls.push(request.url)
  h.headers.push(request.headers)
  if (request.method !== 'GET') h.bodies.push(await request.clone().json().catch(() => null))
}

const orderEntity = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  entity: 'order',
  amount: 49900,
  amount_paid: 0,
  amount_due: 49900,
  currency: 'INR',
  receipt: 'WF-10001-a1',
  offer_id: null,
  status: 'created',
  attempts: 0,
  notes: [],
  created_at: 1758800000,
  ...over,
})

const paymentEntity = (over: Record<string, unknown> = {}) => ({
  id: PAY_ID,
  entity: 'payment',
  amount: 49900,
  currency: 'INR',
  status: 'captured',
  order_id: ORDER_ID,
  method: 'upi',
  amount_refunded: 0,
  refund_status: null,
  captured: true,
  notes: { wf_order: 'WF-10001' },
  email: 'a@example.com',
  contact: '+919876543210',
  error_code: null,
  created_at: 1758800100,
  ...over,
})

const refundEntity = (over: Record<string, unknown> = {}) => ({
  id: 'rfnd_UNITCCCCCCCCCCC',
  entity: 'refund',
  amount: 49900,
  currency: 'INR',
  payment_id: PAY_ID,
  notes: [],
  receipt: 'WF-10001-dup-1',
  acquirer_data: { arn: null },
  created_at: 1758800200,
  batch_id: null,
  status: 'processed',
  speed_processed: 'normal',
  speed_requested: 'normal',
  ...over,
})

const rzpError = (status: number, description: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ error: { code: 'BAD_REQUEST_ERROR', description, source: 'business', step: 'payment_initiation', reason: 'input_validation_failed', metadata: {}, ...extra } }, { status })

function makeGateway(opts: Partial<RazorpayGatewayOptions> = {}) {
  const sleeps: number[] = []
  const logger = { warn: vi.fn(), error: vi.fn() }
  const gateway = new RazorpayGateway({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WH_SECRET,
    webhookSecretOld: WH_OLD,
    // roomy by default (the machine may be busy); timeout tests pass their own short value
    timeoutMs: 2000,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    retryBaseDelayMs: 100,
    retryJitterMs: 100,
    logger,
    ...opts,
  })
  return { gateway, sleeps, logger }
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

describe('RazorpayGateway: success shapes', () => {
  it('createOrder sends amount/currency/receipt/notes with Basic auth and normalises notes', async () => {
    const h = hits()
    server.use(
      http.post(`${API}/orders`, async ({ request }) => {
        await record(h, request)
        const b = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(orderEntity({ amount: b.amount, amount_due: b.amount, receipt: b.receipt, notes: b.notes }))
      }),
    )
    const { gateway } = makeGateway()
    const order = await gateway.createOrder({ amountPaise: 47400, receipt: 'WF-10001-a1', notes: { wf_order: 'WF-10001' } })
    expect(order).toMatchObject({ id: ORDER_ID, amount: 47400, currency: 'INR', receipt: 'WF-10001-a1', status: 'created', notes: { wf_order: 'WF-10001' } })
    expect(h.count).toBe(1)
    expect(h.bodies[0]).toEqual({ amount: 47400, currency: 'INR', receipt: 'WF-10001-a1', notes: { wf_order: 'WF-10001' } })
    expect(h.headers[0].get('authorization')).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`)
    expect(h.headers[0].get('user-agent')).toMatch(/razorpay-node@2\.9\.8/)
  })

  it('fetches orders, payments, order payments, refunds and orders by receipt', async () => {
    const h = hits()
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, () => HttpResponse.json(orderEntity({ status: 'paid', amount_paid: 49900, amount_due: 0, attempts: 2 }))),
      http.get(`${API}/orders/${ORDER_ID}/payments`, () =>
        HttpResponse.json({ entity: 'collection', count: 2, items: [paymentEntity(), paymentEntity({ id: 'pay_UNITFAILEDFAIL1', status: 'failed', notes: [] })] }),
      ),
      http.get(`${API}/payments/${PAY_ID}`, () => HttpResponse.json(paymentEntity())),
      http.get(`${API}/payments/${PAY_ID}/refunds`, () => HttpResponse.json({ entity: 'collection', count: 1, items: [refundEntity()] })),
      http.get(`${API}/orders`, async ({ request }) => {
        await record(h, request)
        const receipt = new URL(request.url).searchParams.get('receipt')
        return HttpResponse.json({
          entity: 'collection',
          count: 2,
          items: [orderEntity({ receipt }), orderEntity({ id: 'order_UNITOTHERRRRRR', receipt: 'WF-99999-a1' })],
        })
      }),
    )
    const { gateway } = makeGateway()
    expect(await gateway.fetchOrder(ORDER_ID)).toMatchObject({ status: 'paid', amount_paid: 49900, attempts: 2, notes: {} })
    const payments = await gateway.fetchOrderPayments(ORDER_ID)
    expect(payments.map((p) => [p.id, p.status])).toEqual([
      [PAY_ID, 'captured'],
      ['pay_UNITFAILEDFAIL1', 'failed'],
    ])
    expect(payments[1].notes).toEqual({})
    expect(await gateway.fetchPayment(PAY_ID)).toMatchObject({ id: PAY_ID, status: 'captured', order_id: ORDER_ID })
    expect((await gateway.fetchRefunds(PAY_ID))[0]).toMatchObject({ id: 'rfnd_UNITCCCCCCCCCCC', notes: {} })
    const byReceipt = await gateway.findOrdersByReceipt('WF-10001-a1')
    expect(byReceipt.map((o) => o.receipt)).toEqual(['WF-10001-a1']) // foreign receipts filtered out
    const q = new URL(h.urls[0]).searchParams
    expect(q.get('receipt')).toBe('WF-10001-a1')
    expect(q.get('count')).toBe('100')
  })

  it('signature helpers use the configured secrets (current and old webhook secret)', () => {
    const { gateway } = makeGateway()
    const sig = signPayment(ORDER_ID, PAY_ID, KEY_SECRET)
    expect(gateway.verifyPaymentSignature({ orderId: ORDER_ID, paymentId: PAY_ID, signature: sig })).toBe(true)
    expect(gateway.verifyPaymentSignature({ orderId: ORDER_ID, paymentId: PAY_ID, signature: signPayment(ORDER_ID, PAY_ID, 'x') })).toBe(false)
    const raw = '{"entity":"event","event":"order.paid"}'
    expect(gateway.verifyWebhookSignature(raw, signWebhook(raw, WH_SECRET))).toBe(true)
    expect(gateway.verifyWebhookSignature(raw, signWebhook(raw, WH_OLD))).toBe(true)
    expect(gateway.verifyWebhookSignature(raw, signWebhook(raw, KEY_SECRET))).toBe(false)
  })
})

describe('RazorpayGateway: timeouts', () => {
  it('configures a 10 s timeout on the SDK axios instance by default (pins the SDK internal)', () => {
    const client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET }) as unknown as RazorpayClientLike & { api: { rq: { defaults: { timeout: number } } } }
    expect(client.api.rq.defaults.timeout).toBe(0) // the SDK default: no timeout at all
    const gateway = new RazorpayGateway({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WH_SECRET, client })
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000)
    expect(gateway.timeoutMs).toBe(10_000)
    expect(gateway.transportConfigured).toBe(true)
    expect(client.api.rq.defaults.timeout).toBe(10_000)
  })

  it('a hanging response becomes a retryable timeout GatewayError (retried once)', async () => {
    const h = hits()
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, async ({ request }) => {
        await record(h, request)
        await delay(3000)
        return HttpResponse.json(orderEntity())
      }),
    )
    const { gateway, sleeps } = makeGateway({ timeoutMs: 150 })
    const started = Date.now()
    const err = await rejection(gateway.fetchOrder(ORDER_ID))
    const elapsed = Date.now() - started
    expect(err).toMatchObject({ kind: 'timeout', code: 'TIMEOUT', statusCode: 0, retryable: true, op: 'fetchOrder' })
    expect(err.outcomeUnknown).toBe(true)
    expect(h.count).toBe(2)
    expect(sleeps).toEqual([150]) // base 100 + 0.5 × jitter 100
    expect(elapsed).toBeGreaterThanOrEqual(280)
    expect(elapsed).toBeLessThan(1500)
  })

  it('a response whose body trickles past the deadline is a timeout too (not the SDK TypeError)', async () => {
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, () => {
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          async start(c) {
            for (let i = 0; i < 30; i++) {
              c.enqueue(enc.encode(' '))
              await delay(100)
            }
            c.enqueue(enc.encode(JSON.stringify(orderEntity())))
            c.close()
          },
        })
        return new HttpResponse(stream, { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
    const { gateway } = makeGateway({ timeoutMs: 200, retries: 0 })
    const started = Date.now()
    expect(await rejection(gateway.fetchOrder(ORDER_ID))).toMatchObject({ kind: 'timeout', code: 'TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('the per-request AbortSignal deadline still fires when the axios timeout is gone', async () => {
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, async () => {
        await delay(3000)
        return HttpResponse.json(orderEntity())
      }),
    )
    const client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET }) as unknown as RazorpayClientLike & { api: { rq: { defaults: { timeout: number } } } }
    const gateway = new RazorpayGateway({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WH_SECRET, client, timeoutMs: 150, retries: 0 })
    client.api.rq.defaults.timeout = 0 // e.g. a socket-idle timer that a trickling response keeps alive
    const started = Date.now()
    const err = await rejection(gateway.fetchOrder(ORDER_ID))
    expect(err.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1100) // deadline = timeout + 250 ms, well before the 3 s response
  })

  it('the Promise.race backstop bounds calls even without access to the SDK transport', async () => {
    const hanging = () => new Promise<never>(() => {})
    const client: RazorpayClientLike = {
      orders: { create: hanging, fetch: hanging, fetchPayments: hanging, all: hanging },
      payments: { fetch: hanging, refund: hanging, fetchMultipleRefund: hanging },
    }
    const gateway = new RazorpayGateway({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WH_SECRET, client, timeoutMs: 50, retries: 0 })
    expect(gateway.transportConfigured).toBe(false)
    const started = Date.now()
    const err = await rejection(gateway.fetchPayment(PAY_ID))
    expect(err).toMatchObject({ kind: 'timeout', op: 'fetchPayment' })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('RazorpayGateway: error normalisation and retries', () => {
  it('a network error is normalised (not the SDK TypeError), retried once, then thrown as unknown outcome', async () => {
    const h = hits()
    server.use(
      http.get(`${API}/payments/${PAY_ID}`, async ({ request }) => {
        await record(h, request)
        return HttpResponse.error()
      }),
    )
    const { gateway, logger } = makeGateway()
    const err = await rejection(gateway.fetchPayment(PAY_ID))
    expect(err).toMatchObject({ kind: 'network', code: 'NETWORK_ERROR', statusCode: 0, retryable: true })
    expect(err.outcomeUnknown).toBe(true)
    expect(h.count).toBe(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ op: 'fetchPayment', attempt: 1, kind: 'network' })
  })

  it('a 502 with an HTML body becomes a server error; a retry that succeeds returns the value', async () => {
    let n = 0
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, () => {
        n += 1
        if (n === 1) return new HttpResponse('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } })
        return HttpResponse.json(orderEntity())
      }),
    )
    const { gateway } = makeGateway()
    expect(await gateway.fetchOrder(ORDER_ID)).toMatchObject({ id: ORDER_ID })
    expect(n).toBe(2)

    server.use(http.get(`${API}/orders/${ORDER_ID}`, () => new HttpResponse('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })))
    const err = await rejection(gateway.fetchOrder(ORDER_ID))
    expect(err).toMatchObject({ kind: 'server', statusCode: 502, code: 'SERVER_ERROR', retryable: true })
    // an empty 503 body must not crash the SDK's `err.response.data.error` either
    server.use(http.get(`${API}/orders/${ORDER_ID}`, () => new HttpResponse(null, { status: 503 })))
    expect(await rejection(gateway.fetchOrder(ORDER_ID))).toMatchObject({ kind: 'server', statusCode: 503 })
  })

  it('429 then success: backs off (doubled for rate limits) and succeeds', async () => {
    let n = 0
    server.use(
      http.get(`${API}/payments/${PAY_ID}`, () => {
        n += 1
        return n === 1 ? rzpError(429, 'Too many requests') : HttpResponse.json(paymentEntity())
      }),
    )
    const { gateway, sleeps } = makeGateway()
    expect(await gateway.fetchPayment(PAY_ID)).toMatchObject({ id: PAY_ID })
    expect(n).toBe(2)
    expect(sleeps).toEqual([250]) // 100 × 2 (rate limited) + 0.5 × 100
  })

  it('429 twice: rate_limited is thrown after one retry', async () => {
    let n = 0
    server.use(
      http.get(`${API}/payments/${PAY_ID}`, () => {
        n += 1
        return rzpError(429, 'Too many requests')
      }),
    )
    const { gateway } = makeGateway()
    expect(await rejection(gateway.fetchPayment(PAY_ID))).toMatchObject({ kind: 'rate_limited', statusCode: 429, retryable: true })
    expect(n).toBe(2)
  })

  it('400 is a bad_request, never retried, with Razorpay field/reason kept', async () => {
    const h = hits()
    server.use(
      http.post(`${API}/orders`, async ({ request }) => {
        await record(h, request)
        return rzpError(400, 'Amount exceeds maximum amount allowed.', { field: 'amount' })
      }),
    )
    const { gateway } = makeGateway()
    const err = await rejection(gateway.createOrder({ amountPaise: 99_999_999, receipt: 'WF-10002-a1' }))
    expect(err).toMatchObject({
      kind: 'bad_request',
      statusCode: 400,
      code: 'BAD_REQUEST_ERROR',
      description: 'Amount exceeds maximum amount allowed.',
      field: 'amount',
      reason: 'input_validation_failed',
      condition: 'amount_too_large',
      retryable: false,
      op: 'createOrder',
    })
    expect(err.outcomeUnknown).toBe(false)
    expect(h.count).toBe(1)
  })

  it('401 (bad keys) is auth, not retried', async () => {
    const h = hits()
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, async ({ request }) => {
        await record(h, request)
        return HttpResponse.json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }, { status: 401 })
      }),
    )
    const { gateway } = makeGateway()
    expect(await rejection(gateway.fetchOrder(ORDER_ID))).toMatchObject({ kind: 'auth', statusCode: 401, description: 'Authentication failed', retryable: false })
    expect(h.count).toBe(1)
  })

  it('"The id provided does not exist" is not_found', async () => {
    server.use(http.get(`${API}/payments/${PAY_ID}`, () => rzpError(400, 'The id provided does not exist')))
    const { gateway } = makeGateway()
    expect(await rejection(gateway.fetchPayment(PAY_ID))).toMatchObject({ kind: 'not_found', statusCode: 400, condition: 'id_not_found', retryable: false })
  })

  it('invalid ids and inputs are rejected locally without any HTTP call', async () => {
    const { gateway } = makeGateway() // onUnhandledRequest: 'error' would fail any request
    for (const p of [
      gateway.fetchOrder(''),
      gateway.fetchOrder('order_../../payments'),
      gateway.fetchPayment('pay_x'),
      gateway.fetchOrderPayments(undefined as unknown as string),
      gateway.refund('order_UNITAAAAAAAAAA', { receipt: 'r' }),
      gateway.createOrder({ amountPaise: 99, receipt: 'WF-1-a1' }),
      gateway.createOrder({ amountPaise: 100.5, receipt: 'WF-1-a1' }),
      gateway.createOrder({ amountPaise: '100' as unknown as number, receipt: 'WF-1-a1' }),
      gateway.createOrder({ amountPaise: 100, receipt: 'x'.repeat(41) }),
      gateway.createOrder({ amountPaise: 100, receipt: 'WF-1-a1-₹' }),
      gateway.createOrder({ amountPaise: 100, receipt: '' }),
      gateway.createOrder({ amountPaise: 100, receipt: 'WF-1-a1', notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) }),
      gateway.createOrder({ amountPaise: 100, receipt: 'WF-1-a1', notes: { a: 'x'.repeat(257) } }),
      gateway.createOrder({ amountPaise: 100, receipt: 'WF-1-a1', notes: { a: 1 as unknown as string } }),
      gateway.refund(PAY_ID, { receipt: 'WF-1-r1', amountPaise: 0 }),
      gateway.refund(PAY_ID, { receipt: 'WF-1-r1', amountPaise: -5 }),
      gateway.refund(PAY_ID, { receipt: 'WF-1-r1', speed: 'instant' as 'normal' }),
    ]) {
      expect(await rejection(p)).toMatchObject({ kind: 'bad_request', retryable: false })
    }
  })

  it('"another operation is in progress" is retryable but not auto-retried', async () => {
    let n = 0
    server.use(
      http.post(`${API}/orders`, () => {
        n += 1
        return rzpError(400, 'Request failed because another order operation is in progress.')
      }),
    )
    const { gateway } = makeGateway()
    expect(await rejection(gateway.createOrder({ amountPaise: 100, receipt: 'WF-1-a1' }))).toMatchObject({
      kind: 'bad_request',
      condition: 'operation_in_progress',
      retryable: true,
    })
    expect(n).toBe(1)
  })
})

describe('RazorpayGateway: createOrder idempotency by receipt', () => {
  it('network error, then "Duplicate request" on the retry → recovers the order via orders.all({receipt})', async () => {
    const posts = hits()
    const gets = hits()
    server.use(
      http.post(`${API}/orders`, async ({ request }) => {
        await record(posts, request)
        return posts.count === 1 ? HttpResponse.error() : rzpError(400, 'Duplicate request. This request has already been processed.')
      }),
      http.get(`${API}/orders`, async ({ request }) => {
        await record(gets, request)
        return HttpResponse.json({ entity: 'collection', count: 1, items: [orderEntity({ amount: 47400, amount_due: 47400, receipt: 'WF-10003-a1' })] })
      }),
    )
    const { gateway } = makeGateway()
    const order = await gateway.createOrder({ amountPaise: 47400, receipt: 'WF-10003-a1' })
    expect(order).toMatchObject({ id: ORDER_ID, amount: 47400, receipt: 'WF-10003-a1' })
    expect(posts.count).toBe(2)
    expect(posts.bodies[0]).toEqual(posts.bodies[1]) // same receipt, same body
    expect(gets.count).toBe(1)
    expect(new URL(gets.urls[0]).searchParams.get('receipt')).toBe('WF-10003-a1')
  })

  it('a 5xx on the first create then success on the retry returns the new order', async () => {
    let n = 0
    server.use(
      http.post(`${API}/orders`, () => {
        n += 1
        return n === 1 ? new HttpResponse('<html>oops</html>', { status: 504 }) : HttpResponse.json(orderEntity())
      }),
    )
    const { gateway } = makeGateway()
    expect(await gateway.createOrder({ amountPaise: 49900, receipt: 'WF-10001-a1' })).toMatchObject({ id: ORDER_ID })
    expect(n).toBe(2)
  })

  it('a first-call duplicate (receipt reused after a crash) is recovered too', async () => {
    const posts = hits()
    server.use(
      http.post(`${API}/orders`, async ({ request }) => {
        await record(posts, request)
        return rzpError(400, 'Duplicate request. This request has already been processed.')
      }),
      http.get(`${API}/orders`, () => HttpResponse.json({ entity: 'collection', count: 1, items: [orderEntity()] })),
    )
    const { gateway } = makeGateway()
    expect(await gateway.createOrder({ amountPaise: 49900, receipt: 'WF-10001-a1' })).toMatchObject({ id: ORDER_ID })
    expect(posts.count).toBe(1)
  })

  it('a recovered order with a different amount is a RECEIPT_CONFLICT; none found is DUPLICATE_UNRESOLVED', async () => {
    server.use(
      http.post(`${API}/orders`, () => rzpError(400, 'Duplicate request. This request has already been processed.')),
      http.get(`${API}/orders`, () => HttpResponse.json({ entity: 'collection', count: 1, items: [orderEntity({ amount: 100 })] })),
    )
    const { gateway } = makeGateway()
    expect(await rejection(gateway.createOrder({ amountPaise: 49900, receipt: 'WF-10001-a1' }))).toMatchObject({
      code: 'RECEIPT_CONFLICT',
      condition: 'receipt_conflict',
      kind: 'bad_request',
    })
    server.use(http.get(`${API}/orders`, () => HttpResponse.json({ entity: 'collection', count: 0, items: [] })))
    expect(await rejection(gateway.createOrder({ amountPaise: 49900, receipt: 'WF-10001-a1' }))).toMatchObject({
      code: 'DUPLICATE_UNRESOLVED',
      retryable: true,
    })
  })
})

describe('RazorpayGateway: refunds', () => {
  it('creates a refund with amount, receipt, speed and notes', async () => {
    const h = hits()
    server.use(
      http.post(`${API}/payments/${PAY_ID}/refund`, async ({ request }) => {
        await record(h, request)
        return HttpResponse.json(refundEntity({ amount: 12500, receipt: 'WF-10001-r1' }))
      }),
    )
    const { gateway } = makeGateway()
    const refund = await gateway.refund(PAY_ID, { amountPaise: 12500, receipt: 'WF-10001-r1', notes: { reason: 'oversell' } })
    expect(refund).toMatchObject({ id: 'rfnd_UNITCCCCCCCCCCC', amount: 12500, status: 'processed', notes: {} })
    expect(h.bodies[0]).toEqual({ amount: 12500, receipt: 'WF-10001-r1', speed: 'normal', notes: { reason: 'oversell' } })
    // full refund: no amount sent
    await gateway.refund(PAY_ID, { receipt: 'WF-10001-r2' })
    expect(h.bodies[1]).toEqual({ receipt: 'WF-10001-r2', speed: 'normal', notes: {} })
  })

  it.each([
    ['The refund amount provided is greater than amount captured.', 'amount_exceeds_captured'],
    ['The payment has been fully refunded already.', 'already_refunded'],
    ['The payment status should be captured for action to be taken.', 'not_captured'],
    ['Your account does not have enough balance to carry out the refund operation.', 'insufficient_balance'],
    ['The refund on this payment is blocked due to ongoing dispute investigation.', 'refund_blocked_dispute'],
  ])('"%s" → bad_request (%s), not retried', async (description, condition) => {
    let n = 0
    server.use(
      http.post(`${API}/payments/${PAY_ID}/refund`, () => {
        n += 1
        return rzpError(400, description)
      }),
    )
    const { gateway } = makeGateway()
    expect(await rejection(gateway.refund(PAY_ID, { amountPaise: 60000, receipt: 'WF-10001-r1' }))).toMatchObject({
      kind: 'bad_request',
      condition,
      description,
      op: 'refund',
    })
    expect(n).toBe(1)
  })

  it('unknown outcome: looks the refund up by receipt before re-sending (found → no second POST)', async () => {
    const posts = hits()
    server.use(
      http.post(`${API}/payments/${PAY_ID}/refund`, async ({ request }) => {
        await record(posts, request)
        return HttpResponse.error()
      }),
      http.get(`${API}/payments/${PAY_ID}/refunds`, () =>
        HttpResponse.json({ entity: 'collection', count: 2, items: [refundEntity({ id: 'rfnd_UNITOTHERRRRRR', receipt: 'other' }), refundEntity({ amount: 12500, receipt: 'WF-10001-r1' })] }),
      ),
    )
    const { gateway } = makeGateway()
    expect(await gateway.refund(PAY_ID, { amountPaise: 12500, receipt: 'WF-10001-r1' })).toMatchObject({ receipt: 'WF-10001-r1', amount: 12500 })
    expect(posts.count).toBe(1)
  })

  it('unknown outcome, nothing found → one retry with the same receipt', async () => {
    const posts = hits()
    server.use(
      http.post(`${API}/payments/${PAY_ID}/refund`, async ({ request }) => {
        await record(posts, request)
        return posts.count === 1 ? new HttpResponse('bad gateway', { status: 502 }) : HttpResponse.json(refundEntity({ receipt: 'WF-10001-r1' }))
      }),
      http.get(`${API}/payments/${PAY_ID}/refunds`, () => HttpResponse.json({ entity: 'collection', count: 0, items: [] })),
    )
    const { gateway } = makeGateway()
    expect(await gateway.refund(PAY_ID, { receipt: 'WF-10001-r1' })).toMatchObject({ receipt: 'WF-10001-r1' })
    expect(posts.count).toBe(2)
    expect(posts.bodies[0]).toEqual(posts.bodies[1])
  })

  it('unknown outcome and the lookup fails too → the original error, no blind re-send', async () => {
    const posts = hits()
    server.use(
      http.post(`${API}/payments/${PAY_ID}/refund`, async ({ request }) => {
        await record(posts, request)
        return HttpResponse.error()
      }),
      http.get(`${API}/payments/${PAY_ID}/refunds`, () => HttpResponse.error()),
    )
    const { gateway } = makeGateway()
    expect(await rejection(gateway.refund(PAY_ID, { amountPaise: 100, receipt: 'WF-10001-r1' }))).toMatchObject({ kind: 'network', op: 'refund' })
    expect(posts.count).toBe(1)
  })

  it('"Duplicate receipt" returns the existing refund, or RECEIPT_CONFLICT when the amount differs', async () => {
    server.use(
      http.post(`${API}/payments/${PAY_ID}/refund`, () => rzpError(400, 'Duplicate receipt found for this refund request.')),
      http.get(`${API}/payments/${PAY_ID}/refunds`, () => HttpResponse.json({ entity: 'collection', count: 1, items: [refundEntity({ amount: 5000, receipt: 'WF-10001-r1' })] })),
    )
    const { gateway } = makeGateway()
    expect(await gateway.refund(PAY_ID, { amountPaise: 5000, receipt: 'WF-10001-r1' })).toMatchObject({ amount: 5000 })
    expect(await gateway.refund(PAY_ID, { receipt: 'WF-10001-r1' })).toMatchObject({ amount: 5000 }) // full refund asked, existing wins
    expect(await rejection(gateway.refund(PAY_ID, { amountPaise: 6000, receipt: 'WF-10001-r1' }))).toMatchObject({ code: 'RECEIPT_CONFLICT' })
  })
})

describe('RazorpayGateway: secrets never leak', () => {
  it('errors, logs and the gateway object carry no secret', async () => {
    server.use(
      http.get(`${API}/orders/${ORDER_ID}`, () => HttpResponse.json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }, { status: 401 })),
      http.get(`${API}/payments/${PAY_ID}`, () => HttpResponse.error()),
    )
    const { gateway, logger } = makeGateway()
    const errors = [await rejection(gateway.fetchOrder(ORDER_ID)), await rejection(gateway.fetchPayment(PAY_ID))]
    const b64 = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')
    const dumps = [
      ...errors.flatMap((e) => [JSON.stringify(e), e.message, String(e.stack), inspect(e, { depth: 10 })]),
      JSON.stringify(logger.warn.mock.calls),
      JSON.stringify(gateway),
      inspect(gateway, { depth: 10, showHidden: true }),
    ]
    for (const d of dumps) {
      expect(d).not.toContain(KEY_SECRET)
      expect(d).not.toContain(WH_SECRET)
      expect(d).not.toContain(b64)
    }
    expect(JSON.stringify(gateway)).toBe(JSON.stringify({ provider: 'razorpay', keyId: KEY_ID }))
  })

  it('refuses to construct without keys', () => {
    expect(() => new RazorpayGateway({ keyId: '', keySecret: 'x', webhookSecret: 'y' })).toThrow(/RAZORPAY_KEY_ID/)
    expect(() => new RazorpayGateway({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: '' })).toThrow(/WEBHOOK_SECRET/)
  })
})

describe('normalizeRazorpayError (every rejection shape the SDK produces)', () => {
  it.each([
    [{ statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'x' } }, { kind: 'bad_request', statusCode: 400, code: 'BAD_REQUEST_ERROR', retryable: false }],
    [{ statusCode: 502 }, { kind: 'server', statusCode: 502, code: 'SERVER_ERROR', retryable: true }],
    [{ statusCode: 429, error: {} }, { kind: 'rate_limited', statusCode: 429, code: 'RATE_LIMITED', retryable: true }],
    [{ statusCode: 401, error: { description: 'Authentication failed', code: 'BAD_REQUEST_ERROR' } }, { kind: 'auth', retryable: false }],
    [{ statusCode: 403 }, { kind: 'auth' }],
    [{ statusCode: 404 }, { kind: 'not_found' }],
    [{ statusCode: 400, error: { description: 'The id provided does not exist' } }, { kind: 'not_found', condition: 'id_not_found' }],
    [{ statusCode: 0, error: { code: 'WF_TIMEOUT', description: 't' } }, { kind: 'timeout', code: 'TIMEOUT' }],
    [{ statusCode: 0, error: { code: 'WF_NETWORK', description: 'n' } }, { kind: 'network', code: 'NETWORK_ERROR' }],
    [new TypeError("Cannot read properties of undefined (reading 'status')"), { kind: 'network', code: 'NETWORK_ERROR', retryable: true }],
    [new Error('`order_id` is mandatory'), { kind: 'bad_request', retryable: false }],
    ['weird', { kind: 'network', code: 'UNKNOWN_ERROR' }],
    [null, { kind: 'network', code: 'UNKNOWN_ERROR' }],
  ])('%j', (input, expected) => {
    const err = normalizeRazorpayError(input, 'op')
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject(expected)
  })

  it('passes GatewayErrors through and keeps a readable message', () => {
    const original = new GatewayError({ kind: 'timeout', code: 'TIMEOUT', description: 'slow', statusCode: 0, op: 'fetchOrder' })
    expect(normalizeRazorpayError(original)).toBe(original)
    expect(original.message).toBe('fetchOrder: timeout - TIMEOUT: slow')
    expect(original.name).toBe('GatewayError')
  })

  it('configureTransport reports false for clients without an axios instance', () => {
    expect(configureTransport({} as RazorpayClientLike, 1000)).toBe(false)
  })
})
