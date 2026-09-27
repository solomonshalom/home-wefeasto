import type { Payload, Where } from 'payload'

import type { Order } from '@/payload-types'

import { sendOrderConfirmation } from '../../email/orders/send'
import { getGateway } from '../../payments'
import type { GatewayPayment } from '../../payments/types'
import { isGatewayError } from '../../payments/types'
import { emitOrderEvent } from '../events'
import { isRetryableTxError, newReq } from './db'
import { expireOrder } from './expire'
import { markPaid, recordPaymentFailure } from './payments'
import { issueQueuedRefunds } from './refunds'

/**
 * reconcilePendingOrders (razorpay.md §12 cron, §13.33/44/53) — safe to run any time, any number of times:
 *
 *   A. unpaid online orders (pending_payment / payment_failed) that are past `reservedUntil`, or older than
 *      10 minutes and not checked in the last 4: ask the gateway for the payments of EVERY attempt;
 *      authorized/captured → markPaid(via 'reconcile') (further ones are duplicates → refunded); failed
 *      ones are logged. Nothing found and past reservedUntil → expireOrder (stock + coupon released).
 *      If the gateway can't be asked, the order is left alone (never expired blind).
 *   B. expired orders from the last 5 days with Razorpay attempts, at most hourly each: late
 *      authorisations whose webhooks never arrived → markPaid (re-reserve, or needs_review + refund).
 *   C. confirmed orders (paid / COD) without `confirmationSentAt`, older than 2 minutes (the normal send had
 *      its chance): re-send the confirmation (confirm:<no> keeps it to one) and re-emit order.confirmed
 *      (handlers are idempotent).
 *   D. queued automatic refunds → issueQueuedRefunds.
 * Bounded by `limit` per section and a wall-clock budget, so one cron call stays short.
 */

export type ReconcileSummary = {
  checked: number
  paid: number
  expired: number
  gatewayErrors: number
  lateChecked: number
  latePaid: number
  confirmationsRetried: number
  refundOrders: number
  refundsIssued: number
  budgetExhausted: boolean
}

export type ReconcileOptions = {
  now?: number
  limit?: number
  budgetMs?: number
  /** Only look at these orders (admin "reconcile now" for one order, tests). */
  only?: (number | string)[]
  /**
   * Skip the age/throttle filters (10-minute grace, 4-minute and hourly re-check limits, the 2-minute
   * confirmation grace) — for an admin's explicit "reconcile now". Never expires before reservedUntil.
   */
  force?: boolean
}

const MIN = 60_000

async function find(payload: Payload, where: Where, limit: number, only: ReconcileOptions['only'], sort = 'createdAt'): Promise<Order[]> {
  const scoped: Where = only ? { and: [where, { id: { in: only.length ? only : [-1] } }] } : where
  const res = await payload.find({ collection: 'orders', where: scoped, limit, sort, depth: 0, overrideAccess: true, showHiddenFields: true })
  return res.docs as Order[]
}

/**
 * Bookkeeping only (the throttle for the next run). It writes the order row outside any transaction, so it
 * can meet an admin edit or a checkout transaction on that row; a deadlock or serialization failure is retried
 * once and then logged, never allowed to abort the rest of the batch (the next run simply checks again).
 * Other errors still propagate.
 */
async function stampReconciled(payload: Payload, id: number, now: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await payload.db.updateOne({ collection: 'orders', id, data: { reconciledAt: new Date(now).toISOString() }, returning: false })
      return
    } catch (err) {
      if (!isRetryableTxError(err)) throw err
      if (attempt === 0) continue
      payload.logger.warn({ msg: 'reconcile: could not stamp reconciledAt (lock conflict), next run re-checks', orderId: id })
      return
    }
  }
}

/** Every payment Razorpay has for the order's attempts; null when the gateway couldn't be asked. */
async function paymentsFor(payload: Payload, order: Order): Promise<GatewayPayment[] | null> {
  const all: GatewayPayment[] = []
  for (const a of order.razorpay?.attempts ?? []) {
    try {
      all.push(...(await getGateway().fetchOrderPayments(a.orderId)))
    } catch (err) {
      // Razorpay doesn't know this order (e.g. keys switched between test and live): nothing was paid on it.
      if (isGatewayError(err) && err.kind === 'not_found') continue
      payload.logger.warn({ msg: 'reconcile: fetchOrderPayments failed', order: order.number, rzpOrderId: a.orderId, ...(isGatewayError(err) ? { kind: err.kind, code: err.code } : {}) })
      return null
    }
  }
  // Oldest first, so the first payment that landed becomes the order's payment and later ones duplicates.
  return all.sort((x, y) => x.created_at - y.created_at)
}

