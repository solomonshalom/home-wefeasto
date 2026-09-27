import { randomUUID } from 'node:crypto'

import { initTransaction, killTransaction, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { onOrderEvent, type OrderEvent } from '@/commerce/events'
import { resetRateLimits } from '@/lib/rateLimit'

import {
  checkoutBody,
  deliver,
  freshMock,
  makeProduct,
  mock,
  orderByNumber,
  placeOrderVia,
  postCheckout,
  quoteTotal,
  restoreEnv,
  settle,
  status,
  stockOf,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createCustomer, createStaff, login } from './helpers/factories'
import { makeReq, getTestPayload } from './helpers/payload'
import { restGet, restPatch, restPost } from './helpers/rest'

/**
 * Order read endpoints (status DTO, /orders/mine), the household answer, access control, and the Orders
 * afterChange effects of admin edits (cancel releases stock, shipped/delivered events + email).
 */

let payload: Payload
const events: OrderEvent[] = []
const unsubscribe: (() => void)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  for (const type of ['order.confirmed', 'order.cancelled', 'order.shipped', 'order.delivered', 'order.household_updated', 'order.refunded'] as const) {
    unsubscribe.push(onOrderEvent(type, `test:orders:${type}`, (e) => void events.push(e)))
  }
})

beforeEach(() => {
  freshMock()
  events.length = 0
})

afterEach(async () => {
  await settle()
  restoreEnv(['PAYMENTS_MODE', 'RATE_LIMIT_DISABLED'])
  resetRateLimits()
})

afterAll(async () => {
  for (const u of unsubscribe) u()
  await restoreStoreSettings(payload)
})

const eventsFor = (number: string, type?: string) => events.filter((e) => e.order.number === number && (!type || e.type === type))

async function codOrder(opts: { qty?: number; stock?: number; cookie?: string } = {}) {
  const p = await makeProduct(payload, { stock: opts.stock ?? 10, pricePaise: 30000 })
  const items = [{ slug: p.slug as string, qty: opts.qty ?? 2 }]
  const body = checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod' })
  const res = await postCheckout(body, randomUUID(), opts.cookie ? { cookie: opts.cookie } : {})
  expect(res.status, res.text).toBe(201)
  return { product: p, number: res.body.order.number as string, token: res.body.order.token as string, body }
}

