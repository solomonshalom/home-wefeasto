import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createGateway,
  getGateway,
  getMockGateway,
  MOCK_DEFAULT_KEY_ID,
  MockGateway,
  RazorpayGateway,
  resetGateway,
  resolvePaymentConfig,
  setGatewayForTests,
} from '@/payments'
import { MOCK_CHECKOUT_SCRIPT, RAZORPAY_CHECKOUT_SCRIPT } from '@/payments/config'
import { destroySharedMockState } from '@/payments/mock'
import { parseMockPayBody } from '@/payments/mockEndpoints'
import { renderMockCheckoutScript } from '@/payments/mockCheckoutScript'
import { signWebhook } from '@/payments/signatures'
import { readEnv } from '@/env'

const KEYS = ['PAYMENTS_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_OLD', 'MOCK_WEBHOOK_DELAY_MS', 'MOCK_LATE_AUTH_DELAY_MS', 'PAYLOAD_PUBLIC_SERVER_URL'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  resetGateway()
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetGateway()
  destroySharedMockState()
})

const useRazorpayEnv = () => {
  process.env.PAYMENTS_MODE = 'razorpay'
  process.env.RAZORPAY_KEY_ID = 'rzp_test_GatewaySelect01'
  process.env.RAZORPAY_KEY_SECRET = 'select-secret'
  process.env.RAZORPAY_WEBHOOK_SECRET = 'select-wh'
  process.env.RAZORPAY_WEBHOOK_SECRET_OLD = 'select-wh-old'
}

describe('getGateway()', () => {
  it('defaults to a shared MockGateway with the dev defaults in mock mode', () => {
    process.env.PAYMENTS_MODE = 'mock'
    const g = getGateway()
    expect(g).toBeInstanceOf(MockGateway)
    expect(g.provider).toBe('mock')
    expect(g.keyId).toBe(MOCK_DEFAULT_KEY_ID)
    expect(g.checkoutScriptUrl).toBe(MOCK_CHECKOUT_SCRIPT)
    expect(getGateway()).toBe(g) // singleton
    expect(getMockGateway()).toBe(g)
    expect((g as MockGateway).autoWebhooks).toBe(true)
  })

  it('builds a RazorpayGateway in razorpay mode, with both webhook secrets', () => {
    useRazorpayEnv()
    const g = getGateway()
    expect(g).toBeInstanceOf(RazorpayGateway)
    expect(g.keyId).toBe('rzp_test_GatewaySelect01')
    expect(g.checkoutScriptUrl).toBe(RAZORPAY_CHECKOUT_SCRIPT)
    expect((g as RazorpayGateway).timeoutMs).toBe(10_000)
    const raw = '{"entity":"event"}'
    expect(g.verifyWebhookSignature(raw, signWebhook(raw, 'select-wh'))).toBe(true)
    expect(g.verifyWebhookSignature(raw, signWebhook(raw, 'select-wh-old'))).toBe(true)
    expect(getMockGateway()).toBeNull() // mock endpoints stay closed
  })

  it('rebuilds when PAYMENTS_MODE or the keys change', () => {
    process.env.PAYMENTS_MODE = 'mock'
    const a = getGateway()
    useRazorpayEnv()
    const b = getGateway()
    expect(b).not.toBe(a)
    expect(b).toBeInstanceOf(RazorpayGateway)
    process.env.RAZORPAY_KEY_SECRET = 'rotated'
    const c = getGateway()
    expect(c).not.toBe(b)
    expect(getGateway()).toBe(c)
  })

  it('in mock mode, configured Razorpay secrets are used instead of the defaults', () => {
    process.env.PAYMENTS_MODE = 'mock'
    process.env.RAZORPAY_KEY_ID = 'rzp_test_MockWithRealKey'
    process.env.RAZORPAY_WEBHOOK_SECRET = 'configured-wh'
    const g = getGateway()
    expect(g.keyId).toBe('rzp_test_MockWithRealKey')
    const raw = '{}'
    expect(g.verifyWebhookSignature(raw, signWebhook(raw, 'configured-wh'))).toBe(true)
  })

  it('setGatewayForTests overrides until resetGateway()', () => {
    process.env.PAYMENTS_MODE = 'mock'
    const injected = new MockGateway({ runId: 'INJECT' })
    setGatewayForTests(injected)
    expect(getGateway()).toBe(injected)
    expect(getMockGateway()).toBe(injected)
    process.env.PAYMENTS_MODE = 'razorpay'
    expect(getGateway()).toBe(injected) // override wins
    expect(getMockGateway()).toBeNull() // …but mock endpoints follow PAYMENTS_MODE
    resetGateway()
    process.env.PAYMENTS_MODE = 'mock'
    expect(getGateway()).not.toBe(injected)
  })

  it('createGateway refuses unknown modes and razorpay mode without keys', () => {
    expect(() => createGateway(readEnv({ PAYMENTS_MODE: 'stripe' }))).toThrow(/PAYMENTS_MODE/)
    expect(() => createGateway(readEnv({ PAYMENTS_MODE: 'razorpay' }))).toThrow(/RAZORPAY_KEY_ID/)
  })
})

