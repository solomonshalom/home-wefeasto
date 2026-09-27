import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import { deriveOrderToken } from '../../commerce/orderToken'
import { getStoreSettings } from '../../commerce/settings'
import { getEnv } from '../../env'
import { sendOnce, type SendOnceResult } from '../sendOnce'
import {
  confirmationVariant,
  type OrderEmailContext,
  renderOrderConfirmation,
  renderOrderShipped,
  renderRefundNotice,
  type RefundReasonKind,
} from './templates'

/**
 * Exactly-once delivery of the order emails (message-log keys, cms-foundation §10):
 *   confirm:<WF-no>     confirmation (online / COD / late-payment variant) — one per order, ever
 *   ship:<WF-no>        shipped
 *   refund:<refundId>   automatic refund notice
 * Always called AFTER the transaction that changed the order has committed (sendOnce claims outside it).
 */

async function reloadWithNonce(payload: Payload, id: number | string): Promise<Order | null> {
  const doc = await payload.findByID({
    collection: 'orders',
    id,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    disableErrors: true,
  })
  return (doc as Order | null) ?? null
}

async function contextFor(payload: Payload, order: Order): Promise<OrderEmailContext> {
  const settings = await getStoreSettings(payload)
  return {
    storefrontUrl: getEnv().storefrontUrl,
    token: deriveOrderToken(order.id, order.tokenNonce as string),
    shippingPromiseText: settings.public.shippingPromiseText,
    supportWhatsappE164: settings.public.supportWhatsappE164,
  }
}

async function logRowSent(payload: Payload, key: string): Promise<boolean> {
  const res = await payload.find({
    collection: 'message-log',
    where: { key: { equals: key } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return (res.docs[0] as { status?: string } | undefined)?.status === 'sent'
}

export const confirmationKey = (number: string) => `confirm:${number}`
export const shippedKey = (number: string) => `ship:${number}`
export const refundKey = (refundId: string) => `refund:${refundId}`

/**
 * Sends the confirmation once and stamps `confirmationSentAt` (also when an earlier call already sent it
 * but crashed before stamping). `late` picks the "your late payment went through" wording.
 */
export async function sendOrderConfirmation(
  payload: Payload,
  orderId: number | string,
  opts: { late?: boolean } = {},
): Promise<SendOnceResult | 'skipped'> {
  const order = await reloadWithNonce(payload, orderId)
  if (!order?.tokenNonce || !order.contact?.email) return 'skipped'
  const key = confirmationKey(order.number)
  const ctx = await contextFor(payload, order)
  const content = renderOrderConfirmation(order, ctx, confirmationVariant(order, opts))
  const result = await sendOnce({
    key,
    type: 'order-confirmation',
    to: order.contact.email,
    order: order.id,
    payload,
    ...content,
  })
  if (!order.confirmationSentAt && (result === 'sent' || (result === 'duplicate' && (await logRowSent(payload, key))))) {
    await payload.db.updateOne({
      collection: 'orders',
      where: { and: [{ id: { equals: order.id } }, { confirmationSentAt: { exists: false } }] },
      data: { confirmationSentAt: new Date().toISOString() },
      options: { atomic: true },
    })
  }
  return result
}

export async function sendOrderShipped(payload: Payload, orderId: number | string): Promise<SendOnceResult | 'skipped'> {
  const order = await reloadWithNonce(payload, orderId)
  if (!order?.tokenNonce || !order.contact?.email) return 'skipped'
  const content = renderOrderShipped(order, await contextFor(payload, order))
  return sendOnce({ key: shippedKey(order.number), type: 'order-shipped', to: order.contact.email, order: order.id, payload, ...content })
}

export async function sendRefundNotice(
  payload: Payload,
  orderId: number | string,
  refund: { refundId: string; amountPaise: number; reason: RefundReasonKind },
): Promise<SendOnceResult | 'skipped'> {
  const order = await reloadWithNonce(payload, orderId)
  if (!order?.tokenNonce || !order.contact?.email || !refund.refundId) return 'skipped'
  const content = renderRefundNotice(order, await contextFor(payload, order), refund)
  return sendOnce({ key: refundKey(refund.refundId), type: 'order-refund', to: order.contact.email, order: order.id, payload, ...content })
}
