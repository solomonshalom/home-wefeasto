import type { Payload } from 'payload'

import type { Order } from '@/payload-types'

import { getGateway } from '../../payments'
import { isRazorpayOrderId, isRazorpayPaymentId } from '../../payments/signatures'
import { isGatewayError, type GatewayPayment } from '../../payments/types'
import { findOrderByRazorpayOrderId, findOrderForGuest } from './orders'
import { markPaid, type MarkPaidOutcome, type PaidVia, recordPaymentFailure } from './payments'

/**
 * Client verify and the redirect callback (razorpay.md §11.3, §12):
 *   1. the order is looked up BY the Razorpay order id in OUR database and must be the (number, token)
 *      the caller holds — someone else's order, an unknown id, a wrong token → not_found (one answer);
 *   2. timing-safe HMAC over `<our razorpay order id>|<payment id>` → a bad signature changes nothing;
 *   3. fetchPayment (the gateway, not the browser, says what happened): order id, amount, currency and a
 *      status of authorized/captured → markPaid(via); a gateway error or an unfinished payment → 'pending'
 *      (the webhook / reconcile settle it; the page keeps polling and never says "failed").
 */

export type VerifyInput = {
  number: unknown
  token: unknown
  razorpay_order_id: unknown
  razorpay_payment_id: unknown
  razorpay_signature: unknown
}

export type VerifyResult =
  | { kind: 'not_found' }
  | { kind: 'bad_request' }
  | { kind: 'signature_invalid'; order: Order }
  | { kind: 'pending'; order: Order }
  | { kind: 'done'; outcome: MarkPaidOutcome; order: Order }

const SIG_RE = /^[0-9a-f]{64}$/

export async function verifyPayment(payload: Payload, input: VerifyInput, via: PaidVia): Promise<VerifyResult> {
  const { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = input
  if (!isRazorpayOrderId(rzpOrderId) || !isRazorpayPaymentId(paymentId) || typeof signature !== 'string' || !SIG_RE.test(signature)) {
    return { kind: 'bad_request' }
  }
  const guest = await findOrderForGuest(payload, input.number, input.token)
  const byRzp = await findOrderByRazorpayOrderId(payload, rzpOrderId)
  if (!guest || !byRzp || guest.id !== byRzp.id) return { kind: 'not_found' }
  const attempt = (guest.razorpay?.attempts ?? []).find((a) => a.orderId === rzpOrderId)
  if (!attempt) return { kind: 'not_found' }

  const gateway = getGateway()
  if (!gateway.verifyPaymentSignature({ orderId: attempt.orderId, paymentId, signature })) {
    return { kind: 'signature_invalid', order: guest }
  }

  let payment: GatewayPayment
  try {
    payment = await gateway.fetchPayment(paymentId)
  } catch (err) {
    payload.logger.warn({
      msg: 'verify: fetchPayment failed; leaving it to the webhook/reconcile',
      order: guest.number,
      paymentId,
      ...(isGatewayError(err) ? { kind: err.kind, code: err.code } : {}),
    })
    return { kind: 'pending', order: guest }
  }
  if (payment.order_id !== attempt.orderId) {
    payload.logger.error({ msg: 'ALERT verify: payment belongs to another Razorpay order', order: guest.number, paymentId, rzpOrderId })
    return { kind: 'signature_invalid', order: guest }
  }
  if (payment.status === 'failed') {
    const r = await recordPaymentFailure(payload, { orderId: guest.id, payment, via })
    return { kind: 'pending', order: r.order ?? guest }
  }
  if (payment.status !== 'authorized' && payment.status !== 'captured') return { kind: 'pending', order: guest }
  const r = await markPaid(payload, { orderId: guest.id, payment, via })
  return { kind: 'done', outcome: r.outcome, order: r.order ?? guest }
}
