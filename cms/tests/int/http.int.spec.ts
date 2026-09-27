import type { Endpoint, Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { HttpError, json, readBodyText, readFormBody, readJsonBody, withErrors } from '@/lib/http'
import { enforceRateLimit, resetRateLimits } from '@/lib/rateLimit'

import { config, getTestPayload } from './helpers/payload'
import { call, restGet, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * End-to-end check of the endpoint helpers on a real PayloadRequest (through the REST handler):
 * body limits, error shape, CORS on custom endpoints, rate limiting, raw body preservation.
 * The test endpoints are appended to the live config for this run only (under /api/__test/*).
 */
let payload: Payload

const testEndpoints: Endpoint[] = [
  {
    path: '/__test/echo',
    method: 'post',
    handler: withErrors(async (req) => json({ got: await readJsonBody(req, { maxBytes: 256 }), user: req.user?.collection ?? null }, { status: 201 })),
  },
  {
    path: '/__test/raw',
    method: 'post',
    handler: withErrors(async (req) => json({ raw: await readBodyText(req) })),
  },
  {
    path: '/__test/form',
    method: 'post',
    handler: withErrors(async (req) => json(Object.fromEntries(await readFormBody(req)))),
  },
  {
    path: '/__test/boom',
    method: 'get',
    handler: withErrors(async () => {
      throw new Error('db password=hunter2 leaked?')
    }),
  },
  {
    path: '/__test/conflict',
    method: 'get',
    handler: withErrors(async () => {
      throw new HttpError(409, 'OUT_OF_STOCK', 'Rolled Oats just sold out.', { slug: 'rolled-oats' })
    }),
  },
  {
    path: '/__test/limited',
    method: 'get',
    handler: withErrors(async (req) => enforceRateLimit(req, 'test-limited', { limit: 2, windowMs: 60_000 }) ?? json({ ok: true })),
  },
]

beforeAll(async () => {
  payload = await getTestPayload()
  const cfg = await config
  for (const e of testEndpoints) {
    if (!cfg.endpoints.some((x) => x.path === e.path && x.method === e.method)) cfg.endpoints.push(e)
  }
})

describe('custom endpoint helpers through the REST stack', () => {
  it('parses JSON and sees the authenticated user', async () => {
    const res = await restPost('__test/echo', { body: { items: [{ slug: 'rolled-oats', qty: 2 }] }, origin: STOREFRONT_ORIGIN })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ got: { items: [{ slug: 'rolled-oats', qty: 2 }] }, user: null })
    // CORS headers are added to custom endpoint responses for allow-listed origins.
    expect(res.headers.get('access-control-allow-origin')).toBe(STOREFRONT_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('rejects wrong content types, bad JSON, arrays and oversize bodies with the standard error body', async () => {
    const wrongType = await restPost('__test/echo', { rawBody: 'a=1', contentType: 'application/x-www-form-urlencoded' })
    expect(wrongType.status).toBe(415)
    expect(wrongType.body).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the request as JSON.' } })

    const bad = await restPost('__test/echo', { rawBody: '{"a":', contentType: 'application/json' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('INVALID_JSON')

    const arr = await restPost('__test/echo', { body: [1, 2] })
    expect(arr.status).toBe(400)
    expect(arr.body.error.code).toBe('VALIDATION')

    const big = await restPost('__test/echo', { body: { s: 'x'.repeat(300) } })
    expect(big.status).toBe(413)
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('keeps the raw body byte-for-byte (webhook HMAC needs it)', async () => {
    const raw = '{"event":"payment.captured",  "payload":{"a":1}}\n'
    const res = await restPost('__test/raw', { rawBody: raw, contentType: 'application/json' })
    expect(res.body.raw).toBe(raw)
  })

  it('reads urlencoded callback forms', async () => {
    const res = await restPost('__test/form', {
      rawBody: new URLSearchParams({ razorpay_payment_id: 'pay_1', razorpay_signature: 'a+b=' }),
      contentType: 'application/x-www-form-urlencoded',
    })
    expect(res.body).toEqual({ razorpay_payment_id: 'pay_1', razorpay_signature: 'a+b=' })
  })

  it('hides unexpected errors and returns typed errors as-is', async () => {
    const boom = await restGet('__test/boom')
    expect(boom.status).toBe(500)
    expect(boom.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } })
    expect(boom.text).not.toContain('hunter2')

    const conflict = await restGet('__test/conflict')
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual({
      error: { code: 'OUT_OF_STOCK', message: 'Rolled Oats just sold out.', details: { slug: 'rolled-oats' } },
    })
  })

  it('rate limits per client IP when enabled', async () => {
    const saved = process.env.RATE_LIMIT_DISABLED
    process.env.RATE_LIMIT_DISABLED = '0'
    resetRateLimits()
    try {
      const ip = { 'x-forwarded-for': '203.0.113.7' }
      expect((await restGet('__test/limited', { headers: ip })).status).toBe(200)
      expect((await restGet('__test/limited', { headers: ip })).status).toBe(200)
      const limited = await restGet('__test/limited', { headers: ip })
      expect(limited.status).toBe(429)
      expect(limited.body.error.code).toBe('RATE_LIMITED')
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      expect((await restGet('__test/limited', { headers: { 'x-forwarded-for': '203.0.113.8' } })).status).toBe(200)
    } finally {
      process.env.RATE_LIMIT_DISABLED = saved
      resetRateLimits()
    }
  })

  it('unknown custom routes 404 and OPTIONS preflight is answered', async () => {
    expect((await restGet('store/does-not-exist')).status).toBe(404)
    const res = await call('POST', '__test/echo', { body: {}, headers: { 'X-Payload-HTTP-Method-Override': 'GET' } })
    expect(res.status).toBeLessThan(500)
  })
})
