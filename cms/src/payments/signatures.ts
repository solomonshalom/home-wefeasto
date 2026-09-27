import crypto from 'node:crypto'

/**
 * Razorpay signatures (razorpay.md §5, §6), verified timing-safe. The SDK's own helpers compare with `===`,
 * throw on missing input and silently fail on parsed bodies (razorpay.md §2.2), so we never use them.
 *
 *   Checkout / redirect callback:  hex(HMAC_SHA256(key_secret, order_id + '|' + payment_id))
 *   Webhook:                       hex(HMAC_SHA256(webhook_secret, <raw request body bytes>))
 *
 * Verification never throws for bad *input* (wrong types, odd lengths, non-hex): it returns false.
 * A missing secret is a configuration error and throws (env.ts refuses to boot razorpay mode without one).
 */

/** Razorpay ids are "14 characters, alphanumeric" after the prefix; kept open-ended to be lenient. */
export const RAZORPAY_ID_PATTERNS = {
  order: /^order_[A-Za-z0-9]{14,40}$/,
  payment: /^pay_[A-Za-z0-9]{14,40}$/,
  refund: /^rfnd_[A-Za-z0-9]{14,40}$/,
} as const

export const isRazorpayOrderId = (v: unknown): v is string => typeof v === 'string' && RAZORPAY_ID_PATTERNS.order.test(v)
export const isRazorpayPaymentId = (v: unknown): v is string => typeof v === 'string' && RAZORPAY_ID_PATTERNS.payment.test(v)
export const isRazorpayRefundId = (v: unknown): v is string => typeof v === 'string' && RAZORPAY_ID_PATTERNS.refund.test(v)

const HEX_SHA256 = /^[0-9a-f]{64}$/

/** Constant-time comparison of two lowercase hex SHA-256 digests. `expected` is trusted, `given` is not. */
export function hexDigestEquals(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !HEX_SHA256.test(given) || !HEX_SHA256.test(expected)) return false
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(given, 'hex')
  // Both are 32 bytes after the regex checks; the length check keeps timingSafeEqual from throwing regardless.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const requireSecret = (secret: unknown, what: string): string => {
  if (typeof secret !== 'string' || secret === '') throw new Error(`${what} is not configured`)
  return secret
}

/** The Checkout signature Razorpay would send for this pair (tests and the mock gateway). */
export function signPayment(orderId: string, paymentId: string, keySecret: string): string {
  requireSecret(keySecret, 'Razorpay key secret')
  return crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex')
}

/**
 * Checkout handler / redirect callback verification. `orderId` MUST be the Razorpay order id stored on OUR
 * order (razorpay.md §5: "Do not use the razorpay_order_id returned by Checkout"). Returns false for
 * malformed ids so `pay_x|undefined`-style inputs can never be signed by accident.
 */
export function verifyPaymentSignature(input: {
  orderId: unknown
  paymentId: unknown
  signature: unknown
  keySecret: string
}): boolean {
  const secret = requireSecret(input.keySecret, 'Razorpay key secret')
  if (!isRazorpayOrderId(input.orderId) || !isRazorpayPaymentId(input.paymentId)) return false
  const expected = crypto.createHmac('sha256', secret).update(`${input.orderId}|${input.paymentId}`).digest('hex')
  return hexDigestEquals(expected, input.signature)
}

type RawBody = string | Uint8Array

const isRawBody = (v: unknown): v is RawBody => typeof v === 'string' || v instanceof Uint8Array

/** The `X-Razorpay-Signature` for a raw body (tests and the mock gateway). */
export function signWebhook(rawBody: RawBody, webhookSecret: string): string {
  requireSecret(webhookSecret, 'Razorpay webhook secret')
  return crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
}

/**
 * Webhook verification over the RAW body exactly as received (call `readBodyText(req)` first; never
 * re-serialise parsed JSON). `secrets` is the current secret, optionally followed by the old one during a
 * rotation (RAZORPAY_WEBHOOK_SECRET_OLD): the body is accepted when any of them matches. Empty entries are
 * ignored; at least one non-empty secret is required. A parsed object is refused (returns false).
 */
export function verifyWebhookSignature(
  rawBody: unknown,
  signature: unknown,
  secrets: string | readonly (string | null | undefined)[],
): boolean {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (s): s is string => typeof s === 'string' && s !== '',
  )
  if (!list.length) throw new Error('Razorpay webhook secret is not configured')
  if (!isRawBody(rawBody)) return false
  if (typeof signature !== 'string' || !HEX_SHA256.test(signature)) return false
  let ok = false
  // Check every secret (no early exit) so timing does not reveal which secret matched.
  for (const secret of list) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    if (hexDigestEquals(expected, signature)) ok = true
  }
  return ok
}
