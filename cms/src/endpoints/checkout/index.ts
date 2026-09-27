import type { Endpoint } from 'payload'

import { mockPaymentEndpoints } from '../../payments/mockEndpoints'
import { orderEndpoints } from './orders'
import { paymentEndpoints } from './payments'
import { storeCheckoutEndpoints } from './store'

/**
 * Checkout + payments endpoints — OWNER: checkout-backend. Contract: SCRATCH/contracts/checkout-backend.md.
 *
 *   POST /api/store/quote                         server quote ($shared quote over the DB catalog)
 *   POST /api/store/checkout                      place an order (Idempotency-Key)
 *   POST /api/store/checkout/retry                new Razorpay attempt for an unpaid online order
 *   POST /api/store/checkout/verify               Checkout handler → verify + markPaid
 *   GET  /api/store/orders/status?no=&t=          OrderStatusDTO for /order and the pending banner
 *   GET  /api/store/orders/mine                   the signed-in customer's orders
 *   POST /api/payments/razorpay/callback?no=&t=   redirect-mode form POST → 303 /order
 *   POST /api/payments/razorpay/webhook           Razorpay webhooks
 *   GET  /api/payments/reconcile                  cron: reconcilePendingOrders (Bearer CRON_SECRET)
 *   GET  /api/payments/mock/checkout.js, POST /api/payments/mock/pay   (gateway agent; mock mode only)
 *
 * POST /api/store/orders/household stays in the retention registry (it steps aside automatically if a
 * route with that path is added here).
 */
export const checkoutEndpoints: Endpoint[] = [...storeCheckoutEndpoints, ...orderEndpoints, ...paymentEndpoints, ...mockPaymentEndpoints]
