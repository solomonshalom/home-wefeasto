import { createHash } from 'node:crypto'

import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import { getGateway } from '../../payments'
import type { GatewayPayment, ParsedWebhook } from '../../payments'
import { isGatewayError } from '../../payments/types'
import { isOrderNumber, nextStatus, razorpayEventToOrderEvent } from '../shared/order-status.js'
import { inTransaction, isUniqueViolation } from './db'
import { findOrderByNumber, findOrderByPaymentId, findOrderByRazorpayOrderId, lockOrder } from './orders'
import { appendReason, razorpayGroup, saveOrder } from './orderWrite'
import { markPaid, recordPaymentFailure } from './payments'
import { processRefundEvent } from './refunds'

/**
 * Razorpay webhook processing (razorpay.md §6, §13.E). The endpoint verifies the signature over the raw
 * bytes first; this module then
 *   1. claims `payment-events.eventId` (unique) OUTSIDE any transaction. A duplicate delivery of an event
 *      that was fully processed → 'duplicate' (no side effects). A duplicate of one whose processing never
 *      finished (crash, DB error → 500 → Razorpay retries) is processed again: every transition is idempotent.
 *   2. routes the event: payment.authorized / payment.captured / order.paid → markPaid; payment.failed →
 *      recordPaymentFailure (never terminal); refund.* → refunds; payment.dispute.* → flag + hold; others
 *      → 'ignored'.
 *   3. stamps processedAt + outcome on the event row. A thrown error (DB down) propagates → HTTP 500.
 *
 * Unknown Razorpay order ("orphan"): answered 200 (a 4xx would make Razorpay retry for 24 h and then
 * disable the webhook). A captured/authorized orphan whose notes.wf_order names one of OUR orders and whose
 * Razorpay order carries our receipt (`<no>-a<n>`, e.g. an attempt whose createOrder response was lost) is
 * attached to that order as an attempt and goes through markPaid (so duplicates are refunded there). Any
 * other orphan is only logged — it may belong to another integration on the same Razorpay account, so it is
 * never refunded automatically.
 */

export type WebhookOutcome = { outcome: string; orderId?: number | null }

