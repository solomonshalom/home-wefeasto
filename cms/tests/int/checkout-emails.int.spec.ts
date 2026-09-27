import { randomUUID } from 'node:crypto'

import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { expireOrder } from '@/commerce/checkout/expire'
import { verifyOrderToken } from '@/commerce/orderToken'
import { resetRateLimits } from '@/lib/rateLimit'

import {
  checkoutBody,
  contactFor,
  deliver,
  ok,
  freshMock,
  makeProduct,
  mock,
  orderByNumber,
  postCheckout,
  quoteTotal,
  restoreEnv,
  settle,
  verify,
} from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restPatch, restPost } from './helpers/rest'

/**
 * Order emails through Mailpit (unique recipient per test): confirmation (COD / online / late variant),
 * shipped, the automatic refund notice — and exactly one confirmation however many paths confirm.
 */

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
})

beforeEach(() => {
  freshMock()
})

afterEach(async () => {
  await settle()
  restoreEnv(['PAYMENTS_MODE'])
  resetRateLimits()
})

afterAll(async () => {
  await restoreStoreSettings(payload)
})

async function place(method: 'upi' | 'cod', qty = 2, pricePaise = 25000) {
  const p = await makeProduct(payload, { pricePaise, stock: 10 })
  const contact = contactFor('mail')
  await deleteMessagesTo(contact.email)
  const items = [{ slug: p.slug as string, qty }]
  const res = await postCheckout(checkoutBody(items, await quoteTotal(items, { method }), { method, contact }), randomUUID())
  expect(res.status, res.text).toBe(201)
  return { product: p, contact, res, number: res.body.order.number as string, token: res.body.order.token as string }
}

describe('confirmation email', () => {
  it('COD: one email with the receipt, pay-on-delivery copy, /order link with a working token, buy-again link, WhatsApp help', async () => {
    const o = await place('cod', 1, 30000)
    const [summary] = await waitForMessages(o.contact.email, { subject: o.number })
    expect(summary.Subject).toBe(`Order ${o.number} placed — pay on delivery`)
    const msg = await getMessage(summary.ID)
    expect(msg.Text).toContain(`Please keep ₹349 ready (cash or UPI)`)
    expect(msg.Text).toContain('Delivery: ₹49')
    expect(msg.Text).toContain('Total: ₹349')
    expect(msg.HTML).toContain(o.product.name as string)
    const links = extractLinks(msg.HTML)
    const orderLink = links.find((l) => l.startsWith('http://localhost:5173/order?'))!
    const url = new URL(orderLink)
    expect(url.searchParams.get('no')).toBe(o.number)
    expect(url.searchParams.get('t')).toBe(o.token)
    const stored = await orderByNumber(payload, o.number)
    expect(verifyOrderToken(stored, url.searchParams.get('t'))).toBe(true)
    expect(links).toContain(`http://localhost:5173/cart?add=${encodeURIComponent(`${o.product.slug}:1`)}&src=email`)
    expect(links.some((l) => l.startsWith('https://wa.me/'))).toBe(true)
    expect(stored.confirmationSentAt).toBeTruthy()
    expect(await settleAndList(o.contact.email)).toHaveLength(1)
  })

  it('online: sent once when paid, however many paths confirm (verify + callback + webhooks at once)', async () => {
    const o = await place('upi')
    // Nothing while unpaid.
    expect(await settleAndList(o.contact.email, 300)).toHaveLength(0)
    const r = ok(await mock().simulatePayment(o.res.body.payment.razorpayOrderId, { outcome: 'success' }))
    await Promise.all([
      verify(o.number, o.token, r.response),
      restPost('payments/razorpay/callback', { rawBody: new URLSearchParams(r.response), contentType: 'application/x-www-form-urlencoded', query: { no: o.number, t: o.token } }),
      deliver(r.events),
      deliver(r.events),
    ])
    await settle()
    const [msg] = await waitForMessages(o.contact.email, { subject: o.number })
    expect(msg.Subject).toBe(`Order ${o.number} confirmed — thank you!`)
    expect(await settleAndList(o.contact.email)).toHaveLength(1)
    expect((await getMessage(msg.ID)).Text).toContain(`We've received your payment of ₹500 for order ${o.number}.`)
  })

  it('late authorisation after expiry: the "your payment went through" variant', async () => {
    const o = await place('upi')
    const r = await mock().simulatePayment(o.res.body.payment.razorpayOrderId, { outcome: 'late' })
    const id = (await orderByNumber(payload, o.number)).id
    await expireOrder(payload, id, { now: Date.now() + 31 * 60_000 })
    const late = await mock().completeLateAuthorization(r.payment.id)
    await deliver(late.events)
    await settle()
    const [msg] = await waitForMessages(o.contact.email, { subject: o.number })
    expect(msg.Subject).toBe(`Good news — your payment for ${o.number} went through`)
    expect((await getMessage(msg.ID)).Text).toContain('no need to order again')
  })
})

describe('shipped and refund emails', () => {
  it('shipped: one "on its way" email when an admin marks it shipped', async () => {
    const o = await place('cod')
    await waitForMessages(o.contact.email, { subject: 'placed' })
    const admin = await createStaff(payload, 'admin')
    const { token } = await login('users', admin.email)
    const id = (await orderByNumber(payload, o.number)).id
    await restPatch(`orders/${id}`, { body: { status: 'cod_confirmed' }, token })
    const res = await restPatch(`orders/${id}`, { body: { fulfilmentStatus: 'shipped' }, token })
    expect(res.status, res.text).toBe(200)
    await settle()
    const [msg] = await waitForMessages(o.contact.email, { subject: 'on its way' })
    expect(msg.Subject).toBe(`Your order ${o.number} is on its way`)
    expect((await getMessage(msg.ID)).Text).toContain('Please keep ₹500 ready')
    expect((await settleAndList(o.contact.email)).filter((m) => m.Subject.includes('on its way'))).toHaveLength(1)
  })

  it('duplicate payment: the refund notice (refund:<refundId>) goes out once', async () => {
    const o = await place('upi')
    const a1 = o.res.body.payment.razorpayOrderId
    const retry = await restPost('store/checkout/retry', { body: { number: o.number, token: o.token } })
    const a2 = retry.body.payment.razorpayOrderId
    const p2 = await mock().simulatePayment(a2, { outcome: 'success' })
    await deliver(p2.events)
    const p1 = await mock().simulatePayment(a1, { outcome: 'success' })
    await deliver(p1.events)
    await deliver(p1.events)
    await settle()
    const refunds = await waitForMessages(o.contact.email, { subject: 'refunded' })
    expect(refunds).toHaveLength(1)
    expect(refunds[0].Subject).toBe(`We've refunded ₹500 for order ${o.number}`)
    expect((await getMessage(refunds[0].ID)).Text).toContain('was paid twice')
    const [refund] = mock().inspect().refunds
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: `refund:${refund.id}` } }, overrideAccess: true })
    expect(log.docs).toHaveLength(1)
    expect((await settleAndList(o.contact.email)).filter((m) => m.Subject.includes('refunded'))).toHaveLength(1)
  })
})
