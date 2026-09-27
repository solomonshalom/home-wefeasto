import {
  MOCK_CHECKOUT_SCRIPT,
  MOCK_DEFAULT_KEY_ID,
  MOCK_DEFAULT_KEY_SECRET,
  MOCK_DEFAULT_WEBHOOK_SECRET,
} from './config'
import { signPayment, signWebhook, verifyPaymentSignature, verifyWebhookSignature } from './signatures'
import {
  classifyDescription,
  GatewayError,
  type CheckoutErrorDetail,
  type CheckoutSuccessResponse,
  type CreateOrderInput,
  type GatewayErrorKind,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
  type RazorpayWebhookEvent,
  type RefundInput,
  type VerifyPaymentSignatureInput,
  type WebhookEntities,
} from './types'
import {
  assertNotes,
  assertOrderAmount,
  assertOrderId,
  assertPaymentId,
  assertReceipt,
  assertRefundAmount,
  assertRefundSpeed,
  badInput,
} from './validation'
import { buildWebhookBody, serializeWebhookBody } from './webhookPayload'

/**
 * In-memory Razorpay (PAYMENTS_MODE=mock): dev, integration tests and browser e2e.
 *
 * Mirrors the Razorpay semantics we depend on (razorpay.md §3, §6-§8):
 *   - orders   created → attempted → paid; amount_paid / amount_due / attempts; receipt idempotency; notes.
 *   - payments created → authorized → captured, or failed (error_code/description/source/step/reason);
 *              late authorisation (failed → authorized → captured later); a second attempt on a paid order
 *              is declined with reason order_already_paid; a late authorisation on an already paid order is
 *              refunded immediately (Razorpay's documented behaviour).
 *   - refunds  only on captured payments, amount ≤ captured − refunded, receipt idempotency, status processed.
 *   - Checkout responses and webhooks carry REAL HMAC-SHA256 signatures made with the configured secrets.
 *
 * State lives on globalThis when `shared: true` (what getGateway() uses), so it survives Next dev HMR and is
 * visible to every module instance in the process. Ids are readable and deterministic within a process:
 * `order_Mock<run><seq>`, `pay_Mock…`, `rfnd_Mock…`, where <run> is 6 base-36 characters fixed per process
 * (so ids never repeat across dev-server restarts sharing one database) and <seq> is a counter that never
 * resets, not even on reset().
 *
 * Test controls: failNext(op, kind, opts), setLatency(ms), reset(), simulatePayment(), capturePayment(),
 * completeLateAuthorization(), emitWebhook()/emitWebhooks(), setWebhookSink(), webhookLog, inspect().
 */

export const MOCK_OUTCOMES = ['success', 'fail', 'late', 'authorize_only'] as const
export type MockOutcome = (typeof MOCK_OUTCOMES)[number]

export const MOCK_METHODS = ['upi', 'card', 'netbanking', 'wallet', 'emi', 'paylater', 'cardless_emi'] as const

export type MockOp =
  | 'createOrder'
  | 'fetchOrder'
  | 'fetchOrderPayments'
  | 'fetchPayment'
  | 'findOrdersByReceipt'
  | 'refund'
  | 'fetchRefunds'
  | 'simulatePayment'
  | 'capturePayment'
  | '*'

export interface FailNextOptions {
  /** How many consecutive calls fail. Default 1. */
  times?: number
  /**
   * Perform the operation, THEN throw: the "response lost" case (e.g. createOrder succeeded at Razorpay but
   * our request timed out). A retry with the same receipt then returns the order that was created.
   */
  commit?: boolean
  statusCode?: number
  code?: string
  description?: string
}

export interface MockWebhookEvent {
  event: RazorpayWebhookEvent
  entities: WebhookEntities
}

export type MockPaymentResult =
  | { ok: true; response: CheckoutSuccessResponse; payment: GatewayPayment; order: GatewayOrder; events: MockWebhookEvent[] }
  | { ok: false; error: CheckoutErrorDetail; payment: GatewayPayment; order: GatewayOrder; events: MockWebhookEvent[] }

export interface SimulatePaymentOptions {
  outcome: MockOutcome
  /** Default 'upi'. */
  method?: string
  /** Checkout prefill; defaults mimic Razorpay's placeholders. */
  email?: string
  contact?: string
  /** Razorpay `error.reason` for fail/late (defaults payment_failed / payment_timed_out). */
  reason?: string
  /** Checkout `description`, copied onto the payment. */
  description?: string
  /**
   * Checkout's `amount` option. When given it must equal the order amount, as in real Checkout
   * (order_amount_mismatch): a mismatch throws a bad_request GatewayError and records nothing.
   */
  amount?: number
}

export interface WebhookDelivery {
  url: string
  event: string
  eventId: string
  /** Exact raw body (sign/verify these bytes). */
  body: string
  signature: string
  headers: Record<string, string>
}

