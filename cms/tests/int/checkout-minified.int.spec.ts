import { randomUUID } from 'node:crypto'

import { type Payload, ValidationError } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { isUniqueViolation } from '@/commerce/checkout/db'
import { reconcilePendingOrders } from '@/commerce/checkout/reconcile'
import { onOrderEvent, type OrderEvent } from '@/commerce/events'
import { confirmationKey, sendOrderConfirmation } from '@/email/orders/send'
import { resetRateLimits } from '@/lib/rateLimit'
import { resetGateway } from '@/payments'

import {
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
  restoreEnv,
  settle,
  simulateMinifiedErrorNames,
  stockOf,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { deleteMessagesTo, settleAndList, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'

/**
 * Unique-violation paths under PRODUCTION error names (W2V2-1).
 *
 * `next build` minifies class names and Payload's APIError sets `this.name = this.constructor.name`, so in
 * production a unique violation is a ValidationError named e.g. 'u'. A name check there made every
 * redelivered webhook 500 (Razorpay retries, then disables the webhook) and turned same-key checkout races
 * into 500s. The rest of the int suite runs unminified and can't see this; here Payload's error classes are
 * renamed for the whole file (simulateMinifiedErrorNames) and the three unique claims are exercised:
 * payment-events.eventId, orders.idempotencyKey and message-log.key (confirmation email).
 */

let payload: Payload
let restoreNames: () => void
const events: OrderEvent[] = []
const unsubscribe: (() => void)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
  restoreNames = simulateMinifiedErrorNames()
  for (const type of ['order.confirmed'] as const) {
    unsubscribe.push(onOrderEvent(type, `test:minified:${type}`, (e) => void events.push(e)))
  }
})

beforeEach(() => {
  freshMock()
  events.length = 0
})

afterEach(async () => {
  await settle()
  restoreEnv(['PAYMENTS_MODE'])
  resetGateway()
  resetRateLimits()
})

afterAll(async () => {
  restoreNames?.()
  for (const u of unsubscribe) u()
  await restoreStoreSettings(payload)
})

const confirmedFor = (number: string) => events.filter((e) => e.order.number === number && e.type === 'order.confirmed')

async function onlineOrder() {
  const p = await makeProduct(payload, { stock: 10 })
  const { res, body } = await placeOrderVia([{ slug: p.slug as string, qty: 1 }])
  expect(res.status, res.text).toBe(201)
  return { number: res.body.order.number as string, rzpOrderId: res.body.payment.razorpayOrderId as string, body }
}

