import type { PayloadRequest } from 'payload'

import type { CheckoutFailure } from '../../commerce/checkout/checkout'
import { checkoutErrorCopy } from '../../commerce/shared/errors.js'
import { getClientIp, jsonError } from '../../lib/http'
import { enforceRateLimit, type RateLimitOptions } from '../../lib/rateLimit'

/** SPEC §6 error body with the shared customer copy (an Issue in details.issues[0] names the product). */
export function failureResponse(f: Pick<CheckoutFailure, 'status' | 'code' | 'details'>): Response {
  const d = f.details as { issues?: unknown[] } | undefined
  const copySource = Array.isArray(d?.issues) && d.issues.length ? d.issues[0] : f.details
  return jsonError(f.status, f.code, checkoutErrorCopy(f.code, copySource), f.details)
}

/** One body for "unknown order" and "wrong token" (and malformed input): nothing to tell them apart. */
export const ORDER_NOT_FOUND_MESSAGE = "We couldn't find that order."
export const orderNotFound = (): Response => jsonError(404, 'NOT_FOUND', ORDER_NOT_FOUND_MESSAGE)

/** Rate limits (per server instance, per client IP unless keyed otherwise). */
export const LIMITS = {
  quote: { limit: 60, windowMs: 60_000 },
  checkout: { limit: 20, windowMs: 60_000 },
  retry: { limit: 20, windowMs: 60_000 },
  verify: { limit: 30, windowMs: 60_000 },
  callback: { limit: 30, windowMs: 60_000 },
  /** /order polls up to ~35 times in 2 minutes per open tab (storefront-checkout.md §3). */
  status: { limit: 240, windowMs: 60_000 },
  statusPerOrder: { limit: 60, windowMs: 60_000 },
  mine: { limit: 30, windowMs: 60_000 },
} satisfies Record<string, RateLimitOptions>

export const limit = (req: PayloadRequest, route: keyof typeof LIMITS, key?: string): Response | null =>
  enforceRateLimit(req, `checkout:${route}`, LIMITS[route], key ? { key: `${getClientIp(req)}|${key}` } : {})

export const queryParam = (req: PayloadRequest, name: string): string | null => {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams.get(name)
  } catch {
    return null
  }
}
