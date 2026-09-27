import type { PayloadRequest } from 'payload'

import type { Order } from '@/payload-types'

/**
 * Order lifecycle events — the seam between checkout/payments (the emitter) and features that react
 * to orders (retention: newsletter consent upsert, refill reminders; emails; analytics).
 *
 * Checkout code calls emitOrderEvent() AFTER its transaction commits, so handlers always see durable
 * state. Handlers are keyed by name (re-registering a name replaces it, which keeps Next dev HMR from
 * stacking duplicates) and each runs isolated: a throwing or hanging handler is logged and reported in
 * the result, never propagated — a reminder email must not be able to fail a payment confirmation.
 *
 * Handlers must be idempotent: the same event can be emitted more than once (client verify, redirect
 * callback, webhook and the reconcile job can all confirm one order; only the first transition emits,
 * but a crash between commit and emit means the reconcile path may emit again). Guard side effects
 * with sendOnce/message-log keys or unique constraints.
 *
 * Registration: an area registers its handlers from module scope in the file that its endpoint
 * registry imports (e.g. src/retention/register.ts imported by src/endpoints/retention/index.ts), so
 * they are in place as soon as payload.config.ts is loaded.
 */

export const ORDER_EVENT_TYPES = [
  /** paid (online, incl. late authorisation) or cod_pending — the order will be fulfilled. */
  'order.confirmed',
  /** a payment attempt failed; the order stays retryable (late authorisation can still confirm it). */
  'order.payment_failed',
  /** reservation TTL passed without payment; stock released. */
  'order.expired',
  'order.cancelled',
  'order.refunded',
  'order.shipped',
  'order.delivered',
  /** the customer answered "Breakfast for how many?" on /order. */
  'order.household_updated',
] as const

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number]

export interface OrderEvent {
  type: OrderEventType
  order: Order
  /** Order status before the transition that produced this event (null when not a status change). */
  previousStatus: Order['status'] | null
  /** Which path produced it: 'client' | 'callback' | 'webhook' | 'reconcile' | 'admin' | 'customer' … */
  source: string
  at: Date
}

export type OrderEventHandler = (event: OrderEvent, req: PayloadRequest) => Promise<void> | void

export interface HandlerResult {
  name: string
  ok: boolean
  error?: string
  timedOut?: boolean
  ms: number
}

type Registry = Map<OrderEventType, Map<string, OrderEventHandler>>

const REGISTRY_KEY = Symbol.for('wefeasto.orderEvents')

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>
  let r = g[REGISTRY_KEY]
  if (!r) {
    r = new Map()
    g[REGISTRY_KEY] = r
  }
  return r
}

/**
 * Registers `fn` for `type` under a unique `name` (replacing any previous handler with that name).
 * Returns an unsubscribe function.
 */
export function onOrderEvent(type: OrderEventType, name: string, fn: OrderEventHandler): () => void {
  if (!ORDER_EVENT_TYPES.includes(type)) throw new Error(`Unknown order event type: ${type}`)
  if (!name) throw new Error('onOrderEvent: a handler name is required')
  const r = registry()
  let byName = r.get(type)
  if (!byName) {
    byName = new Map()
    r.set(type, byName)
  }
  byName.set(name, fn)
  return () => {
    if (byName.get(name) === fn) byName.delete(name)
  }
}

/** Names of the handlers currently registered for `type` (for tests and diagnostics). */
export function orderEventHandlerNames(type: OrderEventType): string[] {
  return [...(registry().get(type)?.keys() ?? [])]
}

/** Removes every handler (tests only). */
export function clearOrderEventHandlers(): void {
  registry().clear()
}

const DEFAULT_TIMEOUT_MS = 4000

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Runs every handler for `event.type` concurrently, each with its own timeout. Never throws.
 * Call it after the transaction that changed the order has committed, with a request that is NOT
 * bound to that (finished) transaction.
 */
export async function emitOrderEvent(
  req: PayloadRequest,
  event: Omit<OrderEvent, 'at' | 'previousStatus'> & Partial<Pick<OrderEvent, 'at' | 'previousStatus'>>,
  opts: { timeoutMs?: number } = {},
): Promise<HandlerResult[]> {
  const full: OrderEvent = { previousStatus: null, at: new Date(), ...event }
  const handlers = [...(registry().get(full.type)?.entries() ?? [])]
  if (!handlers.length) return []
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const logger = req?.payload?.logger

  return Promise.all(
    handlers.map(async ([name, fn]): Promise<HandlerResult> => {
      const started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          Promise.resolve()
            .then(() => fn(full, req))
            .then(() => 'done' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs)
          }),
        ])
        if (outcome === 'timeout') {
          logger?.warn?.({ msg: 'order event handler timed out', handler: name, type: full.type, order: full.order?.number, timeoutMs })
          return { name, ok: false, timedOut: true, error: `timed out after ${timeoutMs}ms`, ms: Date.now() - started }
        }
        return { name, ok: true, ms: Date.now() - started }
      } catch (err) {
        logger?.error?.({ msg: 'order event handler failed', handler: name, type: full.type, order: full.order?.number, err: message(err) })
        return { name, ok: false, error: message(err), ms: Date.now() - started }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )
}
