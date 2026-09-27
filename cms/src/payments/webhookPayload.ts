import { normalizeNotes } from './entities'
import type {
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  Notes,
  RazorpayWebhookBody,
  RazorpayWebhookEvent,
  WebhookEntities,
} from './types'

/**
 * Razorpay webhook bodies (razorpay.md §6.4): building them (mock gateway, tests) and reading them
 * (the webhook receiver, after the signature over the RAW body has been verified).
 */

const withRazorpayNotes = <T extends { notes: Notes }>(entity: T): Omit<T, 'notes'> & { notes: Notes | [] } => {
  const copy = structuredClone(entity) as Omit<T, 'notes'> & { notes: Notes | [] }
  // Razorpay (PHP) serialises an empty notes map as [], not {}.
  copy.notes = Object.keys(entity.notes ?? {}).length ? { ...entity.notes } : []
  return copy
}

/** `contains` order follows Razorpay's samples: refund events list the refund first, the rest payment → order. */
const CONTAINS_ORDER: Record<string, Array<keyof WebhookEntities>> = {
  refund: ['refund', 'payment', 'order'],
  default: ['payment', 'order', 'refund'],
}

export function buildWebhookBody(
  event: RazorpayWebhookEvent,
  entities: WebhookEntities,
  opts: { accountId?: string; createdAt?: number } = {},
): RazorpayWebhookBody {
  const order = String(event).startsWith('refund.') ? CONTAINS_ORDER.refund : CONTAINS_ORDER.default
  const contains = order.filter((k) => entities[k] !== undefined)
  const payload: RazorpayWebhookBody['payload'] = {}
  for (const key of contains) {
    if (key === 'payment') payload.payment = { entity: withRazorpayNotes(entities.payment as GatewayPayment) }
    if (key === 'order') payload.order = { entity: withRazorpayNotes(entities.order as GatewayOrder) }
    if (key === 'refund') payload.refund = { entity: withRazorpayNotes(entities.refund as GatewayRefund) }
  }
  return {
    entity: 'event',
    account_id: opts.accountId ?? 'acc_WefeastoMock01',
    event,
    contains,
    payload,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
  }
}

/**
 * JSON the way Razorpay's PHP backend writes it: compact, `/` escaped as `\/` and non-ASCII escaped as
 * `\uXXXX`. Any receiver that verifies a re-serialised body (JSON.stringify(JSON.parse(raw))) instead of the
 * raw bytes fails against it, exactly as it would in production.
 */
export function serializeWebhookBody(body: unknown): string {
  return JSON.stringify(body)
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export interface ParsedWebhook {
  event: string
  accountId: string | null
  /** Unix seconds (Razorpay's clock). */
  createdAt: number | null
  contains: string[]
  payment: GatewayPayment | null
  order: GatewayOrder | null
  refund: GatewayRefund | null
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

const entityOf = (payload: Record<string, any>, key: string): Record<string, any> | null => {
  const wrapper = payload[key]
  return isObj(wrapper) && isObj(wrapper.entity) && typeof wrapper.entity.id === 'string' ? wrapper.entity : null
}

/**
 * Parses a webhook body that has ALREADY passed signature verification. Returns null for anything that is
 * not a Razorpay event (the receiver should 200 + log such bodies, never 4xx: razorpay.md §6.3). Entities
 * come back with `notes` normalised to an object.
 */
export function parseWebhookBody(raw: string): ParsedWebhook | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(body) || body.entity !== 'event' || typeof body.event !== 'string' || !isObj(body.payload)) return null
  const payment = entityOf(body.payload, 'payment')
  const order = entityOf(body.payload, 'order')
  const refund = entityOf(body.payload, 'refund')
  return {
    event: body.event,
    accountId: typeof body.account_id === 'string' ? body.account_id : null,
    createdAt: Number.isInteger(body.created_at) ? body.created_at : null,
    contains: Array.isArray(body.contains) ? body.contains.filter((c: unknown): c is string => typeof c === 'string') : [],
    payment: payment ? ({ ...payment, notes: normalizeNotes(payment.notes) } as GatewayPayment) : null,
    order: order ? ({ ...order, notes: normalizeNotes(order.notes) } as GatewayOrder) : null,
    refund: refund ? ({ ...refund, notes: normalizeNotes(refund.notes) } as GatewayRefund) : null,
  }
}
