import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest, Where } from 'payload'

import type { Coupon } from '@/payload-types'

import { lockRow, sessionDb, tableOf } from './db'

/**
 * Coupon bookkeeping around $shared evaluateCoupon (SPEC §4 coupons / coupon-redemptions).
 *
 *   checkout  → one `coupon-redemptions` row per order, status `reserved` (inside the checkout transaction,
 *               after the coupon row is locked and the limits re-counted, so concurrent checkouts can't
 *               overshoot `usageLimit`)
 *   paid      → `consumed` + coupons.usedCount += 1 (markPaid)
 *   expired / cancelled → `released` (the code can be used again)
 *
 * Limits count what is spoken for: usageLimit against usedCount + reserved rows; perCustomerLimit against
 * this email's reserved + consumed rows. A code that was valid when the order was placed is honoured when
 * the order is paid, even if it expired or ran out meanwhile (the order total is an immutable snapshot).
 *
 * A RELEASED use is different: expiry/cancel gave it back and another order may have taken it since. Taking
 * it again is re-checked like stock is (recheckReleasedUse): a customer retry after expiry re-counts
 * usageLimit, perCustomerLimit and firstOrderOnly; an admin resolving a review to paid re-counts usageLimit.
 * The snapshot TERMS (discount amount, dates, active flag, minimum) are still honoured. A late payment that
 * lands on an expired order (markPaid) still consumes its released use unchecked: that money is already taken.
 */

export const CONFIRMED_ORDER_STATUSES = ['paid', 'cod_pending', 'cod_confirmed', 'partially_refunded', 'refunded'] as const

type Src = Payload | PayloadRequest
const payloadOf = (s: Src): Payload => ((s as PayloadRequest).payload ?? s) as Payload
const reqOf = (s: Src): { req?: PayloadRequest } => ((s as PayloadRequest).payload ? { req: s as PayloadRequest } : {})

