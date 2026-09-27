import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { getTestPayload } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

/**
 * POST /api/store/csp-report through the real Payload REST stack (routing, CSRF, the custom-endpoint
 * handler): the storefront's report-only CSP collector (vercel.json; hunt w5-security csp-reporting).
 * A browser sends it cookies (same origin through the /api rewrite) and an Origin: neither matters.
 * Unit coverage of the parsing: tests/unit/cspReport.test.ts; browser → CMS log: e2e/full/experience/csp-report.spec.js.
 */

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const report = {
  'csp-report': {
    'document-uri': 'https://wefeasto.com/order?no=WF-1&t=GUEST-TOKEN',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://skimmer.example/a.js?x=1',
    disposition: 'report',
    'status-code': 200,
  },
}

describe('POST /api/store/csp-report', () => {
  it('application/csp-report with the shop cookie + Origin → 204, one info line, no token in it', async () => {
    const info = vi.spyOn(payload.logger, 'info')
    const res = await restPost('store/csp-report', {
      rawBody: JSON.stringify(report),
      contentType: 'application/csp-report',
      cookie: 'payload-token=not-a-real-jwt; wf_bag=1',
    })
    expect(res.status).toBe(204)
    expect(res.text).toBe('')
    const lines = info.mock.calls.map(([obj]) => obj as Record<string, unknown>).filter((o) => o?.msg === 'csp violation')
    expect(lines).toEqual([
      {
        msg: 'csp violation',
        csp: {
          directive: 'script-src-elem',
          blocked: 'https://skimmer.example/a.js',
          document: 'https://wefeasto.com/order',
          disposition: 'report',
          status: 200,
          count: 1,
        },
      },
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('GUEST-TOKEN')
  })

  it('application/reports+json (Chromium Reporting API) → 204', async () => {
    const res = await restPost('store/csp-report', {
      rawBody: JSON.stringify([{ type: 'csp-violation', age: 1, url: 'https://wefeasto.com/', body: { documentURL: 'https://wefeasto.com/', effectiveDirective: 'img-src', blockedURL: 'inline', disposition: 'report' } }]),
      contentType: 'application/reports+json',
    })
    expect(res.status).toBe(204)
  })

  it('refusals use the standard error body', async () => {
    const wrongType = await restPost('store/csp-report', { rawBody: JSON.stringify(report), contentType: 'text/plain' })
    expect(wrongType.status).toBe(415)
    expect(wrongType.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    const notReport = await restPost('store/csp-report', { body: { hello: 'world' } })
    expect(notReport.status).toBe(400)
    expect(notReport.body.error.code).toBe('VALIDATION')
  })

  it('GET is not served', async () => {
    expect((await restGet('store/csp-report')).status).toBe(404)
  })
})
