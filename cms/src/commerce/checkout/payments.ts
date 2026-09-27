import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import type { GatewayPayment } from '../../payments/types'
import { isConfirmed, mergePaymentStatus, nextStatus } from '../shared/order-status.js'
import { consumeRedemption } from './coupons'
import { inTransaction } from './db'
import { applyEffects, type Effects, noEffects } from './effects'
import { lockOrder } from './orders'
import { appendReason, razorpayGroup, saveOrder, upsertPaymentLog, withAttemptStatus } from './orderWrite'
import { refundReceipt } from './paymentInit'
import { queueRefund } from './refunds'
import { orderStockLines, reserveLines } from './stock'

/**
 * markPaid — THE single idempotent "money arrived" transition (SPEC §6, razorpay.md §12), used by client
 * verify, the redirect callback, webhooks and the reconcile job. Under the order row lock:
 *
 *   1. the payment must belong to one of the order's Razorpay orders (attempts)          else not_ours
 *   2. it must be authorized or captured                                                 else not_paid
 *   3. amount === attempt amount === order total, currency INR                           else needs_review
 *      (never paid; alert log; no automatic refund — a human checks)                       → amount_mismatch
 *   4. already paid by THIS payment → merge authorized→captured, nothing else             → already_paid
 *   5. already paid by ANOTHER payment → queue a full refund of this one
 *      (receipt <no>-dup-<last6>), notice email                                          → duplicate
 *   6. nextStatus(status, 'paid'):
 *        needs_review (cancelled / COD / in review) → record it; a cancelled order's payment is refunded
 *                                                     automatically (<no>-cxl-…)         → review | refund_cancelled
 *        paid → stock: reserved → committed; released (expired) → re-reserve, or needs_review +
 *               automatic refund (<no>-oos-…) when it's gone                             → paid | refund_out_of_stock
 *               coupon redemption consumed + usedCount+1, paidAt/paidVia/paymentId,
 *               then (after commit) order.confirmed ONCE + confirmation email once
 * A payment arriving for a refunded order (nextStatus → null) is refunded automatically as well.
 */

export type PaidVia = 'client' | 'callback' | 'webhook' | 'reconcile'

export type MarkPaidOutcome =
  | 'paid'
  | 'already_paid'
  | 'duplicate'
  | 'review'
  | 'refund_cancelled'
  | 'refund_out_of_stock'
  | 'amount_mismatch'
  | 'not_ours'
  | 'not_paid'
  | 'missing'

export type MarkPaidResult = { outcome: MarkPaidOutcome; order: Order | null }

type PaymentLike = Pick<GatewayPayment, 'id' | 'order_id' | 'status' | 'amount' | 'currency' | 'method'> &
  Partial<Pick<GatewayPayment, 'error_code' | 'error_reason' | 'error_description' | 'captured'>>

const isMoney = (s: string) => s === 'authorized' || s === 'captured'