export async function findCoupon(src: Src, code: string | null): Promise<Coupon | null> {
  if (!code) return null
  const res = await payloadOf(src).find({
    collection: 'coupons',
    where: { code: { equals: code } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    ...reqOf(src),
  })
  return (res.docs[0] as Coupon | undefined) ?? null
}

const notIn = (ids: (number | string)[]): Where[] => (ids.length ? [{ order: { not_in: ids } }] : [])

/** Rows currently reserving this coupon (any email), optionally ignoring some orders. */
export async function reservedCount(src: Src, couponId: number, excludeOrderIds: (number | string)[] = []): Promise<number> {
  const { totalDocs } = await payloadOf(src).count({
    collection: 'coupon-redemptions',
    where: { and: [{ coupon: { equals: couponId } }, { status: { equals: 'reserved' } }, ...notIn(excludeOrderIds)] },
    overrideAccess: true,
    ...reqOf(src),
  })
  return totalDocs
}

/** Reserved + consumed uses of this coupon by one email. */
export async function customerUsageCount(
  src: Src,
  couponId: number,
  email: string,
  excludeOrderIds: (number | string)[] = [],
): Promise<number> {
  const { totalDocs } = await payloadOf(src).count({
    collection: 'coupon-redemptions',
    where: {
      and: [
        { coupon: { equals: couponId } },
        { email: { equals: email } },
        { status: { in: ['reserved', 'consumed'] } },
        ...notIn(excludeOrderIds),
      ],
    },
    overrideAccess: true,
    ...reqOf(src),
  })
  return totalDocs
}

/**
 * First order = no earlier order by this email OR phone that was ever confirmed (paid, COD, refunded…), AND no
 * other order by this email or phone that holds (reserved) or used (consumed) a first-order-only offer. The
 * second half stops overlapping unpaid online orders from each getting the first-order discount and then all
 * being paid. Keyed on both because a guest can type a fresh email (razorpay.md §13.17). `excludeOrderIds`:
 * orders that don't count (the order being re-checked, orders a checkout is about to supersede).
 */
export async function isFirstOrder(src: Src, email: string, phone: string, excludeOrderIds: (number | string)[] = []): Promise<boolean> {
  const { totalDocs } = await payloadOf(src).count({
    collection: 'orders',
    where: {
      and: [
        { or: [{ 'contact.email': { equals: email } }, { 'contact.phone': { equals: phone } }] },
        { status: { in: [...CONFIRMED_ORDER_STATUSES] } },
        ...(excludeOrderIds.length ? [{ id: { not_in: excludeOrderIds } }] : []),
      ],
    },
    overrideAccess: true,
    ...reqOf(src),
  })
  if (totalDocs > 0) return false
  return (await firstOrderClaims(src, email, phone, excludeOrderIds)) === 0
}

/**
 * Per-customer advisory keys (db.ts lockKeys) that serialise every transaction which counts first-order
 * claims and may add one: a checkout with a first-order-only offer, and a retry re-taking a released one.
 */
export const firstOrderKeys = (c: { email: string; phone: string }): string[] => [`first-order:${c.email}`, `first-order:${c.phone}`]

/** Reserved/consumed uses of ANY first-order-only offer by orders of this email or phone. */
export async function firstOrderClaims(src: Src, email: string, phone: string, excludeOrderIds: (number | string)[] = []): Promise<number> {
  const payload = payloadOf(src)
  const db = await sessionDb((src as PayloadRequest).payload ? (src as PayloadRequest) : { payload })
  const r = sql.identifier(tableOf(payload, 'coupon-redemptions'))
  const c = sql.identifier(tableOf(payload, 'coupons'))
  const o = sql.identifier(tableOf(payload, 'orders'))
  const ids = excludeOrderIds.map(Number).filter(Number.isSafeInteger)
  const notExcluded = ids.length ? sql`AND ${o}."id" NOT IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql``
  const res = (await db.execute(sql`
    SELECT count(*)::int AS "n" FROM ${r}
      JOIN ${c} ON ${c}."id" = ${r}."coupon_id"
      JOIN ${o} ON ${o}."id" = ${r}."order_id"
    WHERE ${r}."status" IN ('reserved', 'consumed') AND ${c}."first_order_only" = true
      AND (${o}."contact_email" = ${email} OR ${o}."contact_phone" = ${phone} OR ${r}."email" = ${email})
      ${notExcluded}`)) as unknown as { rows?: { n: number }[] }
  return Number(res?.rows?.[0]?.n ?? 0)
}

/**
 * The coupon record as evaluateCoupon should see it: usedCount includes the live reservations.
 * (Payload's generated type has `| null` everywhere; evaluateCoupon treats null as "no limit".)
 */
export function withReservations(coupon: Coupon, reserved: number): Record<string, unknown> {
  return { ...coupon, usedCount: (coupon.usedCount ?? 0) + reserved }
}

/** Locks the coupon row for the rest of req's transaction (serialises limit checks). */
export const lockCoupon = (req: PayloadRequest, couponId: number) => lockRow(req, 'coupons', couponId)

export async function createRedemption(
  req: PayloadRequest,
  data: { couponId: number; code: string; orderId: number; email: string; customerId?: number | null; discountPaise: number },
): Promise<void> {
  await req.payload.create({
    collection: 'coupon-redemptions',
    data: {
      coupon: data.couponId,
      code: data.code,
      order: data.orderId,
      email: data.email,
      ...(data.customerId ? { customer: data.customerId } : {}),
      discountPaise: data.discountPaise,
      status: 'reserved',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}

type RedemptionRow = { id: number; status: 'reserved' | 'consumed' | 'released'; coupon: number | { id: number } }

async function redemptionOf(req: PayloadRequest, orderId: number | string): Promise<RedemptionRow | null> {
  const res = await req.payload.find({
    collection: 'coupon-redemptions',
    where: { order: { equals: orderId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return (res.docs[0] as unknown as RedemptionRow | undefined) ?? null
}

/** Paid: reserved/released → consumed, and the coupon's usedCount +1 (once). */
export async function consumeRedemption(req: PayloadRequest, orderId: number | string): Promise<boolean> {
  const row = await redemptionOf(req, orderId)
  if (!row || row.status === 'consumed') return false
  const couponId = typeof row.coupon === 'object' ? row.coupon.id : row.coupon
  await req.payload.db.updateOne({
    collection: 'coupon-redemptions',
    id: row.id,
    data: { status: 'consumed', consumedAt: new Date().toISOString() },
    req,
    returning: false,
  })
  await req.payload.db.updateOne({
    collection: 'coupons',
    where: { id: { equals: couponId } },
    data: { usedCount: { $inc: 1 } },
    options: { atomic: true },
    req,
  })
  return true
}

/** Expired/cancelled: reserved → released (a consumed use is never given back automatically). */
export async function releaseRedemption(req: PayloadRequest, orderId: number | string): Promise<boolean> {
  const row = await redemptionOf(req, orderId)
  if (!row || row.status !== 'reserved') return false
  await req.payload.db.updateOne({
    collection: 'coupon-redemptions',
    id: row.id,
    data: { status: 'released', releasedAt: new Date().toISOString() },
    req,
    returning: false,
  })
  return true
}

/**
 * Retry after expiry: released → reserved again (the order's discount is a snapshot; honoured). The caller
 * must have checked there is room for the use first (recheckReleasedUse).
 */
export async function rereserveRedemption(req: PayloadRequest, orderId: number | string): Promise<boolean> {
  const row = await redemptionOf(req, orderId)
  if (!row || row.status !== 'released') return false
  await req.payload.db.updateOne({
    collection: 'coupon-redemptions',
    id: row.id,
    data: { status: 'reserved', releasedAt: null },
    req,
    returning: false,
  })
  return true
}

export type ReleasedUseProblem = { reason: 'USAGE_LIMIT' | 'PER_CUSTOMER_LIMIT' | 'FIRST_ORDER_ONLY'; code: string }

/**
 * Before a RELEASED redemption of `orderId` is taken again (retry after expiry, admin resolve to paid): lock
 * the coupon row (lock order: orders → products → coupons, so call it after the stock is re-taken) and check
 * there is still room for this use. `usageLimit` always; with `customer`, also perCustomerLimit (by email) and
 * firstOrderOnly (email or phone). Returns null when the order has no released use or the use may be taken.
 * With `customer`, the caller must hold firstOrderKeys(customer) (taken first in its transaction): the coupon
 * row lock alone doesn't serialise with a checkout using ANOTHER first-order-only code (HUNT-CONC-R3-2).
 */
export async function recheckReleasedUse(
  req: PayloadRequest,
  orderId: number,
  customer: { email: string; phone: string } | null,
): Promise<ReleasedUseProblem | null> {
  const row = await redemptionOf(req, orderId)
  if (!row || row.status !== 'released') return null
  const couponId = typeof row.coupon === 'object' ? row.coupon.id : row.coupon
  await lockCoupon(req, couponId)
  const coupon = (await req.payload.findByID({ collection: 'coupons', id: couponId, depth: 0, overrideAccess: true, disableErrors: true, req })) as Coupon | null
  if (!coupon) return null // deleted meanwhile: nothing left to count against
  const limit = typeof coupon.usageLimit === 'number' ? coupon.usageLimit : null
  if (limit !== null && (coupon.usedCount ?? 0) + (await reservedCount(req, couponId, [orderId])) >= limit) {
    return { reason: 'USAGE_LIMIT', code: coupon.code }
  }
  if (!customer) return null
  if (coupon.firstOrderOnly === true && !(await isFirstOrder(req, customer.email, customer.phone, [orderId]))) {
    return { reason: 'FIRST_ORDER_ONLY', code: coupon.code }
  }
  const perCustomer = typeof coupon.perCustomerLimit === 'number' ? coupon.perCustomerLimit : null
  if (perCustomer !== null && (await customerUsageCount(req, couponId, customer.email, [orderId])) >= perCustomer) {
    return { reason: 'PER_CUSTOMER_LIMIT', code: coupon.code }
  }
  return null
}
