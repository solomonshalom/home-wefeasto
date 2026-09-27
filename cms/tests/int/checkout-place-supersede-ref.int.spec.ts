import { randomUUID } from 'node:crypto'

import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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
  postCheckout,
  quoteTotal,
  reload,
  restoreEnv,
  settle,
  stockOf,
  uniquePhone,
  type Line,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * SUP-PHONE-1: POST /store/checkout takes the same `supersede: {number, token}` guest reference that
 * POST /store/quote prices with, so the two endpoints apply ONE supersede rule. A customer whose online
 * payment was dismissed, who then fixes the phone and picks "Pay on delivery instead", replaces the online
 * order (stock and coupon given back, late money refunded) instead of looping on OUT_OF_STOCK /
 * COUPON_INVALID or ending up with two orders for one bag.
 */

let payload: Payload
const events: OrderEvent[] = []
let unsubscribe: (() => void) | null = null

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  unsubscribe = onOrderEvent('order.cancelled', 'test:supersede-ref', (e) => void events.push(e))
})

beforeEach(() => {
  freshMock()
  events.length = 0
})

afterEach(async () => {
  await settle()
  restoreEnv(['PAYMENTS_MODE'])
  resetRateLimits()
})

afterAll(async () => {
  unsubscribe?.()
  await restoreStoreSettings(payload)
})

