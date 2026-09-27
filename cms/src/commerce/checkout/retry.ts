import type { Payload, PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

import { getGateway } from '../../payments'
import { getStoreSettings } from '../settings'
import { canRetryPayment, nextStatus } from '../shared/order-status.js'
import { createAttempt } from './attempts'
import { firstOrderKeys, recheckReleasedUse, rereserveRedemption } from './coupons'
import { inTransaction, lockKeys } from './db'
import { toOrderStatusDTO } from './dto'
import { findOrderForGuest, lockOrder, moneyArrived, orderRef, tokenFor } from './orders'
import { saveOrder } from './orderWrite'
import { buildPaymentInit } from './paymentInit'
import { markPaid } from './payments'
import { serverQuote } from './quote'
import { reserveLines, orderStockLines } from './stock'
import type { CheckoutFailure, CheckoutResult } from './checkout'

/**
 * POST /api/store/checkout/retry {number, token} (SPEC §6): a NEW Razorpay order for an unpaid online
 * order (receipt `<no>-a<n>`), because Razorpay says to open a fresh order after a closed/failed Checkout.
 *
 *   paid / money already authorised                        → 409 ALREADY_PAID {order: OrderStatusDTO}
 *   COD, cancelled, in review, refunded, 10 attempts used    → 409 NOT_RETRYABLE
 *   expired (stock released) → re-check and re-take what expiry gave back (retakeReleased), or
 *                              → 409 OUT_OF_STOCK | UNAVAILABLE | QTY_LIMIT {issues}, 422 COUPON_INVALID {reason}
 *   otherwise: reservation extended to now + reservationMinutes, status → pending_payment ('retry')
 *   gateway down                                              → 503 PAYMENTS_UNAVAILABLE {order}
 *   paid / cancelled while the new Razorpay order was created → 409 ALREADY_PAID / NOT_RETRYABLE (no sheet)
 * Before opening a new attempt the recent attempts are checked with the gateway: a payment the webhook
 * hasn't delivered yet ("I paid in my UPI app, then closed the window") is confirmed instead.
 * Switching an order to COD is not offered: a COD checkout for the same bag supersedes it (checkout.ts).
 */

const RECENT_ATTEMPTS_CHECKED = 3

async function findLandedPayment(payload: Payload, order: Order): Promise<boolean> {
  const attempts = (order.razorpay?.attempts ?? []).slice(-RECENT_ATTEMPTS_CHECKED)
  const gateway = getGateway()
  for (const a of attempts.reverse()) {
    let payments
    try {
      payments = await gateway.fetchOrderPayments(a.orderId)
    } catch {
      continue // unknown: carry on with the retry; a duplicate would be refunded automatically
    }
    for (const p of payments) {
      if (p.status !== 'authorized' && p.status !== 'captured') continue
      const r = await markPaid(payload, { orderId: order.id, payment: p, via: 'reconcile', note: `retry check ${p.status} ${p.id}` })
      if (r.outcome === 'paid' || r.outcome === 'already_paid') return true
    }
  }
  return false
}

/** Thrown inside the retry transaction to roll back what was already re-taken (stock) and answer `result`. */
class Refused extends Error {
  constructor(readonly result: CheckoutFailure) {
    super('retry refused')
  }
}

/**
 * An expired order (stock and coupon use given back) is revived only on the terms a new checkout would get
 * for what it gave back: every product must still be on sale (published, "Available for sale", within
 * maxPerOrder) with the units in stock, and its coupon use must still be free (usageLimit, perCustomerLimit,
 * firstOrderOnly). The snapshot price and discount are honoured (razorpay.md §13.10–11, §13.17). Otherwise
 * it throws Refused (409 OUT_OF_STOCK | UNAVAILABLE | QTY_LIMIT {issues}, or 422 COUPON_INVALID {reason})
 * and the order stays expired, so the customer re-orders at today's terms.
 */
async function retakeReleased(req: PayloadRequest, order: Order): Promise<void> {
  const items = (order.items ?? []).map((i) => ({ slug: i.slug, qty: i.qty }))
  const sale = (await serverQuote(req.payload, { items, method: order.requestedMethod })).quote
  if (sale.issues.length) throw new Refused({ status: 409, code: sale.issues[0].code, details: { issues: sale.issues } })

  const r = await reserveLines(req, orderStockLines(order))
  if (!r.ok) {
    const item = (order.items ?? []).find((i) => i.slug === r.failed.slug)
    const product = await req.payload.findByID({ collection: 'products', id: r.failed.productId, depth: 0, overrideAccess: true, disableErrors: true, req })
    const available = Math.max(0, Number((product as { stock?: number } | null)?.stock ?? 0))
    throw new Refused({
      status: 409,
      code: 'OUT_OF_STOCK',
      details: {
        issues: [{ slug: r.failed.slug, name: item?.name ?? r.failed.slug, code: 'OUT_OF_STOCK', requestedQty: r.failed.qty, available, suggestedQty: 0 }],
      },
    })
  }
  const problem = await recheckReleasedUse(req, order.id, { email: order.contact.email, phone: order.contact.phone })
  if (problem) throw new Refused({ status: 422, code: 'COUPON_INVALID', details: { reason: problem.reason } })
  await rereserveRedemption(req, order.id)
}

export async function retryPayment(payload: Payload, args: { number: unknown; token: unknown; now?: number }): Promise<CheckoutResult> {
  const now = args.now ?? Date.now()
  const found = await findOrderForGuest(payload, args.number, args.token)
  if (!found) return { status: 404, code: 'NOT_FOUND' }
  const token = tokenFor(found)
  const settings = await getStoreSettings(payload)
  const already = (o: Order): CheckoutFailure => ({
    status: 409,
    code: 'ALREADY_PAID',
    details: { order: toOrderStatusDTO(o, { shippingPromiseText: settings.public.shippingPromiseText }) },
  })
  // Money already arrived online (COD orders are never "paid" here: they get NOT_RETRYABLE below).
  const paidAlready = moneyArrived

  if (paidAlready(found)) return already(found)
  if (!canRetryPayment(found as Parameters<typeof canRetryPayment>[0])) return { status: 409, code: 'NOT_RETRYABLE' }

  if (await findLandedPayment(payload, found)) {
    const fresh = await findOrderForGuest(payload, args.number, args.token)
    return already(fresh ?? found)
  }

  let prep: CheckoutFailure | null
  try {
    prep = await inTransaction(payload, async (req): Promise<CheckoutFailure | null> => {
      // Re-taking a released first-order-only use counts the customer's other first-order claims, like a
      // checkout does: serialise with those checkouts on the SAME per-customer keys (checkout.ts), taken first
      // (advisory keys before row locks, db.ts), or a parallel checkout with another first-order code and
      // this retry each count the other as absent (HUNT-CONC-R3-2). Taken for any order with an offer: its
      // stock state is only known under the order lock, and the keys are per customer, so this costs nothing.
      if (found.coupon?.code) await lockKeys(req, firstOrderKeys(found.contact))
      const order = await lockOrder(req, found.id)
      if (!order) return { status: 404, code: 'NOT_FOUND' }
      if (paidAlready(order)) return already(order)
      if (!canRetryPayment(order as Parameters<typeof canRetryPayment>[0])) return { status: 409, code: 'NOT_RETRYABLE' }
      let stockState = order.stockState
      if (stockState === 'released') {
        await retakeReleased(req, order)
        stockState = 'reserved'
      }
      const next = nextStatus(order.status, 'retry')
      await saveOrder(
        req,
        order,
        {
          ...(next && next !== order.status ? { status: next } : {}),
          stockState,
          reservedUntil: new Date(now + settings.server.reservationMinutes * 60_000).toISOString(),
        },
        { source: 'customer', note: 'payment retry' },
      )
      return null
    })
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    prep = err.result
  }
  if (prep) return prep

  // Paid (a late UPI approval) or cancelled (admin, supersede) while the new Razorpay order was being
  // created: createAttempt re-checks under the order lock and records nothing (HUNT-CONC-R3-1).
  const a = await createAttempt(payload, found.id)
  if (!a.ok && a.refused === 'paid') return already(a.order)
  if (!a.ok && a.refused) return { status: 409, code: 'NOT_RETRYABLE' }
  if (!a.ok) return { status: 503, code: 'PAYMENTS_UNAVAILABLE', details: { order: orderRef(a.order ?? found, token) } }
  return {
    status: 200,
    body: { order: orderRef(a.order, token), payment: buildPaymentInit({ gateway: getGateway(), order: a.order, attempt: a.attempt, token }) },
  }
}
