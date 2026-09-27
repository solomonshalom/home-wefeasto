import type { Payload } from 'payload'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getGateway, resetGateway, setGatewayForTests, type PaymentGateway } from '@/payments'

import { checkoutBody, contactFor, freshMock, makeProduct, mock, orderByNumber, placeOrderVia, postCheckout, quoteTotal, reload, settle, uniquePhone } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'

/**
 * Hunt round 3 (cms-checkout) regressions:
 *  - checkout is no "has this email/phone ordered before?" oracle: identity-dependent refusals
 *    (FIRST_ORDER_ONLY, PER_CUSTOMER_LIMIT, TOO_MANY_OPEN) come only after the price matched the
 *    identity-free quote; a doomed request gets the same PRICE_CHANGED {quote} whatever its history;
 *  - createAttempt re-checks under the order lock that the order still wants money (HUNT-CONC-R3-1):
 *    a checkout / replay whose order was cancelled while the Razorpay order was created gets no sheet.
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
  await restoreStoreSettings(payload)
})
afterAll(async () => {
  await restoreStoreSettings(payload)
})

const setSettings = (data: Record<string, unknown>) => payload.updateGlobal({ slug: 'store-settings', data: data as never, context: { skipDeployHook: true } })
const coupon = (data: Record<string, unknown>) =>
  payload.create({
    collection: 'coupons',
    data: { code: `HR3G${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, type: 'fixed', value: 5000, usedCount: 0, active: true, ...data } as never,
    overrideAccess: true,
  })
const orderCount = async () => (await payload.count({ collection: 'orders', overrideAccess: true })).totalDocs
const shape = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code ?? null,
  reason: r.body?.error?.details?.reason ?? null,
  couponError: r.body?.error?.details?.quote?.couponError ?? null,
  discountPaise: r.body?.error?.details?.quote?.discountPaise ?? null,
  totalPaise: r.body?.error?.details?.quote?.totalPaise ?? null,
})

describe('checkout is not an order-history oracle', () => {
  it('first-order-only: a wrong total answers PRICE_CHANGED (identity-free quote) for a returning phone or email and a stranger alike', async () => {
    const offer = await coupon({ firstOrderOnly: true })
    const p = await makeProduct(payload, { pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const target = contactFor('oracle-target')
    const cod = await placeOrderVia(items, { method: 'cod', contact: target })
    expect(cod.res.status, cod.res.text).toBe(201)

    const before = await orderCount()
    const probe = (contact: Record<string, string>, total = 1) => postCheckout(checkoutBody(items, total, { couponCode: offer.code, contact }))
    const byPhone = await probe({ ...contactFor('oracle-probe'), phone: target.phone })
    const byEmail = await probe({ ...contactFor('oracle-probe'), email: target.email })
    const stranger = await probe(contactFor('oracle-stranger'))
    expect(await orderCount()).toBe(before)
    expect(shape(stranger)).toMatchObject({ status: 409, code: 'PRICE_CHANGED', couponError: null, discountPaise: 5000 })
    expect(shape(byPhone)).toEqual(shape(stranger))
    expect(shape(byEmail)).toEqual(shape(stranger))

    // The correct total (what /store/quote shows) still learns it: the order would otherwise be placed.
    const total = await quoteTotal(items, { couponCode: offer.code })
    const real = await probe({ ...contactFor('oracle-probe'), phone: target.phone }, total)
    expect(shape(real)).toMatchObject({ status: 422, code: 'COUPON_INVALID', reason: 'FIRST_ORDER_ONLY' })
    expect(await orderCount()).toBe(before)
  })

  it('per-customer limit: a used-up email with a wrong total gets the same PRICE_CHANGED as anyone', async () => {
    const offer = await coupon({ perCustomerLimit: 1 })
    const p = await makeProduct(payload, { pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const target = contactFor('oracle-pc')
    const used = await placeOrderVia(items, { couponCode: offer.code, contact: target })
    expect(used.res.status, used.res.text).toBe(201)

    const probe = (contact: Record<string, string>, total = 1) => postCheckout(checkoutBody(items, total, { couponCode: offer.code, contact }))
    const returning = await probe({ ...target, phone: uniquePhone() })
    const stranger = await probe(contactFor('oracle-pc-stranger'))
    expect(shape(stranger)).toMatchObject({ status: 409, code: 'PRICE_CHANGED', couponError: null })
    expect(shape(returning)).toEqual(shape(stranger))
    const real = await probe({ ...target, phone: uniquePhone() }, await quoteTotal(items, { couponCode: offer.code }))
    expect(shape(real)).toMatchObject({ status: 422, code: 'COUPON_INVALID', reason: 'PER_CUSTOMER_LIMIT' })
  })

  it('open-COD cap: a phone at the cap with a wrong total gets PRICE_CHANGED; with the right one, TOO_MANY_OPEN', async () => {
    await setSettings({ codMaxOpenPerPhone: 1 })
    const p = await makeProduct(payload, { pricePaise: 30000 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const target = contactFor('oracle-cod')
    expect((await placeOrderVia(items, { method: 'cod', contact: target })).res.status).toBe(201)

    const probe = (contact: Record<string, string>, total = 1) => postCheckout(checkoutBody(items, total, { method: 'cod', contact }))
    const returning = await probe({ ...contactFor('oracle-cod-probe'), phone: target.phone })
    const stranger = await probe(contactFor('oracle-cod-stranger'))
    expect(shape(stranger)).toMatchObject({ status: 409, code: 'PRICE_CHANGED' })
    expect(shape(returning)).toEqual(shape(stranger))
    const real = await probe({ ...contactFor('oracle-cod-probe'), phone: target.phone }, await quoteTotal(items, { method: 'cod' }))
    expect(shape(real)).toMatchObject({ status: 422, code: 'COD_UNAVAILABLE', reason: 'TOO_MANY_OPEN' })
  })
})

type CreateOrderInput = Parameters<PaymentGateway['createOrder']>[0]

/** The live mock, except that createOrder(input) first awaits `before(input)` (once per receipt prefix). */
function gateCreateOrder(prefix: () => string | null, before: () => Promise<void>): void {
  const inner = getGateway()
  let done = false
  setGatewayForTests(
    new Proxy(inner, {
      get(target, prop) {
        if (prop === 'createOrder') {
          return async (input: CreateOrderInput) => {
            const want = prefix()
            if (!done && want && input.receipt.startsWith(want)) {
              done = true
              await before()
            }
            return target.createOrder(input)
          }
        }
        const v = Reflect.get(target, prop, target) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }),
  )
}

describe('no payment sheet for an order that stopped wanting money during createOrder', () => {
  it('checkout: the new order is cancelled while its first Razorpay order is created → 201 {payment: null}, no attempt', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const body = checkoutBody(items, await quoteTotal(items))
    gateCreateOrder(
      () => 'WF-',
      async () => {
        const o = await payload.find({ collection: 'orders', where: { 'contact.email': { equals: (body.contact as { email: string }).email } }, limit: 1, overrideAccess: true })
        await payload.update({ collection: 'orders', id: o.docs[0].id, data: { status: 'cancelled' }, overrideAccess: true })
      },
    )
    const res = await postCheckout(body)
    expect(res.status, res.text).toBe(201)
    expect(res.body.payment).toBeNull()
    expect(res.body.order.status).toBe('cancelled')
    const stored = await orderByNumber(payload, res.body.order.number)
    expect(stored.razorpay?.attempts ?? []).toEqual([])
  })

  it('replay after a 503: the order is cancelled while the retried createOrder runs → 200 {payment: null}', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const body = checkoutBody(items, await quoteTotal(items))
    const key = randomUUID()
    mock().failNext('createOrder', 'network')
    const first = await postCheckout(body, key)
    expect(first.status, first.text).toBe(503)
    const { number } = first.body.error.details.order
    const id = (await orderByNumber(payload, number)).id
    gateCreateOrder(
      () => `${number}-a`,
      async () => void (await payload.update({ collection: 'orders', id, data: { status: 'cancelled' }, overrideAccess: true })),
    )
    const again = await postCheckout(body, key)
    expect(again.status, again.text).toBe(200)
    expect(again.body).toMatchObject({ order: { number, status: 'cancelled' }, payment: null })
    expect((await reload(payload, id)).razorpay?.attempts ?? []).toEqual([])
    expect(mock().inspect().orders.some((o) => o.receipt === `${number}-a1`)).toBe(true) // created, never handed out
  })
})