describe('production error names (minified)', () => {
  it('the simulation is live: a duplicate insert throws a ValidationError that is not named "ValidationError"', async () => {
    const eventId = 'evt_minified_probe_' + randomUUID().slice(0, 8)
    const data = { eventId, event: 'payment.failed', receivedAt: new Date().toISOString(), rawSha256: 'x'.repeat(64), payload: {} }
    await payload.create({ collection: 'payment-events', data, depth: 0, overrideAccess: true })
    const err = await payload.create({ collection: 'payment-events', data, depth: 0, overrideAccess: true }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).name).not.toBe('ValidationError')
    expect(isUniqueViolation(err, 'eventId')).toBe(true)
    expect(isUniqueViolation(err, 'idempotencyKey')).toBe(false)
  })

  it('a webhook redelivered with the same event id → 200 "duplicate" each time (never 500)', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const eventId = 'evt_minified_dup_' + o.number
    const d = [...(await deliver([r.events[1]], { eventId })), ...(await deliver([r.events[1]], { eventId })), ...(await deliver([r.events[1]], { eventId }))]
    expect(d.map((x) => x.status)).toEqual([200, 200, 200])
    expect(d.map((x) => x.body)).toEqual([
      { ok: true, outcome: 'paid' },
      { ok: true, outcome: 'duplicate' },
      { ok: true, outcome: 'duplicate' },
    ])
    const rows = await payload.find({ collection: 'payment-events', where: { eventId: { equals: eventId } }, overrideAccess: true })
    expect(rows.docs).toHaveLength(1)
    await settle()
    expect(confirmedFor(o.number)).toHaveLength(1)
  })

  it('an event claimed but never finished is processed on redelivery', async () => {
    const o = await onlineOrder()
    const r = await mock().simulatePayment(o.rzpOrderId, { outcome: 'success' })
    const eventId = 'evt_minified_unfinished_' + o.number
    // The claim row a crashed first delivery leaves behind: inserted, never marked processed.
    await payload.create({
      collection: 'payment-events',
      data: { eventId, event: r.events[1].event, receivedAt: new Date().toISOString(), rawSha256: 'y'.repeat(64), payload: {} },
      depth: 0,
      overrideAccess: true,
    })
    const [again] = await deliver([r.events[1]], { eventId })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body).toEqual({ ok: true, outcome: 'paid' })
    expect((await orderByNumber(payload, o.number)).status).toBe('paid')
    const rows = await payload.find({ collection: 'payment-events', where: { eventId: { equals: eventId } }, overrideAccess: true })
    expect(rows.docs).toHaveLength(1)
    expect(rows.docs[0]).toMatchObject({ outcome: 'paid' })
    expect(rows.docs[0].processedAt).toBeTruthy()
  })

  it('online: the same Idempotency-Key 5× in parallel → one 201 and four 200 replays of that order', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 2 }]
    const body = checkoutBody(items, await quoteTotal(items))
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 5 }, () => postCheckout(body, key)))
    expect(results.map((r) => r.status).sort(), results.map((r) => r.text).join('\n')).toEqual([200, 200, 200, 200, 201])
    expect(new Set(results.map((r) => r.body.order.number)).size).toBe(1)
    expect(new Set(results.map((r) => r.body.order.token)).size).toBe(1)
    expect(new Set(results.map((r) => r.body.payment.razorpayOrderId)).size).toBe(1)
    expect(await stockOf(payload, p.slug as string)).toBe(8)
  })

  it('COD: the same Idempotency-Key 5× in parallel → one 201, four 200 replays, one order.confirmed, one email', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const contact = contactFor('minified-cod')
    await deleteMessagesTo(contact.email)
    const body = checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact })
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 5 }, () => postCheckout(body, key)))
    expect(results.map((r) => r.status).sort(), results.map((r) => r.text).join('\n')).toEqual([200, 200, 200, 200, 201])
    const numbers = new Set(results.map((r) => r.body.order.number))
    expect(numbers.size).toBe(1)
    const [number] = [...numbers]
    for (const r of results) expect(r.body).toMatchObject({ order: { number, status: 'cod_pending' }, payment: null })
    expect(await stockOf(payload, p.slug as string)).toBe(9)
    await settle()
    expect(confirmedFor(number)).toHaveLength(1)
    await waitForMessages(contact.email, { subject: number })
    expect(await settleAndList(contact.email)).toHaveLength(1)
  })

  it('confirmation already sent: a second send is a "duplicate" (not a throw), and reconcile re-stamps it and carries on', async () => {
    const p = await makeProduct(payload, { stock: 10 })
    const items = [{ slug: p.slug as string, qty: 1 }]
    const contact = contactFor('minified-confirm')
    await deleteMessagesTo(contact.email)
    const res = await postCheckout(checkoutBody(items, await quoteTotal(items, { method: 'cod' }), { method: 'cod', contact }))
    expect(res.status, res.text).toBe(201)
    const number = res.body.order.number as string
    await settle()
    await waitForMessages(contact.email, { subject: number })
    const order = await orderByNumber(payload, number)
    expect(order.confirmationSentAt).toBeTruthy()
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: confirmationKey(number) } }, overrideAccess: true })
    expect(log.docs.map((d) => (d as { status?: string }).status)).toEqual(['sent'])

    // A crash between sending and stamping: the message-log row says 'sent', the order has no stamp.
    const unstamp = () => payload.db.updateOne({ collection: 'orders', id: order.id, data: { confirmationSentAt: null }, returning: false })
    await unstamp()
    await expect(sendOrderConfirmation(payload, order.id)).resolves.toBe('duplicate')
    expect((await orderByNumber(payload, number)).confirmationSentAt).toBeTruthy()

    await unstamp()
    const summary = await reconcilePendingOrders(payload, { only: [order.id], force: true })
    expect(summary).toMatchObject({ confirmationsRetried: 0, budgetExhausted: false })
    expect((await orderByNumber(payload, number)).confirmationSentAt).toBeTruthy()
    expect(await settleAndList(contact.email)).toHaveLength(1)
  })
})
