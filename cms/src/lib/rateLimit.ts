import type { PayloadRequest } from 'payload'

import { getClientIp, jsonError } from './http'

/**
 * In-memory sliding-window rate limiter keyed by client IP + route.
 *
 *   const limited = enforceRateLimit(req, 'checkout', { limit: 10, windowMs: 60_000 })
 *   if (limited) return limited            // 429 { error: { code: 'RATE_LIMITED', … } } + Retry-After
 *
 * Per server instance only (a serverless deployment has several): it blunts bursts and scripted abuse,
 * it is not a global quota. Disabled entirely when RATE_LIMIT_DISABLED=1 (read on every call, so tests
 * can flip it). Integration tests run with it disabled; tests that exercise limits set it to '0'.
 */

export type RateLimitOptions = {
  /** Max hits allowed inside the window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

export type RateLimitResult = {
  ok: boolean
  limit: number
  /** Hits left in the current window after this one (0 when blocked). */
  remaining: number
  /** Seconds until the next hit would be allowed (0 when ok). */
  retryAfterSeconds: number
}

export type RateLimiter = {
  hit(key: string): RateLimitResult
  reset(key?: string): void
  size(): number
}

export function createRateLimiter(
  { limit, windowMs }: RateLimitOptions,
  { now = Date.now, maxKeys = 10_000 }: { now?: () => number; maxKeys?: number } = {},
): RateLimiter {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('rate limit must be a positive integer')
  if (!(windowMs > 0)) throw new Error('rate limit windowMs must be > 0')
  // key -> ascending hit timestamps inside the window (at most `limit` kept)
  const hits = new Map<string, number[]>()

  const sweep = (t: number) => {
    for (const [key, stamps] of hits) {
      if (!stamps.length || stamps[stamps.length - 1] <= t - windowMs) hits.delete(key)
    }
    // Still too many live keys: drop the oldest-inserted ones (Map keeps insertion order).
    for (const key of hits.keys()) {
      if (hits.size <= maxKeys) break
      hits.delete(key)
    }
  }

  return {
    hit(key) {
      const t = now()
      const stamps = (hits.get(key) ?? []).filter((s) => s > t - windowMs)
      if (stamps.length >= limit) {
        hits.set(key, stamps)
        const retryAfterMs = stamps[0] + windowMs - t
        return { ok: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
      }
      stamps.push(t)
      hits.delete(key) // re-insert so Map order approximates recency
      hits.set(key, stamps)
      if (hits.size > maxKeys) sweep(t)
      return { ok: true, limit, remaining: limit - stamps.length, retryAfterSeconds: 0 }
    },
    reset(key) {
      if (key === undefined) hits.clear()
      else hits.delete(key)
    },
    size: () => hits.size,
  }
}

export const rateLimitDisabled = (): boolean => /^(1|true|yes|on)$/i.test(process.env.RATE_LIMIT_DISABLED ?? '')

// One limiter per route name so each route keeps its own limit/window.
const limiters = new Map<string, { opts: RateLimitOptions; limiter: RateLimiter }>()

function limiterFor(route: string, opts: RateLimitOptions): RateLimiter {
  const existing = limiters.get(route)
  if (existing && existing.opts.limit === opts.limit && existing.opts.windowMs === opts.windowMs) return existing.limiter
  const limiter = createRateLimiter(opts)
  limiters.set(route, { opts, limiter })
  return limiter
}

/** Counts a hit for (client IP, route). Always ok when RATE_LIMIT_DISABLED=1. */
export function rateLimit(
  req: Partial<PayloadRequest>,
  route: string,
  opts: RateLimitOptions,
  { key }: { key?: string } = {},
): RateLimitResult {
  if (rateLimitDisabled()) return { ok: true, limit: opts.limit, remaining: opts.limit, retryAfterSeconds: 0 }
  return limiterFor(route, opts).hit(key ?? getClientIp(req))
}

/** Returns a 429 RATE_LIMITED response when over the limit, else null. */
export function enforceRateLimit(
  req: Partial<PayloadRequest>,
  route: string,
  opts: RateLimitOptions,
  extra: { key?: string } = {},
): Response | null {
  const result = rateLimit(req, route, opts, extra)
  if (result.ok) return null
  return jsonError(429, 'RATE_LIMITED', undefined, { retryAfterSeconds: result.retryAfterSeconds }, {
    'Retry-After': String(result.retryAfterSeconds),
  })
}

/** Test helper: forget every hit on every route. */
export function resetRateLimits(): void {
  limiters.clear()
}
