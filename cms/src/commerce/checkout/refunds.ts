import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import { sendRefundNotice } from '../../email/orders/send'
import { getGateway } from '../../payments'
import { isGatewayError, type GatewayPayment, type GatewayRefund } from '../../payments/types'
import { emitOrderEvent } from '../events'
import { runEffects } from './background'
import { mergePaymentStatus, nextStatus } from '../shared/order-status.js'
import { AUTOMATIC_REFUND_REASONS } from './adminEdits'
import { inTransaction, newReq } from './db'
import { findOrderById, findOrderByPaymentId, findOrderByNumber, lockOrder } from './orders'
import { appendReason, type RefundEntry, saveOrder } from './orderWrite'
import { holdsUnshippedStock, orderStockLines, releaseLines } from './stock'

/**
 * Refunds (razorpay.md §8, §13.55–59).
 *
 * Automatic refunds are QUEUED inside the transaction that decides them (status 'queued', a receipt as the
 * idempotency key) and issued with the gateway after commit by issueQueuedRefunds(). A crash or a gateway
 * error leaves them queued; the reconcile job retries them (the receipt makes retries safe). Razorpay's
 * refund.* webhooks (and immediate 'processed' answers) update the entry and, when the order's own payment
 * is refunded, move the order to partially_refunded / refunded via nextStatus(), with two rules on top:
 *   - a hold (needs_review: a chargeback, or a human's) is only released by a human: a PARTIAL refund leaves the
 *     order in needs_review (paymentStatus still says partially_refunded); a full refund ends it (refunded);
 *   - an order refunded in full before it shipped gives its stock back, like a cancel (it is terminal);
 *   - a refund that FAILS after it was counted (pending: Razorpay's amount_refunded includes it) withdraws it: when
 *     nothing of the payment is refunded any more, the order's money state is recomputed (withdrawnRefundState).
 */

export type RefundKind = 'duplicate_payment' | 'out_of_stock' | 'order_cancelled'

/** Refund list with a queued full refund of `paymentId` (no-op when one already exists for that payment + receipt). */
export function queueRefund(
  order: Pick<Order, 'refunds'>,
  r: { paymentId: string; amountPaise: number; receipt: string; reason: RefundKind },
): { refunds: RefundEntry[]; added: boolean } {
  const refunds = [...(order.refunds ?? [])]
  if (refunds.some((x) => x.paymentId === r.paymentId && (x.receipt === r.receipt || x.status !== 'failed'))) {
    return { refunds, added: false }
  }
  refunds.push({
    paymentId: r.paymentId,
    amountPaise: r.amountPaise,
    receipt: r.receipt,
    reason: r.reason,
    status: 'queued',
    attempts: 0,
    createdAt: new Date().toISOString(),
  })
  return { refunds, added: true }
}

const MAX_REFUND_ATTEMPTS = 12
/** Razorpay auto-refunds a payment left authorised for 3–5 days; past this a not_captured refund needs a human. */
const NOT_CAPTURED_WAIT_MS = 7 * 86_400_000

export type RefundUpdate = {
  refundId: string
  paymentId: string
  amountPaise: number
  status: 'pending' | 'processed' | 'failed'
  receipt?: string | null
  reason?: string | null
  createdAt?: string | null
  error?: string | null
}

const RANK: Record<string, number> = { queued: 0, pending: 1, failed: 2, processed: 3 }
const rank = (s: string | null | undefined) => RANK[s ?? ''] ?? -1

/**
 * The rows an update belongs to (-1 = none):
 *   byId  the row already carrying this refundId;
 *   ours  our own automatic refund not tied to a refundId yet: by the receipt we sent; or, for a refund WITHOUT a
 *         receipt (Razorpay refunding a late authorisation on an already-paid Razorpay order itself, or a full
 *         Dashboard refund), our QUEUED full refund of the same payment that it covers. Any full refund of that
 *         payment settles ours: filing it as a separate row would leave ours queued for good (reconcile would re-send
 *         it every run and it would hold a slot of the queued-refund sweep). A failed one settles nothing.
 */
export function matchRefundRows(refunds: RefundEntry[], u: RefundUpdate): { byId: number; ours: number } {
  const byId = refunds.findIndex((x) => x.refundId && x.refundId === u.refundId)
  const free = (x: RefundEntry) => !x.refundId && x.paymentId === u.paymentId
  let ours = u.receipt ? refunds.findIndex((x) => free(x) && x.receipt === u.receipt) : -1
  if (ours === -1 && !u.receipt && u.status !== 'failed') {
    ours = refunds.findIndex((x) => free(x) && x.status === 'queued' && AUTOMATIC_REFUND_REASONS.has(x.reason ?? '') && (x.amountPaise ?? 0) <= u.amountPaise)
  }
  return { byId, ours }
}