/** Applies what the gateway knows. Returns true when the order ended up paid (or was already). */
async function settle(payload: Payload, order: Order, payments: GatewayPayment[]): Promise<boolean> {
  let paid = false
  for (const p of payments) {
    if (p.status === 'authorized' || p.status === 'captured') {
      const r = await markPaid(payload, { orderId: order.id, payment: p, via: 'reconcile', note: `reconcile ${p.status} ${p.id}` })
      if (r.outcome === 'paid' || r.outcome === 'already_paid' || r.outcome === 'duplicate') paid = true
    } else if (p.status === 'failed') {
      await recordPaymentFailure(payload, { orderId: order.id, payment: p, via: 'reconcile' })
    }
  }
  return paid
}

export async function reconcilePendingOrders(payload: Payload, opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 25
  const deadline = Date.now() + (opts.budgetMs ?? 20_000)
  const out: ReconcileSummary = {
    checked: 0,
    paid: 0,
    expired: 0,
    gatewayErrors: 0,
    lateChecked: 0,
    latePaid: 0,
    confirmationsRetried: 0,
    refundOrders: 0,
    refundsIssued: 0,
    budgetExhausted: false,
  }
  const iso = (ms: number) => new Date(ms).toISOString()
  const overBudget = () => {
    if (Date.now() > deadline) out.budgetExhausted = true
    return out.budgetExhausted
  }

  // A. Unpaid online orders.
  const pending = await find(
    payload,
    {
      and: [
        { status: { in: ['pending_payment', 'payment_failed'] } },
        { paymentMethod: { equals: 'online' } },
        ...(opts.force
          ? []
          : [
              {
                or: [
                  { reservedUntil: { less_than: iso(now) } },
                  {
                    and: [
                      { createdAt: { less_than: iso(now - 10 * MIN) } },
                      { or: [{ reconciledAt: { exists: false } }, { reconciledAt: { less_than: iso(now - 4 * MIN) } }] },
                    ],
                  },
                ],
              } satisfies Where,
            ]),
      ],
    },
    limit,
    opts.only,
    'reservedUntil',
  )
  for (const order of pending) {
    if (overBudget()) break
    out.checked += 1
    const payments = order.razorpay?.attempts?.length ? await paymentsFor(payload, order) : []
    if (payments === null) {
      out.gatewayErrors += 1
      continue
    }
    if (await settle(payload, order, payments)) {
      out.paid += 1
    } else if (order.reservedUntil && Date.parse(order.reservedUntil) <= now) {
      const r = await expireOrder(payload, order.id, { now, source: 'reconcile' })
      if (r.outcome === 'expired') out.expired += 1
    }
    await stampReconciled(payload, order.id, now)
  }

  // B. Late authorisations on expired orders.
  if (!overBudget()) {
    const expired = await find(
      payload,
      {
        and: [
          { status: { equals: 'expired' } },
          { 'razorpay.attempts.orderId': { exists: true } },
          { createdAt: { greater_than: iso(now - 5 * 24 * 60 * MIN) } },
          ...(opts.force ? [] : [{ or: [{ reconciledAt: { exists: false } }, { reconciledAt: { less_than: iso(now - 60 * MIN) } }] } satisfies Where]),
        ],
      },
      Math.min(limit, 10),
      opts.only,
    )
    for (const order of expired) {
      if (overBudget()) break
      out.lateChecked += 1
      const payments = await paymentsFor(payload, order)
      if (payments === null) {
        out.gatewayErrors += 1
        continue
      }
      if (await settle(payload, order, payments)) out.latePaid += 1
      await stampReconciled(payload, order.id, now)
    }
  }

  // C. Confirmation emails that never went out.
  if (!overBudget()) {
    const unsent = await find(
      payload,
      {
        and: [
          { status: { in: ['paid', 'cod_pending', 'cod_confirmed', 'partially_refunded'] } },
          { confirmationSentAt: { exists: false } },
          ...(opts.force ? [] : [{ createdAt: { less_than: iso(now - 2 * MIN) } } satisfies Where]),
          { createdAt: { greater_than: iso(now - 7 * 24 * 60 * MIN) } },
        ],
      },
      limit,
      opts.only,
    )
    for (const order of unsent) {
      if (overBudget()) break
      const late = (order.statusHistory ?? []).some((h) => h.field === 'status' && h.from === 'expired' && h.to === 'paid')
      const result = await sendOrderConfirmation(payload, order.id, { late })
      if (result === 'sent') {
        out.confirmationsRetried += 1
        await emitOrderEvent(await newReq(payload), { type: 'order.confirmed', order, previousStatus: null, source: 'reconcile' })
      }
    }
  }

  // D. Automatic refunds that are still queued.
  if (!overBudget()) {
    const queued = await find(payload, { 'refunds.status': { equals: 'queued' } }, limit, opts.only)
    for (const order of queued) {
      if (overBudget()) break
      out.refundOrders += 1
      out.refundsIssued += await issueQueuedRefunds(payload, order.id)
    }
  }
  return out
}
