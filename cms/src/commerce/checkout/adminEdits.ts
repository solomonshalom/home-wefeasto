import type { CollectionBeforeOperationHook, PayloadRequest, Where } from 'payload'
import { ValidationError } from 'payload'

import type { Order } from '@/payload-types'

import { userIsAdmin } from '../../access/roles'
import { type BulkRefusal, bulkUpdateAllOrNothing } from '../../lib/bulkAllOrNothing'
import { CHECKOUT_CONTEXT, lockRow } from './db'

/**
 * Admin edits of an order (REST PATCH, the admin UI's Save, scripts through the Local API) against the
 * checkout code (markPaid, expiry, retry, webhooks, disputes), which writes under `SELECT … FOR UPDATE` on the
 * order row (HUNT-CONC-2).
 *
 * Payload's update reads the document (originalDoc) BEFORE its UPDATE statement waits for any row lock, then
 * writes the whole document built from that read. Without a lock of its own an admin edit that overlaps a
 * checkout transaction validates against a stale copy, writes the stale payment/refund/dispute fields back,
 * and its afterChange hook releases stock the checkout code already released. So the Orders beforeOperation
 * hook locks the row(s) first: it runs inside the update's transaction, before Payload reads the document,
 * so originalDoc is the latest committed row and the transition guard, the write and the hooks all act on it.
 * Lock order stays orders → products → coupons (the afterChange hook releases stock after this).
 */
export const lockOrdersBeforeUpdate: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'update') return args
  // Checkout code already holds the lock (lockOrder) in this transaction.
  if (req.context?.[CHECKOUT_CONTEXT] === true) return args
  const raw = (args as { data?: unknown }).data
  if (req.context) {
    // Per operation: a later update on the same req must not inherit an earlier form's values.
    req.context[FORM_HISTORY_ROWS] = formHistoryRows(raw)
    req.context[FORM_REVISION] = formRevision(raw)
  }
  if (!req.transactionID) return args
  // REST/GraphQL from a non-admin is refused by access control right after this: don't let it hold locks.
  if (req.payloadAPI !== 'local' && !userIsAdmin(req.user)) return args
  const a = args as { id?: number | string | null; where?: Where }
  if (a.id !== undefined && a.id !== null) {
    if (Number.isSafeInteger(Number(a.id))) await lockRow(req, 'orders', a.id)
    return args
  }
  if (a.where) {
    const res = await req.payload.find({
      collection: 'orders',
      where: a.where,
      pagination: false,
      depth: 0,
      select: { number: true },
      overrideAccess: true,
      req,
    })
    const ids = res.docs.map((d) => Number(d.id)).sort((x, y) => x - y)
    for (const id of ids) await lockRow(req, 'orders', id)
  }
  return args
}

const STATUS_FIELDS = ['status', 'paymentStatus', 'fulfilmentStatus'] as const
/** What an admin Save can write (every other order field is server-write-only and ignored over REST). */
export const ADMIN_FIELDS = [...STATUS_FIELDS, 'reviewReason'] as const
export type AdminField = (typeof ADMIN_FIELDS)[number]

/** req.context key: how many statusHistory rows the submitted admin form was loaded with. */
export const FORM_HISTORY_ROWS = 'wfFormHistoryRows'
/** req.context key: the order `revision` the submitted admin form was loaded with. */
export const FORM_REVISION = 'wfFormRevision'

/**
 * The admin UI's Save sends the whole form, statusHistory included (as rows, or as a row count when the
 * array isn't rendered); REST callers that send only what they change don't. Read from the RAW request
 * (beforeOperation), because by beforeChange Payload has filled every field the request left out from the
 * stored document. Not updatedAt: concurrent writes can leave it older than the last history row.
 */
export function formHistoryRows(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const h = (raw as { statusHistory?: unknown }).statusHistory
  if (Array.isArray(h)) return h.length
  return typeof h === 'number' && Number.isSafeInteger(h) && h >= 0 ? h : undefined
}

