import type { Order } from '@/payload-types'

import { getEnv } from '../../env'
import type { PaymentGateway } from '../../payments/types'

/**
 * PaymentInit (SPEC §6): everything the storefront passes to `new Razorpay(options)` for one attempt.
 * `checkoutScript` is the CDN URL (razorpay) or the relative mock script (through the storefront's /api
 * proxy). `callbackUrl` is the redirect-mode target on the CMS origin; it carries the guest token so the
 * cookie-less form POST can find the order.
 */
export type PaymentInit = {
  provider: 'razorpay' | 'mock'
  keyId: string
  razorpayOrderId: string
  amount: number
  currency: 'INR'
  checkoutScript: string
  callbackUrl: string
  name: 'Wefeasto'
  description: string
  image: string
  prefill: { name: string; email: string; contact: string; method?: 'upi' | 'card' }
  notes: { wf_order: string }
  timeoutSeconds: number
}

/** Checkout closes itself after 15 minutes (the reservation lasts 30). */
export const CHECKOUT_TIMEOUT_SECONDS = 900

export type Attempt = NonNullable<NonNullable<Order['razorpay']>['attempts']>[number]

export function callbackUrlFor(number: string, token: string, serverUrl = getEnv().serverUrl): string {
  const qs = new URLSearchParams({ no: number, t: token })
  return `${serverUrl}/api/payments/razorpay/callback?${qs.toString()}`
}

export function buildPaymentInit(args: { gateway: PaymentGateway; order: Order; attempt: Attempt; token: string }): PaymentInit {
  const { gateway, order, attempt, token } = args
  const env = getEnv()
  const method = order.requestedMethod === 'upi' || order.requestedMethod === 'card' ? order.requestedMethod : undefined
  return {
    provider: gateway.provider,
    keyId: gateway.keyId,
    razorpayOrderId: attempt.orderId,
    amount: attempt.amount,
    currency: 'INR',
    checkoutScript: gateway.checkoutScriptUrl,
    callbackUrl: callbackUrlFor(order.number, token, env.serverUrl),
    name: 'Wefeasto',
    description: `Order ${order.number}`,
    image: `${env.storefrontUrl}/images/webclip.png`,
    prefill: {
      name: order.contact.name,
      email: order.contact.email,
      contact: order.contact.phone,
      ...(method ? { method } : {}),
    },
    notes: { wf_order: order.number },
    timeoutSeconds: CHECKOUT_TIMEOUT_SECONDS,
  }
}

/** Receipt for attempt n of an order: WF-10001-a1, WF-10001-a2, … */
export const attemptReceipt = (number: string, n: number): string => `${number}-a${n}`

/** Receipt for an automatic refund: WF-10001-dup-<last 6 of the payment id> (≤ 40 ASCII chars). */
export const refundReceipt = (number: string, kind: 'dup' | 'oos' | 'cxl', paymentId: string): string =>
  `${number}-${kind}-${paymentId.slice(-6)}`
