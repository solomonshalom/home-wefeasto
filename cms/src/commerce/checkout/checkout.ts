import { createHash } from 'node:crypto'

import type { Payload, PayloadRequest, RequiredDataFromCollectionSlug } from 'payload'

import type { Order } from '@/payload-types'

import { getGateway } from '../../payments'
import { newTokenNonce } from '../orderToken'
import { getStoreSettings } from '../settings'
import { cartSignature, parseSrcParam } from '../shared/cart-links.js'
import { evaluateCoupon } from '../shared/coupons.js'
import { isPaise } from '../shared/money.js'
import { initialStatus, paymentMethodFor } from '../shared/order-status.js'
import { parseItems, type Quote } from '../shared/pricing.js'
import { cleanText, validateCheckoutForm } from '../shared/validate.js'
import { createAttempt, latestAttempt } from './attempts'
import { createRedemption, customerUsageCount, findCoupon, firstOrderKeys, isFirstOrder, lockCoupon, reservedCount, withReservations } from './coupons'
import { inTransaction, isUniqueViolation, lockKeys } from './db'
import { toOrderStatusDTO } from './dto'
import { applyEffects, noEffects } from './effects'
import { releaseAndMove } from './expire'
import { lockOrder, orderRef, type OrderRef, tokenFor } from './orders'
import { buildPaymentInit, type PaymentInit } from './paymentInit'
import { serverQuote } from './quote'
import { findSupersedeTargets, paidMeanwhile, stillSupersedable, supersededStock, supersedeWindowMinutes } from './supersede'
import { reserveLines, type StockLine } from './stock'

/**
 * POST /api/store/checkout (SPEC §6), following shared-commerce-api.md "Server checkout recipe".
 *
 *   Idempotency-Key (uuid v4) + requestHash:   same key + same payload → 200 + the same order/token/payment;
 *                                              same key + other payload → 409 IDEMPOTENCY_MISMATCH.
 *   validate → server quote (DB catalog, coupon with live usage, full identity) → recipe error codes in two
 *              rounds: first those that don't depend on who is ordering (against the identity-free quote,
 *              ending with PRICE_CHANGED), then the identity-dependent ones (FIRST_ORDER_ONLY,
 *              PER_CUSTOMER_LIMIT, TOO_MANY_OPEN), so a doomed request never reveals a customer's history
 *   ONE transaction: supersede → stock reservation (atomic conditional decrements) → coupon row lock +
 *                    limit re-count → order insert (sequential WF- number) → coupon redemption (reserved)
 *   after commit:    COD → cod_pending, order.confirmed + confirmation email;
 *                    online → Razorpay order `<no>-a1` (notes {wf_order}) → 201 {order, payment};
 *                    gateway down → 503 PAYMENTS_UNAVAILABLE {order} (order kept, no Razorpay id; replay or
 *                    /checkout/retry later, or it expires).
 *
 * Supersede (storefront-checkout.md §8.2, rules in ./supersede.ts): a new order for the SAME bag (cart
 * signature) replaces still-unpaid ONLINE orders (pending_payment, payment_failed or expired) from the last
 * max(reservationMinutes, 30) minutes (e.g. "Pay on delivery instead" after a dismissed payment) that the
 * checkout proves are the customer's own (SUP-OWN-1): the order named by the optional
 * `supersede: {number, token}` guest reference (any phone: the token proves it; the same rule POST
 * /store/quote prices with) and, for a signed-in customer, their own orders. Never an order that merely
 * shares the phone. They are cancelled in the same transaction and their stock and coupon given back, so
 * one bag can't ship twice.
 * If money later arrives for a superseded order, markPaid refunds it (PI-SF-2). The reference is not part
 * of the request hash (it names what to replace, not what is ordered); one that doesn't verify or qualify
 * is ignored silently, except a verified one naming this bag's order that has been PAID meanwhile: then
 * nothing is placed and the answer is 409 ALREADY_PAID {order: OrderStatusDTO}, like /checkout/retry
 * (checked before and again inside the transaction, on the locked row).
 *
 * The open-COD cap (codMaxOpenPerPhone) and first-order-only offers count orders that a parallel checkout
 * may be creating right now, so both are re-checked inside the transaction after a per-customer advisory
 * lock (db.ts lockKeys): the phone for COD, the email and phone for a first-order offer. The early check
 * outside the transaction stays as the fast path.
 */

