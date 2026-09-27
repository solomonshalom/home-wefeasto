import { GatewayError, type GatewayOrder, type GatewayPayment, type GatewayRefund, type Notes } from './types'

/** Shaping of Razorpay API responses into the gateway entity types (notes normalised, ids checked). */

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

const badResponse = (op: string) =>
  new GatewayError({ kind: 'server', code: 'BAD_RESPONSE', description: 'Unexpected response from Razorpay.', statusCode: 200, op })

/** Razorpay serialises empty notes as []; normalise to {} (and stringify odd values). */
export function normalizeNotes(notes: unknown): Notes {
  if (!isObj(notes)) return {}
  const out: Notes = {}
  for (const [k, v] of Object.entries(notes)) out[k] = typeof v === 'string' ? v : String(v)
  return out
}

export function toGatewayOrder(raw: unknown, op = 'order'): GatewayOrder {
  if (!isObj(raw) || typeof raw.id !== 'string') throw badResponse(op)
  return { ...(raw as GatewayOrder), notes: normalizeNotes(raw.notes) }
}

export function toGatewayPayment(raw: unknown, op = 'payment'): GatewayPayment {
  if (!isObj(raw) || typeof raw.id !== 'string') throw badResponse(op)
  return { ...(raw as GatewayPayment), notes: normalizeNotes(raw.notes) }
}

export function toGatewayRefund(raw: unknown, op = 'refund'): GatewayRefund {
  if (!isObj(raw) || typeof raw.id !== 'string') throw badResponse(op)
  return { ...(raw as GatewayRefund), notes: normalizeNotes(raw.notes) }
}

/** `items` of a Razorpay collection response (`{entity:'collection', count, items}`). */
export function collectionItems(raw: unknown, op: string): unknown[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw badResponse(op)
  return raw.items
}
