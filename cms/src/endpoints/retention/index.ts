import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'

import { normalizeEmail } from '../../commerce/shared/validate.js'
import { HttpError, json, jsonError, readJsonBody, withErrors } from '../../lib/http'
import { enforceRateLimit } from '../../lib/rateLimit'
import { afterResponse } from '../../retention/background'
import { setHouseholdSize } from '../../retention/household'
import { CONFIRM_PATH, NEWSLETTER_PATH, type NewsletterOutcome, storefrontNewsletterUrl, UNSUBSCRIBE_PATH } from '../../retention/links'
import { confirmSubscription, requestSubscription, unsubscribeByToken } from '../../retention/subscribers'
import { ensureWelcome } from '../../retention/welcome'
import { errMessage } from '../../retention/util'
// Registers the retention order-event handlers (checkout consent, refill reminders) at module scope.
import '../../retention/register'
import { checkoutEndpoints } from '../checkout'

/**
 * Retention endpoints — OWNER: retention agent. Contract: SCRATCH/contracts/retention-backend.md.
 *
 *   POST /api/store/newsletter                 {email, website?} → 200 {ok:true} for any well-formed input
 *                                              (no membership oracle; filled honeypot `website` = silent no-op),
 *                                              400 VALIDATION {fields:{email:'INVALID'}}, 429 RATE_LIMITED (5/min/IP).
 *   GET  /api/store/newsletter/confirm?t=      303 → STOREFRONT_URL/?subscribed=1#newsletter
 *                                              (expired/unknown link → ?subscribed=expired, server error → ?subscribed=error)
 *   GET  /api/store/newsletter/unsubscribe?t=  303 → STOREFRONT_URL/?unsubscribed=1#newsletter
 *                                              (unknown link → ?unsubscribed=invalid, server error → ?unsubscribed=error)
 *   POST /api/store/newsletter/unsubscribe?t=  RFC 8058 one-click (List-Unsubscribe-Post) → 200 {ok:true};
 *                                              404 NOT_FOUND unknown link, 400 VALIDATION malformed.
 *
 *   POST /api/store/orders/household          {number, token, size} → 200 {ok:true}; stores orders.householdSize
 *                                              and emits `order.household_updated` (refill timing).
 *                                              404 NOT_FOUND (unknown order or wrong token, same body),
 *                                              400 VALIDATION {fields:{size:'INVALID'}}, 429 RATE_LIMITED (20/min/IP).
 *                                              Served here unless the checkout registry already registers the
 *                                              same route (then retention steps aside: no duplicate at boot).
 */

const SIGNUP_LIMIT = { limit: 5, windowMs: 60_000 }
/** Link clicks and one-click POSTs (tokens are 256-bit; this only blunts scanning). */
const LINK_LIMIT = { limit: 60, windowMs: 60_000 }

function tokenParam(req: PayloadRequest): string | null {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams.get('t')
  } catch {
    return null
  }
}

function redirect(outcome: NewsletterOutcome): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: storefrontNewsletterUrl(outcome),
      'Cache-Control': 'no-store',
      // The token is in this URL: don't leak it onwards.
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/** Link handlers answer browsers from an email: a failure becomes a redirect, never a JSON 500 page. */
function linkHandler(fallback: NewsletterOutcome, handler: PayloadHandler): PayloadHandler {
  return async (req) => {
    try {
      return await handler(req)
    } catch (err) {
      req.payload.logger.error({ msg: `newsletter link failed: ${req.method} ${req.url?.split('?')[0]}`, err: errMessage(err) })
      return redirect(fallback)
    }
  }
}

const signup: PayloadHandler = withErrors(async (req) => {
  const limited = enforceRateLimit(req, 'newsletter', SIGNUP_LIMIT)
  if (limited) return limited
  const body = await readJsonBody<{ email?: unknown; website?: unknown }>(req, { maxBytes: 2 * 1024 })

  // Honeypot: humans never see `website`. Answer exactly like a success and do nothing.
  const honeypot = typeof body.website === 'string' ? body.website.trim() : body.website
  if (honeypot) return json({ ok: true }, { cache: 'no-store' })

  const email = normalizeEmail(body.email)
  if (!email) throw new HttpError(400, 'VALIDATION', 'Enter a valid email address.', { fields: { email: 'INVALID' } })

  await afterResponse(req.payload, 'newsletter sign-up', async () => {
    const result = await requestSubscription(req.payload, email)
    req.payload.logger.debug?.({ msg: 'newsletter sign-up', outcome: result.outcome, email: result.email })
  })
  return json({ ok: true }, { cache: 'no-store' })
})