export const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const DEFAULT_CONSENT_TEXT = 'Send me refill reminders & recipes. Unsubscribe anytime.'
const METHODS = new Set(['upi', 'card', 'cod'])

export type CheckoutBody = Record<string, unknown>
export type CheckoutSuccess = { status: 200 | 201; body: { order: OrderRef; payment: PaymentInit | null } }
export type CheckoutFailure = { status: number; code: string; details?: unknown }
export type CheckoutResult = CheckoutSuccess | CheckoutFailure

export const isFailure = (r: CheckoutResult): r is CheckoutFailure => 'code' in r

const fail = (status: number, code: string, details?: unknown): CheckoutFailure => ({ status, code, ...(details !== undefined ? { details } : {}) })

class Abort extends Error {
  constructor(readonly result: CheckoutFailure | { replay: true }) {
    super('checkout aborted')
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Deterministic JSON (sorted keys) for hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}

/**
 * sha256 of the checkout request's MEANING: merged items (cart signature), the cleaned contact/address,
 * method, coupon code, expected total, marketing consent and source. Key order, duplicate lines, spacing
 * and phone formatting don't change it; any real change does.
 */
export function checkoutRequestHash(body: CheckoutBody): string {
  const parsed = parseItems(body.items)
  const form = validateCheckoutForm({ ...obj(body.contact), ...obj(body.address) })
  const code = typeof body.couponCode === 'string' ? body.couponCode.trim().toUpperCase() : null
  const canonical = {
    items: parsed.ok ? cartSignature(parsed.items) : (body.items ?? null),
    form: form.value,
    method: body.method ?? null,
    couponCode: code || null,
    expectedTotalPaise: body.expectedTotalPaise ?? null,
    marketing: obj(body.consent).marketing === true,
    source: body.source ?? null,
  }
  return createHash('sha256').update(stableStringify(canonical)).digest('hex')
}

async function findByIdempotencyKey(payload: Payload, key: string): Promise<Order | null> {
  const res = await payload.find({
    collection: 'orders',
    where: { idempotencyKey: { equals: key } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  return (res.docs[0] as Order | undefined) ?? null
}

/** The response to a repeat of an earlier checkout request (same key, same payload). */
export async function replayCheckout(payload: Payload, order: Order): Promise<CheckoutResult> {
  const token = tokenFor(order)
  const waiting = order.paymentMethod === 'online' && (order.status === 'pending_payment' || order.status === 'payment_failed')
  if (!waiting || order.razorpay?.paymentId) return { status: 200, body: { order: orderRef(order, token), payment: null } }
  let current = order
  let attempt = latestAttempt(order)
  if (!attempt) {
    // The first response was 503 (gateway down): try again now.
    const a = await createAttempt(payload, order.id)
    // Paid or cancelled meanwhile: no payment sheet, just where the order stands now.
    if (!a.ok && a.refused) return { status: 200, body: { order: orderRef(a.order, token), payment: null } }
    if (!a.ok) return fail(503, 'PAYMENTS_UNAVAILABLE', { order: orderRef(order, token) })
    current = a.order
    attempt = a.attempt
  }
  return {
    status: 200,
    body: { order: orderRef(current, token), payment: buildPaymentInit({ gateway: getGateway(), order: current, attempt, token }) },
  }
}

/** Open COD orders of this phone (cod_pending / cod_confirmed, not yet delivered). With req: inside its transaction. */
async function openCodCount(src: Payload | PayloadRequest, phone: string): Promise<number> {
  const req = (src as PayloadRequest).payload ? (src as PayloadRequest) : undefined
  const payload = req ? req.payload : (src as Payload)
  const { totalDocs } = await payload.count({
    collection: 'orders',
    where: {
      and: [
        { 'contact.phone': { equals: phone } },
        { status: { in: ['cod_pending', 'cod_confirmed'] } },
        { fulfilmentStatus: { in: ['unfulfilled', 'packed', 'shipped'] } },
      ],
    },
    overrideAccess: true,
    ...(req ? { req } : {}),
  })
  return totalDocs
}

export type PlaceOrderInput = {
  body: CheckoutBody
  idempotencyKey: string
  customerId?: number | null
  now?: number
}

export async function placeOrder(payload: Payload, input: PlaceOrderInput): Promise<CheckoutResult> {
  const { body, idempotencyKey: key } = input
  const now = input.now ?? Date.now()
  const requestHash = checkoutRequestHash(body)

  // 1. Idempotent replay.
  const existing = await findByIdempotencyKey(payload, key)
  if (existing) {
    if (existing.requestHash !== requestHash) return fail(409, 'IDEMPOTENCY_MISMATCH')
    return replayCheckout(payload, existing)
  }

  // 2. Validate the request.
  const parsed = parseItems(body.items)
  if (!parsed.ok) return fail(400, parsed.error.code, parsed.error.details)
  const method = typeof body.method === 'string' && METHODS.has(body.method) ? (body.method as 'upi' | 'card' | 'cod') : null
  const settings = await getStoreSettings(payload)
  const form = validateCheckoutForm({ ...obj(body.contact), ...obj(body.address) }, { blockedPinPrefixes: settings.server.blockedPinPrefixes })
  const fieldErrors: Record<string, string> = { ...form.errors }
  if (!method) fieldErrors.method = body.method === undefined ? 'REQUIRED' : 'INVALID'
  if (!isPaise(body.expectedTotalPaise)) fieldErrors.expectedTotalPaise = body.expectedTotalPaise === undefined ? 'REQUIRED' : 'INVALID'
  const keys = Object.keys(fieldErrors)
  if (keys.length === 1 && fieldErrors.pin === 'UNSERVICEABLE') return fail(422, 'PIN_UNSERVICEABLE', { pin: form.value.pin })
  if (keys.length) return fail(400, 'VALIDATION', { fields: fieldErrors })
  const v = form.value as { name: string; email: string; phone: string; line1: string; city: string; state: string; pin: string }
  const consent = obj(body.consent)
  const marketing = consent.marketing === true
  const consentText = typeof consent.text === 'string' && cleanText(consent.text).length >= 10 ? cleanText(consent.text).slice(0, 300) : DEFAULT_CONSENT_TEXT
  const source = parseSrcParam(body.source) ?? 'web'
  const cartSig = cartSignature(parsed.items)

  // 3. Orders this one replaces (same bag, unpaid online, recent; the referenced order or the session's own).
  const reservationMinutes = settings.server.reservationMinutes
  const windowMinutes = supersedeWindowMinutes(reservationMinutes)
  const supersedeArgs = { customerId: input.customerId ?? null, cartSig, now, windowMinutes }
  const targets = await findSupersedeTargets(payload, { ...supersedeArgs, key, ref: body.supersede })
  const alreadyPaid = (o: Order) =>
    fail(409, 'ALREADY_PAID', { order: toOrderStatusDTO(o, { shippingPromiseText: settings.public.shippingPromiseText }) })
  // The order this checkout was meant to replace has been paid meanwhile: one order for the bag, not two.
  if (targets.paidRef) return alreadyPaid(targets.paidRef)
  const superseded = targets.orders
  const extraStock = supersededStock(superseded)
  const excludeOrderIds = superseded.map((o) => o.id)

  // 4. Server quote with the full identity, then the recipe's checks in two rounds.
  const identity = { email: v.email, phone: v.phone, excludeOrderIds }
  const sq = await serverQuote(payload, {
    items: parsed.items,
    couponCode: body.couponCode,
    method,
    pin: v.pin,
    identity,
    extraStock,
    now,
  })
  const q = sq.quote
  const s = sq.settings
  // 4a. Everything that doesn't depend on WHO is ordering, against the identity-free quote (what
  // /store/quote answers), ending with the price. A request that can't be placed anyway (e.g. a wrong
  // expectedTotalPaise) gets the same answer whatever the email/phone's history, so checkout is no "has
  // this number ordered before?" oracle.
  const early = refusal(sq.publicQuote, { method, pin: v.pin, settings: s })
  if (early) return early
  if (body.expectedTotalPaise !== sq.publicQuote.totalPaise) return fail(409, 'PRICE_CHANGED', { quote: sq.publicQuote })
  // 4b. Identity-dependent refusals (first-order-only, per-customer limit, open COD orders of this phone):
  // only a checkout that would otherwise be placed learns them.
  if (q.couponError) return fail(422, 'COUPON_INVALID', { reason: q.couponError.reason })
  if (method === 'cod' && (await openCodCount(payload, v.phone)) >= s.server.codMaxOpenPerPhone) {
    return fail(422, 'COD_UNAVAILABLE', { reason: 'TOO_MANY_OPEN' })
  }
  if (q.coupon && q.coupon.deferredChecks.length) throw new Error('checkout: coupon identity checks were deferred')
  // Same reads, only the identity inputs differ: with the offer still valid for this customer, the totals match.
  if (q.totalPaise !== sq.publicQuote.totalPaise) throw new Error('checkout: identity quote differs from the public quote')

  // 5. The transaction.
  const bySlug = new Map(sq.catalog.map((p) => [p.slug, p]))
  const lines: StockLine[] = q.lines.map((l) => ({ productId: bySlug.get(l.slug)!.id, slug: l.slug, qty: l.qty }))
  const tokenNonce = newTokenNonce()
  const cancelled: Order[] = []
  let order: Order
  try {
    order = await inTransaction(
      payload,
      async (req) => {
        cancelled.length = 0
        // Rules counted over orders that may not exist yet are serialised per customer (advisory locks, taken
        // before any row lock): parallel COD checkouts of one phone, parallel first-order offers.
        const keys: string[] = []
        if (method === 'cod') keys.push(`cod-open:${v.phone}`)
        if (sq.coupon?.firstOrderOnly === true) keys.push(...firstOrderKeys(v))
        if (keys.length) await lockKeys(req, keys)
        if (method === 'cod' && (await openCodCount(req, v.phone)) >= s.server.codMaxOpenPerPhone) {
          throw new Abort(fail(422, 'COD_UNAVAILABLE', { reason: 'TOO_MANY_OPEN' }))
        }

        // Lock every target (ascending id) BEFORE releasing any stock: taking an order lock while holding a
        // product lock deadlocks with an admin edit or markPaid of that order (orders → products, db.ts).
        const current: Order[] = []
        for (const cand of superseded) {
          const cur = await lockOrder(req, cand.id)
          if (cur) current.push(cur)
        }
        for (const cur of current) {
          if (targets.byRef.has(cur.id) && paidMeanwhile(cur, supersedeArgs)) throw new Abort(alreadyPaid(cur))
        }
        for (const cur of current) {
          if (!stillSupersedable(cur, targets, supersedeArgs)) continue
          cancelled.push(await releaseAndMove(req, cur, 'cancel', { source: 'checkout', note: 'superseded by a newer order for the same bag' }))
        }

        const reserved = await reserveLines(req, lines)
        if (!reserved.ok) throw new Abort(fail(409, 'OUT_OF_STOCK', { slug: reserved.failed.slug }))

        if (sq.coupon) {
          await lockCoupon(req, sq.coupon.id)
          const fresh = await findCoupon(req, sq.coupon.code)
          const r = fresh
            ? evaluateCoupon(withReservations(fresh, await reservedCount(req, fresh.id)) as never, {
                subtotalPaise: q.subtotalPaise,
                deliveryPaise: q.deliveryPaise,
                codFeePaise: q.codFeePaise,
                now,
                email: v.email,
                isFirstOrder: await isFirstOrder(req, v.email, v.phone),
                customerUsageCount: await customerUsageCount(req, fresh.id, v.email),
              })
            : null
          if (!r || r.error) throw new Abort(fail(422, 'COUPON_INVALID', { reason: r?.error?.reason ?? 'NOT_FOUND' }))
          if (r.discountPaise !== q.discountPaise) throw new Abort(fail(409, 'PRICE_CHANGED'))
        }

        let created: Order
        try {
          const data: Omit<RequiredDataFromCollectionSlug<'orders'>, 'number'> = {
              tokenNonce,
              idempotencyKey: key,
              requestHash,
              ...(input.customerId ? { customer: input.customerId } : {}),
              source: source as Order['source'],
              status: initialStatus(method),
              paymentStatus: 'none',
              fulfilmentStatus: 'unfulfilled',
              contact: { name: v.name, email: v.email, phone: v.phone },
              shippingAddress: { line1: v.line1, city: v.city, state: v.state, pin: v.pin },
              items: q.lines.map((l) => ({
                product: bySlug.get(l.slug)!.id as number,
                slug: l.slug,
                name: l.name,
                unitPaise: l.unitPaise,
                qty: l.qty,
                lineTotalPaise: l.lineTotalPaise,
                image: l.image ?? null,
              })),
              subtotalPaise: q.subtotalPaise,
              discountPaise: q.discountPaise,
              deliveryPaise: q.deliveryPaise,
              codFeePaise: q.codFeePaise,
              totalPaise: q.totalPaise,
              currency: 'INR',
              ...(q.coupon ? { coupon: { code: q.coupon.code, discountPaise: q.discountPaise } } : {}),
              requestedMethod: method!,
              paymentMethod: paymentMethodFor(method),
              stockState: method === 'cod' ? 'committed' : 'reserved',
              reservedUntil: method === 'cod' ? null : new Date(now + reservationMinutes * 60_000).toISOString(),
              consent: { marketing, at: new Date(now).toISOString(), text: marketing ? consentText : null },
          }
          created = (await req.payload.create({
            collection: 'orders',
            // `number` is assigned by the Orders beforeChange hook (sequential counter, same transaction).
            data: data as RequiredDataFromCollectionSlug<'orders'>,
            depth: 0,
            overrideAccess: true,
            showHiddenFields: true,
            req,
            context: { statusSource: 'checkout', statusNote: `checkout ${method}${cancelled.length ? ` (replaces ${cancelled.map((c) => c.number).join(', ')})` : ''}` },
          })) as Order
        } catch (err) {
          if (isUniqueViolation(err, 'idempotencyKey')) throw new Abort({ replay: true })
          throw err
        }
        if (sq.coupon && q.coupon) {
          await createRedemption(req, {
            couponId: sq.coupon.id,
            code: q.coupon.code,
            orderId: created.id,
            email: v.email,
            customerId: input.customerId ?? null,
            discountPaise: q.discountPaise,
          })
        }
        return created
      },
      { context: { statusSource: 'checkout' } },
    )
  } catch (err) {
    if (!(err instanceof Abort)) throw err
    const r = err.result
    if ('replay' in r) {
      // Lost the race to a concurrent request with the same key: answer like a replay.
      const winner = await findByIdempotencyKey(payload, key)
      if (!winner) throw new Error('checkout: idempotency key conflict without a stored order')
      if (winner.requestHash !== requestHash) return fail(409, 'IDEMPOTENCY_MISMATCH')
      return replayCheckout(payload, winner)
    }
    if (r.code === 'OUT_OF_STOCK' || r.code === 'PRICE_CHANGED') {
      // Someone else took the stock (or the coupon changed) between the quote and the reservation. The fresh
      // quote shown is the identity-free one, like every PRICE_CHANGED (4a).
      const again = (await serverQuote(payload, { items: parsed.items, couponCode: body.couponCode, method, pin: v.pin, email: v.email, excludeOrderIds, extraStock, now })).publicQuote
      if (r.code === 'OUT_OF_STOCK') return fail(409, 'OUT_OF_STOCK', { issues: outOfStockIssues(again, (r.details as { slug: string }).slug) })
      return fail(409, 'PRICE_CHANGED', { quote: again })
    }
    return r
  }

  // 6. After commit.
  for (const c of cancelled) {
    const e = noEffects()
    e.events.push({ type: 'order.cancelled', previousStatus: superseded.find((o) => o.id === c.id)?.status ?? null, source: 'checkout' })
    await applyEffects(payload, c.id, e, 'supersede')
  }
  const token = tokenFor({ id: order.id, tokenNonce })
  if (method === 'cod') {
    const e = noEffects()
    e.events.push({ type: 'order.confirmed', previousStatus: null, source: 'checkout' })
    e.confirmation = { late: false }
    await applyEffects(payload, order.id, e, 'cod checkout')
    return { status: 201, body: { order: orderRef(order, token), payment: null } }
  }
  const a = await createAttempt(payload, order.id)
  // Superseded (or paid) before its first attempt was recorded: no payment sheet, the order as it stands.
  if (!a.ok && a.refused) return { status: 201, body: { order: orderRef(a.order, token), payment: null } }
  if (!a.ok) return fail(503, 'PAYMENTS_UNAVAILABLE', { order: orderRef(order, token) })
  return {
    status: 201,
    body: { order: orderRef(a.order, token), payment: buildPaymentInit({ gateway: getGateway(), order: a.order, attempt: a.attempt, token }) },
  }
}

/**
 * The recipe's refusals that don't depend on who is ordering, in the recipe's order (shared-commerce-api.md
 * "Server checkout recipe"): stock/limit issues, order errors, an offer that is invalid for everyone (unknown,
 * expired, used up, minimum, bound to another email), PIN, COD availability. null when none applies.
 */
function refusal(
  q: Quote,
  { method, pin, settings }: { method: string | null; pin: string; settings: { public: { codMaxPaise: number; codMinSubtotalPaise: number } } },
): CheckoutFailure | null {
  if (q.issues.length) return fail(409, q.issues[0].code, { issues: q.issues })
  if (q.orderError) return fail(400, q.orderError.code, q.orderError)
  if (q.couponError) return fail(422, 'COUPON_INVALID', { reason: q.couponError.reason })
  if (q.pinServiceable === false) return fail(422, 'PIN_UNSERVICEABLE', { pin })
  if (method === 'cod' && !q.codAvailable) {
    return fail(422, 'COD_UNAVAILABLE', {
      reason: q.codUnavailableReason,
      codMaxPaise: settings.public.codMaxPaise,
      codMinSubtotalPaise: settings.public.codMinSubtotalPaise,
    })
  }
  return null
}

/** Issues for an OUT_OF_STOCK that happened at reservation time (the fresh quote, or one synthesised line). */
function outOfStockIssues(q: Quote, slug: string): Quote['issues'] {
  if (q.issues.length) return q.issues
  const line = q.lines.find((l) => l.slug === slug)
  return [{ slug, name: line?.name ?? slug, code: 'OUT_OF_STOCK', requestedQty: line?.qty ?? null, available: 0, suggestedQty: 0 }]
}
