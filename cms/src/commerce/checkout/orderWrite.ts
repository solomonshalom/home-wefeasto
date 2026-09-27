import type { PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

import type { GatewayPayment } from '../../payments/types'
import { CHECKOUT_CONTEXT } from './db'

/**
 * Writes to an order that the caller has LOCKED (lockOrder) inside req's transaction. Goes through
 * payload.update so the Orders hooks append statusHistory rows (labelled with `source`/`note`).
 */
export async function saveOrder(
  req: PayloadRequest,
  order: Pick<Order, 'id'>,
  data: Partial<Order>,
  { source, note = null }: { source: string; note?: string | null },
): Promise<Order> {
  const { id: _ignored, ...rest } = data as Partial<Order> & { id?: unknown }
  return (await req.payload.update({
    collection: 'orders',
    id: order.id,
    data: rest as never,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    req,
    context: { [CHECKOUT_CONTEXT]: true, statusSource: source, statusNote: note },
  })) as Order
}

/** Appends a line to reviewReason (keeps earlier reasons; capped). */
export function appendReason(current: string | null | undefined, line: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const next = current ? `${current}\n[${stamp}Z] ${line}` : `[${stamp}Z] ${line}`
  return next.length > 4000 ? next.slice(next.length - 4000) : next
}

type Razorpay = NonNullable<Order['razorpay']>
export type PaymentLogEntry = NonNullable<Razorpay['payments']>[number]
export type AttemptEntry = NonNullable<Razorpay['attempts']>[number]
export type RefundEntry = NonNullable<Order['refunds']>[number]

const MAX_LOG = 50

/** Payment log with `payment` inserted or refreshed (by payment id). Status never regresses. */
export function upsertPaymentLog(
  order: Pick<Order, 'razorpay'>,
  payment: Pick<GatewayPayment, 'id' | 'order_id' | 'status' | 'method' | 'amount'> &
    Partial<Pick<GatewayPayment, 'error_code' | 'error_reason' | 'error_description'>>,
  via: string,
): { log: PaymentLogEntry[]; isNew: boolean; changed: boolean } {
  const log = [...(order.razorpay?.payments ?? [])]
  const i = log.findIndex((p) => p.paymentId === payment.id)
  const RANK: Record<string, number> = { created: 0, failed: 1, authorized: 2, captured: 3, refunded: 4 }
  const next: PaymentLogEntry = {
    paymentId: payment.id,
    orderId: payment.order_id ?? null,
    status: payment.status,
    method: payment.method ?? null,
    amount: payment.amount,
    errorCode: payment.error_code || null,
    errorReason: payment.error_reason || null,
    errorDescription: payment.error_description ? String(payment.error_description).slice(0, 300) : null,
    via,
    at: new Date().toISOString(),
  }
  if (i === -1) {
    log.push(next)
    return { log: log.slice(-MAX_LOG), isNew: true, changed: true }
  }
  const prev = log[i]
  const prevRank = RANK[prev.status ?? ''] ?? -1
  const nextRank = RANK[payment.status] ?? -1
  if (nextRank < prevRank || (nextRank === prevRank && prev.method === next.method)) return { log, isNew: false, changed: false }
  log[i] = { ...next, id: prev.id, errorCode: next.errorCode ?? prev.errorCode, errorReason: next.errorReason ?? prev.errorReason }
  return { log, isNew: false, changed: true }
}

/** Attempts with the one for `rzpOrderId` set to `status` (never downgrading 'paid'). */
export function withAttemptStatus(order: Pick<Order, 'razorpay'>, rzpOrderId: string | null, status: 'attempted' | 'paid'): AttemptEntry[] {
  return (order.razorpay?.attempts ?? []).map((a) =>
    a.orderId === rzpOrderId && a.status !== 'paid' ? { ...a, status } : a,
  )
}

/** The razorpay group as a complete object (group writes must not drop sibling fields). */
export function razorpayGroup(order: Pick<Order, 'razorpay'>, patch: Partial<Razorpay>): Razorpay {
  const r = order.razorpay ?? {}
  return {
    attempts: r.attempts ?? [],
    paymentId: r.paymentId ?? null,
    method: r.method ?? null,
    capturedAt: r.capturedAt ?? null,
    payments: r.payments ?? [],
    ...patch,
  }
}
