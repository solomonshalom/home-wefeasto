import type { Endpoint, Payload, PayloadHandler } from 'payload'

import type { Order } from '@/payload-types'

import { runEffects } from '../../commerce/checkout/background'
import { toOrderStatusDTO } from '../../commerce/checkout/dto'
import { findOrderForGuest, tokenFor } from '../../commerce/checkout/orders'
import { markPaid } from '../../commerce/checkout/payments'
import { getStoreSettings } from '../../commerce/settings'
import { getGateway } from '../../payments'
import { json, jsonError, withErrors } from '../../lib/http'
import { limit, orderNotFound, queryParam } from './respond'

/**
 *   GET /api/store/orders/status?no=&t=   → 200 OrderStatusDTO (bare) | 404 (one body for unknown / wrong token)
 *   GET /api/store/orders/mine            → 200 {orders: (OrderStatusDTO & {token})[]} | 401 for guests
 * (POST /api/store/orders/household is served by the retention area; see checkout-backend.md.)
 */

/** Pull-reconcile throttle: at most one gateway look per order per 15 s per instance. */
const PULL_KEY = Symbol.for('wefeasto.checkout.statusPull')
const PULL_EVERY_MS = 15_000
/** Give the normal paths (handler → verify, webhook) this long before asking Razorpay ourselves. */
const PULL_AFTER_ATTEMPT_MS = 20_000

function pullMap(): Map<number, number> {
  const g = globalThis as unknown as Record<symbol, Map<number, number> | undefined>
  let m = g[PULL_KEY]
  if (!m) {
    m = new Map()
    g[PULL_KEY] = m
  }
  return m
}

/**
 * While a customer watches /order for an unpaid online order, ask the gateway (after the response) whether a
 * payment landed on one of the two newest attempts: this confirms "lost" payments even when webhooks are
 * delayed or misconfigured, without waiting for the reconcile cron. The next poll sees the result.
 */
async function maybePull(payload: Payload, order: Order): Promise<void> {
  if (order.paymentMethod !== 'online' || (order.status !== 'pending_payment' && order.status !== 'payment_failed')) return
  const attempts = order.razorpay?.attempts ?? []
  const latest = attempts[attempts.length - 1]
  if (!latest?.createdAt || Date.now() - Date.parse(latest.createdAt) < PULL_AFTER_ATTEMPT_MS) return
  const m = pullMap()
  const last = m.get(order.id) ?? 0
  if (Date.now() - last < PULL_EVERY_MS) return
  m.set(order.id, Date.now())
  if (m.size > 5_000) m.clear()
  await runEffects(payload, `status pull ${order.number}`, async () => {
    for (const a of attempts.slice(-2).reverse()) {
      const payments = await getGateway().fetchOrderPayments(a.orderId)
      for (const p of payments) {
        if (p.status !== 'authorized' && p.status !== 'captured') continue
        await markPaid(payload, { orderId: order.id, payment: p, via: 'reconcile', note: `status poll ${p.status} ${p.id}` })
        return
      }
    }
  })
}

const status: PayloadHandler = withErrors(async (req) => {
  const no = queryParam(req, 'no')
  const t = queryParam(req, 't')
  const limited = limit(req, 'status') ?? limit(req, 'statusPerOrder', String(no ?? '').slice(0, 20))
  if (limited) return limited
  const order = await findOrderForGuest(req.payload, no, t)
  if (!order) return orderNotFound()
  const settings = await getStoreSettings(req.payload)
  await maybePull(req.payload, order)
  return json(toOrderStatusDTO(order, { shippingPromiseText: settings.public.shippingPromiseText }), {
    cache: 'no-store',
    headers: { 'Referrer-Policy': 'no-referrer' },
  })
})

const mine: PayloadHandler = withErrors(async (req) => {
  const limited = limit(req, 'mine')
  if (limited) return limited
  if (req.user?.collection !== 'customers') return jsonError(401, 'UNAUTHORIZED')
  const res = await req.payload.find({
    collection: 'orders',
    where: { customer: { equals: req.user.id } },
    sort: '-createdAt',
    limit: 50,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  const settings = await getStoreSettings(req.payload)
  const orders = (res.docs as Order[]).map((o) =>
    toOrderStatusDTO(o, { shippingPromiseText: settings.public.shippingPromiseText, token: o.tokenNonce ? tokenFor(o) : undefined }),
  )
  return json({ orders }, { cache: 'no-store' })
})

export const orderEndpoints: Endpoint[] = [
  { path: '/store/orders/status', method: 'get', handler: status },
  { path: '/store/orders/mine', method: 'get', handler: mine },
]