/**
 * The order's money state once NOTHING of its own payment is refunded (any more) and no refund of it is pending or
 * queued: a refund counted while pending (Razorpay's payment.amount_refunded includes it) that then FAILED at
 * Razorpay gave nothing back (verify pass 2). Payment status goes back to captured (authorized if the payment was
 * never captured), bypassing mergePaymentStatus: its ranks are monotonic so that a LATE report never downgrades it,
 * but a failed refund is not late news, it withdraws the earlier one. A partly refunded order goes back to paid (the
 * machine's refund_failed event). A hold (needs_review) stays for a human (paymentStatus is corrected under it, so
 * resolving it to paid is consistent), and a refunded order is terminal (its unshipped stock was given back): it
 * stays refunded, and the refund's ALERT in reviewReason tells a human to pay the customer back. Returns only the
 * fields that change.
 */
export function withdrawnRefundState(
  order: Pick<Order, 'status' | 'paymentStatus'> & { razorpay?: { capturedAt?: string | null } | null },
): Pick<Partial<Order>, 'status' | 'paymentStatus'> {
  if (order.status === 'refunded') return {}
  const out: Pick<Partial<Order>, 'status' | 'paymentStatus'> = {}
  if (order.paymentStatus === 'partially_refunded' || order.paymentStatus === 'refunded') {
    out.paymentStatus = order.razorpay?.capturedAt ? 'captured' : 'authorized'
  }
  const back = nextStatus(order.status, 'refund_failed')
  if (back && back !== order.status) out.status = back
  return out
}

/**
 * Records a refund's state on its order (see matchRefundRows; a new row for refunds made elsewhere, e.g. the
 * Razorpay Dashboard) and moves the order status when its primary payment is refunded. When the refund was already
 * filed as a separate row before it could be tied to our queued one, the two rows are merged into ours. When a
 * failed refund leaves nothing of the primary payment refunded, the order's money state is recomputed instead
 * (withdrawnRefundState). Emits order.refunded after commit when a refund moved the status, and the refund notice
 * when a webhook settled one of our automatic refunds (issueQueuedRefunds sends its own). Idempotent.
 */
