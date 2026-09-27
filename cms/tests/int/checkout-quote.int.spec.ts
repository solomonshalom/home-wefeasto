import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetRateLimits } from '@/lib/rateLimit'

import { checkoutBody, contactFor, freshMock, makeProduct, orderByNumber, postCheckout, quoteTotal, restoreEnv, settle, stockOf } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * POST /api/store/quote: the $shared quote() over the DB catalog, the store settings and the coupon record.
 * Stock problems are reported in issues[] (never 409); only malformed input is a 400.
 */

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
})

afterEach(() => {
  restoreEnv(['RATE_LIMIT_DISABLED'])
  resetRateLimits()
})

afterAll(async () => {
  await restoreStoreSettings(payload)
})

const quote = (body: unknown) => restPost('store/quote', { body })
const setSettings = (data: Record<string, unknown>) =>
  payload.updateGlobal({ slug: 'store-settings', data: data as never, context: { skipDeployHook: true } })

describe('POST /api/store/quote', () => {
  it('prices from the DB with product names; free delivery from ₹499 on the pre-discount subtotal', async () => {
    const a = await makeProduct(payload, { pricePaise: 25000 })
    const b = await makeProduct(payload, { pricePaise: 17500 })
    const res = await quote({ items: [{ slug: a.slug, qty: 1, price: 1 }, { slug: b.slug, qty: 1 }] })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.body.quote).toMatchObject({
      subtotalPaise: 42500,
      deliveryPaise: 4900,
      totalPaise: 47400,
      amountToFreeDeliveryPaise: 7400,
      isFreeDelivery: false,
      codAvailable: true,
      canCheckout: true,
      issues: [],
      currency: 'INR',
      pinServiceable: null,
    })
    expect(res.body.quote.lines.map((l: { name: string; unitPaise: number }) => [l.name, l.unitPaise])).toEqual([
      [a.name, 25000],
      [b.name, 17500],
    ])
    const free = await quote({ items: [{ slug: a.slug, qty: 2 }] })
    expect(free.body.quote).toMatchObject({ subtotalPaise: 50000, deliveryPaise: 0, isFreeDelivery: true })
  })

  it('reports stock and availability problems in issues[] with 200', async () => {
    const low = await makeProduct(payload, { stock: 1 })
    const capped = await makeProduct(payload, { maxPerOrder: 2 })
    const res = await quote({ items: [{ slug: low.slug, qty: 3 }, { slug: capped.slug, qty: 5 }, { slug: 'gone-product', qty: 1 }] })
    expect(res.status).toBe(200)
    expect(res.body.quote.canCheckout).toBe(false)
    expect(res.body.quote.issues).toEqual([
      expect.objectContaining({ slug: low.slug, code: 'OUT_OF_STOCK', available: 1, suggestedQty: 1 }),
      expect.objectContaining({ slug: capped.slug, code: 'QTY_LIMIT', max: 2, suggestedQty: 2 }),
      expect.objectContaining({ slug: 'gone-product', code: 'UNAVAILABLE', suggestedQty: 0 }),
    ])
  })

  it('never reveals stock beyond maxPerOrder: 999 packs of a well-stocked product is QTY_LIMIT, not "only 95 left"', async () => {
    const deep = await makeProduct(payload, { stock: 95, maxPerOrder: 10 })
    const shallow = await makeProduct(payload, { stock: 4, maxPerOrder: 10 })
    const res = await quote({ items: [{ slug: deep.slug, qty: 999 }, { slug: shallow.slug, qty: 9 }] })
    expect(res.body.quote.issues).toEqual([
      { slug: deep.slug, name: deep.name, code: 'QTY_LIMIT', requestedQty: 999, max: 10, suggestedQty: 10 },
      expect.objectContaining({ slug: shallow.slug, code: 'OUT_OF_STOCK', available: 4, suggestedQty: 4 }),
    ])
    expect(res.text).not.toContain('95')
  })

  it('an empty bag → 200 with orderError EMPTY_CART; malformed items → 400', async () => {
    const empty = await quote({ items: [] })
    expect(empty.status).toBe(200)
    expect(empty.body.quote.orderError).toEqual({ code: 'EMPTY_CART' })
    for (const [items, code] of [
      [{ nope: 1 }, 'VALIDATION'],
      [[{ slug: 'muesli', qty: '1e3' }], 'BAD_QTY'],
      [[{ slug: '__proto__', qty: 1 }], 'BAD_SLUG'],
      [Array.from({ length: 21 }, (_, i) => ({ slug: `s${i}`, qty: 1 })), 'TOO_MANY_LINES'],
    ] as const) {
      const res = await quote({ items })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(code)
    }
    const notJson = await restPost('store/quote', { rawBody: 'items=1', contentType: 'application/x-www-form-urlencoded' })
    expect(notJson.status).toBe(415)
    const badJson = await restPost('store/quote', { rawBody: '{', contentType: 'application/json' })
    expect(badJson.body.error.code).toBe('INVALID_JSON')
  })

  it('coupons: discount shown; identity checks stay deferred except the bound email when an email is given', async () => {
    const p = await makeProduct(payload, { pricePaise: 30000 })
    const email = uniqueEmail('quote')
    const code = `Q${Date.now().toString(36).toUpperCase()}`
    await payload.create({ collection: 'coupons', data: { code, type: 'percent', value: 10, usedCount: 0, active: true, firstOrderOnly: true, perCustomerLimit: 1, boundEmail: email } as never })
    const items = [{ slug: p.slug, qty: 2 }]
    const anon = await quote({ items, couponCode: code.toLowerCase() })
    expect(anon.body.quote).toMatchObject({ discountPaise: 6000, totalPaise: 54000, couponError: null })
    expect(anon.body.quote.coupon).toMatchObject({ code, type: 'percent', discountPaise: 6000 })
    expect(anon.body.quote.coupon.deferredChecks.sort()).toEqual(['EMAIL', 'FIRST_ORDER', 'PER_CUSTOMER'])
    const right = await quote({ items, couponCode: code, email: email.toUpperCase() })
    expect(right.body.quote.coupon.deferredChecks.sort()).toEqual(['FIRST_ORDER', 'PER_CUSTOMER'])
    const wrong = await quote({ items, couponCode: code, email: uniqueEmail('other') })
    expect(wrong.body.quote).toMatchObject({ discountPaise: 0, coupon: null, couponError: { code: 'COUPON_INVALID', reason: 'EMAIL_MISMATCH' } })
    const missing = await quote({ items, couponCode: 'NO-SUCH-CODE' })
    expect(missing.body.quote.couponError).toEqual({ code: 'COUPON_INVALID', reason: 'NOT_FOUND' })
  })

  it('PIN and COD rules from the server-only settings, which never appear in the response', async () => {
    const p = await makeProduct(payload, { pricePaise: 30000 })
    await setSettings({ blockedPinPrefixes: ['7933'], codBlockedPinPrefixes: ['7944'], codFeePaise: 1000 })
    try {
      const items = [{ slug: p.slug, qty: 1 }]
      const blocked = await quote({ items, pin: '793301' })
      expect(blocked.body.quote.pinServiceable).toBe(false)
      const codBlocked = await quote({ items, pin: '794401', method: 'cod' })
      expect(codBlocked.body.quote).toMatchObject({ pinServiceable: true, codAvailable: false, codUnavailableReason: 'PIN_BLOCKED' })
      const cod = await quote({ items, pin: '560001', method: 'cod' })
      expect(cod.body.quote).toMatchObject({ codFeePaise: 1000, totalPaise: 30000 + 4900 + 1000, codAvailable: true })
      const junkPin = await quote({ items, pin: 'abc' })
      expect(junkPin.body.quote.pinServiceable).toBeNull()
      for (const leak of ['7933', '7944', 'blockedPinPrefixes', 'codMaxOpenPerPhone', 'reservationMinutes', '"stock"']) expect(cod.text).not.toContain(leak)
    } finally {
      await restoreStoreSettings(payload)
    }
  })

  it('rate limit: 60 per minute per IP', async () => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    const headers = { 'x-real-ip': '192.0.2.44' }
    let last = 0
    for (let i = 0; i < 61; i++) last = (await restPost('store/quote', { body: { items: [] }, headers })).status
    expect(last).toBe(429)
  })
})