/** The `revision` a whole-form Save (admin UI, or a REST client sending back the document it read) carries. */
export function formRevision(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = (raw as { revision?: unknown }).revision
  const n = typeof r === 'string' && /^\d{1,15}$/.test(r) ? Number(r) : r
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

const liveRevision = (o: { revision?: number | null }): number => (Number.isSafeInteger(o.revision) ? (o.revision as number) : 0)
const same = (f: AdminField, a: unknown, b: unknown) => (f === 'reviewReason' ? (a ?? '') === (b ?? '') : a === b)

/**
 * Orders `revision`: bumped by every write that changes something an admin acting on the order must have
 * seen: a status field, the review notes (a failed refund, an amount mismatch, a chargeback on an order that
 * is already on hold: none of them changes a status) or the chargeback. Returns the revision to store.
 */
export function nextRevision(data: Record<string, unknown>, doc: object | undefined): number {
  if (!doc) return 0
  const live = doc as Record<string, unknown> & { revision?: number | null }
  const cur = liveRevision(live)
  const changed =
    ADMIN_FIELDS.some((f) => data[f] !== undefined && !same(f, data[f], live[f])) ||
    (data.dispute !== undefined && disputeKey(data.dispute) !== disputeKey(live.dispute))
  return changed ? cur + 1 : cur
}

const disputeKey = (d: unknown): string => {
  const x = (d ?? {}) as Record<string, unknown>
  return [x.disputeId, x.status, x.phase].map((v) => String(v ?? '')).join('|')
}

/**
 * An admin UI Save sends every field as it was when the page was loaded, the ones the admin didn't touch
 * included. If the order changed since, the form is stale, and writing it would undo that change: put a
 * disputed order back to "paid", or erase the "pay the customer back manually" / chargeback notes the
 * system added to reviewReason. Two ways to tell:
 *   - revision: the form carries the order's `revision` (every write an admin must see bumps it,
 *     nextRevision); a different live revision → refuse if the form would write a different value for any
 *     field an admin can change (status, payment, fulfilment, reviewReason);
 *   - statusHistory: the form was loaded with fewer history rows (a form that doesn't carry the revision)
 *     → refuse if it would write a different status, payment or fulfilment value.
 * `data` is Payload's merged data (fields the request left out already hold the live values). Returns the
 * first such field with the message to show, or null. Plain REST calls carry neither and are never stale.
 */
export function staleFormEdit(
  data: Record<string, unknown>,
  live: Pick<Order, 'statusHistory' | AdminField> & { revision?: number | null },
  form: { rows?: number; revision?: number },
): { field: AdminField; message: string } | null {
  const history = live.statusHistory ?? []
  const byHistory = form.rows !== undefined && history.length > form.rows
  const byRevision = form.revision !== undefined && form.revision !== liveRevision(live)
  if (!byHistory && !byRevision) return null
  const fields: readonly AdminField[] = byRevision ? ADMIN_FIELDS : STATUS_FIELDS
  const field = fields.find((f) => data[f] !== undefined && data[f] !== null && !same(f, data[f], live[f]))
  // reviewReason may be cleared by the form (null): that erases the notes too.
  const notes = byRevision && data.reviewReason !== undefined && !same('reviewReason', data.reviewReason, live.reviewReason)
  const hit = field ?? (notes ? 'reviewReason' : undefined)
  if (!hit) return null
  const since = byHistory ? new Set(history.slice(form.rows).map((h) => h.field)) : new Set<string>()
  const what =
    hit !== 'reviewReason' && since.has(hit)
      ? `it is now "${live[hit]}"`
      : notes
        ? 'new notes were added to Review Reason'
        : 'a payment, refund or chargeback update, or another admin, changed it'
  return { field: hit, message: `This order changed while you had it open (${what}). Reload the page to see the latest, then make your change again.` }
}

/** Kept for callers of the round-1 API: the status-only, history-based check. */
export function staleStatusEdit(
  data: Record<string, unknown>,
  live: Pick<Order, 'statusHistory' | (typeof STATUS_FIELDS)[number]>,
  formRows: number | undefined,
): (typeof STATUS_FIELDS)[number] | null {
  if (formRows === undefined || (live.statusHistory ?? []).length <= formRows) return null
  return STATUS_FIELDS.find((f) => data[f] !== undefined && data[f] !== null && data[f] !== live[f]) ?? null
}

/** Reasons of the refunds the checkout code queues itself (always FULL refunds of a payment). */
export const AUTOMATIC_REFUND_REASONS: ReadonlySet<string> = new Set(['duplicate_payment', 'out_of_stock', 'order_cancelled'])

type RefundView = Pick<Order, 'razorpay' | 'refunds'> & { totalPaise?: number | null }

const liveRefundsOfPrimary = (order: RefundView) => {
  const pid = order.razorpay?.paymentId
  const live = pid ? (order.refunds ?? []).filter((r) => r.paymentId === pid && (r.status === 'queued' || r.status === 'pending' || r.status === 'processed')) : []
  return { pid, live }
}

/**
 * The order's own payment (razorpay.paymentId) while an AUTOMATIC refund of it is queued, pending or processed —
 * e.g. money that landed on a cancelled/superseded order (`<no>-cxl-…`) — or while refunds of it cover the whole
 * order. Such an order can't be resolved to a confirmed status: it would be paid (and shipped) and refunded
 * (HUNT-CONC-7). A refund made by hand (Dashboard) for PART of the order doesn't count: the rest may still ship,
 * so a human can release a hold on it to "partially_refunded" (hunt w5 r2). Returns the payment id or null.
 */
export function refundingPrimaryPayment(order: RefundView): string | null {
  const { pid, live } = liveRefundsOfPrimary(order)
  if (!pid || !live.length) return null
  const automatic = live.some((r) => AUTOMATIC_REFUND_REASONS.has(r.reason ?? ''))
  const total = live.reduce((a, r) => a + (r.amountPaise ?? 0), 0)
  return automatic || total >= (order.totalPaise ?? 0) ? pid : null
}

/** The order's own payment when part of it was refunded (pending or processed): "paid" would hide that. */
export function partlyRefundedPrimary(order: RefundView): string | null {
  const { pid, live } = liveRefundsOfPrimary(order)
  return pid && live.some((r) => r.status !== 'queued') ? pid : null
}

/** req.context key: why each order of an admin edit was refused (order id → number + field errors). */
const REFUSALS = 'wfOrderRefusals'

/**
 * The error that refuses an admin edit of `order`, remembered on req.context: a bulk edit (the Orders
 * list's "Edit") keeps only a generic per-document message, so ordersBulkAllOrNothing reads the reason here.
 */
export function orderEditRefused(
  req: PayloadRequest,
  order: { id: number | string; number?: string | null },
  errors: { path: string; message: string }[],
): ValidationError {
  const ctx = req.context as Record<string, unknown> | undefined
  if (ctx) {
    const seen = (ctx[REFUSALS] as Record<string, BulkRefusal> | undefined) ?? {}
    seen[String(order.id)] = { label: order.number ?? undefined, errors }
    ctx[REFUSALS] = seen
  }
  return new ValidationError({ collection: 'orders', errors, req })
}

/** Orders afterOperation: a bulk edit where any order was refused saves nothing (lib/bulkAllOrNothing.ts). */
export const ordersBulkAllOrNothing = bulkUpdateAllOrNothing({
  plural: 'orders',
  refusal: (req, id) => ((req.context as Record<string, unknown> | undefined)?.[REFUSALS] as Record<string, BulkRefusal> | undefined)?.[String(id)],
})
