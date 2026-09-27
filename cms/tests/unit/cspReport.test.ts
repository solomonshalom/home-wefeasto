/**
 * POST /api/store/csp-report (src/endpoints/csp): the collector for the storefront's report-only CSP
 * (vercel.json; hunt w5-security csp-reporting). Both browser formats are accepted, every URL is cut to
 * origin + path (the /order guest token, /login?verify= and /reset-password?token= never reach a log), and
 * nothing but the violation's shape is logged.
 */
import type { PayloadRequest } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CSP_REPORT_MAX_BYTES, CSP_REPORT_MAX_LOGGED, CSP_REPORT_PATH, cspEndpoints } from '@/endpoints/csp'
import { groupViolations, parseCspReports, safeCspUrl } from '@/endpoints/csp/report'
import { endpoints } from '@/endpoints'
import { resetRateLimits } from '@/lib/rateLimit'

const SHOP = 'https://wefeasto.com'
const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; report-uri /api/store/csp-report"

/** What Chromium POSTs with report-uri (captured from a real run). */
const legacy = (over: Record<string, unknown> = {}) => ({
  'csp-report': {
    'document-uri': `${SHOP}/order?no=WF-1001&t=GUEST-TOKEN#top`,
    referrer: `${SHOP}/checkout?email=a@b.c`,
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'original-policy': POLICY,
    disposition: 'report',
    'blocked-uri': 'https://evil.example/skim.js?session=abc',
    'status-code': 200,
    'script-sample': 'var card = "4111 1111"',
    'source-file': `${SHOP}/_app/immutable/entry/app.js?v=1`,
    'line-number': 12,
    'column-number': 7,
    ...over,
  },
})

/** What Chromium POSTs with report-to + Reporting-Endpoints (captured from a real run, HTTPS). */
const reportingApi = (body: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []) => [
  {
    age: 0,
    type: 'csp-violation',
    url: `${SHOP}/login?verify=VERIFY-TOKEN`,
    user_agent: 'Mozilla/5.0 (iPhone) Secret/1.0',
    body: {
      blockedURL: 'https://evil.example/skim.js?session=abc',
      disposition: 'report',
      documentURL: `${SHOP}/login?verify=VERIFY-TOKEN`,
      effectiveDirective: 'script-src-elem',
      originalPolicy: POLICY,
      referrer: '',
      sample: '',
      statusCode: 200,
      ...body,
    },
  },
  ...extra,
]

function post(body: unknown, { type = 'application/csp-report', ip = '203.0.113.9', raw }: { type?: string | null; ip?: string; raw?: string } = {}) {
  const info = vi.fn()
  const headers: Record<string, string> = { 'x-real-ip': ip }
  if (type) headers['content-type'] = type
  const req = new Request(`${SHOP}/api${CSP_REPORT_PATH}`, { method: 'POST', body: raw ?? JSON.stringify(body), headers }) as unknown as PayloadRequest
  ;(req as unknown as { payload: unknown }).payload = { logger: { info, error: vi.fn(), warn: vi.fn() } }
  const handler = cspEndpoints[0].handler
  return { res: handler(req) as Promise<Response>, info }
}

const logged = (info: ReturnType<typeof vi.fn>) => info.mock.calls.map(([obj]) => obj)

afterEach(() => {
  resetRateLimits()
  vi.unstubAllEnvs()
})

describe('safeCspUrl', () => {
  it.each([
    [`${SHOP}/order?no=1&t=TOKEN#x`, `${SHOP}/order`],
    ['https://user:pw@evil.example:8443/a/b.js?k=v', 'https://evil.example:8443/a/b.js'],
    ['inline', 'inline'],
    ['EVAL', 'eval'],
    ['trusted-types-sink', 'trusted-types-sink'],
    ['data:image/png;base64,AAAA', 'data'],
    ['blob:https://wefeasto.com/0f3c', 'blob'],
    ['chrome-extension://abcdef/content.js', 'chrome-extension'],
    ['wss://api.razorpay.com/socket?x=1', 'wss://api.razorpay.com/socket'],
    ['', undefined],
    ['not a url at all', undefined],
    [42, undefined],
    [null, undefined],
  ])('%j → %j', (input, out) => {
    expect(safeCspUrl(input)).toBe(out)
  })

  it('clips long paths and drops non-ASCII / control characters', () => {
    const out = safeCspUrl(`${SHOP}/${'a'.repeat(1000)}`)!
    expect(out.length).toBe(300)
    expect(safeCspUrl(`${SHOP}/café\n`)).toBe(`${SHOP}/caf%C3%A9`)
  })
})

