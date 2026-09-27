import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import {
  getClientIp,
  HttpError,
  json,
  jsonError,
  methodNotAllowed,
  readBodyText,
  readFormBody,
  readJsonBody,
  withErrors,
} from '@/lib/http'

const req = (body: BodyInit | null, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Request('http://localhost/api/x', { method: 'POST', body, headers }) as unknown as PayloadRequest

/** A request whose body is a stream with no Content-Length (chunked upload). */
function streamingReq(chunks: string[], contentType = 'application/json') {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Request('http://localhost/api/x', {
    method: 'POST',
    body: stream,
    headers: { 'content-type': contentType },
    // @ts-expect-error Node's undici needs duplex for streaming bodies
    duplex: 'half',
  }) as unknown as PayloadRequest
}

async function expectHttpError(p: Promise<unknown>, status: number, code: string) {
  try {
    await p
    expect.unreachable(`expected HttpError ${status} ${code}`)
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(status)
    expect((err as HttpError).code).toBe(code)
  }
}

describe('json / jsonError', () => {
  it('jsonError produces { error: { code, message, details? } } with no-store', async () => {
    const res = jsonError(409, 'OUT_OF_STOCK', 'Rolled Oats just sold out.', { slug: 'rolled-oats' })
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      error: { code: 'OUT_OF_STOCK', message: 'Rolled Oats just sold out.', details: { slug: 'rolled-oats' } },
    })
  })

  it('fills a friendly default message and omits undefined details', async () => {
    expect(await jsonError(429, 'RATE_LIMITED').json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a moment and try again.' },
    })
    expect(await jsonError(418, 'TEAPOT').json()).toEqual({ error: { code: 'TEAPOT', message: 'TEAPOT' } })
    expect((await methodNotAllowed().json()).error.code).toBe('METHOD_NOT_ALLOWED')
  })

  it('keeps caller headers (Retry-After) and an explicit Cache-Control', () => {
    const res = jsonError(429, 'RATE_LIMITED', undefined, undefined, { 'Retry-After': '5', 'Cache-Control': 'private' })
    expect(res.headers.get('retry-after')).toBe('5')
    expect(res.headers.get('cache-control')).toBe('private')
  })

  it('json sets status and cache headers', async () => {
    const res = json({ ok: true }, { status: 201, cache: 'max-age=15, s-maxage=30', headers: { 'X-A': '1' } })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('max-age=15, s-maxage=30')
    expect(res.headers.get('x-a')).toBe('1')
    expect(await res.json()).toEqual({ ok: true })
    expect(json(null).status).toBe(200)
  })
})

