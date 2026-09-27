import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import { sendOrderConfirmation } from '../../email/orders/send'
import { emitOrderEvent, type OrderEventType } from '../events'
import { runEffects } from './background'
import { newReq } from './db'
import { findOrderById } from './orders'
import { issueQueuedRefunds } from './refunds'

/**
 * What a committed order transition asks for afterwards. Domain functions collect these inside their
 * transaction and hand them to applyEffects() once it has committed.
 *
 *   events        order events (src/commerce/events.ts), emitted with the fresh committed doc
 *   confirmation  send the confirmation email (confirm:<no>, once) — `late` = "your payment went through"
 *   refunds       issue this order's queued refunds with the gateway (+ refund notice emails)
 */
export type Effects = {
  events: { type: OrderEventType; previousStatus: Order['status'] | null; source: string }[]
  confirmation: { late: boolean } | null
  refunds: boolean
}

export const noEffects = (): Effects => ({ events: [], confirmation: null, refunds: false })

export const hasEffects = (e: Effects): boolean => e.events.length > 0 || e.confirmation !== null || e.refunds

/** Runs the effects now (tests, jobs) or after the response (request scope). Never throws. */
export async function applyEffects(payload: Payload, orderId: number | string, effects: Effects, label = 'order effects'): Promise<void> {
  if (!hasEffects(effects)) return
  await runEffects(payload, `${label} (order ${orderId})`, async () => {
    if (effects.events.length) {
      const order = await findOrderById(payload, orderId)
      if (order) {
        const req = await newReq(payload)
        for (const e of effects.events) {
          await emitOrderEvent(req, { type: e.type, order, previousStatus: e.previousStatus, source: e.source })
        }
      }
    }
    if (effects.confirmation) {
      const result = await sendOrderConfirmation(payload, orderId, { late: effects.confirmation.late })
      if (result === 'failed') payload.logger.warn({ msg: 'confirmation email failed; the reconcile job will retry', orderId })
    }
    if (effects.refunds) await issueQueuedRefunds(payload, orderId)
  })
}
