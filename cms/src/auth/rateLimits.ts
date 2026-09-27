import { APIError, type PayloadRequest } from 'payload'

import { userIsStaff } from '../access/roles'
import { getClientIp } from '../lib/http'
import { rateLimit, type RateLimitOptions, type RateLimitResult } from '../lib/rateLimit'

/**
 * Rate limits for the customer auth flows (Payload's built-in /api/customers/* operations and our
 * /api/store/account/* endpoints). In-memory, per server instance (see src/lib/rateLimit.ts): they blunt
 * credential stuffing, signup spam and email bombing from one client; they are not a global quota.
 * Payload's own per-account lockout (5 bad passwords → 10 min) still applies on top of the login limit.
 *
 * Never applied to the Local API (server code, seed, tests) or to signed-in staff (admin UI).
 * RATE_LIMIT_DISABLED=1 turns every limit off.
 *
 * Over the limit, the built-in routes answer Payload's error shape with status 429 and a Retry-After header:
 *   429 { errors: [{ name, message, data: { code: 'RATE_LIMITED', retryAfterSeconds } }] }
 * (custom endpoints answer our own { error: { code: 'RATE_LIMITED', … } } via enforceRateLimit).
 */

const MIN = 60_000

export type AuthAction = 'signup' | 'login' | 'forgotPassword' | 'resetPassword' | 'verify' | 'resendVerification'

export type AuthLimit = { ip: RateLimitOptions; email?: RateLimitOptions }

export const AUTH_LIMITS: Record<AuthAction, AuthLimit> = {
  signup: { ip: { limit: 5, windowMs: 10 * MIN } },
  login: { ip: { limit: 10, windowMs: MIN } },
  forgotPassword: { ip: { limit: 5, windowMs: 10 * MIN }, email: { limit: 3, windowMs: 60 * MIN } },
  resetPassword: { ip: { limit: 10, windowMs: 10 * MIN } },
  verify: { ip: { limit: 10, windowMs: 10 * MIN } },
  resendVerification: { ip: { limit: 5, windowMs: MIN }, email: { limit: 1, windowMs: 10 * MIN } },
}

export const RATE_LIMITED_MESSAGE = 'Too many attempts. Please wait a moment and try again.'

/** Server code and staff are never limited. */
export function isExemptFromAuthLimits(req: Partial<PayloadRequest>): boolean {
  return req.payloadAPI === 'local' || userIsStaff(req.user ?? null)
}

const normalise = (email: unknown): string | null =>
  typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null

/**
 * Counts one hit of `action` for the client IP (and for `email` when the action has an email limit).
 * The IP bucket is counted first; when it is already full the email bucket is left alone.
 */
export function hitAuthLimit(
  req: Partial<PayloadRequest>,
  action: AuthAction,
  { email }: { email?: unknown } = {},
): { ok: true } | { ok: false; scope: 'ip' | 'email'; result: RateLimitResult } {
  const limits = AUTH_LIMITS[action]
  const byIp = rateLimit(req, `auth:${action}:ip`, limits.ip, { key: getClientIp(req) })
  if (!byIp.ok) return { ok: false, scope: 'ip', result: byIp }
  const key = limits.email ? normalise(email) : null
  if (limits.email && key) {
    const byEmail = rateLimit(req, `auth:${action}:email`, limits.email, { key })
    if (!byEmail.ok) return { ok: false, scope: 'email', result: byEmail }
  }
  return { ok: true }
}

/** Payload-shaped 429 (for built-in operations): sets Retry-After on the response and throws. */
export function throwRateLimited(req: Partial<PayloadRequest>, retryAfterSeconds: number): never {
  const headers = new Headers(req.responseHeaders ?? undefined)
  headers.set('Retry-After', String(retryAfterSeconds))
  if (req) (req as PayloadRequest).responseHeaders = headers
  throw new APIError(RATE_LIMITED_MESSAGE, 429, { code: 'RATE_LIMITED', retryAfterSeconds }, true)
}

/** For the built-in operations: exempt callers pass; otherwise count and throw 429 when over. */
export function enforceAuthLimit(req: Partial<PayloadRequest>, action: AuthAction, extra: { email?: unknown } = {}): void {
  if (isExemptFromAuthLimits(req)) return
  const hit = hitAuthLimit(req, action, extra)
  if (!hit.ok) throwRateLimited(req, hit.result.retryAfterSeconds)
}
