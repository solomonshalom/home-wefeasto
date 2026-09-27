/**
 * Payment gateway abstraction (SPEC §0 "Payments", §6; razorpay.md §9.3a).
 *
 * Every payment call in the CMS goes through `PaymentGateway`, never through the Razorpay SDK directly:
 *   - `RazorpayGateway` (./razorpay.ts) wraps razorpay@2.9.8 with a timeout, error normalisation and retries;
 *   - `MockGateway` (./mock.ts) is an in-memory, Razorpay-faithful fake used in dev, tests and browser e2e.
 * `getGateway()` (./index.ts) picks one from PAYMENTS_MODE.
 *
 * Entities keep Razorpay's own snake_case shapes (they are what webhooks carry), with one normalisation:
 * `notes` is always an object here (Razorpay sends `[]` when empty).
 */

/** Integer paise. */
export type Paise = number

export type PaymentProvider = 'razorpay' | 'mock'

export type RazorpayOrderStatus = 'created' | 'attempted' | 'paid'
export type RazorpayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
export type RazorpayRefundStatus = 'pending' | 'processed' | 'failed'
/** Checkout methods. Razorpay has more (emi, cardless_emi, paylater…); treat unknown values as opaque. */
export type PaymentMethodName = 'upi' | 'card' | 'netbanking' | 'wallet' | 'emi' | (string & {})

export type Notes = Record<string, string>

/** Razorpay order entity (GET /v1/orders/:id). */
export interface GatewayOrder {
  id: string
  entity: 'order'
  amount: Paise
  amount_paid: Paise
  amount_due: Paise
  currency: string
  receipt: string | null
  offer_id: string | null
  status: RazorpayOrderStatus
  /** Number of payment attempts made on this order. */
  attempts: number
  notes: Notes
  /** Unix seconds. */
  created_at: number
}

/** Razorpay payment entity (GET /v1/payments/:id). Only the fields we read are typed strictly. */
export interface GatewayPayment {
  id: string
  entity: 'payment'
  amount: Paise
  currency: string
  status: RazorpayPaymentStatus
  order_id: string | null
  invoice_id: string | null
  international: boolean
  method: PaymentMethodName
  amount_refunded: Paise
  refund_status: 'partial' | 'full' | null
  captured: boolean
  description: string | null
  card_id: string | null
  bank: string | null
  wallet: string | null
  vpa: string | null
  email: string | null
  contact: string | null
  notes: Notes
  fee: number | null
  tax: number | null
  error_code: string | null
  error_description: string | null
  error_source: string | null
  error_step: string | null
  error_reason: string | null
  acquirer_data?: Record<string, unknown>
  card?: Record<string, unknown> | null
  upi?: Record<string, unknown> | null
  /** Unix seconds. */
  created_at: number
  [extra: string]: unknown
}

/** Razorpay refund entity. */
export interface GatewayRefund {
  id: string
  entity: 'refund'
  amount: Paise
  currency: string
  payment_id: string
  notes: Notes
  receipt: string | null
  acquirer_data: { arn: string | null; [k: string]: unknown }
  /** Unix seconds. */
  created_at: number
  batch_id: string | null
  status: RazorpayRefundStatus
  speed_processed: string | null
  speed_requested: string | null
}

export interface CreateOrderInput {
  /** Integer paise, at least 100 (Razorpay's minimum). */
  amountPaise: Paise
  /**
   * ≤ 40 printable ASCII characters, unique per Razorpay order (e.g. `WF-10001-a2`). createOrder is
   * idempotent per receipt: a repeat returns the existing order (or throws RECEIPT_CONFLICT when the
   * amount differs).
   */
  receipt: string
  /** ≤ 15 keys, string values ≤ 256 characters. Put IDs here, never PII. */
  notes?: Notes
}

export interface RefundInput {
  /** Integer paise; omit for a full refund of whatever is still refundable. */
  amountPaise?: Paise
  /** ≤ 40 printable ASCII characters, unique per payment (e.g. `WF-10001-dup-pay_X` or `WF-10001-r1`). Idempotency key. */
  receipt: string
  notes?: Notes
  speed?: 'normal' | 'optimum'
}