describe('parseCspReports', () => {
  it('report-uri format: directive, blocked + page (origin + path), position, disposition, status — nothing else', () => {
    const { violations, other } = parseCspReports(legacy())
    expect(other).toBe(0)
    expect(violations).toEqual([
      {
        directive: 'script-src-elem',
        blocked: 'https://evil.example/skim.js',
        document: `${SHOP}/order`,
        source: `${SHOP}/_app/immutable/entry/app.js`,
        line: 12,
        column: 7,
        disposition: 'report',
        status: 200,
      },
    ])
    const text = JSON.stringify(violations)
    for (const secret of ['GUEST-TOKEN', 'WF-1001', 'a@b.c', '4111', 'session=abc', 'unsafe-inline']) expect(text).not.toContain(secret)
  })

  it('violated-directive is the fallback (older Safari sends no effective-directive)', () => {
    const [v] = parseCspReports(legacy({ 'effective-directive': undefined, 'violated-directive': "img-src 'self' data:" })).violations
    expect(v.directive).toBe('img-src')
  })

  it('Reporting API batch: csp-violation entries only; other report types are counted, not logged', () => {
    const { violations, other } = parseCspReports(reportingApi({}, [{ type: 'deprecation', body: { id: 'x' } }, { nope: 1 }]))
    expect(other).toBe(1)
    expect(violations).toEqual([
      { directive: 'script-src-elem', blocked: 'https://evil.example/skim.js', document: `${SHOP}/login`, disposition: 'report', status: 200 },
    ])
    expect(JSON.stringify(violations)).not.toMatch(/VERIFY-TOKEN|iPhone|Secret/)
  })

  it('junk and hostile values become "unknown" / are left out', () => {
    const [v] = parseCspReports(
      legacy({ 'effective-directive': 'script-src\n{"forged":1}', 'blocked-uri': 5, 'document-uri': {}, 'line-number': -1, 'status-code': 1e6, disposition: 'x' }),
    ).violations
    expect(v).toEqual({ directive: 'script-src', blocked: 'unknown', document: 'unknown', source: `${SHOP}/_app/immutable/entry/app.js`, column: 7, disposition: 'unknown' })
    expect(parseCspReports({ 'csp-report': 'x' })).toEqual({ violations: [], other: 0 })
    expect(parseCspReports([1, 'a', null])).toEqual({ violations: [], other: 0 })
    expect(parseCspReports({ hello: 'world' })).toEqual({ violations: [], other: 0 })
  })

  it('a batch is capped', () => {
    const many = Array.from({ length: 500 }, () => reportingApi()[0])
    expect(parseCspReports(many).violations).toHaveLength(100)
  })

  it('groupViolations: identical violations count once, in first-seen order', () => {
    const a = parseCspReports(legacy()).violations[0]
    const b = { ...a, blocked: 'inline' }
    expect(groupViolations([a, b, a, a])).toEqual([
      { ...a, count: 3 },
      { ...b, count: 1 },
    ])
  })
})

describe('POST /api/store/csp-report', () => {
  it('is registered once, as a root custom endpoint', () => {
    expect(endpoints.filter((e) => e.path === CSP_REPORT_PATH)).toEqual([expect.objectContaining({ method: 'post' })])
  })

  it.each([
    ['application/csp-report', legacy()],
    ['application/csp-report; charset=utf-8', legacy()],
    ['application/reports+json', reportingApi()],
    ['application/json', legacy()],
  ])('%s → 204, one info line per violation, no body', async (type, body) => {
    const { res, info } = post(body, { type })
    const r = await res
    expect(r.status).toBe(204)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.text()).toBe('')
    expect(logged(info)).toEqual([{ msg: 'csp violation', csp: expect.objectContaining({ directive: 'script-src-elem', blocked: 'https://evil.example/skim.js', count: 1 }) }])
    expect(JSON.stringify(logged(info))).not.toMatch(/TOKEN|session=|iPhone|203\.0\.113\.9|a@b\.c/)
  })

  it('a batch of repeats logs once with its count; more than MAX_LOGGED distinct → the rest are counted', async () => {
    const same = post(Array.from({ length: 5 }, () => reportingApi()[0]), { type: 'application/reports+json' })
    expect((await same.res).status).toBe(204)
    expect(logged(same.info)).toEqual([{ msg: 'csp violation', csp: expect.objectContaining({ count: 5 }) }])

    const distinct = Array.from({ length: CSP_REPORT_MAX_LOGGED + 3 }, (_, i) => reportingApi({ blockedURL: `https://x${i}.example/a.js` })[0])
    const many = post(distinct, { type: 'application/reports+json', ip: '203.0.113.10' })
    expect((await many.res).status).toBe(204)
    expect(logged(many.info)).toHaveLength(CSP_REPORT_MAX_LOGGED + 1)
    expect(logged(many.info).at(-1)).toEqual({ msg: 'csp violation', dropped: 3 })
  })

  it('only other report types → 204 and nothing logged', async () => {
    const { res, info } = post([{ type: 'deprecation', body: {} }], { type: 'application/reports+json' })
    expect((await res).status).toBe(204)
    expect(info).not.toHaveBeenCalled()
  })

  it.each([
    ['text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['application/x-www-form-urlencoded', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [null, 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('Content-Type %j → %i %s', async (type, status, code) => {
    const { res, info } = post(legacy(), { type })
    const r = await res
    expect(r.status).toBe(status)
    expect((await r.json()).error.code).toBe(code)
    expect(info).not.toHaveBeenCalled()
  })

  it('malformed JSON → 400 INVALID_JSON; JSON that is no report → 400 VALIDATION', async () => {
    const bad = await post(null, { raw: '{"csp-report":' }).res
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('INVALID_JSON')
    const notReport = await post({ hello: 'world' }).res
    expect(notReport.status).toBe(400)
    expect((await notReport.json()).error.code).toBe('VALIDATION')
  })

  it(`bodies over ${CSP_REPORT_MAX_BYTES / 1024} KiB → 413, unread`, async () => {
    const big = legacy({ 'script-sample': 'x'.repeat(CSP_REPORT_MAX_BYTES) })
    const { res, info } = post(big)
    const r = await res
    expect(r.status).toBe(413)
    expect(info).not.toHaveBeenCalled()
  })

  it('rate limited per IP: 30 a minute, then 429 with Retry-After', async () => {
    vi.stubEnv('RATE_LIMIT_DISABLED', '0')
    for (let i = 0; i < 30; i++) expect((await post(legacy(), { ip: '198.51.100.7' }).res).status).toBe(204)
    const limited = await post(legacy(), { ip: '198.51.100.7' }).res
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    expect((await post(legacy(), { ip: '198.51.100.8' }).res).status).toBe(204)
  })
})
