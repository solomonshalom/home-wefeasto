import type { Payload, PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

import { deriveOrderToken, verifyOrderToken } from '../orderToken'
import { isConfirmed, isOrderNumber } from '../shared/order-status.js'
import { lockRow } from './db'

/**
 * Order lookups for the checkout endpoints. Guest access is `(number, token)`; an unknown order, a wrong
 * token and a malformed input all come back as `null`, and the caller answers them with ONE 404 body.
 */

type Src = Payload | PayloadRequest
const payloadOf = (s: Src): Payload => ((s as PayloadRequest).payload ?? s) as Payload
const reqOf = (s: Src): { req?: PayloadRequest } => ((s as PayloadRequest).payload ? { req: s as PayloadRequest } : {})

/** Base64url HMAC token as issued by deriveOrderToken (43 chars). */
export const ORDER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const isOrderToken = (t: unknown): t is string => typeof t === 'string' && ORDER_TOKEN_RE.test(t)

export async function findOrderByNumber(src: Src, number: string): Promise<Order | null> {
  const res = await payloadOf(src).find({
    collection: 'orders',
    where: { number: { equals: number.trim() } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    ...reqOf(src),
  })
  return (res.docs[0] as Order | undefined) ?? null
}

// A fixed decoy so a lookup of an unknown order still does one HMAC + compare (no timing oracle).
const DECOY = { id: 0, tokenNonce: 'AAAAAAAAAAAAAAAAAAAAAA' }

/** The order when `token` is its guest token, else null (unknown order, wrong token, malformed input). */
export async function findOrderForGuest(src: Src, number: unknown, token: unknown): Promise<Order | null> {
  const well = isOrderNumber(number) && isOrderToken(token)
  const order = well ? await findOrderByNumber(src, String(number)) : null
  const ok = verifyOrderToken(order ?? DECOY, well ? token : '')
  return order && ok ? order : null
}

export async function findOrderById(src: Src, id: number | string): Promise<Order | null> {
  const doc = await payloadOf(src).findByID({
    collection: 'orders',
    id,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    disableErrors: true,
    ...reqOf(src),
  })
  return (doc as Order | null) ?? null
}

/** The order that owns Razorpay order `rzpOrderId` (one of its attempts), else null. */
export async function findOrderByRazorpayOrderId(src: Src, rzpOrderId: string): Promise<Order | null> {
  if (typeof rzpOrderId !== 'string' || !rzpOrderId) return null
  const res = await payloadOf(src).find({
    collection: 'orders',
    where: { 'razorpay.attempts.orderId': { equals: rzpOrderId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    ...reqOf(src),
  })
  return (res.docs[0] as Order | undefined) ?? null
}

/** The order whose primary payment or payment log mentions `paymentId`, else null. */
export async function findOrderByPaymentId(src: Src, paymentId: string): Promise<Order | null> {
  if (typeof paymentId !== 'string' || !paymentId) return null
  const res = await payloadOf(src).find({
    collection: 'orders',
    where: {
      or: [
        { 'razorpay.paymentId': { equals: paymentId } },
        { 'razorpay.payments.paymentId': { equals: paymentId } },
        { 'refunds.paymentId': { equals: paymentId } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    ...reqOf(src),
  })
  return (res.docs[0] as Order | undefined) ?? null
}

/**
 * Money already arrived for this ONLINE order (confirmed, refunded, or a payment recorded / authorised).
 * /checkout/retry answers such an order with 409 ALREADY_PAID, and so does a checkout whose verified
 * supersede reference names it. COD orders never count.
 */
export const moneyArrived = (o: Order): boolean =>
  o.paymentMethod === 'online' &&
  (isConfirmed(o.status) || o.status === 'refunded' || Boolean(o.razorpay?.paymentId) || o.paymentStatus === 'authorized' || o.paymentStatus === 'captured')

/** Locks the order row, then re-reads it inside req's transaction. null when it no longer exists. */
export async function lockOrder(req: PayloadRequest, id: number | string): Promise<Order | null> {
  if (!(await lockRow(req, 'orders', id))) return null
  return findOrderById(req, id)
}

/** The guest token for an order (needs the hidden nonce: read with showHiddenFields). */
export function tokenFor(order: Pick<Order, 'id' | 'tokenNonce'>): string {
  if (!order.tokenNonce) throw new Error(`order ${order.id} has no token nonce`)
  return deriveOrderToken(order.id, order.tokenNonce)
}

export type OrderRef = { number: string; token: string; status: Order['status']; totalPaise: number }

/** `{ order: … }` part of the checkout / retry responses. */
export const orderRef = (order: Order, token = tokenFor(order)): OrderRef => ({
  number: order.number,
  token,
  status: order.status,
  totalPaise: order.totalPaise,
})