/** Minimal, PII-free copy of the event for payment-events.payload. */
export function redactEvent(parsed: ParsedWebhook, raw: Record<string, any> | null): Record<string, unknown> {
  const p = parsed.payment
  const dispute = raw?.payload?.dispute?.entity
  return {
    event: parsed.event,
    createdAt: parsed.createdAt,
    ...(p
      ? {
          payment: {
            id: p.id,
            order_id: p.order_id,
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            method: p.method,
            amount_refunded: p.amount_refunded,
            error_code: p.error_code,
            error_reason: p.error_reason,
            notes: { wf_order: p.notes?.wf_order ?? null },
          },
        }
      : {}),
    ...(parsed.order
      ? { order: { id: parsed.order.id, receipt: parsed.order.receipt, status: parsed.order.status, amount: parsed.order.amount, amount_paid: parsed.order.amount_paid } }
      : {}),
    ...(parsed.refund
      ? { refund: { id: parsed.refund.id, payment_id: parsed.refund.payment_id, amount: parsed.refund.amount, status: parsed.refund.status, receipt: parsed.refund.receipt } }
      : {}),
    ...(dispute ? { dispute: { id: dispute.id, status: dispute.status, phase: dispute.phase, amount: dispute.amount, reason_code: dispute.reason_code } } : {}),
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

type Claim = { id: number; fresh: boolean; processed: boolean }

/** Inserts the event row (outside any transaction). An existing row → not fresh. */
export async function claimEvent(
  payload: Payload,
  args: { eventId: string; event: string; entityId: string | null; rawSha256: string; redacted: Record<string, unknown> },
): Promise<Claim> {
  try {
    const row = await payload.create({
      collection: 'payment-events',
      data: {
        eventId: args.eventId,
        event: args.event,
        entityId: args.entityId,
        receivedAt: new Date().toISOString(),
        rawSha256: args.rawSha256,
        payload: args.redacted,
      },
      depth: 0,
      overrideAccess: true,
    })
    return { id: row.id as number, fresh: true, processed: false }
  } catch (err) {
    if (!isUniqueViolation(err, 'eventId')) throw err
  }
  const res = await payload.find({
    collection: 'payment-events',
    where: { eventId: { equals: args.eventId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const row = res.docs[0] as { id: number; processedAt?: string | null } | undefined
  if (!row) throw new Error(`payment event ${args.eventId} vanished`)
  return { id: row.id, fresh: false, processed: Boolean(row.processedAt) }
}

export async function finishEvent(payload: Payload, id: number, r: WebhookOutcome): Promise<void> {
  await payload.db.updateOne({
    collection: 'payment-events',
    id,
    data: { processedAt: new Date().toISOString(), outcome: r.outcome, ...(r.orderId ? { order: r.orderId } : {}) },
    returning: false,
  })
}

/** Attach a payment on an unknown Razorpay order to our order when notes + receipt prove it's ours. */
async function attachOrphan(payload: Payload, payment: GatewayPayment): Promise<Order | null> {
  const number = payment.notes?.wf_order
  if (!isOrderNumber(number) || !payment.order_id) return null
  const order = await findOrderByNumber(payload, number)
  if (!order) return null
  let rzpOrder
  try {
    rzpOrder = await getGateway().fetchOrder(payment.order_id)
  } catch (err) {
    payload.logger.warn({ msg: 'orphan payment: fetchOrder failed', paymentId: payment.id, ...(isGatewayError(err) ? { kind: err.kind } : {}) })
    return null
  }
  const receiptOk = typeof rzpOrder.receipt === 'string' && rzpOrder.receipt.startsWith(`${order.number}-a`)
  if (!receiptOk || rzpOrder.notes?.wf_order !== order.number || rzpOrder.amount !== order.totalPaise) return null
  return inTransaction(payload, async (req) => {
    const cur = await lockOrder(req, order.id)
    if (!cur) return null
    const attempts = cur.razorpay?.attempts ?? []
    if (attempts.some((a) => a.orderId === rzpOrder.id)) return cur
    return saveOrder(
      req,
      cur,
      {
        razorpay: razorpayGroup(cur, {
          attempts: [
            ...attempts,
            { orderId: rzpOrder.id, receipt: rzpOrder.receipt as string, amount: rzpOrder.amount, status: rzpOrder.status, createdAt: new Date(rzpOrder.created_at * 1000).toISOString() },
          ],
        }),
      },
      { source: 'webhook', note: `attached orphan Razorpay order ${rzpOrder.id}` },
    )
  })
}

async function onPaymentEvent(payload: Payload, parsed: ParsedWebhook): Promise<WebhookOutcome> {
  const payment = parsed.payment
  if (!payment || !payment.order_id) return { outcome: 'invalid' }
  let order = await findOrderByRazorpayOrderId(payload, payment.order_id)
  const mapped = razorpayEventToOrderEvent(parsed.event)
  if (!order && mapped?.orderEvent === 'paid' && (payment.status === 'authorized' || payment.status === 'captured')) {
    order = await attachOrphan(payload, payment)
    if (order) payload.logger.warn({ msg: 'orphan payment attached to its order', order: order.number, paymentId: payment.id })
  }
  if (!order) {
    payload.logger.warn({ msg: 'webhook for an unknown Razorpay order (orphan)', event: parsed.event, paymentId: payment.id, rzpOrderId: payment.order_id })
    return { outcome: 'orphan' }
  }
  if (mapped?.orderEvent === 'payment_failed') {
    const r = await recordPaymentFailure(payload, { orderId: order.id, payment, via: 'webhook' })
    return { outcome: r.outcome === 'recorded' ? 'payment_failed' : `payment_failed_${r.outcome}`, orderId: order.id }
  }
  // The event body is a snapshot (payment.authorized may arrive after capture): trust the entity's status.
  const r = await markPaid(payload, { orderId: order.id, payment, via: 'webhook', note: `${parsed.event} ${payment.id}` })
  return { outcome: r.outcome, orderId: order.id }
}

async function onDisputeEvent(payload: Payload, parsed: ParsedWebhook, raw: Record<string, any> | null): Promise<WebhookOutcome> {
  const d = raw?.payload?.dispute?.entity as Record<string, any> | undefined
  const paymentId = (d?.payment_id as string | undefined) ?? parsed.payment?.id
  if (!d?.id || !paymentId) return { outcome: 'invalid' }
  const order = await findOrderByPaymentId(payload, paymentId)
  if (!order) return { outcome: 'orphan' }
  await inTransaction(payload, async (req) => {
    const cur = await lockOrder(req, order.id)
    if (!cur) return
    const created = parsed.event === 'payment.dispute.created'
    const data: Partial<Order> = {
      dispute: {
        disputeId: String(d.id),
        status: String(d.status ?? parsed.event.replace('payment.dispute.', '')),
        phase: d.phase ? String(d.phase) : null,
        reasonCode: d.reason_code ? String(d.reason_code) : null,
        amountPaise: Number.isSafeInteger(d.amount) ? d.amount : null,
        at: new Date().toISOString(),
      },
    }
    if (created) {
      // Hold: needs_review blocks packing/shipping (canFulfil) until a human resolves it.
      const next = nextStatus(cur.status, 'review')
      if (next && next !== cur.status) data.status = next
      data.reviewReason = appendReason(cur.reviewReason, `Chargeback ${d.id} opened on payment ${paymentId} — hold fulfilment and send evidence.`)
      payload.logger.error({ msg: 'ALERT dispute opened', order: cur.number, disputeId: d.id, paymentId })
    }
    await saveOrder(req, cur, data, { source: 'webhook', note: `${parsed.event} ${d.id}` })
  })
  return { outcome: parsed.event === 'payment.dispute.created' ? 'dispute_flagged' : 'dispute_updated', orderId: order.id }
}

/** Routes one verified, parsed event. Throws only for infrastructure failures (→ 500, Razorpay retries). */
export async function processWebhookEvent(payload: Payload, parsed: ParsedWebhook, raw: Record<string, any> | null): Promise<WebhookOutcome> {
  const e = parsed.event
  if (e === 'payment.authorized' || e === 'payment.captured' || e === 'order.paid' || e === 'payment.failed') {
    return onPaymentEvent(payload, parsed)
  }
  if (e === 'refund.created' || e === 'refund.processed' || e === 'refund.failed') {
    return processRefundEvent(payload, e, parsed.refund, parsed.payment)
  }
  if (e.startsWith('payment.dispute.')) return onDisputeEvent(payload, parsed, raw)
  return { outcome: 'ignored' }
}