describe('GET /api/store/orders/status', () => {
  it('returns the OrderStatusDTO with masked contact details and nothing else personal', async () => {
    const { number, token, body } = await codOrder()
    const res = await status(number, token)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const dto = res.body
    expect(Object.keys(dto).sort()).toEqual(
      [
        'number', 'status', 'paymentStatus', 'paymentMethod', 'requestedMethod', 'fulfilmentStatus', 'createdAt', 'paidAt', 'items',
        'subtotalPaise', 'discountPaise', 'deliveryPaise', 'codFeePaise', 'totalPaise', 'currency', 'coupon', 'contact', 'address',
        'canRetryPayment', 'isConfirmed', 'shippingPromiseText', 'householdSize',
      ].sort(),
    )
    expect(dto).toMatchObject({
      number,
      status: 'cod_pending',
      paymentMethod: 'cod',
      requestedMethod: 'cod',
      fulfilmentStatus: 'unfulfilled',
      subtotalPaise: 60000,
      totalPaise: 60000,
      coupon: null,
      canRetryPayment: false,
      isConfirmed: true,
      address: { city: 'Bengaluru', state: 'Karnataka' },
      contact: { firstName: 'Asha' },
      householdSize: null,
    })
    expect(dto.shippingPromiseText).toBeTruthy()
    expect(dto.items[0]).toEqual({ slug: body.items[0].slug, name: expect.any(String), qty: 2, unitPaise: 30000, lineTotalPaise: 60000, image: expect.any(String) })
    expect(dto.contact.emailMasked).toMatch(/^[a-z0-9]•••@test\.wefeasto\.dev$/)
    expect(dto.contact.phoneMasked).toMatch(/^\+91 ••••• ••\d{3}$/)
    const text = res.text
    for (const secret of [body.contact.email, body.contact.phone, body.address.line1, body.address.pin, token]) expect(text).not.toContain(secret)
  })

  it('unknown order, wrong token and malformed input → byte-identical 404s', async () => {
    const a = await codOrder()
    const b = await codOrder()
    const answers = await Promise.all([
      status(a.number, b.token),
      status('WF-99996', a.token),
      status('WF-1', a.token),
      status(a.number, 'short'),
      restGet('store/orders/status', { query: { no: a.number } }),
      restGet('store/orders/status'),
    ])
    for (const res of answers) {
      expect(res.status).toBe(404)
      expect(res.text).toBe(answers[0].text)
      expect(res.headers.get('content-type')).toBe(answers[0].headers.get('content-type'))
    }
    expect(answers[0].body.error).toEqual({ code: 'NOT_FOUND', message: "We couldn't find that order." })
  })

  it('rate limits per order (60/min) generously enough for /order polling', async () => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    const { number, token } = await codOrder()
    const headers = { 'x-real-ip': '198.51.100.9' }
    let last = 0
    for (let i = 0; i < 61; i++) last = (await restGet('store/orders/status', { query: { no: number, t: token }, headers })).status
    expect(last).toBe(429)
  })

  it('pull-reconcile: a pending order whose attempt is older than 20 s is checked with the gateway while /order polls', async () => {
    const p = await makeProduct(payload)
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }])
    const { number, token } = res.body.order
    await mock().simulatePayment(res.body.payment.razorpayOrderId, { outcome: 'success' }) // lost handler, no webhook
    const order = await orderByNumber(payload, number)
    const attempts = (order.razorpay?.attempts ?? []).map((a) => ({ ...a, createdAt: new Date(Date.now() - 60_000).toISOString() }))
    await payload.update({ collection: 'orders', id: order.id, data: { razorpay: { ...order.razorpay, attempts } } as never, context: { wfCheckout: true } })
    const first = await status(number, token)
    expect(first.body.status).toBe('pending_payment')
    await settle()
    const second = await status(number, token)
    expect(second.body.status).toBe('paid')
    expect((await orderByNumber(payload, number)).paidVia).toBe('reconcile')
  })
})