describe('resolvePaymentConfig', () => {
  it('derives the webhook URL and reads the mock delays', () => {
    const cfg = resolvePaymentConfig(readEnv({ PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.com/' }), { MOCK_WEBHOOK_DELAY_MS: '250', MOCK_LATE_AUTH_DELAY_MS: 'nope' })
    expect(cfg).toMatchObject({
      mode: 'mock',
      webhookUrl: 'https://cms.example.com/api/payments/razorpay/webhook',
      mockWebhookDelayMs: 250,
      mockLateAuthDelayMs: 10_000,
    })
    expect(resolvePaymentConfig(readEnv({}), {}).mockWebhookDelayMs).toBe(1500)
    const rz = resolvePaymentConfig(readEnv({ PAYMENTS_MODE: 'razorpay' }), {})
    expect(rz).toMatchObject({ mode: 'razorpay', keyId: '', keySecret: '', webhookSecrets: [] }) // no mock defaults in razorpay mode
  })
})

describe('mock checkout.js source', () => {
  it('is syntactically valid JavaScript with the config embedded safely', () => {
    const src = renderMockCheckoutScript({ keyId: 'rzp_test_</script><b>x', payPath: '/api/payments/mock/pay' })
    expect(() => new Function(src)).not.toThrow()
    expect(src).not.toContain('</script>')
    expect(src).toContain('rzp_test_\\u003c/script\\u003e\\u003cb\\u003ex')
    expect(src).toContain('window.Razorpay = Razorpay')
    expect(src).not.toContain('__WF_MOCK_CONFIG__')
    // backslashes survive (regexes, \n in the alert text)
    expect(src).toContain('/; wv\\) |Gecko\\) Version\\/[^ ]+ Chrome|Windows Phone|Opera Mini|UCBrowser|CriOS/')
    expect(src).toContain("'Payment Failed.\\n'")
    expect(/[^\x00-\x7f]/.test(src)).toBe(false) // pure ASCII
  })

  it('handles "$" sequences in the key id literally', () => {
    const src = renderMockCheckoutScript({ keyId: "rzp_test_$&$'$`", payPath: '/p' })
    expect(src).toContain('"keyId":"rzp_test_$\\u0026$\'$`"')
    expect(() => new Function(src)).not.toThrow()
  })
})

describe('parseMockPayBody', () => {
  const ok = { razorpayOrderId: 'order_MockABCDEF0001', outcome: 'success' }

  it('accepts the minimal body and defaults webhook to true', () => {
    expect(parseMockPayBody(ok)).toEqual({ value: { razorpayOrderId: 'order_MockABCDEF0001', outcome: 'success', webhook: true } })
    expect(
      parseMockPayBody({ ...ok, outcome: 'late', method: 'card', webhook: false, reason: 'payment_timed_out', email: 'a@b.co', contact: '+91 98765 43210', description: 'Order WF-1', lateAuthDelayMs: 0 }).value,
    ).toEqual({
      razorpayOrderId: 'order_MockABCDEF0001',
      outcome: 'late',
      method: 'card',
      webhook: false,
      reason: 'payment_timed_out',
      email: 'a@b.co',
      contact: '+91 98765 43210',
      description: 'Order WF-1',
      lateAuthDelayMs: 0,
    })
    expect(parseMockPayBody({ ...ok, method: '', email: null }).value).toEqual({ ...ok, webhook: true })
  })

  it.each([
    [{}, { razorpayOrderId: 'required', outcome: 'required' }],
    [{ ...ok, razorpayOrderId: 'order_1' }, { razorpayOrderId: 'invalid' }],
    [{ ...ok, razorpayOrderId: 42 }, { razorpayOrderId: 'invalid' }],
    [{ ...ok, outcome: 'refund' }, { outcome: 'invalid' }],
    [{ ...ok, method: 'bitcoin' }, { method: 'invalid' }],
    [{ ...ok, webhook: 'yes' }, { webhook: 'invalid' }],
    [{ ...ok, reason: 'DROP TABLE' }, { reason: 'invalid' }],
    [{ ...ok, email: 'nope' }, { email: 'invalid' }],
    [{ ...ok, contact: 'call me' }, { contact: 'invalid' }],
    [{ ...ok, description: 'x'.repeat(256) }, { description: 'invalid' }],
    [{ ...ok, amount: '47400' }, { amount: 'invalid' }],
    [{ ...ok, amount: 0 }, { amount: 'invalid' }],
    [{ ...ok, lateAuthDelayMs: -1 }, { lateAuthDelayMs: 'invalid' }],
    [{ ...ok, lateAuthDelayMs: 1.5 }, { lateAuthDelayMs: 'invalid' }],
    [{ ...ok, lateAuthDelayMs: 600_001 }, { lateAuthDelayMs: 'invalid' }],
  ])('%j → %j', (body, fields) => {
    expect(parseMockPayBody(body as Record<string, unknown>)).toEqual({ fields })
  })
})