describe('POST /api/store/quote supersede: {number, token} (PI-SF-1)', () => {
  // The quote a "Pay on delivery instead" checkout sees: the dismissed online order's held units and coupon
  // reservation count the way placeOrder counts them, so the switch is one tap, not a PRICE_CHANGED detour.
  const newCoupon = async (data: Record<string, unknown> = {}) => {
    const code = `SUP${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    await payload.create({ collection: 'coupons', data: { code, type: 'percent', value: 10, usedCount: 0, active: true, ...data } as never })
    return code
  }

  async function dismissedOnline(items: { slug: string; qty: number }[], opts: Record<string, unknown> = {}) {
    const contact = contactFor('quote-supersede')
    const total = await quoteTotal(items, opts.couponCode ? { couponCode: opts.couponCode } : {})
    const res = await postCheckout(checkoutBody(items, total, { contact, ...opts }))
    expect(res.status, res.text).toBe(201)
    return { contact, number: res.body.order.number as string, token: res.body.order.token as string }
  }

  beforeAll(() => {
    freshMock()
  })

  afterAll(async () => {
    await settle()
    restoreEnv(['PAYMENTS_MODE'])
  })

  it('the last unit and a single-use offer held by the dismissed order are available to the order that replaces it', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 50000 })
    const code = await newCoupon({ usageLimit: 1 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items, { couponCode: code })

    const plain = await quote({ items, couponCode: code, method: 'cod' })
    expect(plain.status).toBe(200)
    expect(plain.body.quote.issues.map((i: { code: string }) => i.code)).toEqual(['OUT_OF_STOCK'])
    expect(plain.body.quote.couponError).toMatchObject({ reason: 'USAGE_LIMIT' })

    const view = await quote({ items, couponCode: code, method: 'cod', supersede: { number: online.number, token: online.token } })
    expect(view.status).toBe(200)
    expect(view.body.quote).toMatchObject({ issues: [], couponError: null, discountPaise: 5000, codAvailable: true, canCheckout: true })
    for (const leak of ['"stock"', 'reservationMinutes', online.number]) expect(view.text).not.toContain(leak)

    // The COD checkout with that total (naming the same order, as the storefront does) goes through on the
    // first tap and cancels the online order.
    const supersede = { number: online.number, token: online.token }
    const cod = await postCheckout(checkoutBody(items, view.body.quote.totalPaise, { contact: online.contact, couponCode: code, method: 'cod', supersede }))
    expect(cod.status, cod.text).toBe(201)
    expect((await orderByNumber(payload, online.number)).status).toBe('cancelled')
    expect(await stockOf(payload, p.slug as string)).toBe(0)
  })

  it('a wrong token, another bag, a malformed ref or an order that is no longer unpaid-online is ignored silently (same answer as without)', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 50000 })
    const other = await makeProduct(payload, { stock: 5, pricePaise: 20000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    const plain = await quote({ items, method: 'cod' })
    expect(plain.body.quote.issues.map((i: { code: string }) => i.code)).toEqual(['OUT_OF_STOCK'])

    const wrongToken = online.token.slice(0, -1) + (online.token.endsWith('A') ? 'B' : 'A')
    for (const supersede of [
      { number: online.number, token: wrongToken },
      { number: 'WF-99999999', token: online.token },
      { number: online.number },
      'WF-1',
      [online.number, online.token],
      null,
    ]) {
      const res = await quote({ items, method: 'cod', supersede })
      expect(res.status, JSON.stringify(supersede)).toBe(200)
      expect(res.body, JSON.stringify(supersede)).toEqual(plain.body)
    }

    // Another bag: the order's units don't count for it.
    const bigger = [...items, { slug: other.slug as string, qty: 1 }]
    const otherBag = await quote({ items: bigger, method: 'cod', supersede: { number: online.number, token: online.token } })
    expect(otherBag.body).toEqual((await quote({ items: bigger, method: 'cod' })).body)
    expect(otherBag.body.quote.issues.map((i: { code: string }) => i.code)).toEqual(['OUT_OF_STOCK'])

    // A COD order is never superseded, so its ref changes nothing.
    const codItems = [{ slug: other.slug as string, qty: 1 }]
    const codOrder = await postCheckout(checkoutBody(codItems, await quoteTotal(codItems, { method: 'cod' }), { method: 'cod' }))
    expect(codOrder.status, codOrder.text).toBe(201)
    const withCod = await quote({ items: codItems, method: 'cod', supersede: { number: codOrder.body.order.number, token: codOrder.body.order.token } })
    expect(withCod.body).toEqual((await quote({ items: codItems, method: 'cod' })).body)
  })
})