export type WebhookSink = (
  delivery: WebhookDelivery,
) => Promise<{ status: number; body?: unknown } | void> | { status: number; body?: unknown } | void

export interface WebhookResult {
  event: string
  eventId: string
  body: string
  signature: string
  /** sink: handed to a sink function; http: POSTed; dropped: no target (test env without a sink); cancelled: reset() first. */
  target: 'sink' | 'http' | 'dropped' | 'cancelled'
  delivered: boolean
  status?: number
  error?: string
  at: number
}

export interface EmitOptions {
  /** Wait this long before delivering (the event body is built immediately, like Razorpay's snapshot). */
  delayMs?: number
  /** Deliver to this function instead of HTTP (overrides setWebhookSink()). */
  sink?: WebhookSink
  /** Re-use an event id (dedupe tests). */
  eventId?: string
  /** POST here instead of the configured webhook URL. */
  url?: string
}

export interface MockGatewayOptions {
  keyId?: string
  keySecret?: string
  /** Current secret first; extra entries are accepted by verifyWebhookSignature (rotation). Signing uses the first. */
  webhookSecrets?: string[]
  /** Where HTTP webhooks go (default: MOCK_WEBHOOK_URL or none). getGateway() passes `${serverUrl}/api/payments/razorpay/webhook`. */
  webhookUrl?: string
  /** Keep state on globalThis (survives HMR, shared by instances). Default false: private state. */
  shared?: boolean
  /** 6 characters [A-Z0-9] used in ids. Default: derived from the process start time. */
  runId?: string
  /** Clock in ms (created_at fields). */
  now?: () => number
  /** When true, refund() and capturePayment() deliver their webhooks by themselves (dev). Default false. */
  autoWebhooks?: boolean
  /** Delay for automatic webhooks. Default 0. */
  webhookDelayMs?: number
  accountId?: string
  fetch?: typeof fetch
}

interface Fault {
  op: MockOp
  kind: GatewayErrorKind
  remaining: number
  opts: FailNextOptions
}

interface MockState {
  runId: string
  seq: { order: number; pay: number; rfnd: number; card: number; evt: number }
  orders: Map<string, GatewayOrder>
  payments: Map<string, GatewayPayment>
  refunds: Map<string, GatewayRefund>
  lateAuth: Set<string>
  faults: Fault[]
  latencyMs: number
  timers: Map<ReturnType<typeof setTimeout>, () => void>
  webhookLog: WebhookResult[]
  sink: WebhookSink | null
}

const STATE_KEY = Symbol.for('wefeasto.mockGateway.state')
const WEBHOOK_LOG_MAX = 500

const newRunId = (): string => Date.now().toString(36).slice(-6).toUpperCase().padStart(6, '0')

function freshState(runId: string): MockState {
  return {
    runId,
    seq: { order: 0, pay: 0, rfnd: 0, card: 0, evt: 0 },
    orders: new Map(),
    payments: new Map(),
    refunds: new Map(),
    lateAuth: new Set(),
    faults: [],
    latencyMs: 0,
    timers: new Map(),
    webhookLog: [],
    sink: null,
  }
}

function sharedState(runId?: string): MockState {
  const g = globalThis as unknown as Record<symbol, MockState | undefined>
  let s = g[STATE_KEY]
  if (!s) {
    s = freshState(runId ?? newRunId())
    g[STATE_KEY] = s
  }
  return s
}

const clone = <T>(v: T): T => structuredClone(v)

const FAILURE_REASONS: Record<string, { code: string; source: string; step: string; description: string }> = {
  payment_failed: { code: 'BAD_REQUEST_ERROR', source: 'bank', step: 'payment_authorization', description: 'Payment failed' },
  payment_cancelled: {
    code: 'BAD_REQUEST_ERROR',
    source: 'customer',
    step: 'payment_authentication',
    description: 'Payment processing cancelled by user',
  },
  payment_timed_out: {
    code: 'BAD_REQUEST_ERROR',
    source: 'customer',
    step: 'payment_authentication',
    description: 'Payment was not completed on time.',
  },
  insufficient_funds: {
    code: 'BAD_REQUEST_ERROR',
    source: 'customer',
    step: 'payment_authorization',
    description: "Payment failed due to insufficient balance in the customer's account",
  },
  card_declined: {
    code: 'BAD_REQUEST_ERROR',
    source: 'bank',
    step: 'payment_authorization',
    description: 'Your payment could not be completed as this card was declined by the bank.',
  },
  authentication_failed: {
    code: 'BAD_REQUEST_ERROR',
    source: 'customer',
    step: 'payment_authentication',
    description: 'Payment failed as the authentication was not completed.',
  },
  bank_technical_error: {
    code: 'GATEWAY_ERROR',
    source: 'bank',
    step: 'payment_authorization',
    description: 'Payment failed due to a technical error at the bank.',
  },
  order_already_paid: {
    code: 'BAD_REQUEST_ERROR',
    source: 'business',
    step: 'payment_initiation',
    description: 'Your payment has been declined as the order is already paid. Please initiate the payment with a new order.',
  },
}