/** What Checkout's `handler` receives (and what the redirect callback POSTs) on success. */
export interface CheckoutSuccessResponse {
  razorpay_payment_id: string
  razorpay_order_id: string
  razorpay_signature: string
}

/** `response.error` of Checkout's `payment.failed` event (and the redirect callback's `error[...]` fields). */
export interface CheckoutErrorDetail {
  code: string
  description: string
  source: string
  step: string
  reason: string
  metadata: { order_id: string; payment_id?: string }
  field?: string
}

export interface VerifyPaymentSignatureInput {
  /** The Razorpay order id FROM OUR DATABASE (never only the client's `razorpay_order_id`). */
  orderId: string
  paymentId: string
  signature: string
}

export interface PaymentGateway {
  readonly provider: PaymentProvider
  /** Public key id for Checkout (`key` option, PaymentInit.keyId). Never the secret. */
  readonly keyId: string
  /**
   * Where the browser loads checkout.js from (PaymentInit.checkoutScript). Razorpay: the absolute CDN URL.
   * Mock: `/api/payments/mock/checkout.js`, relative so it goes through the storefront's same-origin /api proxy.
   */
  readonly checkoutScriptUrl: string

  /** POST /v1/orders. Idempotent per receipt (see CreateOrderInput.receipt). */
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>
  fetchOrder(orderId: string): Promise<GatewayOrder>
  /** Every payment attempted on the order (failed, authorized, captured…): the reconciliation primitive. */
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>
  fetchPayment(paymentId: string): Promise<GatewayPayment>
  /** Orders whose receipt equals `receipt` exactly (recovery after an unknown-outcome create). */
  findOrdersByReceipt(receipt: string): Promise<GatewayOrder[]>
  /** POST /v1/payments/:id/refund. Idempotent per (paymentId, receipt). Only captured payments can be refunded. */
  refund(paymentId: string, input: RefundInput): Promise<GatewayRefund>
  fetchRefunds(paymentId: string): Promise<GatewayRefund[]>

  /** Timing-safe Checkout signature check with this gateway's key secret. Never throws for bad input. */
  verifyPaymentSignature(input: VerifyPaymentSignatureInput): boolean
  /** Timing-safe webhook signature check over the RAW body, with the current and the _OLD webhook secret. */
  verifyWebhookSignature(rawBody: string | Uint8Array, signature: string | null | undefined): boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

export type GatewayErrorKind = 'network' | 'timeout' | 'rate_limited' | 'bad_request' | 'auth' | 'server' | 'not_found'

/**
 * Finer classification of Razorpay's (English-only) error descriptions, so callers can branch without
 * string matching. `undefined` when nothing specific was recognised.
 */
export type GatewayErrorCondition =
  | 'duplicate_request'
  | 'duplicate_receipt'
  | 'receipt_conflict'
  | 'amount_exceeds_captured'
  | 'already_refunded'
  | 'not_captured'
  | 'insufficient_balance'
  | 'refund_blocked_dispute'
  | 'partial_refund_unsupported'
  | 'operation_in_progress'
  | 'order_already_paid'
  | 'amount_too_large'
  | 'id_not_found'

const RETRYABLE_KINDS: ReadonlySet<GatewayErrorKind> = new Set(['network', 'timeout', 'rate_limited', 'server'])

export interface GatewayErrorInit {
  kind: GatewayErrorKind
  /** Razorpay `error.code` (e.g. BAD_REQUEST_ERROR) or ours (NETWORK_ERROR, TIMEOUT, RECEIPT_CONFLICT…). */
  code: string
  description: string
  /** HTTP status; 0 when no response arrived (network, timeout). */
  statusCode: number
  /** Defaults to true for network/timeout/rate_limited/server. */
  retryable?: boolean
  condition?: GatewayErrorCondition
  /** Razorpay `error.field` / `error.reason` / `error.source` / `error.step` when present. */
  field?: string
  reason?: string
  source?: string
  step?: string
  /** Gateway operation that failed (createOrder, refund…). */
  op?: string
}

/**
 * The only error type gateway methods reject with. `description` is Razorpay's text (safe to log, never
 * shown to customers verbatim: map with $shared/errors.js). Contains no secrets and no request config.
 */
export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  readonly code: string
  readonly description: string
  readonly statusCode: number
  readonly retryable: boolean
  readonly condition?: GatewayErrorCondition
  readonly field?: string
  readonly reason?: string
  readonly source?: string
  readonly step?: string
  readonly op?: string

