/**
 * Checkout / payments domain (server only). Contract: SCRATCH/contracts/checkout-backend.md.
 */
export { createAttempt, latestAttempt } from './attempts'
export { flushPendingEffects, runEffects } from './background'
export { checkoutRequestHash, DEFAULT_CONSENT_TEXT, IDEMPOTENCY_KEY_RE, isFailure, placeOrder, replayCheckout } from './checkout'
export type { CheckoutFailure, CheckoutResult, CheckoutSuccess } from './checkout'
export { inTransaction, isUniqueViolation, lockRow } from './db'
export { toOrderStatusDTO, type OrderStatusDTO } from './dto'
export { expireOrder } from './expire'
export {
  findOrderById,
  findOrderByNumber,
  findOrderByPaymentId,
  findOrderByRazorpayOrderId,
  findOrderForGuest,
  isOrderToken,
  lockOrder,
  orderRef,
  tokenFor,
} from './orders'
export { attemptReceipt, buildPaymentInit, callbackUrlFor, CHECKOUT_TIMEOUT_SECONDS, refundReceipt, type PaymentInit } from './paymentInit'
export { markPaid, recordPaymentFailure, type MarkPaidOutcome, type PaidVia } from './payments'
export { serverQuote } from './quote'
export { reconcilePendingOrders, type ReconcileSummary } from './reconcile'
export { applyRefundUpdate, issueQueuedRefunds, queueRefund } from './refunds'
export { retryPayment } from './retry'
export { orderStockLines, releaseLines, reserveLines } from './stock'
export { verifyPayment } from './verify'
export { claimEvent, finishEvent, processWebhookEvent, redactEvent } from './webhook'
