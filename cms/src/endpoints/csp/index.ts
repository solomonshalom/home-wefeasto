import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'

import { HttpError, readBodyText, withErrors } from '../../lib/http'
import { enforceRateLimit } from '../../lib/rateLimit'
import { groupViolations, parseCspReports } from './report'

/**
 * CSP report collector — the storefront's report-only Content-Security-Policy (vercel.json: `report-uri` and
 * `report-to csp` + `Reporting-Endpoints: csp="/api/store/csp-report"`) sends its violations here through the
 * /api rewrite, so the owner can see what the real pages (checkout + Razorpay included) load before enforcing it
 * (research/razorpay.md §10: roll out report-only first).
 *
 *   POST /api/store/csp-report   Content-Type application/csp-report | application/reports+json | application/json
 *                                → 204, one info log line `csp violation` per distinct violation (at most
 *                                  MAX_LOGGED per request, then one line with the number dropped);
 *                                415 UNSUPPORTED_MEDIA_TYPE, 413 PAYLOAD_TOO_LARGE (> 64 KiB), 400 INVALID_JSON,
 *                                400 VALIDATION (not a report), 429 RATE_LIMITED (30/min/IP).
 *
 * Unauthenticated by design (browsers send reports without asking). It stores nothing and logs only
 * origin + path of URLs (report.ts): no query strings (guest tokens), user agent, IP or referrer.
 */

export const CSP_REPORT_PATH = '/store/csp-report'
export const CSP_REPORT_TYPES = ['application/csp-report', 'application/reports+json', 'application/json'] as const
/** A Chromium batch holds up to a minute of reports, each carrying the ~1 KiB policy text. */
export const CSP_REPORT_MAX_BYTES = 64 * 1024
export const CSP_REPORT_MAX_LOGGED = 10
const LIMIT = { limit: 30, windowMs: 60_000 }

const mediaType = (req: Partial<PayloadRequest>): string =>
  (req.headers?.get('content-type') ?? '').split(';')[0].trim().toLowerCase()

const noContent = (): Response => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })

const collect: PayloadHandler = withErrors(async (req) => {
  const limited = enforceRateLimit(req, 'csp-report', LIMIT)
  if (limited) return limited
  if (!(CSP_REPORT_TYPES as readonly string[]).includes(mediaType(req))) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a CSP violation report.')
  }
  const text = await readBodyText(req, CSP_REPORT_MAX_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'INVALID_JSON')
  }
  const { violations, other } = parseCspReports(parsed)
  if (violations.length === 0 && other === 0) throw new HttpError(400, 'VALIDATION', 'Expected a CSP violation report.')

  const groups = groupViolations(violations)
  for (const csp of groups.slice(0, CSP_REPORT_MAX_LOGGED)) req.payload.logger.info({ msg: 'csp violation', csp })
  if (groups.length > CSP_REPORT_MAX_LOGGED) {
    req.payload.logger.info({ msg: 'csp violation', dropped: groups.length - CSP_REPORT_MAX_LOGGED })
  }
  return noContent()
})

export const cspEndpoints: Endpoint[] = [{ path: CSP_REPORT_PATH, method: 'post', handler: collect }]
