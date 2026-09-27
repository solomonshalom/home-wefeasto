import { randomUUID } from 'node:crypto'

import type { Payload } from 'payload'
import * as payloadExports from 'payload'

import type { Order } from '@/payload-types'
import { flushPendingEffects } from '@/commerce/checkout/background'
import { findOrderById } from '@/commerce/checkout/orders'
import { getMockGateway, MockGateway, resetGateway } from '@/payments'
import type { MockPaymentResult, MockWebhookEvent, WebhookDelivery } from '@/payments/mock'

import { createProduct } from './helpers/catalogFactories'
import { uniqueEmail } from './helpers/mailpit'
import { restGet, restPost, type RestResult } from './helpers/rest'

/**
 * Shared fixtures for the checkout-*.int.spec.ts files (OWNER: checkout-backend).
 * Every test gets its own products, email and phone: supersede and the open-COD cap key on the phone, and
 * other spec files share the database and Mailpit.
 */

let phoneSeq = 0
/** A fresh valid Indian mobile (E.164) per call. */
export function uniquePhone(): string {
  phoneSeq += 1
  const n = (Date.now() % 1e6) * 1000 + (process.pid % 10) * 100 + (phoneSeq % 100)
  return `+919${String(n).padStart(9, '0').slice(-9)}`
}

export async function makeProduct(payload: Payload, overrides: Record<string, unknown> = {}) {
  const slug = (overrides.slug as string) ?? `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  return createProduct(payload, { slug, name: `Test Oats ${slug.slice(-5)}`, pricePaise: 25000, stock: 50, ...overrides })
}

export type Line = { slug: string; qty: number }

export function contactFor(tag = 'buyer') {
  return { name: 'Asha Kumar', email: uniqueEmail(tag), phone: uniquePhone() }
}

export const ADDRESS = { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' }

export function checkoutBody(items: Line[], expectedTotalPaise: number, overrides: Record<string, unknown> = {}) {
  return {
    items,
    contact: contactFor(),
    address: { ...ADDRESS },
    method: 'upi',
    expectedTotalPaise,
    consent: { marketing: false },
    source: 'web',
    ...overrides,
  }
}

/** POST /store/quote and return the total for these items (+ options). */
export async function quoteTotal(items: Line[], opts: Record<string, unknown> = {}): Promise<number> {
  const res = await restPost('store/quote', { body: { items, ...opts } })
  if (res.status !== 200) throw new Error(`quote → ${res.status} ${res.text}`)
  return res.body.quote.totalPaise
}

export function postCheckout(body: unknown, key: string = randomUUID(), opts: { cookie?: string | null; token?: string } = {}): Promise<RestResult> {
  return restPost('store/checkout', { body, headers: { 'Idempotency-Key': key }, ...opts })
}

/** Quote + checkout in one go. */
export async function placeOrderVia(items: Line[], overrides: Record<string, unknown> = {}, key: string = randomUUID()) {
  const total = await quoteTotal(items, {
    method: overrides.method ?? 'upi',
    ...(overrides.couponCode ? { couponCode: overrides.couponCode } : {}),
  })
  const body = checkoutBody(items, total, overrides)
  const res = await postCheckout(body, key)
  return { res, body, key }
}

export function mock(): MockGateway {
  const m = getMockGateway()
  if (!m) throw new Error('expected PAYMENTS_MODE=mock')
  return m
}

export type Delivered = { delivery: WebhookDelivery; status: number; body: any }

/** Delivers webhook events to the real receiver (exact signed bytes). */
export async function deliver(events: MockWebhookEvent[], opts: { eventId?: string } = {}): Promise<Delivered[]> {
  const out: Delivered[] = []
  for (const e of events) {
    await mock().emitWebhook(e.event, e.entities, {
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
      sink: async (d) => {
        const res = await postWebhook(d)
        out.push({ delivery: d, status: res.status, body: res.body })
        return { status: res.status }
      },
    })
  }
  return out
}

export function postWebhook(d: Pick<WebhookDelivery, 'body' | 'signature' | 'eventId'>, headers: Record<string, string> = {}) {
  return restPost('payments/razorpay/webhook', {
    rawBody: d.body,
    contentType: 'application/json',
    headers: { 'x-razorpay-signature': d.signature, 'x-razorpay-event-id': d.eventId, ...headers },
  })
}

export async function verify(number: string, token: string, response: Record<string, string>) {
  return restPost('store/checkout/verify', { body: { number, token, ...response } })
}

export async function status(number: string, token: string) {
  return restGet('store/orders/status', { query: { no: number, t: token } })
}

export async function orderByNumber(payload: Payload, number: string): Promise<Order> {
  const res = await payload.find({ collection: 'orders', where: { number: { equals: number } }, limit: 1, depth: 0, showHiddenFields: true, overrideAccess: true })
  const doc = res.docs[0] as Order | undefined
  if (!doc) throw new Error(`order ${number} not found`)
  return doc
}

export async function stockOf(payload: Payload, slug: string): Promise<number> {
  const res = await payload.find({ collection: 'products', where: { slug: { equals: slug } }, limit: 1, overrideAccess: true, depth: 0 })
  return Number((res.docs[0] as { stock?: number }).stock)
}

export async function reload(payload: Payload, id: number): Promise<Order> {
  const o = await findOrderById(payload, id)
  if (!o) throw new Error(`order ${id} vanished`)
  return o
}

export async function settle(): Promise<void> {
  await flushPendingEffects()
}

export const SAVED_ENV = { ...process.env }

export function restoreEnv(keys: string[]): void {
  for (const k of keys) {
    if (SAVED_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED_ENV[k]
  }
}

export function freshMock(): MockGateway {
  process.env.PAYMENTS_MODE = 'mock'
  resetGateway()
  const m = mock()
  m.reset()
  return m
}

/** Narrows a simulatePayment result to the success shape (throws otherwise). */
export function ok(r: MockPaymentResult) {
  if (!r.ok) throw new Error(`expected a successful payment, got ${r.error.reason}`)
  // The handler triple as a plain string record (what the browser POSTs to verify / the callback).
  return { ...r, response: { ...r.response } as Record<string, string> }
}

/** Narrows a simulatePayment result to the failure shape (throws otherwise). */
export function failed(r: MockPaymentResult): Extract<MockPaymentResult, { ok: false }> {
  if (r.ok) throw new Error('expected a failed payment')
  return r
}

/**
 * Renames Payload's error classes the way the production build does. APIError sets
 * `this.name = this.constructor.name`, and `next build` minifies class names, so in production a unique
 * violation arrives as a ValidationError whose `name` is something like 'u'. Code that compares `err.name`
 * passes every unminified test and fails only after deploy. Returns the function that restores the names.
 */
export function simulateMinifiedErrorNames(): () => void {
  const restore: (() => void)[] = []
  let n = 0
  for (const value of Object.values(payloadExports)) {
    if (typeof value !== 'function' || !(value.prototype instanceof Error)) continue
    const original = Object.getOwnPropertyDescriptor(value, 'name')!
    Object.defineProperty(value, 'name', { ...original, value: `u${n++}` })
    restore.push(() => Object.defineProperty(value, 'name', original))
  }
  if (!n) throw new Error('simulateMinifiedErrorNames: found no Payload error classes to rename')
  return () => {
    for (const r of restore.reverse()) r()
  }
}