describe('withErrors', () => {
  const logger = { error: vi.fn() }
  const wrap = (fn: () => unknown) =>
    withErrors(async () => fn() as Response)({ payload: { logger }, method: 'POST', url: 'http://x/api/y' } as unknown as PayloadRequest)

  it('maps HttpError to its JSON response', async () => {
    const res = await wrap(() => {
      throw new HttpError(400, 'VALIDATION', 'Check the PIN code.', { fields: { pin: 'invalid' } }, { 'X-B': '2' })
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('x-b')).toBe('2')
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION', message: 'Check the PIN code.', details: { fields: { pin: 'invalid' } } },
    })
  })

  it('hides unexpected errors behind a generic 500 and logs them', async () => {
    logger.error.mockClear()
    const res = await wrap(() => {
      throw new Error('relation "orders" does not exist at postgres://secret')
    })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toMatch(/relation|postgres|secret|stack/)
    expect(JSON.parse(text).error.code).toBe('INTERNAL')
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it('maps Payload errors by name/status', async () => {
    const validation = Object.assign(new Error('The following field is invalid: email'), {
      name: 'ValidationError',
      status: 400,
      data: { errors: [{ path: 'email', message: 'Value must be unique' }] },
    })
    const v = await wrap(() => {
      throw validation
    })
    expect(v.status).toBe(400)
    expect(await v.json()).toEqual({
      error: {
        code: 'VALIDATION',
        message: 'Some details need fixing.',
        details: { errors: [{ path: 'email', message: 'Value must be unique' }] },
      },
    })
    for (const [name, status, code] of [
      ['NotFound', 404, 'NOT_FOUND'],
      ['Forbidden', 403, 'FORBIDDEN'],
      ['UnauthorizedError', 401, 'UNAUTHORIZED'],
    ] as const) {
      const res = await wrap(() => {
        throw Object.assign(new Error('x'), { name, status })
      })
      expect(res.status).toBe(status)
      expect((await res.json()).error.code).toBe(code)
    }
  })

  it('maps Payload errors whose class names were minified (production build)', async () => {
    const { ValidationError, NotFound, Forbidden, UnauthorizedError } = await import('payload')
    const minified = (e: Error) => Object.assign(e, { name: 'u' }) // `class u extends APIError` after next build
    const v = await wrap(() => {
      throw minified(new ValidationError({ errors: [{ path: 'email', message: 'Value must be unique' }] }))
    })
    expect(v.status).toBe(400)
    expect((await v.json()).error).toMatchObject({ code: 'VALIDATION', details: { errors: [{ path: 'email' }] } })

    // A second bundled copy of payload: instanceof fails, the shape still identifies it.
    const shaped = await wrap(() => {
      throw Object.assign(new Error('x'), { name: 'q', status: 400, data: { errors: [{ path: 'slug', message: 'taken' }] } })
    })
    expect((await shaped.json()).error.code).toBe('VALIDATION')

    for (const [err, status, code] of [
      [new NotFound(), 404, 'NOT_FOUND'],
      [new Forbidden(), 403, 'FORBIDDEN'],
      [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    ] as const) {
      const res = await wrap(() => {
        throw minified(err)
      })
      expect(res.status).toBe(status)
      expect((await res.json()).error.code).toBe(code)
    }
  })

  it('never compares error names in src/ (minification renames classes)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(__dirname, '../../src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|js|mjs)$/.test(f) && !p.includes(`${path.sep}payload-types`)) {
          readFileSync(p, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              if (/\.name\s*===?\s*['"][A-Z]\w*(Error|Found|Forbidden)['"]|constructor\.name/.test(line) && !/^\s*(\*|\/\/)/.test(line))
                offenders.push(`${path.relative(root, p)}:${i + 1}: ${line.trim()}`)
            })
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it('passes successful responses through', async () => {
    const res = await wrap(() => json({ ok: 1 }))
    expect(await res.json()).toEqual({ ok: 1 })
  })
})

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    expect(await readJsonBody(req(JSON.stringify({ a: 1, b: ['x'] })))).toEqual({ a: 1, b: ['x'] })
    expect(await readJsonBody(req('{"x":"₹499"}', { 'content-type': 'application/json; charset=utf-8' }))).toEqual({ x: '₹499' })
    expect(await readJsonBody(req('{}', { 'content-type': 'application/vnd.api+json' }))).toEqual({})
  })

  it('415 unless the content type is JSON', async () => {
    await expectHttpError(readJsonBody(req('{}', { 'content-type': 'text/plain' })), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await expectHttpError(readJsonBody(req('{}', {})), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await expectHttpError(
      readJsonBody(req('a=1', { 'content-type': 'application/x-www-form-urlencoded' })),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    )
  })

  it('400 INVALID_JSON for malformed or empty bodies', async () => {
    await expectHttpError(readJsonBody(req('{"a":')), 400, 'INVALID_JSON')
    await expectHttpError(readJsonBody(req('')), 400, 'INVALID_JSON')
    await expectHttpError(readJsonBody(req(null)), 400, 'INVALID_JSON')
  })

  it('400 VALIDATION when the top level is not an object (unless allowed)', async () => {
    for (const body of ['[]', '"x"', '1', 'null', 'true']) {
      await expectHttpError(readJsonBody(req(body)), 400, 'VALIDATION')
    }
    expect(await readJsonBody(req('[1,2]'), { requireObject: false })).toEqual([1, 2])
  })

  it('413 when Content-Length exceeds the limit', async () => {
    const big = JSON.stringify({ s: 'x'.repeat(100) })
    await expectHttpError(readJsonBody(req(big), { maxBytes: 50 }), 413, 'PAYLOAD_TOO_LARGE')
  })

  it('413 when a streamed body without Content-Length exceeds the limit', async () => {
    const r = streamingReq(['{"s":"', 'x'.repeat(40), 'y'.repeat(40), '"}'])
    expect(r.headers.get('content-length')).toBeNull()
    await expectHttpError(readJsonBody(r, { maxBytes: 64 }), 413, 'PAYLOAD_TOO_LARGE')
    expect(await readJsonBody(streamingReq(['{"a"', ':1}']), { maxBytes: 64 })).toEqual({ a: 1 })
  })

  it('counts bytes, not characters', async () => {
    const body = JSON.stringify({ s: '₹'.repeat(20) }) // 20 chars, 60 bytes
    await expectHttpError(readJsonBody(streamingReq([body]), { maxBytes: 40 }), 413, 'PAYLOAD_TOO_LARGE')
  })

  it('falls back to req.text() when there is no stream', async () => {
    const fake = { headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"z":2}' }
    expect(await readJsonBody(fake as unknown as PayloadRequest)).toEqual({ z: 2 })
    const big = { headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ s: 'x'.repeat(99) }) }
    await expectHttpError(readJsonBody(big as unknown as PayloadRequest, { maxBytes: 20 }), 413, 'PAYLOAD_TOO_LARGE')
  })
})

describe('readBodyText / readFormBody', () => {
  it('returns the raw text exactly (for HMAC verification)', async () => {
    const raw = '{"b":1,  "a":2}'
    expect(await readBodyText(req(raw))).toBe(raw)
  })

  it('reads urlencoded forms', async () => {
    const form = await readFormBody(
      req('razorpay_payment_id=pay_1&razorpay_signature=abc%3D', { 'content-type': 'application/x-www-form-urlencoded' }),
    )
    expect(form.get('razorpay_payment_id')).toBe('pay_1')
    expect(form.get('razorpay_signature')).toBe('abc=')
    await expectHttpError(readFormBody(req('{}')), 415, 'UNSUPPORTED_MEDIA_TYPE')
  })
})

describe('getClientIp', () => {
  const h = (headers: Record<string, string>) => ({ headers: new Headers(headers) }) as unknown as PayloadRequest
  it('prefers x-real-ip, then the first x-forwarded-for hop', () => {
    expect(getClientIp(h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }))).toBe('1.2.3.4')
    expect(getClientIp(h({ 'x-forwarded-for': ' 5.6.7.8 , 10.0.0.1' }))).toBe('5.6.7.8')
    expect(getClientIp(h({}))).toBe('unknown')
    expect(getClientIp({} as PayloadRequest)).toBe('unknown')
  })
})
