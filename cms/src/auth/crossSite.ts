import { APIError, type PayloadRequest } from 'payload'

/**
 * Login CSRF guard for the auth operations that answer with a session cookie or act on an account without
 * one: login, signup (create), forgot-password and reset-password, on `customers` and `users`.
 *
 * Payload's `csrf` allow-list only decides whether an incoming cookie JWT is trusted. It does not stop a
 * credentialed login POST from another site: an HTML form may POST `multipart/form-data` (Payload reads the
 * JSON from a `_payload` part) cross-site without a CORS preflight, and the Set-Cookie (SameSite=Lax) of a
 * top-level navigation is stored. One drive-by visit would sign the shopper's browser into the attacker's
 * account, and every order they then place would be linked to it.
 *
 * Rule (the same signals Payload uses for cookie auth, see payload/dist/auth/extractJWT.js):
 *   - an `Origin` header is present   → it must be in config.csrf (STOREFRONT_ORIGINS + the CMS itself);
 *                                       "null" (opaque origins, no-referrer navigations) never is;
 *   - no `Origin`, a browser request  → refused when `Sec-Fetch-Site: cross-site`;
 *   - no `Origin` and no Sec-Fetch-*  → allowed (server-to-server callers, scripts, tests).
 * The storefront reaches the CMS same-origin (Vercel rewrite / dev proxy) and the admin UI is served by the
 * CMS, so neither is affected. The Local API is never checked.
 */

export const CROSS_SITE_AUTH_MESSAGE = 'Sign-in requests must come from the Wefeasto website.'

/**
 * Explicit error name (survives minification): payload.config.ts logs it at info level, like the other
 * expected refusals, instead of error + stack.
 */
export const CROSS_SITE_AUTH_ERROR = 'CrossSiteAuthError'

/** 403, public message, `data.code: 'CROSS_SITE'`. */
export class CrossSiteAuthError extends APIError<{ code: 'CROSS_SITE' }> {
  constructor() {
    super(CROSS_SITE_AUTH_MESSAGE, 403, { code: 'CROSS_SITE' }, true)
    this.name = CROSS_SITE_AUTH_ERROR
  }
}

type ReqLike = Pick<Partial<PayloadRequest>, 'headers' | 'payloadAPI'> & {
  payload?: { config?: { csrf?: string[] } }
}

/** True when `req` is a browser request from a site outside the CSRF allow-list. */
export function isCrossSiteRequest(req: ReqLike): boolean {
  if (req.payloadAPI === 'local' || !req.headers) return false
  const allowed = req.payload?.config?.csrf ?? []
  const origin = req.headers.get('origin')
  if (origin !== null) {
    if (allowed.length === 0) return false
    return !allowed.includes(origin.trim())
  }
  return (req.headers.get('sec-fetch-site') ?? '').trim().toLowerCase() === 'cross-site'
}

/** Throws CrossSiteAuthError (403) for a cross-site auth write. */
export function refuseCrossSiteAuth(req: ReqLike): void {
  if (isCrossSiteRequest(req)) throw new CrossSiteAuthError()
}

/** Auth operations that must never be driven from another site. */
export const CROSS_SITE_GUARDED_OPERATIONS = ['create', 'login', 'forgotPassword', 'resetPassword'] as const

export const isGuardedAuthOperation = (operation: string): boolean =>
  (CROSS_SITE_GUARDED_OPERATIONS as readonly string[]).includes(operation)
