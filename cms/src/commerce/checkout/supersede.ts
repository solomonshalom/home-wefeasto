import type { Payload, Where } from 'payload'

import type { Order } from '@/payload-types'

import { cartSignature } from '../shared/cart-links.js'
import { findOrderForGuest, moneyArrived } from './orders'

/**
 * Supersede rules (checkout-backend.md §1.2), shared by placeOrder and POST /store/quote so the two can't
 * drift. A new checkout for the SAME bag (cart signature) replaces an ONLINE order that never took money:
 *
 *   status        pending_payment | payment_failed | expired   (expired: late money is refunded, PI-SF-2)
 *   paymentStatus none | created | attempted | failed, and no razorpay.paymentId
 *   createdAt     within max(reservationMinutes, 30) minutes
 *
 * Which orders a checkout may replace (SUP-OWN-1, which narrows SUP-PHONE-1): only orders it PROVES are the
 * customer's own.
 *   - the order named by the request's `supersede: {number, token}` guest reference: the token proves the
 *     order is the customer's own, so the phone may differ (a typo fixed before "Pay on delivery instead");
 *   - placeOrder, for a signed-in customer, also replaces that customer's own orders for this bag
 *     (`orders.customer` = the session's customer). The quote endpoint doesn't look at the session, so the
 *     quote only ever uses the reference.
 * A shared phone (or email) proves nothing: neither is a secret, and matching on them let a stranger who knew
 * a shopper's phone and bag cancel that shopper's order while they were paying, the payment then landing on
 * a cancelled order and being refunded. Without a reference or a session the earlier unpaid order is left
 * alone: it stays payable and expires (checkout-backend.md §1.2, §11).
 * A reference that doesn't verify or qualify is ignored silently in both, so it is no oracle. One exception
 * (HUNT-CONC-6): a verified reference to this bag's order that has been PAID meanwhile makes placeOrder answer
 * 409 ALREADY_PAID instead of placing a second order ("Pay on delivery instead" tapped after the UPI app
 * paid). The token already proves it's the customer's order, so this reveals nothing new.
 */

export const SUPERSEDE_STATUSES = ['pending_payment', 'payment_failed', 'expired'] as const
export const SUPERSEDE_PAYMENT_STATUSES = ['none', 'created', 'attempted', 'failed'] as const

const STATUSES = new Set<string>(SUPERSEDE_STATUSES)
const PAYMENT_STATUSES = new Set<string>(SUPERSEDE_PAYMENT_STATUSES)

export const supersedeWindowMinutes = (reservationMinutes: number): number => Math.max(Number(reservationMinutes) || 0, 30)

/** The cart signature of an order's items (same shape as the storefront's bag signature). */
export const orderCartSignature = (order: Pick<Order, 'items'>): string =>
  cartSignature((order.items ?? []).map((i) => ({ slug: i.slug, qty: i.qty })))

export type SupersedeCheck = { cartSig: string; now: number; windowMinutes: number }

/** True when a new checkout for `cartSig` may cancel `order` (every rule above except the phone). */
export function isSupersedable(order: Order, { cartSig, now, windowMinutes }: SupersedeCheck): boolean {
  if (order.paymentMethod !== 'online') return false
  if (!STATUSES.has(order.status)) return false
  if (!PAYMENT_STATUSES.has(order.paymentStatus ?? 'none')) return false
  if (order.razorpay?.paymentId) return false
  const created = order.createdAt ? Date.parse(order.createdAt) : NaN
  if (!Number.isFinite(created) || created <= now - windowMinutes * 60_000) return false
  return orderCartSignature(order) === cartSig
}

/** DB pre-filter for placeOrder's signed-in branch (same rules; the cart signature and paymentId are checked in memory). */
export function supersedeWhere(args: { customerId: number; key: string; now: number; windowMinutes: number }): Where {
  return {
    and: [
      { customer: { equals: args.customerId } },
      { status: { in: [...SUPERSEDE_STATUSES] } },
      { paymentMethod: { equals: 'online' } },
      { paymentStatus: { in: [...SUPERSEDE_PAYMENT_STATUSES] } },
      { createdAt: { greater_than: new Date(args.now - args.windowMinutes * 60_000).toISOString() } },
      { idempotencyKey: { not_equals: args.key } },
    ],
  }
}

