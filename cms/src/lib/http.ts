import { ValidationError } from 'payload'
import type { PayloadHandler, PayloadRequest } from 'payload'

/**
 * JSON helpers for custom endpoints (SPEC §6). Every error body has the shape
 *   { error: { code, message, details? } }
 * with a customer-friendly message: no stack traces, SQL, or secrets.
 *
 *   export const handler = withErrors(async (req) => {
 *     const body = await readJsonBody(req, { maxBytes: 8 * 1024 })   // throws HttpError 400/413/415
 *     if (!ok) throw new HttpError(409, 'OUT_OF_STOCK', 'Rolled Oats just sold out.', { slug })
 *     return json({ ok: true }, { status: 201, cache: 'no-store' })
 *   })
 */

export type ErrorBody = { error: { code: string; message: string; details?: unknown } }

export const DEFAULT_MESSAGES: Record<string, string> = {
  VALIDATION: 'Some details need fixing.',
  INVALID_JSON: 'We could not read that request.',
  UNSUPPORTED_MEDIA_TYPE: 'Send the request as JSON.',
  PAYLOAD_TOO_LARGE: 'That request is too large.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  UNAUTHORIZED: 'Please sign in to continue.',
  FORBIDDEN: "You don't have access to that.",
  NOT_FOUND: "We couldn't find that.",
  METHOD_NOT_ALLOWED: 'That action is not supported here.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
}

/** Throw from a handler wrapped in withErrors(); becomes a JSON error response. */
export class HttpError extends Error {
  status: number
  code: string
  details?: unknown
  headers?: HeadersInit
  constructor(status: number, code: string, message?: string, details?: unknown, headers?: HeadersInit) {
    super(message || DEFAULT_MESSAGES[code] || code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
    this.headers = headers
  }
}

export type JsonInit = {
  status?: number
  headers?: HeadersInit
  /** Shorthand for Cache-Control. 'no-store' is the safe default for anything personal. */
  cache?: 'no-store' | string
}

export function json(data: unknown, init: JsonInit = {}): Response {
  const headers = new Headers(init.headers)
  if (init.cache) headers.set('Cache-Control', init.cache)
  return Response.json(data, { status: init.status ?? 200, headers })
}

export function jsonError(
  status: number,
  code: string,
  message?: string,
  details?: unknown,
  headers?: HeadersInit,
): Response {
  const body: ErrorBody = { error: { code, message: message || DEFAULT_MESSAGES[code] || code } }
  if (details !== undefined) body.error.details = details
  const h = new Headers(headers)
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
  return Response.json(body, { status, headers: h })
}

export function errorResponse(err: HttpError): Response {
  return jsonError(err.status, err.code, err.message, err.details, err.headers)
}

/**
 * Wraps a handler: HttpError → its JSON response; anything else → logged + generic 500 INTERNAL.
 * Payload's own APIError/ValidationError are mapped to their status with a generic code.
 */
export function withErrors(handler: PayloadHandler): PayloadHandler {
  return async (req) => {
    try {
      return await handler(req)
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err)
      const e = err as {
        status?: number
        name?: string
        message?: string
        data?: { errors?: { path?: string; message?: string }[] }
      }
      // Never match on err.name: Payload's APIError sets name from constructor.name, which the minified
      // production build renames (`class u extends APIError`). Use instanceof, then the error's shape.
      if (err instanceof ValidationError || (e?.status === 400 && Array.isArray(e.data?.errors))) {
        const errors = (e.data?.errors ?? []).map(({ path, message }) => ({ path, message }))
        return jsonError(400, 'VALIDATION', undefined, errors.length ? { errors } : undefined)
      }
      if (e?.status === 404) return jsonError(404, 'NOT_FOUND')
      if (e?.status === 403) return jsonError(403, 'FORBIDDEN')
      if (e?.status === 401) return jsonError(401, 'UNAUTHORIZED')
      req.payload?.logger?.error({ err, msg: `Unhandled error in ${req.method} ${safePath(req)}` })
      return jsonError(500, 'INTERNAL')
    }
  }
}

const safePath = (req: Partial<PayloadRequest>): string => {
  try {
    return new URL(req.url ?? '').pathname
  } catch {
    return '?'
  }
}

export type ReadBodyOptions = {
  /** Default 16 KiB. Checkout bodies are ~1 KiB. */
  maxBytes?: number
  /** Default true: reject arrays/primitives with 400 VALIDATION. */
  requireObject?: boolean
}

const DEFAULT_MAX_BYTES = 16 * 1024

/** Reads the raw body as UTF-8 text, refusing more than `maxBytes` (also without Content-Length). */
export async function readBodyText(req: Partial<PayloadRequest>, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  const declared = Number(req.headers?.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE')

  const body = req.body as ReadableStream<Uint8Array> | null | undefined
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE')
      }
      chunks.push(value)
    }
    const buf = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      buf.set(c, offset)
      offset += c.byteLength
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf)
  }
  if (typeof req.text === 'function') {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE')
    return text
  }
  return ''
}

const mediaType = (req: Partial<PayloadRequest>): string =>
  (req.headers?.get('content-type') ?? '').split(';')[0].trim().toLowerCase()

/**
 * Reads a JSON request body. Errors (as HttpError): 415 UNSUPPORTED_MEDIA_TYPE unless
 * `Content-Type: application/json` (or +json), 413 PAYLOAD_TOO_LARGE, 400 INVALID_JSON,
 * 400 VALIDATION when the top level is not an object (unless requireObject: false).
 * Do NOT call it before verifying a raw-body signature (webhooks): use readBodyText instead.
 */
export async function readJsonBody<T = Record<string, unknown>>(
  req: Partial<PayloadRequest>,
  { maxBytes = DEFAULT_MAX_BYTES, requireObject = true }: ReadBodyOptions = {},
): Promise<T> {
  const type = mediaType(req)
  if (type !== 'application/json' && !type.endsWith('+json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE')
  const text = await readBodyText(req, maxBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'INVALID_JSON')
  }
  if (requireObject && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new HttpError(400, 'VALIDATION', 'Expected a JSON object.')
  }
  return parsed as T
}

/** Reads an application/x-www-form-urlencoded body (e.g. the Razorpay redirect callback). */
export async function readFormBody(
  req: Partial<PayloadRequest>,
  { maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {},
): Promise<URLSearchParams> {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE')
  return new URLSearchParams(await readBodyText(req, maxBytes))
}

/**
 * Best-effort client IP for rate limiting: x-real-ip, then the first x-forwarded-for hop, else 'unknown'.
 * On Vercel these are set by the platform; never use the value for anything security-critical.
 */
export function getClientIp(req: Partial<PayloadRequest>): string {
  const h = req.headers
  const real = h?.get('x-real-ip')?.trim()
  if (real) return real
  const fwd = h?.get('x-forwarded-for')?.split(',')[0]?.trim()
  return fwd || 'unknown'
}

/** 405 helper for endpoints that share a path. */
export const methodNotAllowed = (): Response => jsonError(405, 'METHOD_NOT_ALLOWED')
