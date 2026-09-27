import type { Endpoint, PayloadHandler } from 'payload'

import { AUTH_LIMITS } from '../../auth/rateLimits'
import { resendVerificationEmail } from '../../auth/resendVerification'
import { normalizeEmail } from '../../commerce/shared/validate.js'
import { HttpError, json, jsonError, readJsonBody, withErrors } from '../../lib/http'
import { rateLimit } from '../../lib/rateLimit'
import { afterResponse } from '../../retention/background'

/**
 * Account endpoints — OWNER: cms-hardening. Contract: SCRATCH/contracts/cms-hardening.md.
 *
 *   POST /api/store/account/resend-verification  {email}
 *     200 {ok:true}  for ANY well-formed email: unknown, already verified, or a repeat inside 10 minutes
 *                    (nothing is sent then). No account oracle: same body, and the lookup + email run after
 *                    the response, so the timing does not tell either.
 *     400 VALIDATION {fields:{email:'INVALID'}} malformed email · 400 INVALID_JSON · 415 · 413
 *     429 RATE_LIMITED (5/min per IP) with Retry-After.
 *   For an existing unverified customer it regenerates the verification token (the old link stops working)
 *   and sends the signup verification email again (same template and link format).
 */

export const RESEND_VERIFICATION_PATH = '/store/account/resend-verification'

const resendVerification: PayloadHandler = withErrors(async (req) => {
  const limits = AUTH_LIMITS.resendVerification
  const byIp = rateLimit(req, 'auth:resendVerification:ip', limits.ip)
  if (!byIp.ok) {
    return jsonError(429, 'RATE_LIMITED', undefined, { retryAfterSeconds: byIp.retryAfterSeconds }, {
      'Retry-After': String(byIp.retryAfterSeconds),
    })
  }
  const body = await readJsonBody<{ email?: unknown }>(req, { maxBytes: 2 * 1024 })
  const email = normalizeEmail(body.email)
  if (!email) throw new HttpError(400, 'VALIDATION', 'Enter a valid email address.', { fields: { email: 'INVALID' } })

  // 1 per 10 minutes per address, counted whether or not the account exists: over it, answer the same 200
  // and send nothing (no oracle, no inbox flooding).
  const byEmail = rateLimit(req, 'auth:resendVerification:email', limits.email!, { key: email })
  if (byEmail.ok) {
    await afterResponse(req.payload, 'resend verification', async () => {
      const outcome = await resendVerificationEmail(req.payload, email)
      req.payload.logger.debug?.({ msg: 'resend verification', outcome })
    })
  }
  return json({ ok: true }, { cache: 'no-store' })
})

export const accountEndpoints: Endpoint[] = [
  { path: RESEND_VERIFICATION_PATH, method: 'post', handler: resendVerification },
]
