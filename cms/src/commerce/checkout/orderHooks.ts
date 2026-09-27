import type { CollectionAfterChangeHook, PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

import { sendOrderConfirmation, sendOrderShipped } from '../../email/orders/send'
import { emitOrderEvent, type OrderEventType } from '../events'
import { isConfirmed } from '../shared/order-status.js'
import { orderEditRefused } from './adminEdits'
import { detach } from './background'
import { consumeRedemption, recheckReleasedUse, releaseRedemption } from './coupons'
import { CHECKOUT_CONTEXT, newReq } from './db'
import { findOrderById } from './orders'
import { holdsUnshippedStock, orderStockLines, releaseLines, reserveLines } from './stock'

/**
 * Orders afterChange: side effects of changes made OUTSIDE the checkout code (admin UI / REST, scripts).
 *
 *   fulfilmentStatus → shipped    order.shipped + "on its way" email (ship:<no>, once)
 *   fulfilmentStatus → delivered  order.delivered
 *   status → cancelled            stock and coupon reservation given back IN the same transaction
 *                                 (unshipped orders only), then order.cancelled
 *   status → a confirmed status   (e.g. needs_review → paid by an admin) order.confirmed + confirmation email;
 *                                 for → paid / partially_refunded also commit the stock (re-take it if
 *                                 released, else refuse), consume the coupon use, stamp paidAt/paidVia 'admin'
 *   status → refunded             an unshipped order's stock given back IN the same transaction (like a
 *                                 cancel: a refunded order is terminal and never ships), then order.refunded
 *   status → partially_refunded   order.refunded
 *
 * Events and emails must only happen once the admin's update has COMMITTED, and afterChange runs before
 * the commit. So they are detached: wait for the transaction session to end, re-read the order, and act
 * only if the committed row still shows the change (a rolled-back update does nothing).
 * Checkout code tags its writes with context.wfCheckout and emits its own events, so status changes it
 * makes are skipped here (fulfilment changes never come from checkout code).
 */

type Task = { event: OrderEventType; email?: 'shipped' | 'confirmation'; holds: (o: Order) => boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForTransactionEnd(req: PayloadRequest, maxMs = 60_000): Promise<void> {
  const raw = req.transactionID
  const id = raw instanceof Promise ? await raw : raw
  if (!id) return
  const sessions = (req.payload.db as unknown as { sessions?: Record<string, unknown> }).sessions ?? {}
  const started = Date.now()
  while (sessions[id as string] && Date.now() - started < maxMs) await sleep(10)
}

/** Re-reads until the committed row satisfies every task's condition (or gives up: a rollback). */
async function committedOrder(req: PayloadRequest, id: number, tasks: Task[]): Promise<Order | null> {
  const started = Date.now()
  for (;;) {
    const order = await findOrderById(req.payload, id)
    if (order && tasks.some((t) => t.holds(order))) return order
    if (Date.now() - started > 3_000) return null
    await sleep(25)
  }
}

/**
 * An admin confirmed an order by hand (needs_review → paid): its stock must be committed (taken again if it
 * was released — refused when it's gone), its coupon use consumed (a released use only while the offer's
 * usageLimit still has room — refused otherwise), and paidAt/paidVia filled in.
 */
async function settlePaidByAdmin(req: PayloadRequest, order: Order): Promise<Order> {
  let stockState = order.stockState
  if (stockState === 'released') {
    const r = await reserveLines(req, orderStockLines(order))
    if (!r.ok) {
      throw orderEditRefused(req, order, [{ path: 'status', message: `${r.failed.slug} is out of stock — restock it first, or refund the order instead.` }])
    }
  }
  stockState = 'committed'
  // A use given back at expiry/cancel may have been taken by another order since: re-count it like stock.
  const coupon = await recheckReleasedUse(req, order.id, null)
  if (coupon) {
    throw orderEditRefused(req, order, [
      { path: 'status', message: `The offer ${coupon.code} has no uses left — raise its usage limit first, or refund the order instead.` },
    ])
  }
  await consumeRedemption(req, order.id)
  const data = { stockState, ...(order.paidAt ? {} : { paidAt: new Date().toISOString(), paidVia: 'admin' as const }) }
  await req.payload.db.updateOne({ collection: 'orders', id: order.id, data, req, returning: false })
  return { ...order, ...data }
}

/** Gives an unshipped order's stock back inside the admin's transaction (cancel, or a full refund). */
async function releaseUnshipped(req: PayloadRequest, order: Order): Promise<Order> {
  if (!holdsUnshippedStock(order)) return order
  await releaseLines(req, orderStockLines(order))
  await req.payload.db.updateOne({ collection: 'orders', id: order.id, data: { stockState: 'released' }, req, returning: false })
  return { ...order, stockState: 'released' }
}

export const orderEffectsAfterChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if (operation !== 'update' || !previousDoc) return doc
  const order = doc as Order
  const before = previousDoc as Order
  const fromCheckout = req.context?.[CHECKOUT_CONTEXT] === true
  const tasks: Task[] = []

  if (order.fulfilmentStatus !== before.fulfilmentStatus) {
    if (order.fulfilmentStatus === 'shipped') tasks.push({ event: 'order.shipped', email: 'shipped', holds: (o) => o.fulfilmentStatus === 'shipped' })
    if (order.fulfilmentStatus === 'delivered') tasks.push({ event: 'order.delivered', holds: (o) => o.fulfilmentStatus === 'delivered' })
  }

  let result: Order = order
  if (!fromCheckout && order.status !== before.status) {
    if (order.status === 'cancelled') {
      result = await releaseUnshipped(req, order)
      await releaseRedemption(req, order.id)
      tasks.push({ event: 'order.cancelled', holds: (o) => o.status === 'cancelled' })
    } else if (isConfirmed(order.status) && !isConfirmed(before.status)) {
      // Both make the order fulfillable again (a human releasing a hold), so its stock must be there.
      if (order.status === 'paid' || order.status === 'partially_refunded') result = await settlePaidByAdmin(req, order)
      tasks.push({ event: 'order.confirmed', email: 'confirmation', holds: (o) => isConfirmed(o.status) })
    } else if (order.status === 'refunded' || order.status === 'partially_refunded') {
      // A full refund before shipping ends the order (terminal, never packed or shipped): restock like a cancel.
      if (order.status === 'refunded') result = await releaseUnshipped(req, order)
      tasks.push({ event: 'order.refunded', holds: (o) => o.status === order.status })
    }
  }

  if (tasks.length) {
    const previousStatus = before.status
    const source = typeof req.context?.statusSource === 'string' ? req.context.statusSource : req.user ? `admin:${req.user.id}` : 'system'
    detach(req.payload, `order ${order.number} effects`, async () => {
      await waitForTransactionEnd(req)
      const committed = await committedOrder(req, order.id, tasks)
      if (!committed) return
      const eventReq = await newReq(req.payload)
      for (const t of tasks) {
        if (!t.holds(committed)) continue
        await emitOrderEvent(eventReq, { type: t.event, order: committed, previousStatus, source })
        if (t.email === 'shipped') await sendOrderShipped(req.payload, committed.id)
        if (t.email === 'confirmation') await sendOrderConfirmation(req.payload, committed.id)
      }
    })
  }
  return result
}