const confirm: PayloadHandler = linkHandler({ subscribed: 'error' }, async (req) => {
  const limited = enforceRateLimit(req, 'newsletter-link', LINK_LIMIT)
  if (limited) return redirect({ subscribed: 'error' })
  const { outcome, subscriber } = await confirmSubscription(req.payload, tokenParam(req))
  if (outcome === 'expired' || outcome === 'invalid') return redirect({ subscribed: 'expired' })
  if (subscriber) {
    // First confirmation: welcome code + email. Also retried on a repeat click if it never went out.
    await afterResponse(req.payload, 'newsletter welcome', () => ensureWelcome(req.payload, subscriber))
  }
  return redirect({ subscribed: '1' })
})

const unsubscribeGet: PayloadHandler = linkHandler({ unsubscribed: 'error' }, async (req) => {
  const limited = enforceRateLimit(req, 'newsletter-link', LINK_LIMIT)
  if (limited) return redirect({ unsubscribed: 'error' })
  const outcome = await unsubscribeByToken(req.payload, tokenParam(req))
  return redirect(outcome === 'invalid' ? { unsubscribed: 'invalid' } : { unsubscribed: '1' })
})

/** RFC 8058: the mail provider POSTs `List-Unsubscribe=One-Click` to the header URL (no cookies, no redirects). */
const unsubscribePost: PayloadHandler = withErrors(async (req) => {
  const limited = enforceRateLimit(req, 'newsletter-link', LINK_LIMIT)
  if (limited) return limited
  const token = tokenParam(req)
  if (!token) throw new HttpError(400, 'VALIDATION', 'This unsubscribe link is incomplete.')
  const outcome = await unsubscribeByToken(req.payload, token)
  if (outcome === 'invalid') return jsonError(404, 'NOT_FOUND', 'This unsubscribe link is not valid.')
  return json({ ok: true }, { cache: 'no-store' })
})

export const HOUSEHOLD_PATH = '/store/orders/household'
const HOUSEHOLD_LIMIT = { limit: 20, windowMs: 60_000 }
const ORDER_NOT_FOUND = "We couldn't find that order."

const household: PayloadHandler = withErrors(async (req) => {
  const limited = enforceRateLimit(req, 'orders-household', HOUSEHOLD_LIMIT)
  if (limited) return limited
  const body = await readJsonBody<{ number?: unknown; token?: unknown; size?: unknown }>(req, { maxBytes: 1024 })
  const result = await setHouseholdSize(req, { number: body.number, token: body.token, size: body.size })
  if (result.outcome === 'not-found') return jsonError(404, 'NOT_FOUND', ORDER_NOT_FOUND)
  if (result.outcome === 'invalid-size') {
    throw new HttpError(400, 'VALIDATION', 'Choose how many people eat breakfast (1–20).', { fields: { size: 'INVALID' } })
  }
  return json({ ok: true }, { cache: 'no-store' })
})

const householdOwnedByCheckout = checkoutEndpoints.some((e) => e.method === 'post' && e.path === HOUSEHOLD_PATH)

export const retentionEndpoints: Endpoint[] = [
  { path: NEWSLETTER_PATH, method: 'post', handler: signup },
  { path: CONFIRM_PATH, method: 'get', handler: confirm },
  { path: UNSUBSCRIBE_PATH, method: 'get', handler: unsubscribeGet },
  { path: UNSUBSCRIBE_PATH, method: 'post', handler: unsubscribePost },
  ...(householdOwnedByCheckout ? [] : [{ path: HOUSEHOLD_PATH, method: 'post' as const, handler: household }]),
]
