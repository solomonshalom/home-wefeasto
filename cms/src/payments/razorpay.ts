import Razorpay from 'razorpay'

import { RAZORPAY_CHECKOUT_SCRIPT } from './config'
import { collectionItems, toGatewayOrder, toGatewayPayment, toGatewayRefund } from './entities'
import { verifyPaymentSignature, verifyWebhookSignature } from './signatures'
import {
  classifyDescription,
  GatewayError,
  type CreateOrderInput,
  type GatewayErrorKind,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
  type RefundInput,
  type VerifyPaymentSignatureInput,
} from './types'
import {
  assertNotes,
  assertOrderAmount,
  assertOrderId,
  assertPaymentId,
  assertReceipt,
  assertRefundAmount,
  assertRefundSpeed,
} from './validation'

/**
 * `PaymentGateway` over razorpay@2.9.8 (pinned exactly: we configure its internal axios instance).
 *
 * What the wrapper adds (razorpay.md §2 SDK defects):
 *   - A timeout. The SDK has none (axios timeout 0). We set `api.rq.defaults.timeout` AND attach a hard
 *     AbortSignal deadline per request (axios' own timeout is a socket-idle timer that a trickling response
 *     can dodge), plus a Promise.race backstop in case a future SDK stops exposing `api.rq`.
 *   - Error normalisation. The SDK rejects with plain objects, with `{statusCode: 502}` and no `error` for
 *     HTML bodies, and with `TypeError: Cannot read properties of undefined (reading 'status')` for every
 *     network failure (the cause is lost). A response interceptor reshapes transport errors before the SDK
 *     sees them, and `normalizeRazorpayError` turns every shape into a `GatewayError`. The axios error (whose
 *     config carries the key secret) never escapes.
 *   - One retry with jitter for network / timeout / 5xx / 429 on idempotent-safe calls: every GET, plus
 *     createOrder (same receipt; "Duplicate request" is recovered through `orders.all({receipt})`) and refund
 *     (same receipt; existing refunds are looked up by receipt before re-sending).
 *   - Local validation mirroring the API (amount, receipt, notes, id formats), so the SDK's synchronous
 *     throws (`orders.fetch('')`) and path injection are impossible.
 *
 * Secrets live in #private fields; `JSON.stringify(gateway)` shows only the provider and key id.
 */

/** Structural subset of the SDK we call (keeps the SDK's sprawling types out of our code). */
export interface RazorpayClientLike {
  api?: { rq?: AxiosInstanceLike }
  orders: {
    create(params: Record<string, unknown>): Promise<unknown>
    fetch(orderId: string): Promise<unknown>
    fetchPayments(orderId: string): Promise<unknown>
    all(params: Record<string, unknown>): Promise<unknown>
  }
  payments: {
    fetch(paymentId: string): Promise<unknown>
    refund(paymentId: string, params: Record<string, unknown>): Promise<unknown>
    fetchMultipleRefund(paymentId: string, params?: Record<string, unknown>): Promise<unknown>
  }
}

interface AxiosInstanceLike {
  defaults: { timeout?: number }
  interceptors: {
    request: { use(onFulfilled: (config: any) => any, onRejected?: (err: any) => any): number }
    response: { use(onFulfilled: ((res: any) => any) | undefined, onRejected?: (err: any) => any): number }
  }
}

export interface GatewayLogger {
  warn?: (obj: Record<string, unknown>) => void
  error?: (obj: Record<string, unknown>) => void
}

