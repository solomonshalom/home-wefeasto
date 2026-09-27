import type { PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

import { inTransaction } from '../commerce/checkout/db'
import { findOrderById, lockOrder } from '../commerce/checkout/orders'
import { emitOrderEvent } from '../commerce/events'
import { verifyOrderToken } from '../commerce/orderToken'
import { isOrderNumber } from '../commerce/shared/order-status.js'
import { parseQty } from '../commerce/shared/qty.js'
import { MAX_EATERS } from './timing'

/**
 * "Breakfast for how many?" on /order (S2): POST /api/store/orders/household {number, token, size}.
 * Stores `orders.householdSize` and emits `order.household_updated`, which re-queues the refill reminder
 * (src/retention/register.ts). Guest-token protected like every /order call: an unknown order and a
 * wrong token get the same 'not-found'.
 *
 * The write takes the order row lock (the checkout lock order: orders first) and writes ONLY the
 * household_size column (db.updateOne with a partial row). A payload.update would write back the whole order
 * it read before the lock, reverting a cancel / ship / expiry / payment that committed in between.
 */

export type HouseholdResult = { outcome: 'updated' | 'unchanged' } | { outcome: 'not-found' } | { outcome: 'invalid-size' }

/** 1..20 people (the UI offers 1 · 2 · 3 · 4+ and sends 4 for "4+"). */
export function parseHouseholdSize(raw: unknown): number | null {
  const n = parseQty(raw)
  return n !== null && n <= MAX_EATERS ? n : null
}

export async function setHouseholdSize(
  req: PayloadRequest,
  { number, token, size }: { number: unknown; token: unknown; size: unknown },
): Promise<HouseholdResult> {
  const householdSize = parseHouseholdSize(size)
  if (!isOrderNumber(number) || typeof token !== 'string' || !token) return { outcome: 'not-found' }
  const { payload } = req
  const res = await payload.find({
    collection: 'orders',
    where: { number: { equals: String(number).trim() } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  const order = res.docs[0] as Order | undefined
  if (!order || !verifyOrderToken(order, token)) return { outcome: 'not-found' }
  if (householdSize === null) return { outcome: 'invalid-size' }
  if (order.householdSize === householdSize) return { outcome: 'unchanged' }

  const updated = await inTransaction(payload, async (tx) => {
    const current = await lockOrder(tx, order.id)
    if (!current || current.householdSize === householdSize) return null
    await tx.payload.db.updateOne({ collection: 'orders', id: order.id, data: { householdSize }, req: tx, returning: false })
    return findOrderById(tx, order.id)
  })
  if (!updated) return { outcome: 'unchanged' }
  await emitOrderEvent(req, { type: 'order.household_updated', order: updated, source: 'customer' })
  return { outcome: 'updated' }
}
