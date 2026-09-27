import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'

import { findOrderByNumber, findOrderForGuest, isOrderToken } from '../../commerce/checkout/orders'
import { recordPaymentFailure } from '../../commerce/checkout/payments'
import { reconcilePendingOrders } from '../../commerce/checkout/reconcile'
import { verifyPayment } from '../../commerce/checkout/verify'
import { claimEvent, finishEvent, processWebhookEvent, redactEvent, sha256 } from '../../commerce/checkout/webhook'
import { isOrderNumber } from '../../commerce/shared/order-status.js'
import { getEnv } from '../../env'
import { canRunJobs } from '../../jobs/access'
import { getClientIp, json, jsonError, readBodyText, readFormBody, withErrors } from '../../lib/http'
import { getGateway } from '../../payments'
import { isRazorpayOrderId, isRazorpayPaymentId } from '../../payments/signatures'
import { parseWebhookBody } from '../../payments/webhookPayload'
import { limit, queryParam } from './respond'

/**
 *   POST /api/payments/razorpay/callback?no=&t=   redirect-mode form POST → 303 STOREFRONT_URL/order?no=&t=
 *                                                  (+ &payment=failed&reason=<error[reason]> for error POSTs)
 *   POST /api/payments/razorpay/webhook            raw body, HMAC, event-id dedupe → 200 {ok, outcome} |
 *                                                  400 bad signature | 500 infrastructure failure
 *   GET  /api/payments/reconcile[?order=WF-…]      Vercel Cron (Bearer CRON_SECRET) or an admin → 200 summary
 */

// ---------------------------------------------------------------------------------------------- callback

const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/

