import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getGateway, resetGateway, setGatewayForTests, type PaymentGateway } from '@/payments'

import { deliver, freshMock, makeProduct, mock, orderByNumber, placeOrderVia, reload, settle } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * HUNT-CONC-R3-1 (cms-checkout): POST /store/checkout/retry opens a NEW Razorpay order for an order whose
 * money landed while the retry was being prepared.
 *
 * retryPayment() checks "paid already?" (findLandedPayment + the locked re-check) and commits, then calls
 * createAttempt() AFTER the commit. createAttempt() creates the Razorpay order and records it under the
 * order lock, but never re-checks that the order still wants money. A UPI approval (webhook / verify /
 * reconcile → markPaid) that lands during that gateway call makes the order `paid`, and the retry still
 * answers 200 with a fresh payment sheet for it: the customer is asked to pay a paid order again, and a
 * second payment is then captured and auto-refunded (duplicate).
 *
 * The gateway call is gated here so the interleaving is deterministic: the late payment on attempt 1 is
 * delivered (signed webhook → markPaid) while createOrder for attempt 2 is in flight.
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
})
afterAll(async () => {
  await restoreStoreSettings(payload)
})

type CreateOrderInput = Parameters<PaymentGateway['createOrder']>[0]

/** The live mock, except that createOrder(input) first awaits `before(input)`. */
function gateCreateOrder(before: (input: CreateOrderInput) => Promise<void>): void {
  const inner = getGateway()
  const gated = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'createOrder') {
        return async (input: CreateOrderInput) => {
          await before(input)
          return target.createOrder(input)
        }
      }
      const v = Reflect.get(target, prop, target) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  setGatewayForTests(gated)
}

describe('retry vs a payment landing while the new attempt is opened', () => {
  it('answers 409 ALREADY_PAID instead of a fresh payment sheet for a paid order', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
    expect(res.status, res.text).toBe(201)
    const { number, token } = res.body.order as { number: string; token: string }
    const firstRzp = res.body.payment.razorpayOrderId as string
    const id = (await orderByNumber(payload, number)).id

    // The customer closed the sheet; their UPI app approves attempt 1 just as they tap "Try again".
    let landed = false
    gateCreateOrder(async (input) => {
      if (landed || !input.receipt.startsWith(`${number}-a`)) return
      landed = true
      const r = await mock().simulatePayment(firstRzp, { outcome: 'success' })
      const d = await deliver(r.events)
      expect(d.map((x) => x.status)).toEqual(d.map(() => 200))
    })

    const again = await restPost('store/checkout/retry', { body: { number, token } })
    expect(landed).toBe(true)
    const order = await reload(payload, id)
    expect(order.status).toBe('paid')

    // Correct: the order is paid, so no new Razorpay order is handed out.
    expect({ status: again.status, code: again.body?.error?.code ?? null, newPayment: again.body?.payment?.razorpayOrderId ?? null }).toEqual({
      status: 409,
      code: 'ALREADY_PAID',
      newPayment: null,
    })
    expect(order.razorpay?.attempts?.length).toBe(1)
  })

  it('answers 409 NOT_RETRYABLE instead of a payment sheet for an order cancelled meanwhile', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const { res } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
    expect(res.status, res.text).toBe(201)
    const { number, token } = res.body.order as { number: string; token: string }
    const id = (await orderByNumber(payload, number)).id

    // An admin (or a script) cancels the unpaid order while the customer's retry is opening attempt 2.
    let cancelled = false
    gateCreateOrder(async (input) => {
      if (cancelled || !input.receipt.startsWith(`${number}-a`)) return
      cancelled = true
      await payload.update({ collection: 'orders', id, data: { status: 'cancelled' }, overrideAccess: true })
    })

    const again = await restPost('store/checkout/retry', { body: { number, token } })
    expect(cancelled).toBe(true)
    expect((await reload(payload, id)).status).toBe('cancelled')
    expect({ status: again.status, code: again.body?.error?.code ?? null, newPayment: again.body?.payment?.razorpayOrderId ?? null }).toEqual({
      status: 409,
      code: 'NOT_RETRYABLE',
      newPayment: null,
    })
  })
})