export interface RazorpayGatewayOptions {
  keyId: string
  keySecret: string
  webhookSecret: string
  webhookSecretOld?: string
  /** Per-attempt timeout. Default 10 000 ms. */
  timeoutMs?: number
  /** Automatic retries for retryable failures. Default 1 (so at most two attempts). */
  retries?: number
  /** Backoff before retry n: base·2^(n-1) (doubled for 429) + random·jitter. Defaults 250 / 250 ms. */
  retryBaseDelayMs?: number
  retryJitterMs?: number
  logger?: GatewayLogger
  /** Tests: override sleeping / randomness / the SDK client. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  client?: RazorpayClientLike
}

export const DEFAULT_TIMEOUT_MS = 10_000

const TIMEOUT_MARK = 'WF_TIMEOUT'
const NETWORK_MARK = 'WF_NETWORK'

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/**
 * Installs the timeout + error-shaping interceptors on the SDK's axios instance. Returns false when the SDK
 * no longer exposes it (then only the Promise.race backstop applies). Exported for the unit test that pins
 * this SDK internal.
 */
export function configureTransport(client: RazorpayClientLike, timeoutMs: number): boolean {
  const rq = client.api?.rq
  if (!rq || !rq.defaults || !rq.interceptors) return false
  rq.defaults.timeout = timeoutMs
  rq.interceptors.request.use((config) => {
    config.__wfStartedAt = Date.now()
    // Hard deadline: fires even when the socket keeps trickling bytes. Slightly after axios' own timeout so
    // its clearer error wins when both would fire.
    if (!config.signal && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      config.signal = AbortSignal.timeout(timeoutMs + 250)
    }
    return config
  })
  rq.interceptors.response.use(undefined, (err) => Promise.reject(shapeTransportError(err, timeoutMs)))
  return true
}

/**
 * Converts an axios rejection into the `{response:{status, data:{error}}}` shape the SDK's normalizeError
 * expects, so the SDK produces `{statusCode, error}` for every failure instead of a TypeError. Drops the
 * axios config (it holds the Basic-auth secret).
 */
function shapeTransportError(err: any, timeoutMs: number): { response: { status: number; data: { error?: unknown } } } {
  const status = Number(err?.response?.status) || 0
  if (status >= 400) {
    const data = err.response.data
    const error = isObj(data) && isObj(data.error) ? data.error : undefined
    return { response: { status, data: { error } } }
  }
  const code = String(err?.code ?? '')
  const message = String(err?.message ?? '')
  const startedAt = Number(err?.config?.__wfStartedAt) || 0
  const elapsed = startedAt ? Date.now() - startedAt : 0
  // A deadline hit while the body is still streaming surfaces as ERR_BAD_RESPONSE on a 2xx response
  // ("stream has been aborted"): only then is elapsed time used to tell a timeout from a network error.
  const timedOut =
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_CANCELED' ||
    /timeout/i.test(message) ||
    (status > 0 && startedAt > 0 && elapsed >= timeoutMs - 25)
  const error = timedOut
    ? { code: TIMEOUT_MARK, description: `No response from Razorpay within ${timeoutMs} ms.` }
    : { code: NETWORK_MARK, description: `Could not reach Razorpay${/^[A-Z_]+$/.test(code) ? ` (${code})` : ''}.` }
  return { response: { status: 0, data: { error } } }
}

/** Normalises anything the SDK (or our transport shaping) rejects with into a GatewayError. */
export function normalizeRazorpayError(err: unknown, op?: string): GatewayError {
  if (err instanceof GatewayError) return err

  if (isObj(err) && 'statusCode' in err) {
    const statusCode = Number(err.statusCode) || 0
    const e = isObj(err.error) ? err.error : undefined
    const rzCode = str(e?.code)
    const extras = { field: str(e?.field), reason: str(e?.reason), source: str(e?.source), step: str(e?.step), op }

    if (statusCode === 0) {
      if (rzCode === TIMEOUT_MARK) {
        return new GatewayError({ kind: 'timeout', code: 'TIMEOUT', description: str(e?.description) ?? 'Razorpay timed out.', statusCode: 0, op })
      }
      return new GatewayError({ kind: 'network', code: 'NETWORK_ERROR', description: str(e?.description) ?? 'Could not reach Razorpay.', statusCode: 0, op })
    }

    const description = str(e?.description)
    const condition = classifyDescription(description)
    let kind: GatewayErrorKind
    if (statusCode === 401 || statusCode === 403) kind = 'auth'
    else if (statusCode === 404 || condition === 'id_not_found') kind = 'not_found'
    else if (statusCode === 429) kind = 'rate_limited'
    else if (statusCode >= 500) kind = 'server'
    else kind = 'bad_request'

    const fallbackCode = kind === 'server' ? 'SERVER_ERROR' : kind === 'rate_limited' ? 'RATE_LIMITED' : 'BAD_REQUEST_ERROR'
    return new GatewayError({
      kind,
      code: rzCode ?? fallbackCode,
      description: description ?? `Razorpay returned HTTP ${statusCode}.`,
      statusCode,
      // "another operation is in progress" is a 400 that succeeds when repeated a few seconds later.
      ...(condition === 'operation_in_progress' ? { retryable: true } : {}),
      ...(condition ? { condition } : {}),
      ...extras,
    })
  }

  if (err instanceof TypeError) {
    // razorpay@2.9.8 turns every transport failure into this TypeError (razorpay.md §2.1) when our
    // interceptors are not installed. The outcome is unknown.
    return new GatewayError({ kind: 'network', code: 'NETWORK_ERROR', description: 'Could not reach Razorpay (no response).', statusCode: 0, op })
  }
  if (err instanceof Error && /mandatory/i.test(err.message)) {
    return new GatewayError({ kind: 'bad_request', code: 'BAD_REQUEST_ERROR', description: err.message, statusCode: 0, op })
  }
  const name = err instanceof Error ? err.name : typeof err
  return new GatewayError({ kind: 'network', code: 'UNKNOWN_ERROR', description: `Unexpected ${name} from the Razorpay client.`, statusCode: 0, op })
}

const AUTO_RETRY: ReadonlySet<GatewayErrorKind> = new Set(['network', 'timeout', 'server', 'rate_limited'])
const autoRetryable = (e: GatewayError) => AUTO_RETRY.has(e.kind)

// ------------------------------------------------------------------------------------------------- gateway

export class RazorpayGateway implements PaymentGateway {
  readonly provider = 'razorpay' as const
  readonly keyId: string
  readonly checkoutScriptUrl = RAZORPAY_CHECKOUT_SCRIPT
  readonly timeoutMs: number
  /** False when the SDK's axios instance could not be configured (only the race backstop applies). */
  readonly transportConfigured: boolean