export async function markPaid(
  payload: Payload,
  args: { orderId: number | string; payment: PaymentLike; via: PaidVia; note?: string },
): Promise<MarkPaidResult> {
  const { orderId, payment, via } = args
  const effects: Effects = noEffects()
  const note = args.note ?? `${via} ${payment.status} ${payment.id}`

  const result = await inTransaction(payload, async (req): Promise<MarkPaidResult> => {
    const order = await lockOrder(req, orderId)
    if (!order) return { outcome: 'missing', order: null }
    const attempt = (order.razorpay?.attempts ?? []).find((a) => a.orderId === payment.order_id)
    if (!attempt) return { outcome: 'not_ours', order }
    if (!isMoney(payment.status)) return { outcome: 'not_paid', order }

    const incoming = payment.status === 'captured' ? 'captured' : 'authorized'
    const { log, changed: logChanged } = upsertPaymentLog(order, payment, via)
    const primary = order.razorpay?.paymentId ?? null
    const now = new Date().toISOString()

    // 3. Amount / currency must be exactly what we asked for.
    const amountOk =
      payment.amount === attempt.amount && payment.amount === order.totalPaise && String(payment.currency).toUpperCase() === 'INR'
    if (!amountOk) {
      // A redelivery of the same mismatching payment: already flagged.
      if (!logChanged && order.reviewReason?.includes(payment.id)) return { outcome: 'amount_mismatch', order }
      const data: Partial<Order> = { razorpay: razorpayGroup(order, { payments: log }) }
      if (!primary) {
        const next = nextStatus(order.status, 'review')
        if (next) data.status = next
      }
      data.reviewReason = appendReason(
        order.reviewReason,
        `Amount mismatch: payment ${payment.id} is ${payment.amount} ${payment.currency}, order ${order.number} expects ${order.totalPaise} INR. Not marked paid — check it and refund by hand.`,
      )
      payload.logger.error({ msg: 'ALERT payment amount/currency mismatch', order: order.number, paymentId: payment.id, amount: payment.amount, currency: payment.currency, expected: order.totalPaise })
      const saved = await saveOrder(req, order, data, { source: via, note: `amount mismatch ${payment.id}` })
      return { outcome: 'amount_mismatch', order: saved }
    }

    // 4. Same payment again (verify + callback + webhooks + reconcile): only capture news.
    if (primary === payment.id) {
      const paymentStatus = mergePaymentStatus(order.paymentStatus, incoming)
      const capturedAt = incoming === 'captured' ? (order.razorpay?.capturedAt ?? now) : (order.razorpay?.capturedAt ?? null)
      const changed = paymentStatus !== order.paymentStatus || capturedAt !== (order.razorpay?.capturedAt ?? null)
      if (!changed && !logChanged) return { outcome: 'already_paid', order }
      const saved = await saveOrder(
        req,
        order,
        {
          paymentStatus,
          razorpay: razorpayGroup(order, { capturedAt, payments: log, attempts: withAttemptStatus(order, payment.order_id, 'paid') }),
        },
        { source: via, note },
      )
      return { outcome: 'already_paid', order: saved }
    }

    // 5. Paid twice (two tabs, a late authorisation on an old attempt…): refund the newcomer.
    if (primary) {
      const q = queueRefund(order, {
        paymentId: payment.id,
        amountPaise: payment.amount,
        receipt: refundReceipt(order.number, 'dup', payment.id),
        reason: 'duplicate_payment',
      })
      if (!q.added && !logChanged) return { outcome: 'duplicate', order }
      if (q.added) effects.refunds = true
      payload.logger.warn({ msg: 'duplicate payment: refunding automatically', order: order.number, paymentId: payment.id, primary })
      const saved = await saveOrder(
        req,
        order,
        { refunds: q.refunds, razorpay: razorpayGroup(order, { payments: log }) },
        { source: via, note: `duplicate payment ${payment.id}` },
      )
      return { outcome: 'duplicate', order: saved }
    }

    const prev = order.status
    const next = nextStatus(prev, 'paid')
    const paidFields = {
      paymentStatus: mergePaymentStatus(order.paymentStatus, incoming),
      razorpay: razorpayGroup(order, {
        paymentId: payment.id,
        method: payment.method ?? null,
        capturedAt: incoming === 'captured' ? now : null,
        payments: log,
        attempts: withAttemptStatus(order, payment.order_id, 'paid'),
      }),
    } satisfies Partial<Order>

    // 6a. A payment the order can't take (cancelled, COD, in review, already refunded).
    if (next !== 'paid') {
      const refundIt = prev === 'cancelled' || next === null
      const data: Partial<Order> = { ...paidFields }
      if (next && next !== prev) data.status = next
      if (refundIt) {
        const q = queueRefund(order, {
          paymentId: payment.id,
          amountPaise: payment.amount,
          receipt: refundReceipt(order.number, 'cxl', payment.id),
          reason: 'order_cancelled',
        })
        data.refunds = q.refunds
        if (q.added) effects.refunds = true
        data.reviewReason = appendReason(order.reviewReason, `Payment ${payment.id} arrived while the order was ${prev} — refunding it automatically.`)
      } else {
        data.reviewReason = appendReason(order.reviewReason, `Payment ${payment.id} arrived while the order was ${prev} — confirm the order (resolve to paid) or refund it.`)
      }
      payload.logger.warn({ msg: 'payment for an order that cannot take it', order: order.number, status: prev, paymentId: payment.id })
      const saved = await saveOrder(req, order, data, { source: via, note: `payment ${payment.id} while ${prev}` })
      return { outcome: refundIt ? 'refund_cancelled' : 'review', order: saved }
    }

    // 6b. Paid. Stock: keep the reservation, or take it again after expiry (late authorisation).
    let late = prev === 'expired'
    if (order.stockState === 'released') {
      const r = await reserveLines(req, orderStockLines(order))
      if (!r.ok) {
        const q = queueRefund(order, {
          paymentId: payment.id,
          amountPaise: payment.amount,
          receipt: refundReceipt(order.number, 'oos', payment.id),
          reason: 'out_of_stock',
        })
        if (q.added) effects.refunds = true
        payload.logger.error({ msg: 'ALERT late payment but stock is gone: refunding', order: order.number, paymentId: payment.id, slug: r.failed.slug })
        const saved = await saveOrder(
          req,
          order,
          {
            ...paidFields,
            status: nextStatus(prev, 'review') ?? 'needs_review',
            refunds: q.refunds,
            reviewReason: appendReason(
              order.reviewReason,
              `Late payment ${payment.id} after the reservation was released, and ${r.failed.slug} is out of stock — refunding automatically.`,
            ),
          },
          { source: via, note: `late payment, out of stock ${payment.id}` },
        )
        return { outcome: 'refund_out_of_stock', order: saved }
      }
      late = true
    }
    await consumeRedemption(req, order.id)
    const saved = await saveOrder(
      req,
      order,
      { ...paidFields, status: 'paid', paidAt: now, paidVia: via, stockState: 'committed' },
      { source: via, note },
    )
    effects.events.push({ type: 'order.confirmed', previousStatus: prev, source: via })
    effects.confirmation = { late }
    return { outcome: 'paid', order: saved }
  })

  if (result.order) await applyEffects(payload, result.order.id, effects, `markPaid ${result.outcome}`)
  return result
}