export async function applyRefundUpdate(
  payload: Payload,
  orderId: number | string,
  u: RefundUpdate,
  opts: { source: string; payment?: Pick<GatewayPayment, 'id' | 'amount' | 'amount_refunded'> | null } = { source: 'webhook' },
): Promise<{ outcome: 'recorded' | 'unchanged' | 'missing'; statusChanged: boolean }> {
  let previous: Order['status'] | null = null
  let refundMoved = false
  let notice: { refundId: string; amountPaise: number; reason: string } | null = null
  const res = await inTransaction(payload, async (req) => {
    // inTransaction may run this again (a retryable conflict): nothing from a rolled-back attempt carries over.
    previous = null
    refundMoved = false
    notice = null
    const order = await lockOrder(req, orderId)
    if (!order) return { outcome: 'missing' as const, statusChanged: false }
    const refunds = [...(order.refunds ?? [])]
    const { byId, ours } = matchRefundRows(refunds, u)
    const now = new Date().toISOString()
    let changed = false
    let settled: RefundEntry | null = null
    if (byId !== -1 && ours !== -1 && byId !== ours) {
      const other = refunds[byId]
      const cur = refunds[ours]
      const status = rank(other.status) >= rank(u.status) ? (other.status as RefundUpdate['status']) : u.status
      settled = {
        ...cur,
        refundId: u.refundId,
        amountPaise: u.amountPaise || other.amountPaise || cur.amountPaise,
        status,
        processedAt: status === 'processed' ? (other.processedAt ?? now) : null,
        error: status === 'failed' ? (other.error ?? u.error ?? 'refund failed') : null,
      }
      refunds[ours] = settled
      refunds.splice(byId, 1)
      changed = true
    } else if (byId === -1 && ours === -1) {
      refunds.push({
        refundId: u.refundId,
        paymentId: u.paymentId,
        amountPaise: u.amountPaise,
        status: u.status,
        receipt: u.receipt ?? null,
        reason: u.reason ?? 'external',
        createdAt: u.createdAt ?? now,
        processedAt: u.status === 'processed' ? now : null,
        error: u.error ?? null,
      })
      changed = true
    } else {
      const i = byId !== -1 ? byId : ours
      const cur = refunds[i]
      const keep = rank(cur.status) > rank(u.status) && cur.refundId
      if (!keep && (cur.status !== u.status || cur.refundId !== u.refundId)) {
        refunds[i] = {
          ...cur,
          refundId: u.refundId,
          amountPaise: u.amountPaise || cur.amountPaise,
          status: u.status,
          processedAt: u.status === 'processed' ? (cur.processedAt ?? now) : cur.processedAt,
          error: u.status === 'failed' ? (u.error ?? 'refund failed') : null,
        }
        if (!cur.refundId) settled = refunds[i]
        changed = true
      }
    }
    if (!changed) return { outcome: 'unchanged' as const, statusChanged: false }
    if (settled && settled.status !== 'failed' && AUTOMATIC_REFUND_REASONS.has(settled.reason ?? '')) {
      notice = { refundId: u.refundId, amountPaise: settled.amountPaise, reason: String(settled.reason) }
    }

    const data: Partial<Order> = { refunds }
    const primary = order.razorpay?.paymentId
    let withdrawn = false
    if (primary && u.paymentId === primary) {
      const ofPrimary = refunds.filter((x) => x.paymentId === primary)
      const fromEntries = ofPrimary.filter((x) => x.status === 'processed').reduce((a, x) => a + (x.amountPaise ?? 0), 0)
      const fromPayment = opts.payment && opts.payment.id === primary ? opts.payment.amount_refunded ?? 0 : 0
      const refunded = Math.max(fromEntries, fromPayment)
      if (refunded === 0) {
        // Nothing of it refunded any more (a refund counted while pending failed): unless another refund of it is
        // still on its way, its money state comes from what IS refunded, i.e. nothing.
        const underway = ofPrimary.some((x) => x.status === 'pending' || x.status === 'queued')
        const back = underway ? {} : withdrawnRefundState(order)
        if (back.paymentStatus && back.paymentStatus !== order.paymentStatus) data.paymentStatus = back.paymentStatus
        if (back.status && back.status !== order.status) {
          data.status = back.status
          withdrawn = true
        }
      } else {
        const full = refunded >= order.totalPaise
        // Only a human releases a hold (needs_review: a chargeback — "hold fulfilment" — or an admin's): a partial
        // refund settling later must not make the order packable (needs_review → partially_refunded is theirs).
        const held = order.status === 'needs_review' && !full
        const next = held ? null : nextStatus(order.status, full ? 'refund' : 'partial_refund')
        if (next && next !== order.status) {
          previous = order.status
          data.status = next
        }
        data.paymentStatus = mergePaymentStatus(order.paymentStatus, full ? 'refunded' : 'partially_refunded')
      }
    }
    // Refunded in full before it shipped: terminal, never packed or shipped, so its stock goes back (like a cancel).
    let restocked = false
    if ((data.status ?? order.status) === 'refunded' && holdsUnshippedStock(order)) {
      await releaseLines(req, orderStockLines(order))
      data.stockState = 'released'
      restocked = true
    }
    if (u.status === 'failed') {
      data.reviewReason = appendReason(
        order.reviewReason,
        `Refund ${u.refundId} of payment ${u.paymentId} FAILED at Razorpay — pay the customer back manually.`,
      )
      payload.logger.error({ msg: 'ALERT refund failed', order: order.number, refundId: u.refundId, paymentId: u.paymentId })
    }
    const note = `refund ${u.refundId} ${u.status}${restocked ? ' · unshipped stock given back' : ''}${withdrawn ? ' · nothing refunded: back to paid' : ''}`
    await saveOrder(req, order, data, { source: opts.source, note })
    // A withdrawn refund is not a refund: no order.refunded for it.
    refundMoved = data.status !== undefined && !withdrawn
    return { outcome: 'recorded' as const, statusChanged: data.status !== undefined }
  })
  if (refundMoved) {
    await runEffects(payload, `order.refunded (order ${orderId})`, async () => {
      const fresh = await findOrderById(payload, orderId)
      if (fresh) await emitOrderEvent(await newReq(payload), { type: 'order.refunded', order: fresh, previousStatus: previous, source: opts.source })
    })
  }
  const n = notice as { refundId: string; amountPaise: number; reason: string } | null
  if (n && opts.source !== 'refund') {
    await runEffects(payload, `refund notice (order ${orderId})`, () => sendRefundNotice(payload, orderId, n))
  }
  return res
}

/** Normalises a gateway refund entity into a RefundUpdate. */
export const refundUpdateFrom = (r: GatewayRefund, extra: { reason?: string | null } = {}): RefundUpdate => ({
  refundId: r.id,
  paymentId: r.payment_id,
  amountPaise: r.amount,
  status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending',
  receipt: r.receipt,
  reason: extra.reason ?? (typeof r.notes?.reason === 'string' ? r.notes.reason : null),
  createdAt: Number.isFinite(r.created_at) ? new Date(r.created_at * 1000).toISOString() : null,
})

