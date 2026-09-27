import type { Endpoint, PayloadHandler } from 'payload'

import { IDEMPOTENCY_KEY_RE, isFailure, placeOrder } from '../../commerce/checkout/checkout'
import { toOrderStatusDTO } from '../../commerce/checkout/dto'
import { retryPayment } from '../../commerce/checkout/retry'
import { serverQuote } from '../../commerce/checkout/quote'
import { quoteSupersedeView } from '../../commerce/checkout/supersede'
import { verifyPayment } from '../../commerce/checkout/verify'
import { getStoreSettings } from '../../commerce/settings'
import { cartSignature } from '../../commerce/shared/cart-links.js'
import { parseItems } from '../../commerce/shared/pricing.js'
import { normalizeEmail, normalizePin, PIN_RE } from '../../commerce/shared/validate.js'
import { getClientIp, json, jsonError, readJsonBody, withErrors } from '../../lib/http'
import { failureResponse, limit, orderNotFound } from './respond'

/**
 * JSON checkout endpoints (SPEC §6). Contract with request/response examples:
 * SCRATCH/contracts/checkout-backend.md.
 *
 *   POST /api/store/quote              {items, couponCode?, email?, pin?, method?, supersede?:{number, token}} → 200 {quote}
 *   POST /api/store/checkout           Idempotency-Key + body (+ supersede?:{number, token}) → 201/200 {order, payment}
 *   POST /api/store/checkout/retry     {number, token}                               → 200 {order, payment}
 *   POST /api/store/checkout/verify    {number, token, razorpay_*}                   → 200/202 {order: OrderStatusDTO}
 */

const quote: PayloadHandler = withErrors(async (req) => {
  const limited = limit(req, 'quote')
  if (limited) return limited
  const body = await readJsonBody(req, { maxBytes: 8 * 1024 })
  let items: unknown = body.items
  let cartSig: string | null = null
  if (!(Array.isArray(items) && items.length === 0)) {
    const parsed = parseItems(items)
    if (!parsed.ok) return failureResponse({ status: 400, code: parsed.error.code, details: parsed.error.details })
    items = parsed.items
    cartSig = cartSignature(parsed.items)
  }
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : null
  const pinRaw = typeof body.pin === 'string' || typeof body.pin === 'number' ? normalizePin(body.pin) : ''
  const pin = PIN_RE.test(pinRaw) ? pinRaw : null
  // The order this bag would replace ("Pay on delivery instead"): its held units and coupon reservation
  // count for this quote the way placeOrder counts them (PI-SF-1). Silently ignored unless it qualifies.
  const now = Date.now()
  const view =
    cartSig && body.supersede !== undefined
      ? await quoteSupersedeView(req.payload, body.supersede, {
          cartSig,
          now,
          reservationMinutes: (await getStoreSettings(req.payload)).server.reservationMinutes,
        })
      : null
  const { quote: q } = await serverQuote(req.payload, {
    items,
    couponCode: body.couponCode,
    method: body.method,
    email,
    pin,
    now,
    ...(view ? { extraStock: view.extraStock, excludeOrderIds: view.excludeOrderIds } : {}),
  })
  return json({ quote: q }, { cache: 'no-store' })
})

const checkout: PayloadHandler = withErrors(async (req) => {
  const limited = limit(req, 'checkout')
  if (limited) return limited
  const key = req.headers.get('idempotency-key')?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_RE.test(key)) return failureResponse({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' })
  const body = await readJsonBody(req, { maxBytes: 16 * 1024 })
  const customerId = req.user?.collection === 'customers' ? Number(req.user.id) : null
  const result = await placeOrder(req.payload, { body, idempotencyKey: key.toLowerCase(), customerId })
  if (isFailure(result)) return failureResponse(result)
  return json(result.body, { status: result.status, cache: 'no-store' })
})

const retry: PayloadHandler = withErrors(async (req) => {
  const limited = limit(req, 'retry')
  if (limited) return limited
  const body = await readJsonBody(req, { maxBytes: 2 * 1024 })
  const result = await retryPayment(req.payload, { number: body.number, token: body.token })
  if (isFailure(result)) return result.code === 'NOT_FOUND' ? orderNotFound() : failureResponse(result)
  return json(result.body, { status: 200, cache: 'no-store' })
})

const verify: PayloadHandler = withErrors(async (req) => {
  const limited = limit(req, 'verify')
  if (limited) return limited
  const body = await readJsonBody(req, { maxBytes: 2 * 1024 })
  const r = await verifyPayment(
    req.payload,
    {
      number: body.number,
      token: body.token,
      razorpay_order_id: body.razorpay_order_id,
      razorpay_payment_id: body.razorpay_payment_id,
      razorpay_signature: body.razorpay_signature,
    },
    'client',
  )
  if (r.kind === 'bad_request') return jsonError(400, 'VALIDATION', 'That payment confirmation looks incomplete.')
  if (r.kind === 'not_found') return orderNotFound()
  if (r.kind === 'signature_invalid') {
    req.payload.logger.warn({ msg: 'SECURITY verify: bad payment signature', order: r.order.number, ip: getClientIp(req) })
    return failureResponse({ status: 400, code: 'SIGNATURE_INVALID' })
  }
  const settings = await getStoreSettings(req.payload)
  const dto = toOrderStatusDTO(r.order, { shippingPromiseText: settings.public.shippingPromiseText })
  return json({ order: dto }, { status: r.kind === 'pending' ? 202 : 200, cache: 'no-store' })
})

export const storeCheckoutEndpoints: Endpoint[] = [
  { path: '/store/quote', method: 'post', handler: quote },
  { path: '/store/checkout', method: 'post', handler: checkout },
  { path: '/store/checkout/retry', method: 'post', handler: retry },
  { path: '/store/checkout/verify', method: 'post', handler: verify },
]
