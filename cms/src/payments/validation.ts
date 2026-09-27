import { isRazorpayOrderId, isRazorpayPaymentId } from './signatures'
import { GatewayError, type Notes } from './types'

/**
 * Input rules Razorpay enforces (razorpay.md §3, §8), checked locally by both gateways so the mock rejects
 * exactly what the real API would, and the SDK never sees an input that makes it throw synchronously.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const badInput = (op: string, description: string, field?: string): GatewayError =>
  new GatewayError({
    kind: 'bad_request',
    code: 'BAD_REQUEST_ERROR',
    description,
    statusCode: 0,
    retryable: false,
    op,
    ...(field ? { field } : {}),
  })

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

/** Receipts: 1–40 printable ASCII characters. */
export function assertReceipt(op: string, receipt: unknown): string {
  if (typeof receipt !== 'string' || receipt.length < 1 || receipt.length > 40 || !PRINTABLE_ASCII.test(receipt)) {
    throw badInput(op, 'receipt must be 1-40 printable ASCII characters.', 'receipt')
  }
  return receipt
}

/** Notes: at most 15 keys, string values of at most 256 characters. Returns a copy ({} when absent). */
export function assertNotes(op: string, notes: unknown): Notes {
  if (notes === undefined || notes === null) return {}
  if (!isObj(notes)) throw badInput(op, 'notes must be an object.', 'notes')
  const entries = Object.entries(notes)
  if (entries.length > 15) throw badInput(op, 'notes can have at most 15 keys.', 'notes')
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || v.length > 256 || k.length > 256) {
      throw badInput(op, 'notes values must be strings of at most 256 characters.', 'notes')
    }
  }
  return { ...(notes as Notes) }
}

/** Order amount: integer paise, at least 100 (₹1.00). */
export function assertOrderAmount(op: string, amount: unknown): number {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) throw badInput(op, 'The amount must be an integer.', 'amount')
  if (amount < 100) throw badInput(op, 'The amount must be at least INR 1.00.', 'amount')
  return amount
}

/** Refund amount: undefined (full refund) or a positive integer. */
export function assertRefundAmount(op: string, amount: unknown): number | undefined {
  if (amount === undefined) return undefined
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
    throw badInput(op, 'The refund amount must be a positive integer (paise).', 'amount')
  }
  return amount
}

export function assertRefundSpeed(op: string, speed: unknown): 'normal' | 'optimum' {
  if (speed === undefined) return 'normal'
  if (speed !== 'normal' && speed !== 'optimum') throw badInput(op, 'speed must be normal or optimum.', 'speed')
  return speed
}

export function assertOrderId(op: string, id: unknown): string {
  if (!isRazorpayOrderId(id)) throw badInput(op, 'Invalid order id.', 'order_id')
  return id
}

export function assertPaymentId(op: string, id: unknown): string {
  if (!isRazorpayPaymentId(id)) throw badInput(op, 'Invalid payment id.', 'payment_id')
  return id
}
