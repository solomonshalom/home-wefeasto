import type { PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getMockGateway, resetGateway } from '@/payments'
import { destroySharedMockState } from '@/payments/mock'
import {
  MOCK_FAULT_PATH,
  mockFaultClearHandler,
  mockFaultHandler,
  mockPaymentEndpoints,
  parseMockFaultBody,
} from '@/payments/mockEndpoints'
import { GatewayError } from '@/payments/types'
import { resetRateLimits } from '@/lib/rateLimit'

/** POST/DELETE /api/payments/mock/fault (e2e-1): MockGateway.failNext over HTTP, mock mode only. */

const KEYS = ['PAYMENTS_MODE', 'RATE_LIMIT_DISABLED', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  resetGateway()
  resetRateLimits()
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetGateway()
  destroySharedMockState()
  resetRateLimits()
})

const req = (method: 'POST' | 'DELETE', body?: unknown, contentType = 'application/json') =>
  new Request(`http://localhost:3000/api${MOCK_FAULT_PATH}`, {
    method,
    headers: { 'content-type': contentType, 'x-real-ip': '203.0.113.9' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }) as unknown as PayloadRequest

const call = async (method: 'POST' | 'DELETE', body?: unknown, contentType?: string) => {
  const res = await (method === 'POST' ? mockFaultHandler : mockFaultClearHandler)(req(method, body, contentType))
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }
}

describe('parseMockFaultBody', () => {
  it('accepts op + kind with defaults, and the full body', () => {
    expect(parseMockFaultBody({ op: 'createOrder', kind: 'server' })).toEqual({ value: { op: 'createOrder', kind: 'server', times: 1, commit: false } })
    expect(parseMockFaultBody({ op: '*', kind: 'timeout', times: 20, commit: true, statusCode: 504 })).toEqual({
      value: { op: '*', kind: 'timeout', times: 20, commit: true, statusCode: 504 },
    })
    expect(parseMockFaultBody({ probe: true })).toEqual({ probe: true })
  })

  it.each([
    [{}, { op: 'required', kind: 'required' }],
    [{ op: 'deleteEverything', kind: 'server' }, { op: 'invalid' }],
    [{ op: 'createOrder', kind: 'meteor' }, { kind: 'invalid' }],
    [{ op: 'createOrder', kind: 'server', times: 0 }, { times: 'invalid' }],
    [{ op: 'createOrder', kind: 'server', times: 21 }, { times: 'invalid' }],
    [{ op: 'createOrder', kind: 'server', times: 1.5 }, { times: 'invalid' }],
    [{ op: 'createOrder', kind: 'server', times: '2' }, { times: 'invalid' }],
    [{ op: 'createOrder', kind: 'server', commit: 'yes' }, { commit: 'invalid' }],
    [{ op: 'createOrder', kind: 'server', statusCode: 200 }, { statusCode: 'invalid' }],
    [{ op: 'toString', kind: 'constructor' }, { op: 'invalid', kind: 'invalid' }],
    [{ probe: true, op: 'createOrder' }, { kind: 'required' }],
  ])('%j → %j', (body, fields) => {
    expect(parseMockFaultBody(body as Record<string, unknown>)).toEqual({ fields })
  })
})

describe('the endpoint', () => {
  it('is registered for POST and DELETE', () => {
    expect(mockPaymentEndpoints.filter((e) => e.path === MOCK_FAULT_PATH).map((e) => e.method).sort()).toEqual(['delete', 'post'])
  })

  it('404 NOT_FOUND unless PAYMENTS_MODE=mock', async () => {
    process.env.PAYMENTS_MODE = 'razorpay'
    process.env.RAZORPAY_KEY_ID = 'rzp_test_FaultGate01'
    process.env.RAZORPAY_KEY_SECRET = 'fault-secret'
    process.env.RAZORPAY_WEBHOOK_SECRET = 'fault-wh'
    expect(getMockGateway()).toBeNull()
    const post = await call('POST', { op: 'createOrder', kind: 'server' })
    expect(post.status).toBe(404)
    expect(post.body.error.code).toBe('NOT_FOUND')
    expect((await call('POST', { probe: true })).status).toBe(404)
    expect((await call('DELETE')).status).toBe(404)
  })

  it('arms the fault, the next gateway call fails with it, DELETE disarms', async () => {
    process.env.PAYMENTS_MODE = 'mock'
    const mock = getMockGateway()!
    expect(mock).not.toBeNull()

    const probe = await call('POST', { probe: true })
    expect(probe).toMatchObject({ status: 200, body: { ok: true, probe: true, armed: [] }, cache: 'no-store' })

    const armed = await call('POST', { op: 'createOrder', kind: 'server', times: 2 })
    expect(armed.status).toBe(200)
    expect(armed.body).toEqual({ ok: true, armed: [{ op: 'createOrder', kind: 'server', remaining: 2, commit: false }] })

    const err = await mock.createOrder({ amountPaise: 10000, receipt: 'WF-1-a1', notes: { wf_order: 'WF-1' } }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).kind).toBe('server')
    expect(mock.armedFaults()).toEqual([{ op: 'createOrder', kind: 'server', remaining: 1, commit: false }])

    const cleared = await call('DELETE')
    expect(cleared).toMatchObject({ status: 200, body: { ok: true, armed: [] } })
    const created = await mock.createOrder({ amountPaise: 10000, receipt: 'WF-1-a1', notes: { wf_order: 'WF-1' } })
    expect(created.id).toMatch(/^order_/)
  })

  it('commit:true performs the call, then throws (lost response); a replay with the receipt finds it', async () => {
    process.env.PAYMENTS_MODE = 'mock'
    const mock = getMockGateway()!
    expect((await call('POST', { op: 'createOrder', kind: 'timeout', commit: true })).status).toBe(200)
    const err = await mock.createOrder({ amountPaise: 5000, receipt: 'WF-2-a1', notes: { wf_order: 'WF-2' } }).catch((e) => e)
    expect((err as GatewayError).kind).toBe('timeout')
    expect(mock.inspect().orders.map((o) => o.receipt)).toContain('WF-2-a1')
  })

  it('400 VALIDATION with fields for a bad body; 415 for a non-JSON body', async () => {
    process.env.PAYMENTS_MODE = 'mock'
    const bad = await call('POST', { op: 'createOrder', kind: 'meteor', times: 99 })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'VALIDATION', details: { fields: { kind: 'invalid', times: 'invalid' } } })
    expect(getMockGateway()!.armedFaults()).toEqual([])
    expect((await call('POST', 'op=createOrder', 'text/plain')).status).toBe(415)
  })
})
