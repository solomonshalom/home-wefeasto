import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import { sessionDb } from '@/commerce/checkout/db'
import { expireOrder } from '@/commerce/checkout/expire'
import { onOrderEvent, type OrderEvent } from '@/commerce/events'
import { resetRateLimits } from '@/lib/rateLimit'

import {
  ADDRESS,
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
  uniquePhone,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createCustomer, login } from './helpers/factories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * POST /api/store/checkout (SPEC §6, shared-commerce-api.md "Server checkout recipe"): validation, server
 * pricing, coupons, COD rules, idempotency, concurrency (double submit, last unit, last coupon use),
 * gateway failure, supersede. Payment confirmation lives in checkout-payments.int.spec.ts.
 */

let payload: Payload
const events: OrderEvent[] = []
const unsubscribe: (() => void)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  for (const type of ['order.confirmed', 'order.cancelled'] as const) {
    unsubscribe.push(onOrderEvent(type, `test:place:${type}`, (e) => void events.push(e)))
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

/** Moves an order's createdAt `minutes` into the past (supersede window). */
async function backdateOrder(id: number, minutes: number): Promise<void> {
  const db = await sessionDb({ payload })
  await db.execute(sql`UPDATE orders SET created_at = created_at - make_interval(mins => ${minutes}) WHERE id = ${id}`)
}

const setSettings = (data: Record<string, unknown>) =>
  payload.updateGlobal({ slug: 'store-settings', data: data as never, context: { skipDeployHook: true } })

const coupon = (data: Record<string, unknown>) =>
  payload.create({
    collection: 'coupons',
    data: { code: `T${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, type: 'percent', value: 10, usedCount: 0, active: true, ...data } as never,
  })

describe('happy paths', () => {
  it('online: 201 {order, payment}, stock reserved, one Razorpay order <no>-a1 with notes {wf_order}', async () => {
    const p = await makeProduct(payload, { pricePaise: 25000, stock: 5 })
    const { res, body } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }])
    expect(res.status, res.text).toBe(201)
    const { order, payment } = res.body
    expect(order).toMatchObject({ status: 'pending_payment', totalPaise: 50000 })
    expect(order.number).toMatch(/^WF-\d{5,}$/)
    expect(order.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(payment).toMatchObject({
      provider: 'mock',
      keyId: expect.stringMatching(/^rzp_test_/),
      razorpayOrderId: expect.stringMatching(/^order_/),
      amount: 50000,
      currency: 'INR',
      checkoutScript: '/api/payments/mock/checkout.js',
      name: 'Wefeasto',
      description: `Order ${order.number}`,
      prefill: { name: body.contact.name, email: body.contact.email, contact: body.contact.phone, method: 'upi' },
      notes: { wf_order: order.number },
      timeoutSeconds: 900,
    })
    expect(payment.callbackUrl).toBe(
      `http://localhost:3000/api/payments/razorpay/callback?no=${order.number}&t=${encodeURIComponent(order.token)}`,
    )
    expect(payment.image).toBe('http://localhost:5173/images/webclip.png')
    expect(await stockOf(payload, p.slug as string)).toBe(3)

    const stored = await orderByNumber(payload, order.number)
    expect(stored).toMatchObject({
      status: 'pending_payment',
      paymentStatus: 'created',
      paymentMethod: 'online',
      requestedMethod: 'upi',
      stockState: 'reserved',
      subtotalPaise: 50000,
      deliveryPaise: 0,
      discountPaise: 0,
      totalPaise: 50000,
      currency: 'INR',
      source: 'web',
      contact: body.contact,
      shippingAddress: ADDRESS,
    })
    expect(Date.parse(stored.reservedUntil as string) - Date.now()).toBeGreaterThan(29 * 60_000)
    expect(stored.items).toEqual([
      expect.objectContaining({ product: p.id, slug: p.slug, name: p.name, unitPaise: 25000, qty: 2, lineTotalPaise: 50000 }),
    ])
    const [attempt] = stored.razorpay?.attempts ?? []
    expect(attempt).toMatchObject({ receipt: `${order.number}-a1`, amount: 50000, orderId: payment.razorpayOrderId })
    const rzp = mock().inspect().orders.find((o) => o.id === payment.razorpayOrderId)
    expect(rzp).toMatchObject({ amount: 50000, receipt: `${order.number}-a1`, notes: { wf_order: order.number } })
    expect(stored.statusHistory?.[0]).toMatchObject({ field: 'status', to: 'pending_payment', source: 'checkout' })
    // No confirmation for an unpaid online order.
    expect(events.filter((e) => e.order.number === order.number)).toEqual([])
  })

  it('COD: 201, cod_pending, payment null, stock committed, order.confirmed once', async () => {
    const p = await makeProduct(payload, { pricePaise: 30000, stock: 4 })
    const { res, body, key } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { method: 'cod' })
    expect(res.status, res.text).toBe(201)
    expect(res.body).toMatchObject({ order: { status: 'cod_pending', totalPaise: 30000 + 4900 }, payment: null })
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored).toMatchObject({ paymentMethod: 'cod', requestedMethod: 'cod', stockState: 'committed', paymentStatus: 'none', reservedUntil: null })
    expect(stored.razorpay?.attempts ?? []).toEqual([])
    expect(await stockOf(payload, p.slug as string)).toBe(3)
    expect(mock().inspect().orders).toEqual([])
    const mine = () => events.filter((e) => e.order.number === stored.number)
    expect(mine()).toHaveLength(1)
    expect(mine()[0]).toMatchObject({ type: 'order.confirmed', previousStatus: null, source: 'checkout' })
    // A replay neither re-emits nor re-reserves.
    const again = await postCheckout(body, key)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(res.body)
    expect(mine()).toHaveLength(1)
    expect(await stockOf(payload, p.slug as string)).toBe(3)
  })

  it('card: prefill.method is card; consent text is stored only with marketing consent', async () => {
    const p = await makeProduct(payload)
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }], { method: 'card', consent: { marketing: true } })
    expect(res.status).toBe(201)
    expect(res.body.payment.prefill.method).toBe('card')
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored.consent).toMatchObject({ marketing: true, text: 'Send me refill reminders & recipes. Unsubscribe anytime.' })
    expect(stored.consent?.at).toBeTruthy()
    const { res: res2 } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }])
    expect((await orderByNumber(payload, res2.body.order.number)).consent).toMatchObject({ marketing: false, text: null })
  })

  it('links the order to a signed-in customer (cookie), never for guests', async () => {
    const p = await makeProduct(payload)
    const customer = await createCustomer(payload)
    const { cookie } = await login('customers', customer.email)
    const items = [{ slug: p.slug as string, qty: 2 }]
    const res = await postCheckout(checkoutBody(items, await quoteTotal(items)), randomUUID(), { cookie })
    expect(res.status, res.text).toBe(201)
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored.customer).toBe(customer.id)
    const guest = await postCheckout(checkoutBody(items, await quoteTotal(items)))
    expect((await orderByNumber(payload, guest.body.order.number)).customer ?? null).toBeNull()
  })

  it('normalises contact details and keeps Unicode names and addresses', async () => {
    const p = await makeProduct(payload)
    const phone = uniquePhone()
    const national = phone.slice(3)
    const items = [{ slug: p.slug as string, qty: 2 }]
    const body = checkoutBody(items, await quoteTotal(items), {
      contact: { name: '  आशा  👩‍🍳 Kumar ', email: ` ${uniqueEmail('Unicode').toUpperCase()} `, phone: `0${national.slice(0, 5)} ${national.slice(5)}` },
      address: { line1: 'फ्लैट 4B, 12 MG Road 🏠', city: 'bengaluru', state: 'karnataka', pin: '560 001' },
      source: 'EMAIL',
    })
    const res = await postCheckout(body)
    expect(res.status, res.text).toBe(201)
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored.contact).toMatchObject({ name: 'आशा 👩‍🍳 Kumar', phone, email: body.contact.email.trim().toLowerCase() })
    expect(stored.shippingAddress).toMatchObject({ line1: 'फ्लैट 4B, 12 MG Road 🏠', state: 'Karnataka', pin: '560001' })
    expect(stored.source).toBe('email')
    // Razorpay only ever sees ids in notes.
    expect(res.body.payment.notes).toEqual({ wf_order: stored.number })
  })
})