function orderRedirect(no: string | null, t: string | null, failure?: { reason: string }): Response {
  const qs = new URLSearchParams()
  if (isOrderNumber(no)) qs.set('no', String(no).trim())
  if (isOrderToken(t)) qs.set('t', t as string)
  if (failure) {
    qs.set('payment', 'failed')
    if (REASON_RE.test(failure.reason)) qs.set('reason', failure.reason)
  }
  const q = qs.toString()
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${getEnv().storefrontUrl}/order${q ? `?${q}` : ''}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/** error[metadata] is a JSON string {"order_id":…,"payment_id":…}. */
function parseMetadata(raw: string | null): { order_id?: string; payment_id?: string } {
  if (!raw) return {}
  try {
    const m = JSON.parse(raw) as unknown
    return m && typeof m === 'object' ? (m as { order_id?: string; payment_id?: string }) : {}
  } catch {
    return {}
  }
}

/**
 * Razorpay's redirect mode (iOS, in-app browsers): a cross-site, cookie-less form POST from Checkout.
 * Success fields → the same verify as the client path (DB order id, HMAC, fetchPayment, markPaid 'callback').
 * error[...] fields are unsigned, so a failure is only recorded after the gateway confirms that payment
 * failed on one of this order's attempts; the customer is redirected with the reason either way.
 * Never renders anything: every outcome (bad signature, unknown order, errors) is a 303 to /order,
 * which polls the real status.
 */
const callback: PayloadHandler = async (req) => {
  const no = queryParam(req, 'no')
  const t = queryParam(req, 't')
  try {
    if (limit(req, 'callback')) return orderRedirect(no, t)
    const form = await readFormBody(req, { maxBytes: 8 * 1024 })
    const paymentId = form.get('razorpay_payment_id')
    if (paymentId) {
      const r = await verifyPayment(
        req.payload,
        { number: no, token: t, razorpay_order_id: form.get('razorpay_order_id'), razorpay_payment_id: paymentId, razorpay_signature: form.get('razorpay_signature') },
        'callback',
      )
      if (r.kind === 'signature_invalid') req.payload.logger.warn({ msg: 'SECURITY callback: bad payment signature', order: r.order.number, ip: getClientIp(req) })
      return orderRedirect(no, t)
    }
    const code = form.get('error[code]')
    const reason = form.get('error[reason]') ?? ''
    if (code || reason) {
      const meta = parseMetadata(form.get('error[metadata]'))
      const order = await findOrderForGuest(req.payload, no, t)
      const attempt = order?.razorpay?.attempts?.find((a) => a.orderId === meta.order_id)
      if (order && attempt && isRazorpayOrderId(meta.order_id) && isRazorpayPaymentId(meta.payment_id)) {
        try {
          const payment = await getGateway().fetchPayment(meta.payment_id)
          if (payment.order_id === attempt.orderId && payment.status === 'failed') {
            await recordPaymentFailure(req.payload, { orderId: order.id, payment, via: 'callback' })
          }
        } catch {
          // The payment.failed webhook will record it.
        }
      }
      return orderRedirect(no, t, { reason: reason.trim().toLowerCase() })
    }
    return orderRedirect(no, t)
  } catch (err) {
    req.payload.logger.error({ msg: 'payment callback failed', err: err instanceof Error ? err.message : String(err) })
    return orderRedirect(no, t)
  }
}

// ----------------------------------------------------------------------------------------------- webhook

/**
 * Razorpay webhooks. The raw body is read FIRST (before any parsing) and the signature checked over those
 * exact bytes with the current or the _OLD webhook secret. Then claim-dedupe-process (webhook.ts).
 * Non-events and unknown orders get 200 (a 4xx makes Razorpay retry for 24 h, then disable the hook).
 */
const webhook: PayloadHandler = async (req: PayloadRequest) => {
  let raw: string
  try {
    raw = await readBodyText(req, 256 * 1024)
  } catch {
    return jsonError(413, 'PAYLOAD_TOO_LARGE')
  }
  const signature = req.headers.get('x-razorpay-signature')
  let valid = false
  try {
    valid = getGateway().verifyWebhookSignature(raw, signature)
  } catch (err) {
    // Missing webhook secret: a configuration error. 500 so Razorpay retries once it's fixed.
    req.payload.logger.error({ msg: 'ALERT webhook secret not configured', err: err instanceof Error ? err.message : String(err) })
    return jsonError(500, 'INTERNAL')
  }
  if (!valid) {
    req.payload.logger.warn({ msg: 'SECURITY webhook with an invalid signature', ip: getClientIp(req) })
    return jsonError(400, 'SIGNATURE_INVALID', 'Invalid signature.')
  }
  const parsed = parseWebhookBody(raw)
  if (!parsed) {
    req.payload.logger.warn({ msg: 'webhook body is not a Razorpay event; ignored' })
    return json({ ok: true, outcome: 'ignored' }, { cache: 'no-store' })
  }
  let rawJson: Record<string, any> | null = null
  try {
    rawJson = JSON.parse(raw)
  } catch {
    rawJson = null
  }
  const rawSha256 = sha256(raw)
  const eventId = req.headers.get('x-razorpay-event-id')?.trim().slice(0, 100) || `sha256:${rawSha256}`
  try {
    const claim = await claimEvent(req.payload, {
      eventId,
      event: parsed.event,
      entityId: parsed.refund?.id ?? parsed.payment?.id ?? parsed.order?.id ?? rawJson?.payload?.dispute?.entity?.id ?? null,
      rawSha256,
      redacted: redactEvent(parsed, rawJson),
    })
    if (claim.processed) return json({ ok: true, outcome: 'duplicate' }, { cache: 'no-store' })
    const result = await processWebhookEvent(req.payload, parsed, rawJson)
    await finishEvent(req.payload, claim.id, result)
    return json({ ok: true, outcome: result.outcome }, { cache: 'no-store' })
  } catch (err) {
    req.payload.logger.error({ msg: 'webhook processing failed (Razorpay will retry)', event: parsed.event, eventId, err: err instanceof Error ? err.message : String(err) })
    return jsonError(500, 'INTERNAL')
  }
}

// --------------------------------------------------------------------------------------------- reconcile

/**
 * GET /api/payments/reconcile[?limit=25&budgetMs=20000][&order=WF-10001]
 * Vercel Cron (Authorization: Bearer $CRON_SECRET) every 5 minutes, or a signed-in admin ("reconcile now";
 * `order` limits the run to one order).
 */
const reconcile: PayloadHandler = withErrors(async (req) => {
  if (!canRunJobs({ req })) return jsonError(401, 'UNAUTHORIZED')
  const lim = Number(queryParam(req, 'limit'))
  const budget = Number(queryParam(req, 'budgetMs'))
  const number = queryParam(req, 'order')
  let only: number[] | undefined
  if (number !== null) {
    const order = isOrderNumber(number) ? await findOrderByNumber(req.payload, number) : null
    if (!order) return jsonError(404, 'NOT_FOUND', "We couldn't find that order.")
    only = [order.id]
  }
  const summary = await reconcilePendingOrders(req.payload, {
    limit: Number.isInteger(lim) && lim > 0 ? Math.min(lim, 100) : 25,
    budgetMs: Number.isInteger(budget) && budget > 0 ? Math.min(budget, 50_000) : 20_000,
    ...(only ? { only, force: true } : {}),
  })
  req.payload.logger.info({ msg: 'reconcilePendingOrders', ...summary })
  return json({ ok: true, ...summary }, { cache: 'no-store' })
})

export const paymentEndpoints: Endpoint[] = [
  { path: '/payments/razorpay/callback', method: 'post', handler: callback },
  { path: '/payments/razorpay/webhook', method: 'post', handler: webhook },
  { path: '/payments/reconcile', method: 'get', handler: reconcile },
]