export type FailureOutcome = 'recorded' | 'duplicate' | 'ignored' | 'not_ours' | 'missing'

/**
 * payment.failed (webhook), a redirect-mode error POST (after checking the payment with the gateway), or
 * a failed payment seen by reconcile: log the attempt, paymentStatus → failed (never over captured),
 * pending_payment → payment_failed. Never terminal: a late authorisation of the same payment still goes
 * through markPaid. Emits order.payment_failed once per failed payment id while the order is unpaid.
 */
export async function recordPaymentFailure(
  payload: Payload,
  args: { orderId: number | string; payment: PaymentLike; via: PaidVia },
): Promise<{ outcome: FailureOutcome; order: Order | null }> {
  const { orderId, payment, via } = args
  const effects = noEffects()
  const result = await inTransaction(payload, async (req) => {
    const order = await lockOrder(req, orderId)
    if (!order) return { outcome: 'missing' as const, order: null }
    if (!(order.razorpay?.attempts ?? []).some((a) => a.orderId === payment.order_id)) return { outcome: 'not_ours' as const, order }
    if (payment.status !== 'failed') return { outcome: 'ignored' as const, order }
    const { log, isNew, changed } = upsertPaymentLog(order, payment, via)
    if (!changed) return { outcome: 'duplicate' as const, order }
    const data: Partial<Order> = {
      paymentStatus: mergePaymentStatus(order.paymentStatus, 'failed'),
      razorpay: razorpayGroup(order, { payments: log, attempts: withAttemptStatus(order, payment.order_id, 'attempted') }),
    }
    const next = nextStatus(order.status, 'payment_failed')
    if (next && next !== order.status) data.status = next
    const saved = await saveOrder(req, order, data, {
      source: via,
      note: `payment failed ${payment.id}${payment.error_reason ? ` (${payment.error_reason})` : ''}`,
    })
    const waiting = order.status === 'pending_payment' || order.status === 'payment_failed'
    if (isNew && waiting && !isConfirmed(order.status) && !order.razorpay?.paymentId) {
      effects.events.push({ type: 'order.payment_failed', previousStatus: order.status, source: via })
    }
    return { outcome: 'recorded' as const, order: saved }
  })
  if (result.order) await applyEffects(payload, result.order.id, effects, 'payment failure')
  return result
}