describe('request validation (400)', () => {
  const key = () => randomUUID()

  it('requires a uuid v4 Idempotency-Key', async () => {
    const p = await makeProduct(payload)
    const body = checkoutBody([{ slug: p.slug as string, qty: 1 }], 1)
    for (const k of [undefined, '', 'abc', '123e4567-e89b-12d3-a456-426614174000' /* v1 */]) {
      const res = await restPost('store/checkout', { body, headers: k === undefined ? {} : { 'Idempotency-Key': k } })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    }
  })

  it.each([
    ['not an array', { a: 1 }, 'VALIDATION'],
    ['empty', [], 'EMPTY_CART'],
    ['row not an object', ['muesli'], 'VALIDATION'],
    ['qty 0', [{ slug: 'muesli', qty: 0 }], 'BAD_QTY'],
    ['qty -3', [{ slug: 'muesli', qty: -3 }], 'BAD_QTY'],
    ['qty 2.5', [{ slug: 'muesli', qty: 2.5 }], 'BAD_QTY'],
    ['qty "1e3"', [{ slug: 'muesli', qty: '1e3' }], 'BAD_QTY'],
    ['qty "0x10"', [{ slug: 'muesli', qty: '0x10' }], 'BAD_QTY'],
    ['qty " 3"', [{ slug: 'muesli', qty: ' 3' }], 'BAD_QTY'],
    ['qty true', [{ slug: 'muesli', qty: true }], 'BAD_QTY'],
    ['qty []', [{ slug: 'muesli', qty: [] }], 'BAD_QTY'],
    ['qty 99999', [{ slug: 'muesli', qty: 99999 }], 'BAD_QTY'],
    ['qty 2**53', [{ slug: 'muesli', qty: 2 ** 53 }], 'BAD_QTY'],
    ['qty Infinity (JSON null)', [{ slug: 'muesli', qty: Infinity }], 'BAD_QTY'],
    ['slug __proto__', [{ slug: '__proto__', qty: 1 }], 'BAD_SLUG'],
    ['slug with capitals', [{ slug: 'Muesli', qty: 1 }], 'BAD_SLUG'],
    ['slug too long', [{ slug: 'a'.repeat(65), qty: 1 }], 'BAD_SLUG'],
    ['21 distinct lines', Array.from({ length: 21 }, (_, i) => ({ slug: `x${i}`, qty: 1 })), 'TOO_MANY_LINES'],
    ['51 raw rows', Array.from({ length: 51 }, () => ({ slug: 'muesli', qty: 1 })), 'TOO_MANY_LINES'],
  ])('items %s → %s', async (_label, items, code) => {
    const res = await postCheckout(checkoutBody(items as never, 1000), key())
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(code)
    expect(res.body.error.message).toBeTruthy()
  })

  it('field errors → VALIDATION details.fields (field → code)', async () => {
    const p = await makeProduct(payload)
    const res = await postCheckout(
      {
        items: [{ slug: p.slug, qty: 1 }],
        contact: { name: 'A', email: 'not-an-email', phone: '12345' },
        address: { line1: '', city: 'Bengaluru', state: 'Narnia', pin: '012345' },
        method: 'paypal',
      },
      key(),
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION')
    expect(res.body.error.details.fields).toEqual({
      name: 'TOO_SHORT',
      email: 'INVALID',
      phone: 'INVALID',
      line1: 'REQUIRED',
      state: 'INVALID',
      pin: 'INVALID',
      method: 'INVALID',
      expectedTotalPaise: 'REQUIRED',
    })
  })

  it('415 / 400 INVALID_JSON / 413 from the body reader', async () => {
    const k = key()
    const notJson = await restPost('store/checkout', { rawBody: 'x=1', contentType: 'application/x-www-form-urlencoded', headers: { 'Idempotency-Key': k } })
    expect(notJson.status).toBe(415)
    const bad = await restPost('store/checkout', { rawBody: '{nope', contentType: 'application/json', headers: { 'Idempotency-Key': k } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('INVALID_JSON')
    const big = await restPost('store/checkout', { rawBody: JSON.stringify({ pad: 'x'.repeat(20_000) }), contentType: 'application/json', headers: { 'Idempotency-Key': k } })
    expect(big.status).toBe(413)
  })

  it('rate limit: 20 per minute per IP → 429 RATE_LIMITED with Retry-After', async () => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    const headers = { 'x-real-ip': '203.0.113.77' }
    const codes: number[] = []
    for (let i = 0; i < 20; i++) codes.push((await restPost('store/checkout', { body: {}, headers })).status)
    expect(codes.every((c) => c === 400)).toBe(true)
    const last = await restPost('store/checkout', { body: {}, headers })
    expect(last.status).toBe(429)
    expect(last.body.error.code).toBe('RATE_LIMITED')
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

describe('server pricing and catalog checks', () => {
  it('ignores client prices, totals and currency; a wrong expectedTotalPaise → 409 PRICE_CHANGED with the server quote', async () => {
    const p = await makeProduct(payload, { pricePaise: 25000 })
    const items = [{ slug: p.slug as string, qty: 2, price: 1, pricePaise: 100, unitPaise: 1 }]
    const tampered = { ...checkoutBody(items, 100), total: 100, totalPaise: 100, currency: 'USD', discountPaise: 99999 }
    const res = await postCheckout(tampered)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('PRICE_CHANGED')
    expect(res.body.error.details.quote).toMatchObject({ subtotalPaise: 50000, totalPaise: 50000, currency: 'INR' })
    // With the real total it goes through at DB prices, in INR.
    const ok = await postCheckout({ ...tampered, expectedTotalPaise: 50000 })
    expect(ok.status, ok.text).toBe(201)
    const stored = await orderByNumber(payload, ok.body.order.number)
    expect(stored).toMatchObject({ totalPaise: 50000, currency: 'INR', discountPaise: 0 })
    expect(Number.isInteger(stored.totalPaise)).toBe(true)
  })

  it('PRICE_CHANGED when the price changes between quote and checkout; the order keeps its snapshot price', async () => {
    const p = await makeProduct(payload, { pricePaise: 25000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const quoted = await quoteTotal(items)
    await payload.update({ collection: 'products', id: p.id, data: { pricePaise: 27000 }, context: { skipDeployHook: true } })
    const res = await postCheckout(checkoutBody(items, quoted))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('PRICE_CHANGED')
    expect(res.body.error.details.quote.totalPaise).toBe(27000 + 4900)
    const ok = await postCheckout(checkoutBody(items, 27000 + 4900))
    expect(ok.status).toBe(201)
    // Admin edits after the order was placed don't touch it (razorpay.md §13.11).
    await payload.update({ collection: 'products', id: p.id, data: { pricePaise: 30000 }, context: { skipDeployHook: true } })
    expect((await orderByNumber(payload, ok.body.order.number)).totalPaise).toBe(31900)
  })

  it('unknown / unpublished / "constructor" → 409 UNAVAILABLE with issues', async () => {
    const listed = await makeProduct(payload)
    const unpublished = await payload.create({
      collection: 'products',
      data: { name: 'Secret Granola', slug: `secret-${Date.now().toString(36)}`, _status: 'draft' } as never,
      draft: true,
      context: { skipDeployHook: true },
    })
    for (const slug of ['no-such-product', 'constructor', unpublished.slug as string]) {
      const res = await postCheckout(checkoutBody([{ slug: listed.slug as string, qty: 1 }, { slug, qty: 1 }], 1))
      expect(res.status, slug).toBe(409)
      expect(res.body.error.code).toBe('UNAVAILABLE')
      expect(res.body.error.details.issues).toEqual([expect.objectContaining({ slug, code: 'UNAVAILABLE', suggestedQty: 0 })])
    }
  })

  it('out of stock / not enough / unticked → 409 OUT_OF_STOCK with available; over maxPerOrder → QTY_LIMIT', async () => {
    const low = await makeProduct(payload, { stock: 2 })
    const res = await postCheckout(checkoutBody([{ slug: low.slug as string, qty: 3 }], 1))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'OUT_OF_STOCK', message: expect.stringContaining('Only 2 packs') })
    expect(res.body.error.details.issues[0]).toMatchObject({ slug: low.slug, available: 2, suggestedQty: 2 })

    const off = await makeProduct(payload, { stock: 50, inStock: false })
    const res2 = await postCheckout(checkoutBody([{ slug: off.slug as string, qty: 1 }], 1))
    expect(res2.body.error).toMatchObject({ code: 'OUT_OF_STOCK' })
    expect(res2.body.error.details.issues[0]).toMatchObject({ available: 0, suggestedQty: 0 })

    const capped = await makeProduct(payload, { maxPerOrder: 3 })
    // Duplicate lines are merged before the cap.
    const res3 = await postCheckout(checkoutBody([{ slug: capped.slug as string, qty: 2 }, { slug: capped.slug as string, qty: 2 }], 1))
    expect(res3.status).toBe(409)
    expect(res3.body.error.code).toBe('QTY_LIMIT')
    expect(res3.body.error.details.issues[0]).toMatchObject({ requestedQty: 4, max: 3, suggestedQty: 3 })
  })

  it('merges duplicate lines into one order line', async () => {
    const p = await makeProduct(payload, { pricePaise: 20000 })
    const items = [
      { slug: p.slug as string, qty: 1 },
      { slug: p.slug as string, qty: 2 },
    ]
    const { res } = await placeOrderVia(items)
    expect(res.status).toBe(201)
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored.items).toHaveLength(1)
    expect(stored.items[0]).toMatchObject({ qty: 3, lineTotalPaise: 60000 })
  })

  it('free delivery is judged on the pre-discount subtotal at the ₹499 boundary', async () => {
    const at = await makeProduct(payload, { pricePaise: 49900 })
    const below = await makeProduct(payload, { pricePaise: 49800 })
    expect(await quoteTotal([{ slug: at.slug as string, qty: 1 }])).toBe(49900)
    expect(await quoteTotal([{ slug: below.slug as string, qty: 1 }])).toBe(49800 + 4900)
    const c = await coupon({ type: 'percent', value: 10 })
    // 10% off ₹499 = ₹49 → total ₹450, delivery stays free.
    const { res } = await placeOrderVia([{ slug: at.slug as string, qty: 1 }], { couponCode: c.code })
    expect(res.status, res.text).toBe(201)
    expect(await orderByNumber(payload, res.body.order.number)).toMatchObject({ subtotalPaise: 49900, discountPaise: 4900, deliveryPaise: 0, totalPaise: 45000 })
  })

  it('ABOVE_MAX over maxOrderPaise (400); blocked PIN → 422 PIN_UNSERVICEABLE {pin}', async () => {
    const p = await makeProduct(payload, { pricePaise: 100000, maxPerOrder: 10 })
    await setSettings({ maxOrderPaise: 300000, blockedPinPrefixes: ['7911'] })
    try {
      const res = await postCheckout(checkoutBody([{ slug: p.slug as string, qty: 4 }], 400000))
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'ABOVE_MAX', details: { code: 'ABOVE_MAX', limitPaise: 300000 } })
      const pin = await postCheckout(checkoutBody([{ slug: p.slug as string, qty: 1 }], 100000, { address: { ...ADDRESS, pin: '791122' } }))
      expect(pin.status).toBe(422)
      expect(pin.body.error).toMatchObject({ code: 'PIN_UNSERVICEABLE', details: { pin: '791122' }, message: expect.stringContaining('791122') })
    } finally {
      await restoreStoreSettings(payload)
    }
  })
})

describe('COD rules', () => {
  it('COD cap (codMaxPaise) → 422 COD_UNAVAILABLE ABOVE_MAX; codAllowed:false → ITEM_NOT_ALLOWED; COD-blocked PIN → PIN_BLOCKED', async () => {
    const big = await makeProduct(payload, { pricePaise: 150000 })
    const noCod = await makeProduct(payload, { codAllowed: false })
    await setSettings({ codBlockedPinPrefixes: ['7922'] })
    try {
      const a = await postCheckout(checkoutBody([{ slug: big.slug as string, qty: 2 }], 300000, { method: 'cod' }))
      expect(a.status).toBe(422)
      expect(a.body.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'ABOVE_MAX' }, message: expect.stringContaining('₹2,000') })
      const b = await postCheckout(checkoutBody([{ slug: noCod.slug as string, qty: 2 }], 50000, { method: 'cod' }))
      expect(b.body.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'ITEM_NOT_ALLOWED' } })
      const c = await postCheckout(checkoutBody([{ slug: big.slug as string, qty: 1 }], 150000, { method: 'cod', address: { ...ADDRESS, pin: '792201' } }))
      expect(c.body.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'PIN_BLOCKED' } })
      // The same bag online is fine.
      const d = await postCheckout(checkoutBody([{ slug: big.slug as string, qty: 1 }], 150000, { address: { ...ADDRESS, pin: '792201' } }))
      expect(d.status).toBe(201)
    } finally {
      await restoreStoreSettings(payload)
    }
  })

  it('at most codMaxOpenPerPhone open COD orders per phone → TOO_MANY_OPEN', async () => {
    const p = await makeProduct(payload, { pricePaise: 20000 })
    const contact = contactFor('cod-cap')
    const place = async (qty: number) => {
      const items = [{ slug: p.slug as string, qty }]
      return postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact }))
    }
    expect((await place(1)).status).toBe(201)
    expect((await place(2)).status).toBe(201)
    const third = await place(3)
    expect(third.status).toBe(422)
    expect(third.body.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'TOO_MANY_OPEN' } })
    // Delivered orders are no longer open.
    const open = await payload.find({ collection: 'orders', where: { 'contact.phone': { equals: contact.phone } }, overrideAccess: true })
    await payload.update({ collection: 'orders', id: open.docs[0].id, data: { status: 'cod_confirmed' } })
    await payload.update({ collection: 'orders', id: open.docs[0].id, data: { fulfilmentStatus: 'shipped' } })
    await payload.update({ collection: 'orders', id: open.docs[0].id, data: { fulfilmentStatus: 'delivered' } })
    await settle()
    expect((await place(3)).status).toBe(201)
  })

  it('hunt: a cap of 0 open COD orders means no COD: the quote says DISABLED up front and the checkout agrees (never TOO_MANY_OPEN)', async () => {
    const p = await makeProduct(payload, { pricePaise: 20000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    try {
      await setSettings({ codMaxOpenPerPhone: 0 })
      const q = await restPost('store/quote', { body: { items, method: 'cod', pin: ADDRESS.pin } })
      expect(q.status, q.text).toBe(200)
      expect(q.body.quote).toMatchObject({ codAvailable: false, codUnavailableReason: 'DISABLED' })
      const res = await postCheckout(checkoutBody(items, q.body.quote.totalPaise, { method: 'cod', contact: contactFor('cod-cap-0') }))
      expect(res.status, res.text).toBe(422)
      expect(res.body.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'DISABLED' } })
      expect(res.text).not.toMatch(/already have/i)
      expect(await stockOf(payload, p.slug as string)).toBe(50) // refused before anything was taken
      // Paying online is unaffected.
      const online = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact: contactFor('cod-cap-0-online') }))
      expect(online.status, online.text).toBe(201)
      // A cap of 1 offers COD again.
      await setSettings({ codMaxOpenPerPhone: 1 })
      const q1 = await restPost('store/quote', { body: { items, method: 'cod' } })
      expect(q1.body.quote).toMatchObject({ codAvailable: true, codUnavailableReason: null })
    } finally {
      await restoreStoreSettings(payload)
    }
  })
})

