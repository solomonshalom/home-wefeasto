import type { Endpoint, PayloadHandler } from 'payload'

import { HttpError, json, jsonError, readJsonBody, withErrors } from '../lib/http'
import { enforceRateLimit } from '../lib/rateLimit'
import { resolvePaymentConfig } from './config'
import { getMockGateway } from './index'
import { MOCK_METHODS, MOCK_OUTCOMES, type MockOp, type MockOutcome } from './mock'
import { renderMockCheckoutScript } from './mockCheckoutScript'
import { isRazorpayOrderId } from './signatures'
import { GatewayError, type GatewayErrorKind } from './types'

/**
 * Mock-mode-only endpoints (SPEC §6). All answer 404 NOT_FOUND unless PAYMENTS_MODE=mock (checked per
 * request, so flipping the env in a test takes effect immediately). Fault injection: see mockFaultHandler.
 *
 *   GET  /api/payments/mock/checkout.js   the window.Razorpay stand-in (application/javascript, no-store)
 *   POST /api/payments/mock/pay           { razorpayOrderId, outcome, method?, webhook?, reason?, email?,
 *                                           contact?, description?, amount?, lateAuthDelayMs? }
 *        200 { ok: true,  response: {razorpay_payment_id, razorpay_order_id, razorpay_signature}, paymentId, paymentStatus, webhooks }
 *        200 { ok: false, error: {code, description, source, step, reason, metadata:{order_id, payment_id}}, paymentId, paymentStatus, webhooks }
 *        400 VALIDATION {fields} (also: `amount` ≠ the order amount) · 404 NOT_FOUND (unknown order) · 413 · 415 · 429
 *        503 PAYMENTS_UNAVAILABLE (injected fault)
 *
 * Signed webhooks for the attempt are delivered MOCK_WEBHOOK_DELAY_MS (default 1500) later unless
 * `webhook: false`; 'late' payments are authorised `lateAuthDelayMs` (default MOCK_LATE_AUTH_DELAY_MS,
 * 10 s) later, followed by their webhooks.
 */

export const MOCK_SCRIPT_PATH = '/payments/mock/checkout.js'
export const MOCK_PAY_PATH = '/payments/mock/pay'
export const MOCK_FAULT_PATH = '/payments/mock/fault'

const notFound = () => jsonError(404, 'NOT_FOUND')

export const mockCheckoutScriptHandler: PayloadHandler = withErrors(async (req) => {
  const mock = getMockGateway()
  if (!mock) return notFound()
  const limited = enforceRateLimit(req, 'mock-checkout-js', { limit: 240, windowMs: 60_000 })
  if (limited) return limited
  const body = renderMockCheckoutScript({ keyId: mock.keyId, payPath: `/api${MOCK_PAY_PATH}` })
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

export interface MockPayRequest {
  razorpayOrderId: string
  outcome: MockOutcome
  method?: string
  webhook: boolean
  reason?: string
  email?: string
  contact?: string
  description?: string
  amount?: number
  lateAuthDelayMs?: number
}

const blank = (v: unknown) => v === undefined || v === null || v === ''

/** Validates the /mock/pay body. Returns the value or a `{field: code}` map ('required' | 'invalid'). */
export function parseMockPayBody(body: Record<string, unknown>): { value?: MockPayRequest; fields?: Record<string, string> } {
  const fields: Record<string, string> = {}
  const { razorpayOrderId, outcome, method, webhook, reason, email, contact, description, amount, lateAuthDelayMs } = body

  if (blank(razorpayOrderId)) fields.razorpayOrderId = 'required'
  else if (!isRazorpayOrderId(razorpayOrderId)) fields.razorpayOrderId = 'invalid'

  if (blank(outcome)) fields.outcome = 'required'
  else if (!MOCK_OUTCOMES.includes(outcome as MockOutcome)) fields.outcome = 'invalid'

  if (!blank(method) && !(MOCK_METHODS as readonly unknown[]).includes(method)) fields.method = 'invalid'
  if (webhook !== undefined && typeof webhook !== 'boolean') fields.webhook = 'invalid'
  if (!blank(reason) && (typeof reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(reason))) fields.reason = 'invalid'
  if (!blank(email) && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))) fields.email = 'invalid'
  if (!blank(contact) && (typeof contact !== 'string' || !/^\+?[0-9][0-9 -]{5,19}$/.test(contact))) fields.contact = 'invalid'
  if (!blank(description) && (typeof description !== 'string' || description.length > 255)) fields.description = 'invalid'
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1)) fields.amount = 'invalid'
  if (
    lateAuthDelayMs !== undefined &&
    (typeof lateAuthDelayMs !== 'number' || !Number.isInteger(lateAuthDelayMs) || lateAuthDelayMs < 0 || lateAuthDelayMs > 600_000)
  ) {
    fields.lateAuthDelayMs = 'invalid'
  }

  if (Object.keys(fields).length) return { fields }
  return {
    value: {
      razorpayOrderId: razorpayOrderId as string,
      outcome: outcome as MockOutcome,
      webhook: webhook !== false,
      ...(blank(method) ? {} : { method: method as string }),
      ...(blank(reason) ? {} : { reason: reason as string }),
      ...(blank(email) ? {} : { email: email as string }),
      ...(blank(contact) ? {} : { contact: contact as string }),
      ...(blank(description) ? {} : { description: description as string }),
      ...(amount === undefined ? {} : { amount: amount as number }),
      ...(lateAuthDelayMs === undefined ? {} : { lateAuthDelayMs: lateAuthDelayMs as number }),
    },
  }
}

