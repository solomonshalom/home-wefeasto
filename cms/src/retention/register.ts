import type { Order } from '@/payload-types'

import { onOrderEvent } from '../commerce/events'
import { scheduleRefillReminder } from './refill'
import { upsertCheckoutConsent } from './subscribers'

/**
 * Retention's order-event handlers (see src/commerce/events.ts). Registered at module scope; this file is
 * imported by src/endpoints/retention/index.ts, so they are active as soon as payload.config loads.
 * Re-registering replaces by name (safe under HMR and in tests).
 *
 *   order.confirmed          retention:checkout-consent   consent.marketing → subscriber confirmed (source 'checkout')
 *   order.confirmed          retention:refill-schedule    queue the refillReminder job
 *   order.household_updated  retention:refill-household   re-queue it with the new household size
 *
 * All are idempotent (repeated events are no-ops) and quick (a few indexed queries + one insert); the
 * slow part (the reminder email) runs later in the jobs queue. They use the Local API without the
 * event's req, so nothing runs inside (or can abort) the emitter's transaction.
 */

export const RETENTION_HANDLER_NAMES = {
  consent: 'retention:checkout-consent',
  refill: 'retention:refill-schedule',
  household: 'retention:refill-household',
} as const

export function registerRetentionHandlers(): void {
  onOrderEvent('order.confirmed', RETENTION_HANDLER_NAMES.consent, async ({ order }, req) => {
    const payload = req.payload
    // The consent group is immutable on an order; re-read only if the event carried a partial doc.
    const doc =
      order?.consent && order?.contact
        ? order
        : ((await payload.findByID({ collection: 'orders', id: order.id, depth: 0, overrideAccess: true, disableErrors: true })) as Order | null)
    if (!doc) return
    const outcome = await upsertCheckoutConsent(payload, doc)
    payload.logger.debug?.({ msg: 'retention: checkout consent', order: doc.number, outcome })
  })

  onOrderEvent('order.confirmed', RETENTION_HANDLER_NAMES.refill, async ({ order }, req) => {
    const result = await scheduleRefillReminder(req.payload, order.id)
    req.payload.logger.debug?.({ msg: 'retention: refill schedule', order: order.number, outcome: result.outcome })
  })

  onOrderEvent('order.household_updated', RETENTION_HANDLER_NAMES.household, async ({ order }, req) => {
    const result = await scheduleRefillReminder(req.payload, order.id)
    req.payload.logger.debug?.({ msg: 'retention: refill re-schedule', order: order.number, outcome: result.outcome })
  })
}

registerRetentionHandlers()