describe('coupons at checkout', () => {
  const bag = async (pricePaise = 30000) => {
    const p = await makeProduct(payload, { pricePaise })
    return [{ slug: p.slug as string, qty: 2 }]
  }

  it('valid code: discount applied, redemption reserved, usedCount untouched until paid', async () => {
    const c = await coupon({ type: 'percent', value: 10, maxDiscountPaise: 5000 })
    const items = await bag()
    const { res } = await placeOrderVia(items, { couponCode: c.code.toLowerCase() })
    expect(res.status, res.text).toBe(201)
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored).toMatchObject({ subtotalPaise: 60000, discountPaise: 5000, totalPaise: 55000, coupon: { code: c.code, discountPaise: 5000 } })
    const red = await payload.find({ collection: 'coupon-redemptions', where: { order: { equals: stored.id } }, overrideAccess: true })
    expect(red.docs[0]).toMatchObject({ code: c.code, status: 'reserved', discountPaise: 5000, email: stored.contact.email })
    expect((await payload.findByID({ collection: 'coupons', id: c.id })).usedCount).toBe(0)
  })

  it.each([
    ['EXPIRED', { endsAt: new Date(Date.now() - 1000).toISOString() }],
    ['NOT_STARTED', { startsAt: new Date(Date.now() + 86_400_000).toISOString() }],
    ['INACTIVE', { active: false }],
    ['USAGE_LIMIT', { usageLimit: 1, usedCount: 1 }],
    ['EMAIL_MISMATCH', { boundEmail: 'someone.else@example.com' }],
    ['MIN_SUBTOTAL', { minSubtotalPaise: 100000 }],
  ])('%s → 422 COUPON_INVALID {reason}', async (reason, data) => {
    const c = await coupon(data)
    const items = await bag()
    const res = await postCheckout(checkoutBody(items, 60000 - 6000, { couponCode: c.code }))
    expect(res.status, res.text).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason } })
  })

  it('unknown code → COUPON_INVALID NOT_FOUND (malformed codes too)', async () => {
    const items = await bag()
    for (const code of ['NOPE-NOT-A-CODE', '!!']) {
      const res = await postCheckout(checkoutBody(items, 60000, { couponCode: code }))
      expect(res.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'NOT_FOUND' } })
    }
  })

  it('bound email: the right email may use it (case-insensitive)', async () => {
    const email = uniqueEmail('bound')
    const c = await coupon({ boundEmail: email })
    const items = await bag()
    const res = await postCheckout(checkoutBody(items, 54000, { couponCode: c.code, contact: { ...contactFor(), email: email.toUpperCase() } }))
    expect(res.status, res.text).toBe(201)
  })

  it('first order only: an earlier confirmed order by the same email or phone → FIRST_ORDER_ONLY', async () => {
    const c = await coupon({ firstOrderOnly: true })
    const items = await bag()
    const contact = contactFor('first')
    // First ever order (COD, confirmed at once) without the code.
    const first = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact }))
    expect(first.status).toBe(201)
    const byEmail = await postCheckout(checkoutBody(items, 54000, { couponCode: c.code, contact: { ...contact, phone: uniquePhone() } }))
    expect(byEmail.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'FIRST_ORDER_ONLY' } })
    const byPhone = await postCheckout(checkoutBody(items, 54000, { couponCode: c.code, contact: { ...contact, email: uniqueEmail('other') } }))
    expect(byPhone.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'FIRST_ORDER_ONLY' } })
    const fresh = await postCheckout(checkoutBody(items, 54000, { couponCode: c.code }))
    expect(fresh.status, fresh.text).toBe(201)
  })

  it('reservations count toward usageLimit and perCustomerLimit', async () => {
    const limited = await coupon({ usageLimit: 1 })
    const items = await bag()
    expect((await postCheckout(checkoutBody(items, 54000, { couponCode: limited.code }))).status).toBe(201)
    const second = await postCheckout(checkoutBody(items, 54000, { couponCode: limited.code }))
    expect(second.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'USAGE_LIMIT' } })

    const perCustomer = await coupon({ perCustomerLimit: 1 })
    const contact = contactFor('per-customer')
    expect((await postCheckout(checkoutBody(items, 54000, { couponCode: perCustomer.code, contact }))).status).toBe(201)
    const again = await postCheckout(checkoutBody([{ ...items[0], qty: 1 }], 30000 + 4900 - 3000, { couponCode: perCustomer.code, contact: { ...contact, phone: uniquePhone() } }))
    expect(again.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'PER_CUSTOMER_LIMIT' } })
  })

  it('a discount bigger than the bag is clamped (never below the subtotal; total ≥ ₹1)', async () => {
    const c = await coupon({ type: 'fixed', value: 1_000_000 })
    const items = await bag(20000)
    const total = await quoteTotal(items, { couponCode: c.code })
    expect(total).toBe(4900) // subtotal ₹400 fully discounted; the ₹49 delivery remains
    const res = await postCheckout(checkoutBody(items, total, { couponCode: c.code }))
    expect(res.status, res.text).toBe(201)
    expect(res.body.payment.amount).toBe(4900)
    expect(await orderByNumber(payload, res.body.order.number)).toMatchObject({ discountPaise: 40000, totalPaise: 4900 })
  })

  it('last use of a single-use code under 5 concurrent checkouts: exactly one wins', async () => {
    const c = await coupon({ usageLimit: 1 })
    const items = await bag()
    const results = await Promise.all(Array.from({ length: 5 }, () => postCheckout(checkoutBody(items, 54000, { couponCode: c.code }))))
    const codes = results.map((r) => r.status).sort()
    expect(codes).toEqual([201, 422, 422, 422, 422])
    for (const r of results.filter((x) => x.status === 422)) expect(r.body.error.details.reason).toBe('USAGE_LIMIT')
    const { totalDocs } = await payload.count({ collection: 'coupon-redemptions', where: { coupon: { equals: c.id } }, overrideAccess: true })
    expect(totalDocs).toBe(1)
  })
})