const newCoupon = async (data: Record<string, unknown> = {}) => {
  const code = `REF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const doc = await payload.create({ collection: 'coupons', data: { code, type: 'percent', value: 10, usedCount: 0, active: true, ...data } as never })
  return { code, id: doc.id }
}

type Online = { contact: ReturnType<typeof contactFor>; number: string; token: string; rzpOrderId: string; ref: { number: string; token: string } }

/** An online order whose payment window was dismissed (pending_payment, stock and coupon held). */
async function dismissedOnline(items: Line[], opts: Record<string, unknown> = {}): Promise<Online> {
  const contact = contactFor('sup-ref')
  const total = await quoteTotal(items, opts.couponCode ? { couponCode: opts.couponCode } : {})
  const res = await postCheckout(checkoutBody(items, total, { contact, ...opts }))
  expect(res.status, res.text).toBe(201)
  const { number, token } = res.body.order as { number: string; token: string }
  return { contact, number, token, rzpOrderId: res.body.payment.razorpayOrderId, ref: { number, token } }
}

/** The quote the storefront shows for the switch (with the ref), then the COD checkout with its total. */
async function switchToCod(items: Line[], online: Online, opts: { phone?: string; couponCode?: string; ref?: unknown; key?: string } = {}) {
  const ref = 'ref' in opts ? opts.ref : online.ref
  const q = await restPost('store/quote', { body: { items, method: 'cod', ...(opts.couponCode ? { couponCode: opts.couponCode } : {}), ...(ref !== undefined ? { supersede: ref } : {}) } })
  expect(q.status, q.text).toBe(200)
  const contact = { ...online.contact, phone: opts.phone ?? uniquePhone() }
  const body = checkoutBody(items, q.body.quote.totalPaise, {
    contact,
    method: 'cod',
    ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
    ...(ref !== undefined ? { supersede: ref } : {}),
  })
  const res = await postCheckout(body, opts.key ?? randomUUID())
  return { quote: q.body.quote, res, body, contact }
}

const cancelledNumbers = () => events.filter((e) => e.type === 'order.cancelled').map((e) => e.order.number)

describe('POST /store/checkout supersede: {number, token} — the same rule as the quote (SUP-PHONE-1)', () => {
  it('(a) last pack held by the dismissed order, phone changed: the quote says ready AND the COD checkout agrees', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 17400 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    expect(await stockOf(payload, p.slug as string)).toBe(0)

    const { quote, res, contact } = await switchToCod(items, online)
    expect(quote.issues).toEqual([])
    expect(contact.phone).not.toBe(online.contact.phone)
    expect(res.status, res.text).toBe(201)
    expect(res.body.order.status).toBe('cod_pending')

    const old = await orderByNumber(payload, online.number)
    expect(old).toMatchObject({ status: 'cancelled', stockState: 'released' })
    expect(old.statusHistory?.at(-1)).toMatchObject({ from: 'pending_payment', to: 'cancelled', source: 'checkout', note: expect.stringContaining('superseded') })
    expect(await stockOf(payload, p.slug as string)).toBe(0)
    expect(await orderByNumber(payload, res.body.order.number)).toMatchObject({ status: 'cod_pending', stockState: 'committed', contact: { phone: contact.phone } })
    await settle()
    expect(cancelledNumbers()).toEqual([online.number])
  })

  it('(b) single-use offer held by the dismissed order, phone changed: 201 with the discount, the old reservation released', async () => {
    const p = await makeProduct(payload, { stock: 5, pricePaise: 50000 })
    const c = await newCoupon({ usageLimit: 1 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items, { couponCode: c.code })

    const { quote, res } = await switchToCod(items, online, { couponCode: c.code })
    expect(quote).toMatchObject({ couponError: null, discountPaise: 5000 })
    expect(res.status, res.text).toBe(201)
    const cod = await orderByNumber(payload, res.body.order.number)
    expect(cod).toMatchObject({ status: 'cod_pending', discountPaise: 5000, coupon: { code: c.code } })
    expect((await orderByNumber(payload, online.number)).status).toBe('cancelled')
    const reds = await payload.find({ collection: 'coupon-redemptions', where: { coupon: { equals: c.id } }, overrideAccess: true, sort: 'createdAt', depth: 0 })
    expect(reds.docs.map((r) => r.status)).toEqual(['released', 'reserved'])
    expect(await stockOf(payload, p.slug as string)).toBe(4)
  })

  it('(c) late money on the dismissed order after a phone change is refunded: one live order for the bag', async () => {
    const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    const { res } = await switchToCod(items, online)
    expect(res.status, res.text).toBe(201)
    const old = await orderByNumber(payload, online.number)
    expect(old.status).toBe('cancelled')

    const pay = await mock().simulatePayment(online.rzpOrderId, { outcome: 'success' })
    const d = await deliver(pay.events)
    expect(d[0].body.outcome).toBe('refund_cancelled')
    await settle()
    const after = await reload(payload, old.id)
    expect(after.status).toBe('refunded')
    expect(after.paymentStatus).not.toBe('captured')
    expect(after.refunds?.[0]).toMatchObject({ reason: 'order_cancelled', status: 'processed', paymentId: pay.payment.id })
    expect(mock().inspect().refunds).toHaveLength(1)

    const all = await payload.find({ collection: 'orders', where: { 'contact.email': { equals: online.contact.email } }, depth: 0, overrideAccess: true, limit: 10 })
    const live = all.docs.filter((o) => ['paid', 'cod_pending', 'cod_confirmed', 'pending_payment', 'payment_failed'].includes(o.status))
    expect(live.map((o) => `${o.number}:${o.status}`)).toEqual([`${res.body.order.number}:cod_pending`])
    expect(await stockOf(payload, p.slug as string)).toBe(19)
  })

  it('(d) a wrong token behaves exactly as without a reference: plenty of stock → two orders; the last pack → OUT_OF_STOCK', async () => {
    const plenty = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
    const bag1 = [{ slug: plenty.slug as string, qty: 1 }]
    const a = await dismissedOnline(bag1)
    const wrong = { number: a.number, token: a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A') }
    const r1 = await switchToCod(bag1, a, { ref: wrong })
    expect(r1.res.status, r1.res.text).toBe(201)
    expect((await orderByNumber(payload, a.number)).status).toBe('pending_payment')

    const last = await makeProduct(payload, { stock: 1, pricePaise: 17400 })
    const bag2 = [{ slug: last.slug as string, qty: 1 }]
    const b = await dismissedOnline(bag2)
    const wrongB = { number: b.number, token: a.token } // another order's valid token
    const r2 = await switchToCod(bag2, b, { ref: wrongB })
    expect(r2.quote.issues.map((i: { code: string }) => i.code)).toEqual(['OUT_OF_STOCK'])
    expect(r2.res.status, r2.res.text).toBe(409)
    expect(r2.res.body.error.code).toBe('OUT_OF_STOCK')
    expect((await orderByNumber(payload, b.number)).status).toBe('pending_payment')
    await settle()
    expect(cancelledNumbers()).toEqual([])
  })
})

describe('supersede reference: edges', () => {
  it('the reference with the order\'s own phone cancels it once', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    const { res } = await switchToCod(items, online, { phone: online.contact.phone })
    expect(res.status, res.text).toBe(201)
    const old = await orderByNumber(payload, online.number)
    expect(old.status).toBe('cancelled')
    expect(old.statusHistory?.filter((h) => h.to === 'cancelled')).toHaveLength(1)
    await settle()
    expect(cancelledNumbers()).toEqual([online.number])
  })

  it('SUP-OWN-1: the order\'s own phone with no reference, or a wrong one, cancels nothing (a phone proves nothing)', async () => {
    const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    const wrong = { number: online.number, token: online.token.slice(0, -1) + (online.token.endsWith('A') ? 'B' : 'A') }
    for (const ref of [undefined, wrong]) { // two: the open-COD cap per phone is 2
      const { res } = await switchToCod(items, online, { phone: online.contact.phone, ref })
      expect(res.status, `${JSON.stringify(ref)} → ${res.text}`).toBe(201)
    }
    expect(await orderByNumber(payload, online.number)).toMatchObject({ status: 'pending_payment', stockState: 'reserved' })
    await settle()
    expect(cancelledNumbers()).toEqual([])
  })

  it('malformed references are ignored silently (no 400; the same answer as without one)', async () => {
    const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    for (const ref of ['WF-10001', [online.ref], 42, true, {}, { number: online.number }, { token: online.token }, { number: online.number, token: 'short' }]) {
      const { res } = await switchToCod(items, online, { ref })
      expect(res.status, `${JSON.stringify(ref)} → ${res.text}`).toBe(201)
    }
    expect((await orderByNumber(payload, online.number)).status).toBe('pending_payment')
  })

  it('never cancels the referenced order when it is for another bag, has money on it, or is COD', async () => {
    const p = await makeProduct(payload, { stock: 20, pricePaise: 30000 })
    const bag = [{ slug: p.slug as string, qty: 2 }]
    const otherBag = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(bag)
    const r1 = await switchToCod(otherBag, online)
    expect(r1.res.status, r1.res.text).toBe(201)
    expect((await orderByNumber(payload, online.number)).status).toBe('pending_payment')

    const paid = await dismissedOnline(bag)
    const pay = await mock().simulatePayment(paid.rzpOrderId, { outcome: 'success' })
    await deliver(pay.events)
    await settle()
    expect((await orderByNumber(payload, paid.number)).status).toBe('paid')
    // Paid meanwhile (the UPI app, confirmed by the webhook): nothing new is placed for this bag (HUNT-CONC-6).
    const r2 = await switchToCod(bag, paid)
    expect(r2.res.status, r2.res.text).toBe(409)
    expect(r2.res.body.error).toMatchObject({ code: 'ALREADY_PAID', details: { order: { number: paid.number, status: 'paid' } } })
    expect((await orderByNumber(payload, paid.number)).status).toBe('paid')

    const codFirst = await switchToCod(bag, online, { ref: undefined })
    expect(codFirst.res.status, codFirst.res.text).toBe(201)
    const codRef = { number: codFirst.res.body.order.number, token: codFirst.res.body.order.token }
    const r3 = await switchToCod(bag, online, { ref: codRef })
    expect(r3.res.status, r3.res.text).toBe(201)
    expect((await orderByNumber(payload, codRef.number)).status).toBe('cod_pending')
  })

  it('an online checkout (any method) with the reference replaces it too', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    const total = await quoteTotal(items, { supersede: online.ref })
    const res = await postCheckout(checkoutBody(items, total, { contact: { ...online.contact, phone: uniquePhone() }, supersede: online.ref }))
    expect(res.status, res.text).toBe(201)
    expect(res.body.payment?.razorpayOrderId).toBeTruthy()
    expect((await orderByNumber(payload, online.number)).status).toBe('cancelled')
  })

  it('the reference is not part of the request hash: a retry with the same key replays the same order', async () => {
    const p = await makeProduct(payload, { stock: 1, pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const online = await dismissedOnline(items)
    const key = randomUUID()
    const first = await switchToCod(items, online, { key })
    expect(first.res.status, first.res.text).toBe(201)
    for (const body of [first.body, { ...first.body, supersede: undefined }]) {
      const again = await postCheckout(body, key)
      expect(again.status, again.text).toBe(200)
      expect(again.body.order.number).toBe(first.res.body.order.number)
    }
    await settle()
    expect(cancelledNumbers()).toEqual([online.number])
  })
})