describe('GET /api/store/orders/mine', () => {
  it('401 for guests and staff; a customer sees only orders placed while signed in, newest first, with tokens', async () => {
    const guest = await restGet('store/orders/mine')
    expect(guest.status).toBe(401)
    expect(guest.body.error.code).toBe('UNAUTHORIZED')
    const staff = await createStaff(payload, 'admin')
    const { token: staffToken } = await login('users', staff.email)
    expect((await restGet('store/orders/mine', { token: staffToken })).status).toBe(401)

    const customer = await createCustomer(payload)
    const { cookie } = await login('customers', customer.email)
    const first = await codOrder({ cookie })
    const second = await codOrder({ cookie })
    // A guest order with the same email is NOT back-linked (SPEC §0).
    const p = await makeProduct(payload)
    const items = [{ slug: p.slug as string, qty: 2 }]
    await postCheckout(checkoutBody(items, await quoteTotal(items), { contact: { name: 'Test Customer', email: customer.email, phone: first.body.contact.phone } }))
    const other = await createCustomer(payload)
    const otherLogin = await login('customers', other.email)
    await codOrder({ cookie: otherLogin.cookie })

    const res = await restGet('store/orders/mine', { cookie })
    expect(res.status).toBe(200)
    expect(res.body.orders.map((o: { number: string }) => o.number)).toEqual([second.number, first.number])
    expect(res.body.orders[0].token).toBe(second.token)
    expect((await status(first.number, res.body.orders[1].token)).status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('POST /api/store/orders/household (retention route) with a real checkout token', () => {
  it('stores householdSize and emits order.household_updated; wrong token → 404', async () => {
    const { number, token } = await codOrder()
    const ok = await restPost('store/orders/household', { body: { number, token, size: 3 } })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body).toEqual({ ok: true })
    expect((await orderByNumber(payload, number)).householdSize).toBe(3)
    expect((await status(number, token)).body.householdSize).toBe(3)
    expect(eventsFor(number, 'order.household_updated')).toHaveLength(1)
    const other = await codOrder()
    const bad = await restPost('store/orders/household', { body: { number, token: other.token, size: 2 } })
    expect(bad.status).toBe(404)
  })
})

describe('access control (REST)', () => {
  it('customers cannot read or write orders, payment events or coupon redemptions', async () => {
    const customer = await createCustomer(payload)
    const { token } = await login('customers', customer.email)
    const mine = await codOrder()
    const order = await orderByNumber(payload, mine.number)
    for (const path of ['orders', `orders/${order.id}`, 'payment-events', 'coupon-redemptions']) {
      const res = await restGet(path, { token })
      expect([401, 403], path).toContain(res.status)
    }
    const create = await restPost('orders', { body: { status: 'paid' }, token })
    expect([401, 403]).toContain(create.status)
    const patch = await restPatch(`orders/${order.id}`, { body: { status: 'cancelled' }, token })
    expect([401, 403]).toContain(patch.status)
    const anon = await restGet(`orders/${order.id}`)
    expect([401, 403]).toContain(anon.status)
    expect((await orderByNumber(payload, mine.number)).status).toBe('cod_pending')
  })
})

describe('admin edits (Orders afterChange effects)', () => {
  async function adminToken() {
    const admin = await createStaff(payload, 'admin')
    return (await login('users', admin.email)).token
  }

  it('cancelling an unshipped COD order releases its stock and coupon, then emits order.cancelled', async () => {
    const c = await payload.create({ collection: 'coupons', data: { code: `CXL${Date.now().toString(36).toUpperCase()}`, type: 'percent', value: 10, usedCount: 0, active: true } as never })
    const p = await makeProduct(payload, { stock: 5, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 2 }]
    const res = await postCheckout(checkoutBody(items, 54000, { method: 'cod', couponCode: c.code }))
    expect(res.status, res.text).toBe(201)
    expect(await stockOf(payload, p.slug as string)).toBe(3)
    const order = await orderByNumber(payload, res.body.order.number)
    const token = await adminToken()
    const patch = await restPatch(`orders/${order.id}`, { body: { status: 'cancelled' }, token })
    expect(patch.status, patch.text).toBe(200)
    await settle()
    expect(await stockOf(payload, p.slug as string)).toBe(5)
    expect(await orderByNumber(payload, order.number)).toMatchObject({ status: 'cancelled', stockState: 'released' })
    const red = await payload.find({ collection: 'coupon-redemptions', where: { order: { equals: order.id } }, overrideAccess: true })
    expect(red.docs[0].status).toBe('released')
    expect(eventsFor(order.number, 'order.cancelled')).toHaveLength(1)
    expect(eventsFor(order.number, 'order.cancelled')[0]).toMatchObject({ previousStatus: 'cod_pending', order: { status: 'cancelled' } })
  })

  it('shipped → order.shipped (+ email), delivered → order.delivered, each once and after the commit', async () => {
    const { number } = await codOrder()
    const order = await orderByNumber(payload, number)
    const token = await adminToken()
    expect((await restPatch(`orders/${order.id}`, { body: { status: 'cod_confirmed' }, token })).status).toBe(200)
    expect((await restPatch(`orders/${order.id}`, { body: { fulfilmentStatus: 'shipped' }, token })).status).toBe(200)
    await settle()
    expect(eventsFor(number, 'order.shipped')).toHaveLength(1)
    expect(eventsFor(number, 'order.shipped')[0].order.fulfilmentStatus).toBe('shipped')
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: `ship:${number}` } }, overrideAccess: true })
    expect(log.docs).toHaveLength(1)
    expect((await restPatch(`orders/${order.id}`, { body: { fulfilmentStatus: 'delivered' }, token })).status).toBe(200)
    await settle()
    expect(eventsFor(number, 'order.delivered')).toHaveLength(1)
    expect(eventsFor(number, 'order.shipped')).toHaveLength(1)
  })

  it('a rolled-back update emits nothing', async () => {
    const { number } = await codOrder()
    const order = await orderByNumber(payload, number)
    await payload.update({ collection: 'orders', id: order.id, data: { status: 'cod_confirmed' } })
    const req = await makeReq()
    await initTransaction(req)
    await payload.update({ collection: 'orders', id: order.id, data: { fulfilmentStatus: 'shipped' }, req })
    await killTransaction(req)
    await settle()
    expect(eventsFor(number, 'order.shipped')).toHaveLength(0)
    expect((await orderByNumber(payload, number)).fulfilmentStatus).toBe('unfulfilled')
  })

  it('an admin resolving needs_review → paid emits order.confirmed and sends the confirmation once', async () => {
    const p = await makeProduct(payload)
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }])
    const { number } = res.body.order
    const r = await mock().simulatePayment(res.body.payment.razorpayOrderId, { outcome: 'success' })
    // Mismatched amount → needs_review, then a correct payment on the same order is recorded for review.
    const bad = mock().buildWebhook('payment.captured', { payment: { ...r.payment, amount: 100 } })
    await restPost('payments/razorpay/webhook', { rawBody: bad.body, contentType: 'application/json', headers: { 'x-razorpay-signature': bad.signature, 'x-razorpay-event-id': bad.eventId } })
    await deliver(r.events)
    let order = await orderByNumber(payload, number)
    expect(order.status).toBe('needs_review')
    expect(order.razorpay?.paymentId).toBe(r.payment.id)
    const token = await adminToken()
    const patch = await restPatch(`orders/${order.id}`, { body: { status: 'paid' }, token })
    expect(patch.status, patch.text).toBe(200)
    await settle()
    order = await orderByNumber(payload, number)
    expect(order).toMatchObject({ status: 'paid', stockState: 'committed', paidVia: 'admin' })
    expect(eventsFor(number, 'order.confirmed')).toHaveLength(1)
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: `confirm:${number}` } }, overrideAccess: true })
    expect(log.docs).toHaveLength(1)
  })
})