describe('idempotency and concurrency', () => {
  it('same key + same payload → 200 with the same order, token and payment (no second order)', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const { res, body, key } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }])
    expect(res.status).toBe(201)
    // Key order, duplicate lines and phone formatting don't make it a different request.
    const reordered = { ...body, items: [{ qty: 1, slug: p.slug }, { slug: p.slug, qty: 1 }], contact: { phone: `+91 ${body.contact.phone.slice(3)}`, email: body.contact.email, name: body.contact.name } }
    const again = await postCheckout(reordered, key)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(res.body)
    expect(await stockOf(payload, p.slug as string)).toBe(8)
    const { totalDocs } = await payload.count({ collection: 'orders', where: { idempotencyKey: { equals: key } }, overrideAccess: true })
    expect(totalDocs).toBe(1)
  })

  it('same key + different payload → 409 IDEMPOTENCY_MISMATCH', async () => {
    const p = await makeProduct(payload)
    const { res, body, key } = await placeOrderVia([{ slug: p.slug as string, qty: 2 }])
    expect(res.status).toBe(201)
    for (const change of [{ method: 'card' }, { items: [{ slug: p.slug, qty: 3 }] }, { consent: { marketing: true } }, { couponCode: 'X12' }]) {
      const r = await postCheckout({ ...body, ...change }, key)
      expect(r.status).toBe(409)
      expect(r.body.error.code).toBe('IDEMPOTENCY_MISMATCH')
    }
  })

  it('double submit: the same key 5× in parallel → one order, one reservation, one Razorpay order', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 2 }]
    const body = checkoutBody(items, await quoteTotal(items))
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 5 }, () => postCheckout(body, key)))
    for (const r of results) expect([200, 201], r.text).toContain(r.status)
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    const numbers = new Set(results.map((r) => r.body.order.number))
    const tokens = new Set(results.map((r) => r.body.order.token))
    const rzpIds = new Set(results.map((r) => r.body.payment.razorpayOrderId))
    expect([numbers.size, tokens.size, rzpIds.size]).toEqual([1, 1, 1])
    expect(await stockOf(payload, p.slug as string)).toBe(8)
    const order = await orderByNumber(payload, [...numbers][0])
    expect(order.razorpay?.attempts).toHaveLength(1)
    expect(mock().inspect().orders.filter((o) => o.receipt === `${order.number}-a1`)).toHaveLength(1)
  })

  it('two tabs, two different bags → two keys, two orders', async () => {
    const p = await makeProduct(payload)
    const contact = contactFor('tabs')
    const a = await placeOrderVia([{ slug: p.slug as string, qty: 1 }], { contact })
    const b = await placeOrderVia([{ slug: p.slug as string, qty: 3 }], { contact })
    expect([a.res.status, b.res.status]).toEqual([201, 201])
    expect(a.res.body.order.number).not.toBe(b.res.body.order.number)
  })

  it('the last unit: 10 parallel checkouts for 1 unit → exactly one reservation, nine 409 OUT_OF_STOCK', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 25000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const total = await quoteTotal(items)
    const results = await Promise.all(Array.from({ length: 10 }, () => postCheckout(checkoutBody(items, total))))
    const ok = results.filter((r) => r.status === 201)
    const out = results.filter((r) => r.status === 409)
    expect(ok).toHaveLength(1)
    expect(out).toHaveLength(9)
    for (const r of out) {
      expect(r.body.error.code).toBe('OUT_OF_STOCK')
      expect(r.body.error.details.issues[0]).toMatchObject({ slug: p.slug, code: 'OUT_OF_STOCK', available: 0 })
    }
    expect(await stockOf(payload, p.slug as string)).toBe(0)
    const { totalDocs } = await payload.count({ collection: 'orders', where: { 'items.slug': { equals: p.slug } }, overrideAccess: true })
    expect(totalDocs).toBe(1)
  })

  it('a multi-line order that fails on its second line reserves nothing (rollback)', async () => {
    const a = await makeProduct(payload, { stock: 5 })
    const b = await makeProduct(payload, { stock: 1 })
    const items = [
      { slug: a.slug as string, qty: 2 },
      { slug: b.slug as string, qty: 1 },
    ]
    const total = await quoteTotal(items)
    // Someone takes b's last unit between the quote and our reservation.
    await payload.db.updateOne({ collection: 'products', where: { id: { equals: b.id } }, data: { stock: { $inc: -1 } }, options: { atomic: true } })
    const res = await postCheckout(checkoutBody(items, total))
    expect(res.status).toBe(409)
    expect(await stockOf(payload, a.slug as string)).toBe(5)
    expect(await stockOf(payload, b.slug as string)).toBe(0)
  })

  it('an admin edit of the product after a reservation keeps the reserved stock (version row mirrored)', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 3 }])
    expect(res.status).toBe(201)
    await payload.update({ collection: 'products', id: p.id, data: { description: 'New words.' }, context: { skipDeployHook: true } })
    expect(await stockOf(payload, p.slug as string)).toBe(7)
  })
})

