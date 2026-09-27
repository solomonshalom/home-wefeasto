import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRateLimiter, enforceRateLimit, rateLimit, rateLimitDisabled, resetRateLimits } from '@/lib/rateLimit'

const reqFrom = (ip: string, headers: Record<string, string> = {}) => ({ headers: new Headers({ 'x-forwarded-for': ip, ...headers }) })

describe('createRateLimiter (sliding window)', () => {
  it('allows `limit` hits per window, then blocks with Retry-After', () => {
    let t = 1_000_000
    const rl = createRateLimiter({ limit: 3, windowMs: 10_000 }, { now: () => t })
    expect(rl.hit('a')).toMatchObject({ ok: true, remaining: 2 })
    t += 1000
    expect(rl.hit('a')).toMatchObject({ ok: true, remaining: 1 })
    t += 1000
    expect(rl.hit('a')).toMatchObject({ ok: true, remaining: 0 })
    t += 1000
    const blocked = rl.hit('a')
    expect(blocked).toMatchObject({ ok: false, remaining: 0 })
    // Oldest hit was at +0 → free again at +10s; we are at +3s.
    expect(blocked.retryAfterSeconds).toBe(7)
  })

  it('slides: each old hit expires on its own', () => {
    let t = 0
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 }, { now: () => t })
    rl.hit('k') // t=0
    t = 600
    rl.hit('k') // t=600
    t = 999
    expect(rl.hit('k').ok).toBe(false)
    t = 1000 // the t=0 hit left the window
    expect(rl.hit('k').ok).toBe(true)
    t = 1500
    expect(rl.hit('k').ok).toBe(false) // hits at 600 and 1000 still inside
    t = 1601
    expect(rl.hit('k').ok).toBe(true)
  })

  it('blocked attempts do not extend the block', () => {
    let t = 0
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 }, { now: () => t })
    rl.hit('k')
    for (t = 100; t < 1000; t += 100) expect(rl.hit('k').ok).toBe(false)
    t = 1000
    expect(rl.hit('k').ok).toBe(true)
  })

  it('keys are independent; reset clears one key or all', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 })
    expect(rl.hit('a').ok).toBe(true)
    expect(rl.hit('b').ok).toBe(true)
    expect(rl.hit('a').ok).toBe(false)
    rl.reset('a')
    expect(rl.hit('a').ok).toBe(true)
    expect(rl.hit('b').ok).toBe(false)
    rl.reset()
    expect(rl.size()).toBe(0)
  })

  it('bounds memory: expired keys are swept and the key count is capped', () => {
    let t = 0
    const rl = createRateLimiter({ limit: 5, windowMs: 1000 }, { now: () => t, maxKeys: 100 })
    for (let i = 0; i < 100; i++) rl.hit(`old-${i}`)
    t = 5000
    for (let i = 0; i < 50; i++) rl.hit(`new-${i}`)
    expect(rl.size()).toBeLessThanOrEqual(100)
    for (let i = 0; i < 500; i++) rl.hit(`flood-${i}`)
    expect(rl.size()).toBeLessThanOrEqual(101)
  })

  it('validates options', () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1 })).toThrow()
    expect(() => createRateLimiter({ limit: 1.5, windowMs: 1 })).toThrow()
    expect(() => createRateLimiter({ limit: 1, windowMs: 0 })).toThrow()
  })
})

describe('rateLimit / enforceRateLimit (per IP + route)', () => {
  const saved = process.env.RATE_LIMIT_DISABLED
  beforeEach(() => {
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
  })
  afterEach(() => {
    process.env.RATE_LIMIT_DISABLED = saved
  })

  it('keys by client IP and route', () => {
    const opts = { limit: 2, windowMs: 60_000 }
    expect(rateLimit(reqFrom('1.1.1.1'), 'checkout', opts).ok).toBe(true)
    expect(rateLimit(reqFrom('1.1.1.1, 10.0.0.1'), 'checkout', opts).ok).toBe(true)
    expect(rateLimit(reqFrom('1.1.1.1'), 'checkout', opts).ok).toBe(false)
    expect(rateLimit(reqFrom('2.2.2.2'), 'checkout', opts).ok).toBe(true) // other IP
    expect(rateLimit(reqFrom('1.1.1.1'), 'status', opts).ok).toBe(true) // other route
    // x-real-ip wins over x-forwarded-for
    expect(rateLimit(reqFrom('1.1.1.1', { 'x-real-ip': '3.3.3.3' }), 'checkout', opts).ok).toBe(true)
    // explicit key (e.g. per email)
    expect(rateLimit(reqFrom('1.1.1.1'), 'checkout', opts, { key: 'a@b.dev' }).ok).toBe(true)
  })

  it('returns a 429 JSON error with Retry-After', async () => {
    const opts = { limit: 1, windowMs: 30_000 }
    expect(enforceRateLimit(reqFrom('9.9.9.9'), 'newsletter', opts)).toBeNull()
    const res = enforceRateLimit(reqFrom('9.9.9.9'), 'newsletter', opts)!
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(29)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(typeof body.error.message).toBe('string')
    expect(body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(29)
  })

  it('RATE_LIMIT_DISABLED=1 turns it off (read on every call)', () => {
    const opts = { limit: 1, windowMs: 60_000 }
    rateLimit(reqFrom('5.5.5.5'), 'r', opts)
    expect(rateLimit(reqFrom('5.5.5.5'), 'r', opts).ok).toBe(false)
    process.env.RATE_LIMIT_DISABLED = '1'
    expect(rateLimitDisabled()).toBe(true)
    expect(rateLimit(reqFrom('5.5.5.5'), 'r', opts).ok).toBe(true)
    expect(enforceRateLimit(reqFrom('5.5.5.5'), 'r', opts)).toBeNull()
  })

  it('changing a route’s limits starts a fresh window', () => {
    rateLimit(reqFrom('6.6.6.6'), 'x', { limit: 1, windowMs: 60_000 })
    expect(rateLimit(reqFrom('6.6.6.6'), 'x', { limit: 1, windowMs: 60_000 }).ok).toBe(false)
    expect(rateLimit(reqFrom('6.6.6.6'), 'x', { limit: 5, windowMs: 60_000 }).ok).toBe(true)
  })

  it('requests without IP headers share the "unknown" bucket', () => {
    const opts = { limit: 1, windowMs: 60_000 }
    expect(rateLimit({ headers: new Headers() }, 'u', opts).ok).toBe(true)
    expect(rateLimit({ headers: new Headers() }, 'u', opts).ok).toBe(false)
  })
})