/**
 * Sends every queued refund of the order to the gateway (idempotent per receipt), records the result and
 * emails the customer (refund:<refundId>, once). Gateway errors keep the refund queued for the reconcile job
 * (after MAX_REFUND_ATTEMPTS it is marked failed and flagged for a human). Never throws.
 */
export async function issueQueuedRefunds(payload: Payload, orderId: number | string): Promise<number> {
  const order = await findOrderById(payload, orderId)
  const queued = (order?.refunds ?? []).filter((r) => r.status === 'queued' && r.paymentId && r.receipt)
  let issued = 0
  for (const entry of queued) {
    const gateway = getGateway()
    try {
      let refund: GatewayRefund
      try {
        refund = await gateway.refund(entry.paymentId as string, {
          receipt: entry.receipt as string,
          notes: { wf_order: order!.number, reason: String(entry.reason ?? 'refund') },
        })
      } catch (err) {
        // Fully refunded already (e.g. Razorpay auto-refunded a late authorisation): find that refund — ours by
        // receipt, else one that covers this refund — and settle this entry with it (applyRefundUpdate merges it
        // with the row a refund webhook may already have filed for it).
        if (isGatewayError(err) && err.condition === 'already_refunded') {
          const list = await gateway.fetchRefunds(entry.paymentId as string)
          const existing =
            list.find((r) => r.receipt === entry.receipt) ??
            list.find((r) => r.status !== 'failed' && r.amount >= (entry.amountPaise ?? 0)) ??
            list.find((r) => r.status !== 'failed') ??
            list[0]
          if (!existing) throw err
          refund = existing
        } else throw err
      }
      await applyRefundUpdate(payload, orderId, { ...refundUpdateFrom(refund, { reason: entry.reason }), receipt: entry.receipt }, { source: 'refund' })
      issued += 1
      if (refund.status !== 'failed') {
        await sendRefundNotice(payload, orderId, { refundId: refund.id, amountPaise: refund.amount, reason: String(entry.reason ?? '') })
      }
    } catch (err) {
      const detail = isGatewayError(err) ? `${err.kind}:${err.code}${err.condition ? `:${err.condition}` : ''}` : String((err as Error)?.message ?? err)
      payload.logger.warn({ msg: 'refund not issued yet (will retry)', order: order?.number, paymentId: entry.paymentId, detail })
      await inTransaction(payload, async (req) => {
        const cur = await lockOrder(req, orderId)
        if (!cur) return
        let alert = false
        const refunds = (cur.refunds ?? []).map((x) => {
          if (x.id !== entry.id || x.status !== 'queued') return x
          const attempts = (x.attempts ?? 0) + 1
          // An authorised-only payment can't be refunded until it is captured (or Razorpay auto-refunds it within
          // days): keep waiting, but not forever.
          const notCaptured = isGatewayError(err) && err.condition === 'not_captured'
          const age = Date.now() - Date.parse(x.createdAt ?? '')
          const giveUp = attempts >= MAX_REFUND_ATTEMPTS && (!notCaptured || age > NOT_CAPTURED_WAIT_MS)
          alert = giveUp
          return { ...x, attempts, error: detail.slice(0, 200), ...(giveUp ? { status: 'failed' } : {}) }
        })
        await saveOrder(req, cur, {
          refunds,
          ...(alert ? { reviewReason: appendReason(cur.reviewReason, `Automatic refund of ${entry.paymentId} kept failing (${detail}) — refund it by hand.`) } : {}),
        }, { source: 'refund', note: null })
        if (alert) payload.logger.error({ msg: 'ALERT automatic refund gave up', order: cur.number, paymentId: entry.paymentId })
      })
    }
  }
  return issued
}

/** refund.created / refund.processed / refund.failed webhooks. */
export async function processRefundEvent(
  payload: Payload,
  event: string,
  refund: GatewayRefund | null,
  payment: GatewayPayment | null,
): Promise<{ outcome: string; orderId?: number }> {
  if (!refund) return { outcome: 'invalid' }
  let order = await findOrderByPaymentId(payload, refund.payment_id)
  if (!order && refund.receipt) {
    const m = /^(WF-\d{5,12})-/.exec(refund.receipt)
    if (m) order = await findOrderByNumber(payload, m[1])
  }
  if (!order) return { outcome: 'orphan' }
  const u = refundUpdateFrom(refund)
  if (event === 'refund.failed') u.status = 'failed'
  if (event === 'refund.processed') u.status = 'processed'
  const r = await applyRefundUpdate(payload, order.id, u, { source: 'webhook', payment })
  return { outcome: r.outcome === 'recorded' ? 'refund_recorded' : 'refund_unchanged', orderId: order.id }
}