export const mockPayHandler: PayloadHandler = withErrors(async (req) => {
  const mock = getMockGateway()
  if (!mock) return notFound()
  const limited = enforceRateLimit(req, 'mock-pay', { limit: 60, windowMs: 60_000 })
  if (limited) return limited

  const body = await readJsonBody(req, { maxBytes: 2048 })
  const { value, fields } = parseMockPayBody(body)
  if (!value) throw new HttpError(400, 'VALIDATION', undefined, { fields })

  let result
  try {
    result = await mock.simulatePayment(value.razorpayOrderId, {
      outcome: value.outcome,
      method: value.method,
      reason: value.reason,
      email: value.email,
      contact: value.contact,
      description: value.description,
      amount: value.amount,
    })
  } catch (err) {
    if (err instanceof GatewayError && err.kind === 'not_found') throw new HttpError(404, 'NOT_FOUND', 'The id provided does not exist.')
    if (err instanceof GatewayError && err.kind === 'bad_request') {
      throw new HttpError(400, 'VALIDATION', err.description, err.field ? { fields: { [err.field]: 'mismatch' } } : undefined)
    }
    if (err instanceof GatewayError) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'The mock gateway is failing on purpose (fault injection).')
    throw err
  }

  const cfg = resolvePaymentConfig()
  const webhooks = value.webhook ? result.events.map((e) => e.event) : []
  if (value.webhook) void mock.emitWebhooks(result.events, { delayMs: cfg.mockWebhookDelayMs })
  if (value.outcome === 'late' && result.payment.error_reason !== 'order_already_paid') {
    const delay = value.lateAuthDelayMs ?? cfg.mockLateAuthDelayMs
    void mock.scheduleLateAuthorization(result.payment.id, delay, value.webhook ? {} : false)
  }

  const common = { paymentId: result.payment.id, paymentStatus: result.payment.status, webhooks }
  return json(result.ok ? { ok: true, response: result.response, ...common } : { ok: false, error: result.error, ...common }, {
    cache: 'no-store',
  })
})

export const MOCK_FAULT_OPS = [
  'createOrder',
  'fetchOrder',
  'fetchOrderPayments',
  'fetchPayment',
  'findOrdersByReceipt',
  'refund',
  'fetchRefunds',
  'simulatePayment',
  'capturePayment',
  '*',
] as const satisfies readonly MockOp[]
export const MOCK_FAULT_KINDS = ['network', 'timeout', 'rate_limited', 'server', 'bad_request', 'auth', 'not_found'] as const satisfies readonly GatewayErrorKind[]