  constructor(init: GatewayErrorInit) {
    super(`${init.op ? `${init.op}: ` : ''}${init.kind} ${init.statusCode || '-'} ${init.code}: ${init.description}`)
    this.name = 'GatewayError'
    this.kind = init.kind
    this.code = init.code
    this.description = init.description
    this.statusCode = init.statusCode
    this.retryable = init.retryable ?? RETRYABLE_KINDS.has(init.kind)
    if (init.condition) this.condition = init.condition
    if (init.field) this.field = init.field
    if (init.reason) this.reason = init.reason
    if (init.source) this.source = init.source
    if (init.step) this.step = init.step
    if (init.op) this.op = init.op
  }

  /**
   * True when the request may have been applied even though we got an error (no response, or a 5xx):
   * a create/refund must be reconciled (same receipt) rather than assumed to have failed.
   */
  get outcomeUnknown(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server'
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      code: this.code,
      description: this.description,
      statusCode: this.statusCode,
      retryable: this.retryable,
      ...(this.condition ? { condition: this.condition } : {}),
      ...(this.field ? { field: this.field } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.op ? { op: this.op } : {}),
    }
  }
}

export const isGatewayError = (err: unknown): err is GatewayError => err instanceof GatewayError

/** Maps Razorpay's error descriptions to a condition (case-insensitive substring rules). */
export function classifyDescription(description: string | undefined | null): GatewayErrorCondition | undefined {
  const d = String(description ?? '').toLowerCase()
  if (!d) return undefined
  if (d.includes('duplicate receipt')) return 'duplicate_receipt'
  if (d.includes('duplicate request')) return 'duplicate_request'
  if (d.includes('greater than amount captured') || d.includes('greater than the amount captured')) return 'amount_exceeds_captured'
  if (d.includes('fully refunded already')) return 'already_refunded'
  if (d.includes('status should be captured')) return 'not_captured'
  if (d.includes('does not have enough balance')) return 'insufficient_balance'
  if (d.includes('dispute')) return 'refund_blocked_dispute'
  if (d.includes('partial refund is currently not supported')) return 'partial_refund_unsupported'
  if (d.includes('operation is in progress') || d.includes('operation in progress')) return 'operation_in_progress'
  if (d.includes('order is already paid')) return 'order_already_paid'
  if (d.includes('exceeds maximum amount allowed')) return 'amount_too_large'
  if (d.includes('does not exist')) return 'id_not_found'
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------------------------

/** Events the mock emits (and the ones Wefeasto subscribes to, razorpay.md §6.2). */
export type RazorpayWebhookEvent =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'order.paid'
  | 'refund.created'
  | 'refund.processed'
  | 'refund.failed'
  | (string & {})

/** Entities carried by one webhook (`payload.<name>.entity`). */
export interface WebhookEntities {
  payment?: GatewayPayment
  order?: GatewayOrder
  refund?: GatewayRefund
}

/** The JSON body Razorpay POSTs (razorpay.md §6.4). Empty `notes` are serialised as `[]`. */
export interface RazorpayWebhookBody {
  entity: 'event'
  account_id: string
  event: RazorpayWebhookEvent
  contains: Array<keyof WebhookEntities>
  payload: {
    payment?: { entity: Omit<GatewayPayment, 'notes'> & { notes: Notes | [] } }
    order?: { entity: Omit<GatewayOrder, 'notes'> & { notes: Notes | [] } }
    refund?: { entity: Omit<GatewayRefund, 'notes'> & { notes: Notes | [] } }
  }
  /** Unix seconds. */
  created_at: number
}
