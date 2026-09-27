import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import { getGateway } from '../../payments'
import { isGatewayError, type GatewayError } from '../../payments/types'
import { canRetryPayment, mergePaymentStatus } from '../shared/order-status.js'
import { inTransaction } from './db'
import { findOrderById, lockOrder, moneyArrived } from './orders'
import { razorpayGroup, saveOrder } from './orderWrite'
import { type Attempt, attemptReceipt } from './paymentInit'

/**
 * One Razorpay order per payment attempt (razorpay.md §13.32): receipt `<number>-a<n>`, notes
 * `{ wf_order: <number> }`, amount = the order's total. Created AFTER the order's transaction has committed
 * (never hold a DB transaction across an HTTP call). `createOrder` is idempotent per receipt, so racing
 * callers that computed the same `n` get the same Razorpay order, and the attempt is recorded once
 * (deduplicated by Razorpay order id under the order lock).
 *
 * The caller decided the order wants money BEFORE the gateway call, in another transaction; a payment
 * (webhook / verify / reconcile → markPaid), an admin cancel or a supersede can land during that call. So
 * the attempt is recorded only if, under the order lock, the order STILL wants money (wantsPayment);
 * otherwise nothing is recorded and the result says why ({ok:false, refused}). The Razorpay order just
 * created is then never shown to anyone (harmless: it expires unpaid, and a later attempt with the same
 * receipt gets the same one back). HUNT-CONC-R3-1.
 */

export type AttemptRefusal = 'paid' | 'not_payable'

export type AttemptResult =
  | { ok: true; order: Order; attempt: Attempt }
  | { ok: false; refused: AttemptRefusal; order: Order }
  | { ok: false; refused?: undefined; order: Order | null; error: GatewayError | Error }

/**
 * May a payment sheet be handed out for this order right now? Only for an unpaid ONLINE order waiting for
 * money (pending_payment / payment_failed) with no money arrived ('paid' otherwise 'not_payable'). Recording
 * a NEW attempt (`recording`) also needs attempts left (canRetryPayment); handing back one a racing caller
 * already recorded does not.
 */
export function attemptRefusal(order: Order, { recording = true }: { recording?: boolean } = {}): AttemptRefusal | null {
  if (moneyArrived(order)) return 'paid'
  const waiting = order.paymentMethod === 'online' && (order.status === 'pending_payment' || order.status === 'payment_failed')
  if (!waiting) return 'not_payable'
  if (recording && !canRetryPayment(order as Parameters<typeof canRetryPayment>[0])) return 'not_payable'
  return null
}

export async function createAttempt(payload: Payload, orderId: number | string): Promise<AttemptResult> {
  const order = await findOrderById(payload, orderId)
  if (!order) return { ok: false, order: null, error: new Error(`order ${orderId} not found`) }
  const n = (order.razorpay?.attempts?.length ?? 0) + 1
  const receipt = attemptReceipt(order.number, n)
  let rzp
  try {
    rzp = await getGateway().createOrder({ amountPaise: order.totalPaise, receipt, notes: { wf_order: order.number } })
  } catch (err) {
    const e = isGatewayError(err) ? err : (err as Error)
    const info = isGatewayError(err) ? { kind: err.kind, code: err.code, statusCode: err.statusCode, op: err.op } : { error: String(e?.message ?? e) }
    const log = isGatewayError(err) && err.kind === 'auth' ? 'error' : 'warn'
    payload.logger[log]({ msg: `${log === 'error' ? 'ALERT ' : ''}payment gateway createOrder failed`, order: order.number, receipt, ...info })
    return { ok: false, order, error: e }
  }

  type Saved = { order: Order; attempt: Attempt } | { order: Order; refused: AttemptRefusal }
  const saved = await inTransaction(payload, async (req): Promise<Saved | null> => {
    const cur = await lockOrder(req, orderId)
    if (!cur) return null
    const attempts = cur.razorpay?.attempts ?? []
    const existing = attempts.find((a) => a.orderId === rzp.id)
    // Paid, cancelled or superseded while the gateway call ran: hand out no payment sheet for it.
    const refused = attemptRefusal(cur, { recording: !existing })
    if (refused) return { order: cur, refused }
    if (existing) return { order: cur, attempt: existing }
    const attempt: Attempt = { orderId: rzp.id, receipt: rzp.receipt ?? receipt, amount: rzp.amount, status: 'created', createdAt: new Date().toISOString() }
    const next = await saveOrder(
      req,
      cur,
      {
        paymentStatus: mergePaymentStatus(cur.paymentStatus, 'created'),
        razorpay: razorpayGroup(cur, { attempts: [...attempts, attempt] }),
      },
      { source: 'checkout', note: `attempt ${attempt.receipt} ${rzp.id}` },
    )
    const stored = (next.razorpay?.attempts ?? []).find((a) => a.orderId === rzp.id) ?? attempt
    return { order: next, attempt: stored }
  })
  if (!saved) return { ok: false, order: null, error: new Error(`order ${orderId} vanished`) }
  if ('refused' in saved) {
    payload.logger.info({ msg: 'payment attempt not recorded: order no longer wants money', order: saved.order.number, receipt, razorpayOrderId: rzp.id, refused: saved.refused, status: saved.order.status })
    return { ok: false, refused: saved.refused, order: saved.order }
  }
  return { ok: true, ...saved }
}

/** The newest recorded attempt, or null. */
export const latestAttempt = (order: Pick<Order, 'razorpay'>): Attempt | null => {
  const list = order.razorpay?.attempts ?? []
  return list.length ? list[list.length - 1] : null
}