export interface MockFaultRequest {
  op: MockOp
  kind: GatewayErrorKind
  times: number
  commit: boolean
  statusCode?: number
}

/**
 * Validates the /mock/fault body `{op, kind, times?, commit?, statusCode?}`. `{probe: true}` alone (the e2e
 * harness's `faultsAvailable()`) is answered with `{probe: true}` and arms nothing.
 */
export function parseMockFaultBody(body: Record<string, unknown>): { value?: MockFaultRequest; probe?: true; fields?: Record<string, string> } {
  const { op, kind, times, commit, statusCode, probe } = body
  if (probe === true && op === undefined && kind === undefined) return { probe: true }
  const fields: Record<string, string> = {}
  if (blank(op)) fields.op = 'required'
  else if (!(MOCK_FAULT_OPS as readonly unknown[]).includes(op)) fields.op = 'invalid'
  if (blank(kind)) fields.kind = 'required'
  else if (!(MOCK_FAULT_KINDS as readonly unknown[]).includes(kind)) fields.kind = 'invalid'
  if (times !== undefined && (typeof times !== 'number' || !Number.isInteger(times) || times < 1 || times > 20)) fields.times = 'invalid'
  if (commit !== undefined && typeof commit !== 'boolean') fields.commit = 'invalid'
  if (statusCode !== undefined && (typeof statusCode !== 'number' || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)) {
    fields.statusCode = 'invalid'
  }
  if (Object.keys(fields).length) return { fields }
  return {
    value: {
      op: op as MockOp,
      kind: kind as GatewayErrorKind,
      times: (times as number | undefined) ?? 1,
      commit: commit === true,
      ...(statusCode === undefined ? {} : { statusCode: statusCode as number }),
    },
  }
}

/**
 * POST   /api/payments/mock/fault  {op, kind, times?, commit?, statusCode?} → 200 {ok:true, armed:[{op, kind, remaining, commit}]}
 *                                  400 VALIDATION {fields} · 404 NOT_FOUND unless PAYMENTS_MODE=mock · 413 · 415 · 429
 * DELETE /api/payments/mock/fault  → 200 {ok:true, armed:[]} (disarms every pending fault)
 *
 * MockGateway.failNext over HTTP, so browser e2e against a running CMS can reach the gateway-outage paths
 * (PAYMENTS_UNAVAILABLE from createOrder, commit:true lost-response replay, verify's fetchPayment timeout).
 */
export const mockFaultHandler: PayloadHandler = withErrors(async (req) => {
  const mock = getMockGateway()
  if (!mock) return notFound()
  const limited = enforceRateLimit(req, 'mock-fault', { limit: 120, windowMs: 60_000 })
  if (limited) return limited
  const body = await readJsonBody(req, { maxBytes: 1024 })
  const { value, probe, fields } = parseMockFaultBody(body)
  if (probe) return json({ ok: true, probe: true, armed: mock.armedFaults() }, { cache: 'no-store' })
  if (!value) throw new HttpError(400, 'VALIDATION', undefined, { fields })
  mock.failNext(value.op, value.kind, {
    times: value.times,
    commit: value.commit,
    ...(value.statusCode === undefined ? {} : { statusCode: value.statusCode }),
  })
  return json({ ok: true, armed: mock.armedFaults() }, { cache: 'no-store' })
})

export const mockFaultClearHandler: PayloadHandler = withErrors(async (req) => {
  const mock = getMockGateway()
  if (!mock) return notFound()
  const limited = enforceRateLimit(req, 'mock-fault', { limit: 120, windowMs: 60_000 })
  if (limited) return limited
  mock.clearFaults()
  return json({ ok: true, armed: [] }, { cache: 'no-store' })
})

export const mockPaymentEndpoints: Endpoint[] = [
  { path: MOCK_SCRIPT_PATH, method: 'get', handler: mockCheckoutScriptHandler },
  { path: MOCK_PAY_PATH, method: 'post', handler: mockPayHandler },
  { path: MOCK_FAULT_PATH, method: 'post', handler: mockFaultHandler },
  { path: MOCK_FAULT_PATH, method: 'delete', handler: mockFaultClearHandler },
]