/** A usable customer id from the checkout's session, else null (guests, malformed ids). */
export function sessionCustomerId(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

/** True when `order` belongs to the signed-in customer `customerId` (the relation, at any depth). */
export function ownedByCustomer(order: Pick<Order, 'customer'>, customerId: number | null | undefined): boolean {
  const id = sessionCustomerId(customerId)
  if (id === null) return false
  const c = order.customer
  const orderCustomer = c && typeof c === 'object' ? c.id : c
  return orderCustomer != null && Number(orderCustomer) === id
}

/** Units the orders still hold (stockState 'reserved') that a superseding checkout may count as available. */
export function supersededStock(orders: Order[]): Map<string, number> {
  const extra = new Map<string, number>()
  for (const o of orders) {
    if (o.stockState !== 'reserved') continue
    for (const it of o.items ?? []) extra.set(it.slug, (extra.get(it.slug) ?? 0) + it.qty)
  }
  return extra
}

export type SupersedeView = { extraStock: Map<string, number>; excludeOrderIds: (number | string)[] }

const NO_VIEW: SupersedeView = { extraStock: new Map(), excludeOrderIds: [] }

/**
 * The order named by a `supersede: {number, token}` reference, when it may be replaced by a checkout of
 * `cartSig` now. The token is checked like /store/orders/status (constant time, decoy for unknown numbers).
 * Any mismatch (malformed, unknown, wrong token, paid, COD, too old, other bag) gives null, never an error.
 */
export async function orderForSupersedeRef(payload: Payload, ref: unknown, check: SupersedeCheck): Promise<Order | null> {
  return (await resolveSupersedeRef(payload, ref, check)).order
}

/**
 * True when `order` would be replaced by a checkout of `cartSig` now, except that money has arrived for it
 * (paid in the UPI app, confirmed only by the webhook, after the page last looked): same bag, online, within
 * the window. A checkout naming it must not place a second order for the bag (409 ALREADY_PAID).
 */
export function paidMeanwhile(order: Order, { cartSig, now, windowMinutes }: SupersedeCheck): boolean {
  if (!moneyArrived(order)) return false
  const created = order.createdAt ? Date.parse(order.createdAt) : NaN
  if (!Number.isFinite(created) || created <= now - windowMinutes * 60_000) return false
  return orderCartSignature(order) === cartSig
}

/**
 * A verified reference as placeOrder sees it: `order` when it may be superseded, `paid` when it names the
 * customer's own order for this bag that has been paid meanwhile (paidMeanwhile). The token is verified
 * first, so `paid` tells the caller nothing /store/orders/status wouldn't.
 */
export async function resolveSupersedeRef(payload: Payload, ref: unknown, check: SupersedeCheck): Promise<{ order: Order | null; paid: Order | null }> {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return { order: null, paid: null }
  const { number, token } = ref as { number?: unknown; token?: unknown }
  const order = await findOrderForGuest(payload, number, token)
  if (!order) return { order: null, paid: null }
  if (isSupersedable(order, check)) return { order, paid: null }
  return { order: null, paid: paidMeanwhile(order, check) ? order : null }
}

/**
 * POST /store/quote `supersede: {number, token}` (PI-SF-1): price the bag the way the checkout that would
 * replace this order sees it: the order's held units count as available and its coupon reservation is
 * not counted against the offer's limits. Any mismatch gives the plain view: no error and no difference in
 * the response shape, so the ref is no oracle.
 */
export async function quoteSupersedeView(
  payload: Payload,
  ref: unknown,
  { cartSig, now, reservationMinutes }: { cartSig: string; now: number; reservationMinutes: number },
): Promise<SupersedeView> {
  const order = await orderForSupersedeRef(payload, ref, { cartSig, now, windowMinutes: supersedeWindowMinutes(reservationMinutes) })
  if (!order) return NO_VIEW
  return { extraStock: supersededStock([order]), excludeOrderIds: [order.id] }
}

export type SupersedeTargets = {
  /** Orders the checkout will try to cancel (deduped, oldest id first). */
  orders: Order[]
  /** Ids named by a verified guest reference: their phone may differ from the checkout's. */
  byRef: Set<number | string>
  /** The verified reference names this bag's order, and it has been paid meanwhile (paidMeanwhile). */
  paidRef: Order | null
}

/** `customerId`: the checkout's signed-in customer (null/absent for a guest). */
export type SupersedeOwner = { customerId?: number | null }

export type SupersedeTargetArgs = SupersedeCheck & SupersedeOwner & { key: string; ref?: unknown }

const NO_REF: { order: Order | null; paid: Order | null } = { order: null, paid: null }

/**
 * placeOrder's view (SUP-OWN-1): the verified reference's order (any phone) plus, for a signed-in
 * customer, their own orders for this bag. Never the order that owns this request's Idempotency-Key, and
 * never an order matched on the phone or email alone.
 */
export async function findSupersedeTargets(payload: Payload, args: SupersedeTargetArgs): Promise<SupersedeTargets> {
  const check: SupersedeCheck = { cartSig: args.cartSig, now: args.now, windowMinutes: args.windowMinutes }
  const customerId = sessionCustomerId(args.customerId)
  const [owned, ref] = await Promise.all([
    customerId === null
      ? Promise.resolve([] as Order[])
      : payload
          .find({
            collection: 'orders',
            where: supersedeWhere({ customerId, key: args.key, now: args.now, windowMinutes: args.windowMinutes }),
            // The cart signature is checked in memory: leave room for the customer's other bags in the window.
            limit: 25,
            sort: '-createdAt',
            depth: 0,
            overrideAccess: true,
            showHiddenFields: true,
          })
          .then((r) => r.docs as Order[]),
    args.ref === undefined || args.ref === null ? Promise.resolve(NO_REF) : resolveSupersedeRef(payload, args.ref, check),
  ])
  const refOrder = ref.order
  const paidRef = ref.paid && ref.paid.idempotencyKey !== args.key ? ref.paid : null
  const found = new Map<number | string, Order>()
  const byRef = new Set<number | string>()
  if (refOrder && refOrder.idempotencyKey !== args.key) {
    found.set(refOrder.id, refOrder)
    byRef.add(refOrder.id)
  }
  for (const o of owned) if (!found.has(o.id) && ownedByCustomer(o, customerId) && isSupersedable(o, check)) found.set(o.id, o)
  const orders = [...found.values()].sort((a, b) => Number(a.id) - Number(b.id))
  return { orders, byRef, paidRef }
}

/**
 * The in-transaction re-check on the locked, re-read row: the rules still hold (no money arrived
 * meanwhile) and it is either the referenced order or the signed-in customer's own. A matching phone
 * alone never qualifies (SUP-OWN-1).
 */
export function stillSupersedable(cur: Order, targets: Pick<SupersedeTargets, 'byRef'>, args: SupersedeCheck & SupersedeOwner): boolean {
  if (!targets.byRef.has(cur.id) && !ownedByCustomer(cur, args.customerId)) return false
  return isSupersedable(cur, args)
}