  readonly #client: RazorpayClientLike
  readonly #keySecret: string
  readonly #webhookSecrets: string[]
  readonly #retries: number
  readonly #baseDelay: number
  readonly #jitter: number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number
  readonly #logger?: GatewayLogger

  constructor(opts: RazorpayGatewayOptions) {
    if (!opts.keyId || !opts.keySecret) throw new Error('RazorpayGateway needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET')
    if (!opts.webhookSecret) throw new Error('RazorpayGateway needs RAZORPAY_WEBHOOK_SECRET')
    this.keyId = opts.keyId
    this.#keySecret = opts.keySecret
    this.#webhookSecrets = [opts.webhookSecret, opts.webhookSecretOld].filter((s): s is string => Boolean(s))
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#retries = Math.max(0, opts.retries ?? 1)
    this.#baseDelay = opts.retryBaseDelayMs ?? 250
    this.#jitter = opts.retryJitterMs ?? 250
    this.#sleep = opts.sleep ?? defaultSleep
    this.#random = opts.random ?? Math.random
    this.#logger = opts.logger
    this.#client =
      opts.client ?? (new Razorpay({ key_id: opts.keyId, key_secret: opts.keySecret }) as unknown as RazorpayClientLike)
    this.transportConfigured = configureTransport(this.#client, this.timeoutMs)
  }

  toJSON() {
    return { provider: this.provider, keyId: this.keyId }
  }

  // --- plumbing

  /** One attempt, bounded by the timeout even if the transport interceptors are missing. */
  async #once(op: string, fn: () => Promise<unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const backstop = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GatewayError({ kind: 'timeout', code: 'TIMEOUT', description: `No response from Razorpay within ${this.timeoutMs} ms.`, statusCode: 0, op })),
        this.timeoutMs + 1000,
      )
      timer.unref?.()
    })
    try {
      return await Promise.race([Promise.resolve().then(fn), backstop])
    } catch (err) {
      throw normalizeRazorpayError(err, op)
    } finally {
      clearTimeout(timer)
    }
  }

  #delayFor(err: GatewayError, attempt: number): number {
    const base = this.#baseDelay * 2 ** (attempt - 1) * (err.kind === 'rate_limited' ? 2 : 1)
    return Math.round(base + this.#random() * this.#jitter)
  }

  #logRetry(op: string, err: GatewayError, attempt: number) {
    this.#logger?.warn?.({ msg: 'razorpay call failed, retrying', op, attempt, kind: err.kind, statusCode: err.statusCode, code: err.code })
  }

  /** Idempotent-safe call (GETs): retried on network/timeout/5xx/429. */
  async #safe(op: string, fn: () => Promise<unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(op, fn)
      } catch (e) {
        const err = e as GatewayError
        if (attempt < this.#retries && autoRetryable(err)) {
          this.#logRetry(op, err, attempt + 1)
          await this.#sleep(this.#delayFor(err, attempt + 1))
          continue
        }
        throw err
      }
    }
  }

  // --- orders

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const op = 'createOrder'
    const amount = assertOrderAmount(op, input?.amountPaise)
    const receipt = assertReceipt(op, input.receipt)
    const notes = assertNotes(op, input.notes)
    const params = { amount, currency: 'INR', receipt, notes }
    for (let attempt = 0; ; attempt++) {
      try {
        return toGatewayOrder(await this.#once(op, () => this.#client.orders.create({ ...params, notes: { ...notes } })), op)
      } catch (e) {
        const err = e as GatewayError
        // Receipts are idempotency keys: a duplicate means an earlier attempt (maybe one whose response we
        // lost) created the order. Recover it instead of failing the checkout.
        if (err.condition === 'duplicate_request') return this.#recoverOrder(receipt, amount)
        if (attempt < this.#retries && autoRetryable(err)) {
          this.#logRetry(op, err, attempt + 1)
          await this.#sleep(this.#delayFor(err, attempt + 1))
          continue // same receipt
        }
        throw err
      }
    }
  }

  async #recoverOrder(receipt: string, amount: number): Promise<GatewayOrder> {
    const found = (await this.findOrdersByReceipt(receipt))[0]
    if (!found) {
      throw new GatewayError({
        kind: 'server',
        code: 'DUPLICATE_UNRESOLVED',
        description: 'Razorpay reported a duplicate receipt but no order with that receipt was found.',
        statusCode: 400,
        retryable: true,
        condition: 'duplicate_request',
        op: 'createOrder',
      })
    }
    if (found.amount !== amount || found.currency !== 'INR') {
      throw new GatewayError({
        kind: 'bad_request',
        code: 'RECEIPT_CONFLICT',
        description: `An order with receipt ${receipt} already exists for a different amount.`,
        statusCode: 400,
        condition: 'receipt_conflict',
        op: 'createOrder',
      })
    }
    return found
  }

  async fetchOrder(orderId: string): Promise<GatewayOrder> {
    const id = assertOrderId('fetchOrder', orderId)
    return toGatewayOrder(await this.#safe('fetchOrder', () => this.#client.orders.fetch(id)), 'fetchOrder')
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const op = 'fetchOrderPayments'
    const id = assertOrderId(op, orderId)
    const res = await this.#safe(op, () => this.#client.orders.fetchPayments(id))
    return collectionItems(res, op).map((p) => toGatewayPayment(p, op))
  }

  async findOrdersByReceipt(receipt: string): Promise<GatewayOrder[]> {
    const op = 'findOrdersByReceipt'
    const r = assertReceipt(op, receipt)
    const res = await this.#safe(op, () => this.#client.orders.all({ receipt: r, count: 100 }))
    return collectionItems(res, op)
      .map((o) => toGatewayOrder(o, op))
      .filter((o) => o.receipt === r)
  }

  // --- payments

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const id = assertPaymentId('fetchPayment', paymentId)
    return toGatewayPayment(await this.#safe('fetchPayment', () => this.#client.payments.fetch(id)), 'fetchPayment')
  }

  async fetchRefunds(paymentId: string): Promise<GatewayRefund[]> {
    const op = 'fetchRefunds'
    const id = assertPaymentId(op, paymentId)
    const res = await this.#safe(op, () => this.#client.payments.fetchMultipleRefund(id, { count: 100 }))
    return collectionItems(res, op).map((r) => toGatewayRefund(r, op))
  }

  async refund(paymentId: string, input: RefundInput): Promise<GatewayRefund> {
    const op = 'refund'
    const id = assertPaymentId(op, paymentId)
    const receipt = assertReceipt(op, input?.receipt)
    const notes = assertNotes(op, input.notes)
    const amount = assertRefundAmount(op, input.amountPaise)
    const params: Record<string, unknown> = { receipt, speed: assertRefundSpeed(op, input.speed), notes }
    if (amount !== undefined) params.amount = amount

    for (let attempt = 0; ; attempt++) {
      try {
        return toGatewayRefund(await this.#once(op, () => this.#client.payments.refund(id, { ...params, notes: { ...notes } })), op)
      } catch (e) {
        const err = e as GatewayError
        if (err.condition === 'duplicate_receipt') {
          const existing = await this.#findRefund(id, receipt)
          if (existing) return this.#matchRefund(existing, input, receipt)
          throw err
        }
        if (attempt < this.#retries && autoRetryable(err)) {
          // The refund may have been created even though we saw an error. Look before re-sending so a
          // partial refund can never be issued twice; if we cannot look, give up (the caller reconciles).
          let existing: GatewayRefund | undefined
          try {
            existing = await this.#findRefund(id, receipt)
          } catch {
            throw err
          }
          if (existing) return this.#matchRefund(existing, input, receipt)
          this.#logRetry(op, err, attempt + 1)
          await this.#sleep(this.#delayFor(err, attempt + 1))
          continue
        }
        throw err
      }
    }
  }

  async #findRefund(paymentId: string, receipt: string): Promise<GatewayRefund | undefined> {
    return (await this.fetchRefunds(paymentId)).find((r) => r.receipt === receipt)
  }

  #matchRefund(existing: GatewayRefund, input: RefundInput, receipt: string): GatewayRefund {
    if (input.amountPaise !== undefined && existing.amount !== input.amountPaise) {
      throw new GatewayError({
        kind: 'bad_request',
        code: 'RECEIPT_CONFLICT',
        description: `A refund with receipt ${receipt} already exists for a different amount.`,
        statusCode: 400,
        condition: 'receipt_conflict',
        op: 'refund',
      })
    }
    return existing
  }

  // --- signatures

  verifyPaymentSignature(input: VerifyPaymentSignatureInput): boolean {
    return verifyPaymentSignature({ ...input, keySecret: this.#keySecret })
  }

  verifyWebhookSignature(rawBody: string | Uint8Array, signature: string | null | undefined): boolean {
    return verifyWebhookSignature(rawBody, signature, this.#webhookSecrets)
  }
}
