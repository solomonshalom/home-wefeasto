import { REST_DELETE, REST_GET, REST_PATCH, REST_POST, REST_PUT } from '@payloadcms/next/routes'

import config from '@/payload.config'

/**
 * Drives the real Payload REST stack (routing, auth, CSRF, access control, custom endpoints) in-process,
 * exactly like the Next route file src/app/(payload)/api/[...slug]/route.ts, without a server.
 *
 *   const res = await restPost('customers/login', { body: { email, password }, origin: STOREFRONT_ORIGIN })
 *   res.status, res.body (parsed JSON or null), res.text, res.headers, res.cookie ('payload-token=…' | null)
 *   await restGet('customers/me', { token: jwtOf(res) })          // Authorization: JWT <token>
 *   await restGet('customers/me', { cookie: res.cookie })         // cookie auth; Origin defaults to the storefront
 *
 * Customers have auth.removeTokenFromResponses: the JWT is ONLY in the Set-Cookie payload-token (never in
 * the JSON body). jwtOf(res) reads it from there (and falls back to body.token for staff `users`).
 */

export const STOREFRONT_ORIGIN = 'http://localhost:5173'
export const API_BASE = 'http://localhost:3000/api'

const handlers = {
  GET: REST_GET(config),
  POST: REST_POST(config),
  PATCH: REST_PATCH(config),
  PUT: REST_PUT(config),
  DELETE: REST_DELETE(config),
} as const

export type Method = keyof typeof handlers

export type CallOptions = {
  /** JSON-serialised with Content-Type: application/json. */
  body?: unknown
  /** Sent as-is (use with contentType). Wins over `body`. */
  rawBody?: string | URLSearchParams
  /** Content-Type override; null sends none. */
  contentType?: string | null
  headers?: Record<string, string>
  /** Adds `Authorization: JWT <token>`. */
  token?: string
  /** Cookie header value, e.g. res.cookie from a login. */
  cookie?: string | null
  /**
   * Origin header. Defaults to STOREFRONT_ORIGIN when a cookie is sent (browsers send Origin, and
   * Payload ignores cookie auth from origins outside the CSRF allowlist). Pass null to omit it.
   */
  origin?: string | null
  /** Query string (without '?') or a record. */
  query?: string | Record<string, string>
}

export type RestResult<T = any> = {
  status: number
  headers: Headers
  /** Parsed JSON body, or null when the body is not JSON. */
  body: T
  text: string
  setCookie: string[]
  /** `payload-token=<jwt>` when the response set a live token cookie; null when it cleared it or set none. */
  cookie: string | null
}

export async function call(method: Method, path: string, opts: CallOptions = {}): Promise<Response> {
  const clean = path.replace(/^\/+/, '').replace(/^api\//, '')
  const url = new URL(`${API_BASE}/${clean}`)
  if (opts.query) {
    const qs = typeof opts.query === 'string' ? opts.query : new URLSearchParams(opts.query).toString()
    url.search = qs.replace(/^\?/, '')
  }
  const headers = new Headers(opts.headers)
  let body: string | undefined
  if (opts.rawBody !== undefined) body = opts.rawBody.toString()
  else if (opts.body !== undefined) body = JSON.stringify(opts.body)
  const contentType = opts.contentType === undefined ? (body !== undefined ? 'application/json' : undefined) : opts.contentType
  if (contentType) headers.set('Content-Type', contentType)
  if (opts.token) headers.set('Authorization', `JWT ${opts.token}`)
  if (opts.cookie) headers.set('Cookie', opts.cookie)
  const origin = opts.origin === undefined ? (opts.cookie ? STOREFRONT_ORIGIN : undefined) : opts.origin
  if (origin) headers.set('Origin', origin)

  const request = new Request(url, { method, headers, body })
  const slug = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean)
  return handlers[method](request, { params: Promise.resolve({ slug }) })
}

export function tokenCookieFrom(setCookie: string[]): string | null {
  for (const c of setCookie) {
    const m = /^payload-token=([^;]*)/.exec(c)
    if (!m) continue
    const expired = /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c)
    return m[1] && !expired ? `payload-token=${m[1]}` : null
  }
  return null
}

/** The JWT a login / refresh / reset response issued: the live payload-token cookie value, else body.token. */
export function jwtOf(res: Pick<RestResult, 'cookie' | 'body'>): string {
  const fromCookie = res.cookie?.replace(/^payload-token=/, '')
  const token = fromCookie || (res.body && typeof res.body.token === 'string' ? (res.body.token as string) : '')
  if (!token) throw new Error('jwtOf: the response set no payload-token cookie and has no body.token')
  return token
}

export async function rest<T = any>(method: Method, path: string, opts: CallOptions = {}): Promise<RestResult<T>> {
  const res = await call(method, path, opts)
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  const setCookie = res.headers.getSetCookie?.() ?? []
  return { status: res.status, headers: res.headers, body, text, setCookie, cookie: tokenCookieFrom(setCookie) }
}

export const restGet = <T = any>(path: string, opts?: CallOptions) => rest<T>('GET', path, opts)
export const restPost = <T = any>(path: string, opts?: CallOptions) => rest<T>('POST', path, opts)
export const restPatch = <T = any>(path: string, opts?: CallOptions) => rest<T>('PATCH', path, opts)
export const restPut = <T = any>(path: string, opts?: CallOptions) => rest<T>('PUT', path, opts)
export const restDelete = <T = any>(path: string, opts?: CallOptions) => rest<T>('DELETE', path, opts)
