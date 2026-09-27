import type { Payload, PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

import { nextStatus } from '../shared/order-status.js'
import { releaseRedemption } from './coupons'
import { inTransaction } from './db'
import { applyEffects, noEffects } from './effects'
import { lockOrder } from './orders'
import { saveOrder } from './orderWrite'
import { orderStockLines, releaseLines } from './stock'

/**
 * Reservation TTL passed without payment (razorpay.md §13.53): pending_payment / payment_failed → expired,
 * stock released (atomic increments), coupon reservation released. The caller (reconcile) must first have
 * asked the gateway for payments on every attempt; an order whose paymentStatus says money arrived is
 * never expired. The Razorpay orders stay open: a late payment later goes through markPaid (re-reserve or
 * refund). Emits order.expired after commit.
 */
export async function expireOrder(
  payload: Payload,
  orderId: number | string,
  { now = Date.now(), source = 'reconcile' }: { now?: number; source?: string } = {},
): Promise<{ outcome: 'expired' | 'skipped'; order: Order | null }> {
  const effects = noEffects()
  const result = await inTransaction(payload, async (req) => {
    const order = await lockOrder(req, orderId)
    if (!order) return { outcome: 'skipped' as const, order: null }
    if (order.status !== 'pending_payment' && order.status !== 'payment_failed') return { outcome: 'skipped' as const, order }
    if (order.paymentStatus === 'authorized' || order.paymentStatus === 'captured' || order.razorpay?.paymentId) {
      return { outcome: 'skipped' as const, order }
    }
    if (order.reservedUntil && Date.parse(order.reservedUntil) > now) return { outcome: 'skipped' as const, order }
    const saved = await releaseAndMove(req, order, 'expire', { source, note: 'reservation expired' })
    effects.events.push({ type: 'order.expired', previousStatus: order.status, source })
    return { outcome: 'expired' as const, order: saved }
  })
  if (result.order && result.outcome === 'expired') await applyEffects(payload, result.order.id, effects, 'expire')
  return result
}

/**
 * Inside a transaction that holds the order lock: give back stock and the coupon reservation and apply
 * `event` ('expire' | 'cancel'). Used by expireOrder and by checkout's supersede step.
 */
export async function releaseAndMove(
  req: PayloadRequest,
  order: Order,
  event: 'expire' | 'cancel',
  { source, note }: { source: string; note: string },
): Promise<Order> {
  const next = nextStatus(order.status, event)
  let stockState = order.stockState
  if (stockState === 'reserved' || (event === 'cancel' && stockState === 'committed')) {
    await releaseLines(req, orderStockLines(order))
    stockState = 'released'
  }
  await releaseRedemption(req, order.id)
  return saveOrder(req, order, { ...(next ? { status: next } : {}), stockState }, { source, note })
}