describe('gateway failure at checkout', () => {
  it('createOrder fails → 503 PAYMENTS_UNAVAILABLE {order}; the order stays pending (stock held, no Razorpay id); a replay later works', async () => {
    const p = await makeProduct(payload, { stock: 5 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const body = checkoutBody(items, await quoteTotal(items))
    const key = randomUUID()
    mock().failNext('createOrder', 'network')
    const res = await postCheckout(body, key)
    expect(res.status).toBe(503)
    expect(res.body.error).toMatchObject({ code: 'PAYMENTS_UNAVAILABLE', message: expect.stringContaining('Cash on Delivery') })
    const { number, token } = res.body.error.details.order
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const pending = await orderByNumber(payload, number)
    expect(pending).toMatchObject({ status: 'pending_payment', stockState: 'reserved', paymentStatus: 'none' })
    expect(pending.razorpay?.attempts ?? []).toEqual([])
    expect(await stockOf(payload, p.slug as string)).toBe(4)

    const again = await postCheckout(body, key)
    expect(again.status, again.text).toBe(200)
    expect(again.body.order).toMatchObject({ number, token })
    expect(again.body.payment.razorpayOrderId).toMatch(/^order_/)
    expect((await orderByNumber(payload, number)).razorpay?.attempts?.[0].receipt).toBe(`${number}-a1`)
    expect(await stockOf(payload, p.slug as string)).toBe(4)
  })

  it('a lost createOrder response (Razorpay created it) is recovered by receipt on the replay: no second Razorpay order', async () => {
    const p = await makeProduct(payload)
    const items = [{ slug: p.slug as string, qty: 2 }]
    const body = checkoutBody(items, await quoteTotal(items))
    const key = randomUUID()
    mock().failNext('createOrder', 'timeout', { commit: true })
    const res = await postCheckout(body, key)
    expect(res.status).toBe(503)
    const created = mock().inspect().orders
    expect(created).toHaveLength(1)
    const again = await postCheckout(body, key)
    expect(again.status).toBe(200)
    expect(again.body.payment.razorpayOrderId).toBe(created[0].id)
    expect(mock().inspect().orders).toHaveLength(1)
  })

  it.each(['rate_limited', 'server', 'auth', 'bad_request'] as const)('%s from the gateway → 503 PAYMENTS_UNAVAILABLE', async (kind) => {
    const p = await makeProduct(payload)
    mock().failNext('createOrder', kind)
    const items = [{ slug: p.slug as string, qty: 2 }]
    const res = await postCheckout(checkoutBody(items, await quoteTotal(items)))
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE')
  })
})

describe('supersede: a new order for the same bag replaces the customer\'s own unpaid online order (SUP-OWN-1)', () => {
  it('COD after a dismissed online payment: the online order is cancelled, its stock and coupon given back', async () => {
    const p = await makeProduct(payload, { stock: 2, pricePaise: 30000 })
    const c = await coupon({ usageLimit: 1 })
    const contact = contactFor('supersede')
    const items = [{ slug: p.slug as string, qty: 2 }]
    const online = await postCheckout(checkoutBody(items, 54000, { couponCode: c.code, contact }))
    expect(online.status, online.text).toBe(201)
    expect(await stockOf(payload, p.slug as string)).toBe(0)

    // "Pay on delivery instead": same bag, new key, naming the online order (its guest reference). The last
    // 2 units and the single-use code are still held by the online order, yet this goes through.
    const codTotal = 54000
    const ref = { number: online.body.order.number, token: online.body.order.token }
    const cod = await postCheckout(checkoutBody(items, codTotal, { couponCode: c.code, contact, method: 'cod', supersede: ref }))
    expect(cod.status, cod.text).toBe(201)
    expect(await stockOf(payload, p.slug as string)).toBe(0)
    const old = await orderByNumber(payload, online.body.order.number)
    expect(old).toMatchObject({ status: 'cancelled', stockState: 'released' })
    expect(old.statusHistory?.at(-1)).toMatchObject({ from: 'pending_payment', to: 'cancelled', source: 'checkout', note: expect.stringContaining('superseded') })
    const reds = await payload.find({ collection: 'coupon-redemptions', where: { coupon: { equals: c.id } }, overrideAccess: true, sort: 'createdAt' })
    expect(reds.docs.map((r) => r.status)).toEqual(['released', 'reserved'])
    expect(events.filter((e) => e.type === 'order.cancelled').map((e) => e.order.number)).toEqual([old.number])

    // The customer had paid the first one after all: that money is refunded automatically.
    const pay = await mock().simulatePayment(online.body.payment.razorpayOrderId, { outcome: 'success' })
    const d = await deliver(pay.events)
    expect(d.map((x) => x.body.outcome)).toEqual(['refund_cancelled', 'already_paid', 'already_paid'])
    await settle()
    const after = await reload(payload, old.id)
    expect(after.status).toBe('refunded')
    expect(after.refunds?.[0]).toMatchObject({ reason: 'order_cancelled', status: 'processed', receipt: `${old.number}-cxl-${pay.payment.id.slice(-6)}` })
    expect(mock().inspect().refunds).toHaveLength(1)
  })

  it('PI-SF-2: an EXPIRED order is superseded too, so late money on it is refunded instead of making a second order', async () => {
    const p = await makeProduct(payload, { stock: 5, pricePaise: 30000 })
    const contact = contactFor('supersede-expired')
    const items = [{ slug: p.slug as string, qty: 2 }]
    const online = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact }))
    expect(online.status, online.text).toBe(201)
    const onlineOrder = await orderByNumber(payload, online.body.order.number)

    // The reservation runs out with no payment: expired, stock released.
    const expired = await expireOrder(payload, onlineOrder.id, { now: Date.now() + 24 * 60 * 60_000, source: 'test' })
    expect(expired.outcome).toBe('expired')
    expect(await stockOf(payload, p.slug as string)).toBe(5)
    events.length = 0

    // The customer orders the same bag again as COD, naming the expired order: it replaces it.
    const ref = { number: online.body.order.number, token: online.body.order.token }
    const cod = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { contact, method: 'cod', supersede: ref }))
    expect(cod.status, cod.text).toBe(201)
    expect(await stockOf(payload, p.slug as string)).toBe(3)
    const old = await reload(payload, onlineOrder.id)
    expect(old).toMatchObject({ status: 'cancelled', stockState: 'released' })
    expect(old.statusHistory?.at(-1)).toMatchObject({ from: 'expired', to: 'cancelled', source: 'checkout', note: expect.stringContaining('superseded') })
    await settle()
    expect(events.filter((e) => e.type === 'order.cancelled').map((e) => [e.order.number, e.previousStatus])).toEqual([[old.number, 'expired']])

    // The bank authorises the old payment after all: refunded, not honoured; the COD order is untouched.
    const pay = await mock().simulatePayment(online.body.payment.razorpayOrderId, { outcome: 'success' })
    const d = await deliver(pay.events)
    expect(d[0].body.outcome).toBe('refund_cancelled')
    await settle()
    const after = await reload(payload, old.id)
    expect(after.status).not.toBe('paid')
    expect(after.status).toBe('refunded')
    expect(after.stockState).toBe('released')
    expect(after.refunds).toHaveLength(1)
    expect(after.refunds?.[0]).toMatchObject({ reason: 'order_cancelled', status: 'processed', paymentId: pay.payment.id })
    expect(mock().inspect().refunds).toHaveLength(1)
    expect(await stockOf(payload, p.slug as string)).toBe(3)
    expect(await orderByNumber(payload, cod.body.order.number)).toMatchObject({ status: 'cod_pending', stockState: 'committed', paymentStatus: 'none' })
  })

  it('an expired order older than the supersede window is left alone (late money then follows the expired rules)', async () => {
    const p = await makeProduct(payload, { stock: 5 })
    const contact = contactFor('supersede-old')
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact }))
    expect(online.status, online.text).toBe(201)
    const id = (await orderByNumber(payload, online.body.order.number)).id
    await expireOrder(payload, id, { now: Date.now() + 24 * 60 * 60_000, source: 'test' })
    await backdateOrder(id, 31)
    const ref = { number: online.body.order.number, token: online.body.order.token }
    const cod = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { contact, method: 'cod', supersede: ref }))
    expect(cod.status, cod.text).toBe(201)
    expect((await reload(payload, id)).status).toBe('expired')
  })

  it('does not touch orders with a different bag, another phone, or money on them', async () => {
    const p = await makeProduct(payload, { stock: 20 })
    const contact = contactFor('keep')
    const items = [{ slug: p.slug as string, qty: 2 }]
    const a = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact }))
    const otherBag = [{ slug: p.slug as string, qty: 3 }]
    const b = await postCheckout(checkoutBody(otherBag, await quoteTotal(otherBag), { contact, method: 'cod' }))
    const c = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { contact: contactFor('other-phone'), method: 'cod' }))
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201])
    expect((await orderByNumber(payload, a.body.order.number)).status).toBe('pending_payment')
  })

  it('hunt: a guest checkout sharing only the phone (even the email) and the bag never cancels the order, not while it is being paid', async () => {
    const p = await makeProduct(payload, { stock: 5, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const victim = contactFor('sup-victim')
    const online = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact: victim }))
    expect(online.status, online.text).toBe(201)
    const id = (await orderByNumber(payload, online.body.order.number)).id
    expect(await reload(payload, id)).toMatchObject({ status: 'pending_payment', paymentStatus: 'created' }) // payment window open

    // A stranger who knows the phone (and email) and guesses the bag: online and COD, no reference, no session.
    const stranger = { ...victim, name: 'Mallory Stranger' }
    const address = { ...ADDRESS, line1: '99 Elsewhere Lane, Indiranagar' }
    const upi = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact: stranger, address }))
    const cod = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { contact: stranger, address, method: 'cod' }))
    expect([upi.status, cod.status], `${upi.text} ${cod.text}`).toEqual([201, 201])
    expect(await reload(payload, id)).toMatchObject({ status: 'pending_payment', paymentStatus: 'created', stockState: 'reserved' })
    expect(await stockOf(payload, p.slug as string)).toBe(2) // the victim's unit was never handed over
    await settle()
    expect(events.filter((e) => e.type === 'order.cancelled')).toEqual([])

    // The victim finishes paying in the window they had open: an ordinary paid order, nothing refunded.
    const pay = await mock().simulatePayment(online.body.payment.razorpayOrderId, { outcome: 'success' })
    await deliver(pay.events)
    await settle()
    const after = await reload(payload, id)
    expect(after).toMatchObject({ status: 'paid', stockState: 'committed' })
    expect(after.refunds ?? []).toEqual([])
    expect(mock().inspect().refunds).toHaveLength(0)
  })

  it('a signed-in customer\'s own earlier order is replaced without a reference; another customer\'s is not', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const owner = await createCustomer(payload)
    const other = await createCustomer(payload)
    const { cookie: ownerCookie } = await login('customers', owner.email)
    const { cookie: otherCookie } = await login('customers', other.email)
    const contact = contactFor('sup-session')
    const online = await postCheckout(checkoutBody(items, await quoteTotal(items), { contact }), randomUUID(), { cookie: ownerCookie })
    expect(online.status, online.text).toBe(201)
    const id = (await orderByNumber(payload, online.body.order.number)).id

    // Another account using the same phone and bag owns nothing here.
    const codTotal = await quoteTotal(items, { method: 'cod' })
    const theirs = await postCheckout(checkoutBody(items, codTotal, { contact, method: 'cod' }), randomUUID(), { cookie: otherCookie })
    expect(theirs.status, theirs.text).toBe(201)
    expect((await reload(payload, id)).status).toBe('pending_payment')

    // The owner, on another device (no reference) and with a corrected phone: their own order is replaced.
    const mine = await postCheckout(checkoutBody(items, codTotal, { contact: { ...contact, phone: uniquePhone() }, method: 'cod' }), randomUUID(), { cookie: ownerCookie })
    expect(mine.status, mine.text).toBe(201)
    const old = await reload(payload, id)
    expect(old).toMatchObject({ status: 'cancelled', stockState: 'released' })
    expect(old.statusHistory?.at(-1)).toMatchObject({ from: 'pending_payment', to: 'cancelled', source: 'checkout', note: expect.stringContaining('superseded') })
    expect(await stockOf(payload, p.slug as string)).toBe(8)
  })
})

describe('order events', () => {
  it('emits order.confirmed once per COD order, even under a replay storm', async () => {
    const p = await makeProduct(payload)
    const items = [{ slug: p.slug as string, qty: 2 }]
    const body = checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod' })
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 4 }, () => postCheckout(body, key)))
    const number = results[0].body.order.number
    await settle()
    expect(events.filter((e) => e.type === 'order.confirmed' && e.order.number === number)).toHaveLength(1)
    const doc = events.find((e) => e.order.number === number)?.order as Order
    expect(doc.status).toBe('cod_pending')
  })
})