describe('rate limits on the remaining endpoints', () => {
  it.each([
    ['retry', 20, () => restPost('store/checkout/retry', { body: {}, headers: { 'x-real-ip': '198.51.100.21' } })],
    ['verify', 30, () => restPost('store/checkout/verify', { body: {}, headers: { 'x-real-ip': '198.51.100.22' } })],
    ['mine', 30, () => restGet('store/orders/mine', { headers: { 'x-real-ip': '198.51.100.23' } })],
  ] as const)('%s: %i per minute, then 429 RATE_LIMITED', async (_name, max, call) => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    for (let i = 0; i < max; i++) expect((await call()).status).not.toBe(429)
    const res = await call()
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
  })

  it('callback: over the limit it still answers 303 to /order (never an error page) and changes nothing', async () => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    const { number, token } = await codOrder()
    const call = () =>
      restPost('payments/razorpay/callback', {
        rawBody: new URLSearchParams({ razorpay_payment_id: 'pay_Nope000000000001' }),
        contentType: 'application/x-www-form-urlencoded',
        query: { no: number, t: token },
        headers: { 'x-real-ip': '198.51.100.24' },
      })
    for (let i = 0; i < 31; i++) {
      const res = await call()
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`http://localhost:5173/order?no=${number}&t=${token}`)
    }
  })
})