const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/
const METHOD_RE = /^[a-z][a-z_]{1,19}$/

/** Errors the real API returns, as GatewayErrors (statusCode as Razorpay sends it). */
const apiError = (op: string, description: string, opts: { statusCode?: number; kind?: GatewayErrorKind; code?: string } = {}) =>
  new GatewayError({
    kind: opts.kind ?? 'bad_request',
    code: opts.code ?? 'BAD_REQUEST_ERROR',
    description,
    statusCode: opts.statusCode ?? 400,
    condition: classifyDescription(description),
    op,
  })

const notFound = (op: string) => apiError(op, 'The id provided does not exist', { kind: 'not_found' })

function faultError(op: string, kind: GatewayErrorKind, opts: FailNextOptions): GatewayError {
  const base: Record<GatewayErrorKind, { statusCode: number; code: string; description: string }> = {
    network: { statusCode: 0, code: 'NETWORK_ERROR', description: 'Could not reach Razorpay (mock fault).' },
    timeout: { statusCode: 0, code: 'TIMEOUT', description: 'No response from Razorpay (mock fault).' },
    rate_limited: { statusCode: 429, code: 'BAD_REQUEST_ERROR', description: 'Too many requests (mock fault).' },
    server: { statusCode: 502, code: 'SERVER_ERROR', description: 'Razorpay returned HTTP 502 (mock fault).' },
    bad_request: { statusCode: 400, code: 'BAD_REQUEST_ERROR', description: 'Bad request (mock fault).' },
    auth: { statusCode: 401, code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' },
    not_found: { statusCode: 400, code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
  }
  const b = base[kind]
  const description = opts.description ?? b.description
  return new GatewayError({
    kind,
    code: opts.code ?? b.code,
    description,
    statusCode: opts.statusCode ?? b.statusCode,
    condition: classifyDescription(description),
    op,
  })
}

export class MockGateway implements PaymentGateway {
  readonly provider = 'mock' as const
  readonly keyId: string
  readonly checkoutScriptUrl = MOCK_CHECKOUT_SCRIPT
  readonly webhookUrl: string | undefined
  readonly autoWebhooks: boolean
  readonly webhookDelayMs: number

  readonly #keySecret: string
  readonly #webhookSecrets: string[]
  readonly #state: MockState
  readonly #now: () => number
  readonly #accountId: string
  readonly #fetch: typeof fetch

  constructor(opts: MockGatewayOptions = {}) {
    this.keyId = opts.keyId || MOCK_DEFAULT_KEY_ID
    this.#keySecret = opts.keySecret || MOCK_DEFAULT_KEY_SECRET
    const secrets = (opts.webhookSecrets ?? []).filter(Boolean)
    this.#webhookSecrets = secrets.length ? secrets : [MOCK_DEFAULT_WEBHOOK_SECRET]
    this.webhookUrl = opts.webhookUrl
    this.autoWebhooks = opts.autoWebhooks ?? false
    this.webhookDelayMs = opts.webhookDelayMs ?? 0
    if (opts.runId !== undefined && !/^[A-Z0-9]{6}$/.test(opts.runId)) throw new Error('MockGateway runId must be 6 characters [A-Z0-9]')
    this.#state = opts.shared ? sharedState(opts.runId) : freshState(opts.runId ?? newRunId())
    this.#now = opts.now ?? Date.now
    this.#accountId = opts.accountId ?? 'acc_WefeastoMock01'
    this.#fetch = opts.fetch ?? ((...args) => fetch(...args))
  }

  toJSON() {
    return { provider: this.provider, keyId: this.keyId }
  }

  get runId(): string {
    return this.#state.runId
  }

  // ------------------------------------------------------------------------------------------ internals

  #nowSec(): number {
    return Math.floor(this.#now() / 1000)
  }

  #id(kind: 'order' | 'pay' | 'rfnd' | 'card'): string {
    const n = ++this.#state.seq[kind]
    return `${kind}_Mock${this.#state.runId}${String(n).padStart(4, '0')}`
  }

  #eventId(): string {
    const n = ++this.#state.seq.evt
    return `MockEvt${this.#state.runId}${String(n).padStart(4, '0')}`
  }

  #sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#state.timers.delete(timer)
        resolve(true)
      }, ms)
      timer.unref?.()
      this.#state.timers.set(timer, () => resolve(false))
    })
  }

  /** Latency + fault injection. Throws for plain faults; returns the fault for commit-then-throw ones. */
  async #enter(op: Exclude<MockOp, '*'>): Promise<GatewayError | null> {
    if (this.#state.latencyMs > 0) await this.#sleep(this.#state.latencyMs)
    const i = this.#state.faults.findIndex((f) => (f.op === op || f.op === '*') && f.remaining > 0)
    if (i === -1) return null
    const fault = this.#state.faults[i]
    fault.remaining -= 1
    if (fault.remaining <= 0) this.#state.faults.splice(i, 1)
    const err = faultError(op, fault.kind, fault.opts)
    if (fault.opts.commit) return err
    throw err
  }

  #order(op: string, id: string): GatewayOrder {
    const o = this.#state.orders.get(id)
    if (!o) throw notFound(op)
    return o
  }

  #payment(op: string, id: string): GatewayPayment {
    const p = this.#state.payments.get(id)
    if (!p) throw notFound(op)
    return p
  }

  #newest<T extends { created_at: number }>(list: T[]): T[] {
    // Razorpay collections are newest first; insertion order breaks created_at ties.
    return list.map((v, i) => ({ v, i })).sort((a, b) => b.v.created_at - a.v.created_at || b.i - a.i).map(({ v }) => clone(v))
  }

  // ------------------------------------------------------------------------------------ PaymentGateway

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const op = 'createOrder'
    const amount = assertOrderAmount(op, input?.amountPaise)
    const receipt = assertReceipt(op, input.receipt)
    const notes = assertNotes(op, input.notes)
    const fault = await this.#enter(op)
    let order = [...this.#state.orders.values()].find((o) => o.receipt === receipt)
    if (order) {
      if (order.amount !== amount) {
        throw new GatewayError({
          kind: 'bad_request',
          code: 'RECEIPT_CONFLICT',
          description: `An order with receipt ${receipt} already exists for a different amount.`,
          statusCode: 400,
          condition: 'receipt_conflict',
          op,
        })
      }
    } else {
      order = {
        id: this.#id('order'),
        entity: 'order',
        amount,
        amount_paid: 0,
        amount_due: amount,
        currency: 'INR',
        receipt,
        offer_id: null,
        status: 'created',
        attempts: 0,
        notes,
        created_at: this.#nowSec(),
      }
      this.#state.orders.set(order.id, order)
    }
    if (fault) throw fault
    return clone(order)
  }

  async fetchOrder(orderId: string): Promise<GatewayOrder> {
    const op = 'fetchOrder'
    const id = assertOrderId(op, orderId)
    const fault = await this.#enter(op)
    const order = clone(this.#order(op, id))
    if (fault) throw fault
    return order
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const op = 'fetchOrderPayments'
    const id = assertOrderId(op, orderId)
    const fault = await this.#enter(op)
    this.#order(op, id)
    const list = this.#newest([...this.#state.payments.values()].filter((p) => p.order_id === id))
    if (fault) throw fault
    return list
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const op = 'fetchPayment'
    const id = assertPaymentId(op, paymentId)
    const fault = await this.#enter(op)
    const payment = clone(this.#payment(op, id))
    if (fault) throw fault
    return payment
  }

  async findOrdersByReceipt(receipt: string): Promise<GatewayOrder[]> {
    const op = 'findOrdersByReceipt'
    const r = assertReceipt(op, receipt)
    const fault = await this.#enter(op)
    const list = this.#newest([...this.#state.orders.values()].filter((o) => o.receipt === r))
    if (fault) throw fault
    return list
  }

  async fetchRefunds(paymentId: string): Promise<GatewayRefund[]> {
    const op = 'fetchRefunds'
    const id = assertPaymentId(op, paymentId)
    const fault = await this.#enter(op)
    this.#payment(op, id)
    const list = this.#newest([...this.#state.refunds.values()].filter((r) => r.payment_id === id))
    if (fault) throw fault
    return list
  }

  async refund(paymentId: string, input: RefundInput): Promise<GatewayRefund> {
    const op = 'refund'
    const id = assertPaymentId(op, paymentId)
    const receipt = assertReceipt(op, input?.receipt)
    const notes = assertNotes(op, input.notes)
    const amount = assertRefundAmount(op, input.amountPaise)
    const speed = assertRefundSpeed(op, input.speed)
    const fault = await this.#enter(op)
    const payment = this.#payment(op, id)

    const existing = [...this.#state.refunds.values()].find((r) => r.payment_id === id && r.receipt === receipt)
    if (existing) {
      if (amount !== undefined && existing.amount !== amount) {
        throw new GatewayError({
          kind: 'bad_request',
          code: 'RECEIPT_CONFLICT',
          description: `A refund with receipt ${receipt} already exists for a different amount.`,
          statusCode: 400,
          condition: 'receipt_conflict',
          op,
        })
      }
      if (fault) throw fault
      return clone(existing)
    }

    const { refund, events } = this.#applyRefund(op, payment, { amount, receipt, notes, speed })
    if (this.autoWebhooks) void this.emitWebhooks(events, { delayMs: this.webhookDelayMs })
    if (fault) throw fault
    return clone(refund)
  }

  #applyRefund(
    op: string,
    payment: GatewayPayment,
    input: { amount?: number; receipt: string | null; notes: Record<string, string>; speed: 'normal' | 'optimum' },
  ): { refund: GatewayRefund; events: MockWebhookEvent[] } {
    if (payment.status !== 'captured' && payment.status !== 'refunded') {
      throw apiError(op, 'The payment status should be captured for action to be taken.')
    }
    const refundable = payment.amount - payment.amount_refunded
    if (refundable <= 0) throw apiError(op, 'The payment has been fully refunded already.')
    const amount = input.amount ?? refundable
    if (amount > refundable) throw apiError(op, 'The refund amount provided is greater than amount captured.')

    const refund: GatewayRefund = {
      id: this.#id('rfnd'),
      entity: 'refund',
      amount,
      currency: payment.currency,
      payment_id: payment.id,
      notes: input.notes,
      receipt: input.receipt,
      acquirer_data: { arn: null },
      created_at: this.#nowSec(),
      batch_id: null,
      status: 'processed',
      speed_processed: input.speed === 'optimum' ? 'instant' : 'normal',
      speed_requested: input.speed,
    }
    this.#state.refunds.set(refund.id, refund)
    payment.amount_refunded += amount
    const full = payment.amount_refunded >= payment.amount
    payment.refund_status = full ? 'full' : 'partial'
    if (full) payment.status = 'refunded'
    return { refund, events: [{ event: 'refund.processed', entities: { refund: clone(refund), payment: clone(payment) } }] }
  }

  verifyPaymentSignature(input: VerifyPaymentSignatureInput): boolean {
    return verifyPaymentSignature({ ...input, keySecret: this.#keySecret })
  }

  verifyWebhookSignature(rawBody: string | Uint8Array, signature: string | null | undefined): boolean {
    return verifyWebhookSignature(rawBody, signature, this.#webhookSecrets)
  }

  // ------------------------------------------------------------------------------------ payment simulation

  /** The signature Checkout would hand to `handler` for this pair (made with the configured key secret). */
  signPayment(orderId: string, paymentId: string): string {
    return signPayment(orderId, paymentId, this.#keySecret)
  }

  #newPayment(order: GatewayOrder, opts: SimulatePaymentOptions): GatewayPayment {
    const method = opts.method ?? 'upi'
    const n = this.#state.seq.pay + 1
    const ref = `${this.#state.runId.replace(/\D/g, '').padEnd(4, '7').slice(0, 4)}${String(n).padStart(8, '0')}`
    const payment: GatewayPayment = {
      id: this.#id('pay'),
      entity: 'payment',
      amount: order.amount,
      currency: order.currency,
      status: 'created',
      order_id: order.id,
      invoice_id: null,
      international: false,
      method,
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      description: opts.description ?? null,
      card_id: null,
      bank: null,
      wallet: null,
      vpa: null,
      email: opts.email || 'void@razorpay.com',
      contact: opts.contact || '+919000090000',
      notes: { ...order.notes },
      fee: null,
      tax: null,
      error_code: null,
      error_description: null,
      error_source: null,
      error_step: null,
      error_reason: null,
      acquirer_data: {},
      created_at: this.#nowSec(),
    }
    if (method === 'upi') {
      payment.vpa = 'wefeasto.mock@okhdfcbank'
      payment.upi = { payer_account_type: 'bank_account', vpa: payment.vpa, flow: 'intent' }
      payment.acquirer_data = { rrn: ref }
    } else if (method === 'card') {
      payment.card_id = this.#id('card')
      payment.card = {
        id: payment.card_id,
        entity: 'card',
        name: '',
        last4: '1111',
        network: 'Visa',
        type: 'debit',
        issuer: 'HDFC',
        international: false,
        emi: false,
        sub_type: 'consumer',
      }
      payment.acquirer_data = { auth_code: ref.slice(-6) }
    } else if (method === 'netbanking') {
      payment.bank = 'HDFC'
      payment.acquirer_data = { bank_transaction_id: ref }
    } else if (method === 'wallet') {
      payment.wallet = 'paytm'
      payment.acquirer_data = { transaction_id: null }
    }
    this.#state.payments.set(payment.id, payment)
    return payment
  }

  #fail(payment: GatewayPayment, reason: string) {
    const r = FAILURE_REASONS[reason] ?? { ...FAILURE_REASONS.payment_failed }
    payment.status = 'failed'
    payment.error_code = r.code
    payment.error_description = r.description
    payment.error_source = r.source
    payment.error_step = r.step
    payment.error_reason = reason
  }

  #authorize(payment: GatewayPayment) {
    payment.status = 'authorized'
    payment.error_code = null
    payment.error_description = null
    payment.error_source = null
    payment.error_step = null
    payment.error_reason = null
  }

  /** Captures an authorized payment; returns the events it produces. */
  #capture(payment: GatewayPayment): MockWebhookEvent[] {
    payment.status = 'captured'
    payment.captured = true
    payment.fee = Math.round(payment.amount * 0.02)
    payment.tax = Math.round(payment.fee * 0.18)
    const events: MockWebhookEvent[] = [{ event: 'payment.captured', entities: { payment: clone(payment) } }]
    const order = payment.order_id ? this.#state.orders.get(payment.order_id) : undefined
    if (order && order.status !== 'paid') {
      order.status = 'paid'
      order.amount_paid = payment.amount
      order.amount_due = 0
      events.push({ event: 'order.paid', entities: { payment: clone(payment), order: clone(order) } })
    }
    return events
  }

  #errorDetail(payment: GatewayPayment): CheckoutErrorDetail {
    return {
      code: payment.error_code ?? 'BAD_REQUEST_ERROR',
      description: payment.error_description ?? 'Payment failed',
      source: payment.error_source ?? 'bank',
      step: payment.error_step ?? 'payment_authorization',
      reason: payment.error_reason ?? 'payment_failed',
      metadata: { order_id: payment.order_id ?? '', payment_id: payment.id },
    }
  }

  /**
   * What happens when a customer pays in Checkout. Returns what Checkout would hand to the page (the
   * `handler` triple, or the `payment.failed` error) plus the webhook events Razorpay would send, in order.
   * Webhooks are NOT delivered here: pass `result.events` to emitWebhooks() (the /mock/pay endpoint does).
   *
   *   success         authorized → captured, order paid        events: payment.authorized, payment.captured, order.paid
   *   authorize_only  authorized (capture later)                events: payment.authorized
   *   fail            failed (reason default payment_failed)    events: payment.failed
   *   late            failed (payment_timed_out) now; completeLateAuthorization() later authorises and captures
   */
  async simulatePayment(orderId: string, opts: SimulatePaymentOptions): Promise<MockPaymentResult> {
    const op = 'simulatePayment'
    const id = assertOrderId(op, orderId)
    if (!opts || !MOCK_OUTCOMES.includes(opts.outcome)) throw badInput(op, `outcome must be one of ${MOCK_OUTCOMES.join(', ')}.`, 'outcome')
    if (opts.method !== undefined && !METHOD_RE.test(opts.method)) throw badInput(op, 'Invalid method.', 'method')
    if (opts.reason !== undefined && !REASON_RE.test(opts.reason)) throw badInput(op, 'Invalid reason.', 'reason')
    const fault = await this.#enter(op)
    const order = this.#order(op, id)
    if (opts.amount !== undefined && opts.amount !== order.amount) {
      throw badInput(op, `The amount in the Checkout options (${opts.amount}) does not match the order amount (${order.amount}).`, 'amount')
    }
    const payment = this.#newPayment(order, opts)
    order.attempts += 1
    if (order.status === 'created') order.status = 'attempted'

    const events: MockWebhookEvent[] = []
    let ok = false
    if (order.status === 'paid') {
      this.#fail(payment, 'order_already_paid')
      events.push({ event: 'payment.failed', entities: { payment: clone(payment) } })
    } else if (opts.outcome === 'success' || opts.outcome === 'authorize_only') {
      this.#authorize(payment)
      events.push({ event: 'payment.authorized', entities: { payment: clone(payment) } })
      if (opts.outcome === 'success') events.push(...this.#capture(payment))
      ok = true
    } else {
      this.#fail(payment, opts.reason ?? (opts.outcome === 'late' ? 'payment_timed_out' : 'payment_failed'))
      if (opts.outcome === 'late') this.#state.lateAuth.add(payment.id)
      events.push({ event: 'payment.failed', entities: { payment: clone(payment) } })
    }
    if (fault) throw fault
    const base = { payment: clone(payment), order: clone(order), events }
    return ok
      ? {
          ok: true,
          response: {
            razorpay_payment_id: payment.id,
            razorpay_order_id: order.id,
            razorpay_signature: this.signPayment(order.id, payment.id),
          },
          ...base,
        }
      : { ok: false, error: this.#errorDetail(payment), ...base }
  }

  /** Captures an `authorize_only` payment (as auto-capture or a Dashboard capture would). */
  async capturePayment(paymentId: string): Promise<{ payment: GatewayPayment; events: MockWebhookEvent[] }> {
    const op = 'capturePayment'
    const id = assertPaymentId(op, paymentId)
    const fault = await this.#enter(op)
    const payment = this.#payment(op, id)
    if (payment.status === 'captured' || payment.status === 'refunded') {
      throw apiError(op, 'This payment has already been captured')
    }
    if (payment.status !== 'authorized') throw apiError(op, 'Only payments which have been authorized and not yet captured can be captured')
    const events = this.#capture(payment)
    if (this.autoWebhooks) void this.emitWebhooks(events, { delayMs: this.webhookDelayMs })
    if (fault) throw fault
    return { payment: clone(payment), events }
  }

  /**
   * The bank confirms a 'late' payment (razorpay.md §7): failed → authorized → (auto) captured, and the
   * order becomes paid. If the order was paid by another payment meanwhile, Razorpay refunds the late one
   * immediately: the payment ends `refunded` and a refund.processed event follows.
   */
  async completeLateAuthorization(
    paymentId: string,
    { capture = true }: { capture?: boolean } = {},
  ): Promise<{ payment: GatewayPayment; order: GatewayOrder | null; events: MockWebhookEvent[] }> {
    const op = 'completeLateAuthorization'
    const id = assertPaymentId(op, paymentId)
    const payment = this.#payment(op, id)
    if (!this.#state.lateAuth.has(id) || payment.status !== 'failed') {
      throw badInput(op, 'This payment is not waiting for a late authorisation.', 'payment_id')
    }
    this.#state.lateAuth.delete(id)
    const order = payment.order_id ? (this.#state.orders.get(payment.order_id) ?? null) : null
    const events: MockWebhookEvent[] = []
    this.#authorize(payment)
    events.push({ event: 'payment.authorized', entities: { payment: clone(payment) } })
    if (order && order.status === 'paid') {
      payment.status = 'captured' // refunds apply to captured payments; Razorpay does this internally
      payment.captured = true
      const { events: refundEvents } = this.#applyRefund(op, payment, {
        receipt: null,
        notes: { reason: 'late_authorization_on_paid_order' },
        speed: 'normal',
      })
      events.push(...refundEvents)
    } else if (capture) {
      events.push(...this.#capture(payment))
    }
    return { payment: clone(payment), order: order ? clone(order) : null, events }
  }

  /**
   * Schedules completeLateAuthorization after `delayMs` (the /mock/pay 'late' outcome), then delivers its
   * webhooks with `emit` options, or none when `emit` is false. Resolves to the delivery results ([] when
   * suppressed), or null when reset() cancelled it or the payment was no longer waiting.
   */
  scheduleLateAuthorization(paymentId: string, delayMs: number, emit: EmitOptions | false = {}): Promise<WebhookResult[] | null> {
    return this.#sleep(delayMs).then(async (fired) => {
      if (!fired) return null
      try {
        const { events } = await this.completeLateAuthorization(paymentId)
        return emit === false ? [] : await this.emitWebhooks(events, { ...emit, delayMs: 0 })
      } catch {
        return null
      }
    })
  }

  // ------------------------------------------------------------------------------------------ webhooks

  /** Builds a signed webhook exactly as it would be delivered (no delivery). */
  buildWebhook(
    event: RazorpayWebhookEvent,
    entities: WebhookEntities,
    opts: { eventId?: string; createdAt?: number } = {},
  ): Omit<WebhookDelivery, 'url'> {
    const body = serializeWebhookBody(
      buildWebhookBody(event, entities, { accountId: this.#accountId, createdAt: opts.createdAt ?? this.#nowSec() }),
    )
    const signature = signWebhook(body, this.#webhookSecrets[0])
    const eventId = opts.eventId ?? this.#eventId()
    return {
      event,
      eventId,
      body,
      signature,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
        'user-agent': 'Razorpay-Webhook/v1 (wefeasto-mock)',
      },
    }
  }

  /** Where webhooks go when no sink is given: MOCK_WEBHOOK_URL, else the configured URL; never HTTP under NODE_ENV=test. */
  #httpTarget(explicit?: string): string | null {
    if (explicit) return explicit
    const override = process.env.MOCK_WEBHOOK_URL
    if (override) return override
    if (process.env.NODE_ENV === 'test') return null
    return this.webhookUrl ?? null
  }

  /**
   * Builds, signs and delivers one webhook (after `delayMs`). Never rejects: the outcome is in the result
   * and in `webhookLog`. Target: opts.sink, else setWebhookSink(), else HTTP POST to the webhook URL.
   */
  async emitWebhook(event: RazorpayWebhookEvent, entities: WebhookEntities, opts: EmitOptions = {}): Promise<WebhookResult> {
    const built = this.buildWebhook(event, entities, { eventId: opts.eventId })
    if (opts.delayMs && opts.delayMs > 0) {
      const fired = await this.#sleep(opts.delayMs)
      if (!fired) return this.#log({ ...this.#base(built), target: 'cancelled', delivered: false })
    }
    const sink = opts.sink ?? this.#state.sink
    const url = this.#httpTarget(opts.url) ?? ''
    const delivery: WebhookDelivery = { url, ...built }
    if (sink) {
      try {
        const res = await sink(delivery)
        const status = res && typeof res === 'object' && typeof res.status === 'number' ? res.status : 200
        return this.#log({ ...this.#base(built), target: 'sink', delivered: status >= 200 && status < 300, status })
      } catch (err) {
        return this.#log({ ...this.#base(built), target: 'sink', delivered: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (!url) return this.#log({ ...this.#base(built), target: 'dropped', delivered: false, error: 'no webhook target (NODE_ENV=test without a sink)' })
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: built.headers,
        body: built.body,
        signal: AbortSignal.timeout(5000),
      })
      await res.arrayBuffer().catch(() => undefined)
      return this.#log({ ...this.#base(built), target: 'http', delivered: res.ok, status: res.status })
    } catch (err) {
      return this.#log({ ...this.#base(built), target: 'http', delivered: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Delivers events in order (each after the previous one settled), the first after `delayMs`. */
  async emitWebhooks(events: MockWebhookEvent[], opts: Omit<EmitOptions, 'eventId'> = {}): Promise<WebhookResult[]> {
    const results: WebhookResult[] = []
    for (const [i, e] of events.entries()) {
      results.push(await this.emitWebhook(e.event, e.entities, { ...opts, delayMs: i === 0 ? opts.delayMs : 0 }))
    }
    return results
  }

  #base(b: Omit<WebhookDelivery, 'url'>) {
    return { event: b.event, eventId: b.eventId, body: b.body, signature: b.signature, at: this.#now() }
  }

  #log(result: WebhookResult): WebhookResult {
    const log = this.#state.webhookLog
    log.push(result)
    if (log.length > WEBHOOK_LOG_MAX) log.splice(0, log.length - WEBHOOK_LOG_MAX)
    return result
  }

  /** Deliver every webhook to `sink` (null restores HTTP delivery). Cleared by reset(). */
  setWebhookSink(sink: WebhookSink | null): void {
    this.#state.sink = sink
  }

  /** Every webhook result so far (newest last, capped at 500). */
  get webhookLog(): WebhookResult[] {
    return [...this.#state.webhookLog]
  }

  // ------------------------------------------------------------------------------------------ test controls

  /**
   * The next `times` (default 1) calls of `op` ('*' = any operation) fail with a GatewayError of `kind`,
   * shaped like the real wrapper's (statusCode 0 for network/timeout, 429, 502, 400, 401…).
   */
  failNext(op: MockOp, kind: GatewayErrorKind, opts: FailNextOptions = {}): void {
    this.#state.faults.push({ op, kind, remaining: Math.max(1, opts.times ?? 1), opts })
  }

  /** Faults still armed (for the POST /api/payments/mock/fault answer). */
  armedFaults(): { op: MockOp; kind: GatewayErrorKind; remaining: number; commit: boolean }[] {
    return this.#state.faults.map((f) => ({ op: f.op, kind: f.kind, remaining: f.remaining, commit: f.opts.commit === true }))
  }

  /** Disarms every pending fault (latency and the rest of the state are kept). */
  clearFaults(): void {
    this.#state.faults.length = 0
  }

  /** Every gateway call waits this long first (0 = off). */
  setLatency(ms: number): void {
    this.#state.latencyMs = Math.max(0, ms)
  }

  /**
   * Forgets orders, payments, refunds, faults, latency, the sink and the webhook log, and cancels pending
   * timers (scheduled webhooks resolve as 'cancelled'). Id counters keep counting so ids never repeat.
   */
  reset(): void {
    const s = this.#state
    for (const [timer, cancel] of s.timers) {
      clearTimeout(timer)
      cancel()
    }
    s.timers.clear()
    s.orders.clear()
    s.payments.clear()
    s.refunds.clear()
    s.lateAuth.clear()
    s.faults.length = 0
    s.latencyMs = 0
    s.webhookLog.length = 0
    s.sink = null
  }

  /** Snapshot of everything the mock holds (deep copies). */
  inspect(): { orders: GatewayOrder[]; payments: GatewayPayment[]; refunds: GatewayRefund[]; pendingLateAuth: string[] } {
    return {
      orders: [...this.#state.orders.values()].map(clone),
      payments: [...this.#state.payments.values()].map(clone),
      refunds: [...this.#state.refunds.values()].map(clone),
      pendingLateAuth: [...this.#state.lateAuth],
    }
  }
}

/** Test helper: drop the shared globalThis state entirely (a new runId is picked on next use). */
export function destroySharedMockState(): void {
  const g = globalThis as unknown as Record<symbol, MockState | undefined>
  const s = g[STATE_KEY]
  if (s) {
    for (const [timer, cancel] of s.timers) {
      clearTimeout(timer)
      cancel()
    }
  }
  delete g[STATE_KEY]
}
