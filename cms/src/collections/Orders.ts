import type { CollectionBeforeChangeHook, CollectionConfig, Field, FieldAccess } from 'payload'

import { isAdmin, nobody } from '../access'
import { userIsAdmin } from '../access/roles'
import {
  FORM_HISTORY_ROWS,
  FORM_REVISION,
  lockOrdersBeforeUpdate,
  nextRevision,
  orderEditRefused,
  ordersBulkAllOrNothing,
  partlyRefundedPrimary,
  refundingPrimaryPayment,
  staleFormEdit,
} from '../commerce/checkout/adminEdits'
import { orderEffectsAfterChange } from '../commerce/checkout/orderHooks'
import { nextOrderNumber } from '../commerce/orderNumber'
import { deriveOrderToken, hashToken, newTokenNonce } from '../commerce/orderToken'
import {
  canFulfil,
  canFulfilmentTransition,
  canTransition,
  FULFILMENT_STATUSES,
  isConfirmed,
  mergePaymentStatus,
  ORDER_SOURCES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REQUESTED_METHODS,
} from '../commerce/shared/order-status.js'

/**
 * Orders (SPEC §4). Created ONLY by server code (checkout endpoint, seed, tests) through the Local API:
 * REST create is closed for everyone, admins may read and update (status/fulfilment), nobody deletes.
 *
 * Automatic on Local API create (same transaction when `req` is passed):
 *   - `number`      WF-10001, WF-10002… from the `counters` collection when not supplied
 *   - `tokenNonce`  16 random bytes (base64url) when not supplied
 *   - `tokenHash`   sha256(deriveOrderToken(id, tokenNonce)) written right after insert
 *   - `statusHistory` gets an entry for the initial status and for every later change of
 *     status / paymentStatus / fulfilmentStatus. Callers can label entries with
 *     `context: { statusSource: 'webhook', statusNote: 'payment.captured pay_X' }`.
 * Items, money fields and history are immutable over REST (field update access = nobody); server code
 * with overrideAccess (the Local API default) can still write them.
 */

// Status vocabularies come from the shared state machine ($shared/order-status.js) so the admin UI,
// the checkout code and the storefront can never disagree.
export { FULFILMENT_STATUSES, ORDER_SOURCES, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, REQUESTED_METHODS }
export const STOCK_STATES = ['reserved', 'committed', 'released'] as const
export const PAID_VIA = ['client', 'callback', 'webhook', 'reconcile', 'admin'] as const
export const HISTORY_FIELDS = ['status', 'paymentStatus', 'fulfilmentStatus'] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number]

const options = (values: readonly string[]) => values.map((value) => ({ label: value.replace(/_/g, ' '), value }))

/** REST writes are ignored for these fields (admin UI shows them read-only). */
const serverOnlyWrite: { create: FieldAccess; update: FieldAccess } = { create: () => false, update: () => false }

/**
 * Admin date+time display for the order's timeline fields (status history, payments, refunds, chargeback):
 * Payload's default date-only 'MM/dd/yyyy' shows 9 October as "10/09/2026" (read as 10 September in India)
 * and hides the time a human needs to sort out an order.
 */
const dateTime = { date: { pickerAppearance: 'dayAndTime' as const } }

const money = (name: string, extra: Partial<Field> = {}): Field =>
  ({
    name,
    type: 'number',
    required: true,
    min: 0,
    defaultValue: 0,
    access: serverOnlyWrite,
    admin: { readOnly: true, description: 'Paise (₹1 = 100).' },
    validate: (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? true : 'Must be whole paise ≥ 0.'),
    ...extra,
  }) as Field

/**
 * Admin edits over REST/admin UI must follow the shared state machine: no status jumps the event table
 * does not allow, fulfilment only forward (and only once the order is paid / COD-confirmed), and payment
 * status never downgraded. Server code (Local API) is trusted to use nextStatus() itself.
 * originalDoc is the live row: the beforeOperation hook locked it before Payload read it (adminEdits.ts).
 * Also refused: a Save from a form loaded before the order changed (staleFormEdit: its `revision` or its
 * statusHistory rows are behind the live ones), resolving to a confirmed status an order whose own
 * payment is being refunded (refundingPrimaryPayment), and resolving to "paid" one whose payment was partly
 * refunded ("partially_refunded" is the status that may ship the rest) or whose payment status says it was
 * (partially_) refunded: "paid" goes with an authorized/captured payment only. The same checks hold for
 * partially_refunded → paid (allowed by the machine for a refund that failed). Only a human takes an order out of
 * needs_review (a chargeback's or an admin's hold) to a fulfillable status: refund webhooks never do (refunds.ts).
 */
/** Fulfilment steps that send goods out, so they need canFulfil(status) whatever fulfilment came from. */
const FULFIL_GATED = new Set(['packed', 'shipped'])

const guardAdminTransitions: CollectionBeforeChangeHook = ({ data, operation, originalDoc, req }) => {
  if (operation !== 'update' || !originalDoc || req.payloadAPI === 'local') return data
  const errors: { path: string; message: string }[] = []
  const formRows = req.context?.[FORM_HISTORY_ROWS]
  const formRev = req.context?.[FORM_REVISION]
  const stale = staleFormEdit(data, originalDoc, {
    rows: typeof formRows === 'number' ? formRows : undefined,
    revision: typeof formRev === 'number' ? formRev : undefined,
  })
  if (stale) throw orderEditRefused(req, originalDoc, [{ path: stale.field, message: stale.message }])
  const status = (data.status ?? originalDoc.status) as string
  if (data.status !== undefined && data.status !== originalDoc.status && !canTransition(originalDoc.status, data.status)) {
    errors.push({ path: 'status', message: `An order can't move from "${originalDoc.status}" to "${data.status}".` })
  } else if (data.status !== undefined && data.status !== originalDoc.status && isConfirmed(data.status)) {
    // Into a confirmed status from an unconfirmed one (a human resolving a review), or back to "paid" from
    // "partially_refunded" (the machine's refund_failed: only right when nothing of the payment is refunded).
    const intoPaid = data.status === 'paid'
    const refunding = intoPaid || !isConfirmed(originalDoc.status) ? refundingPrimaryPayment(originalDoc) : null
    const partly = !refunding && intoPaid ? partlyRefundedPrimary(originalDoc) : null
    // Whatever the refund rows say, "paid" must never sit next to a refunded payment status (verify pass 2).
    const paidAs = (data.paymentStatus ?? originalDoc.paymentStatus) as string
    const refundedPayment = intoPaid && (paidAs === 'partially_refunded' || paidAs === 'refunded')
    if (refunding) {
      errors.push({
        path: 'status',
        message: `Payment ${refunding} is being refunded automatically, so this order can't be marked "${data.status}". Let the refund finish, or cancel the order.`,
      })
    } else if (partly) {
      const what = originalDoc.status === 'partially_refunded' ? 'this order stays "partially refunded"' : 'mark this order "partially refunded", not "paid"'
      errors.push({ path: 'status', message: `Part of payment ${partly} has been refunded, so ${what}.` })
    } else if (refundedPayment) {
      errors.push({
        path: 'status',
        message: `The payment status is "${paidAs.replace(/_/g, ' ')}", so this order can't be marked "paid". Mark it "${paidAs === 'refunded' ? 'refunded' : 'partially refunded'}" instead.`,
      })
    }
  }
  const fromF = originalDoc.fulfilmentStatus as string
  const toF = data.fulfilmentStatus as string | undefined
  if (toF !== undefined && toF !== fromF) {
    if (!canFulfilmentTransition(fromF, toF)) {
      errors.push({ path: 'fulfilmentStatus', message: `Fulfilment can't move from "${fromF}" to "${toF}".` })
    } else if (FULFIL_GATED.has(toF) && !canFulfil(status)) {
      // Every step INTO packed/shipped is gated on the order's CURRENT status, not only the first one out of
      // `unfulfilled`: an order packed before a chargeback (needs_review = hold), a full refund or a cancel
      // (stock given back) must not leave on the truck. shipped → delivered/rto and delivered → returned
      // record what already happened, so they stay allowed.
      errors.push({
        path: 'fulfilmentStatus',
        message:
          fromF === 'unfulfilled'
            ? 'Only paid orders (or confirmed COD orders) can be packed or shipped.'
            : `This order is "${status}" now, so it can't be ${toF}. Only paid orders (or confirmed COD orders) can be packed or shipped.`,
      })
    }
  }
  const fromP = originalDoc.paymentStatus as string
  const toP = data.paymentStatus as string | undefined
  if (toP !== undefined && toP !== fromP && mergePaymentStatus(fromP, toP) !== toP) {
    errors.push({ path: 'paymentStatus', message: `Payment status can't go back from "${fromP}" to "${toP}".` })
  }
  if (errors.length) throw orderEditRefused(req, originalDoc, errors)
  return data
}

/** Every write an admin acting on the order must have seen bumps `revision` (adminEdits.ts nextRevision). */
const bumpRevision: CollectionBeforeChangeHook = ({ data, operation, originalDoc }) => {
  data.revision = nextRevision(data, operation === 'update' ? originalDoc : undefined)
  return data
}

type HistoryRow = { at: string; field: string; from?: string | null; to: string; source: string; note?: string | null }

const appendStatusHistory: CollectionBeforeChangeHook = ({ data, operation, originalDoc, req }) => {
  const source =
    typeof req.context?.statusSource === 'string'
      ? req.context.statusSource
      : userIsAdmin(req.user)
        ? `admin:${req.user?.id}`
        : 'system'
  const note = typeof req.context?.statusNote === 'string' ? req.context.statusNote : null
  const at = new Date().toISOString()
  const rows: HistoryRow[] = []
  for (const field of HISTORY_FIELDS) {
    const to = data[field] as string | undefined
    const from = (operation === 'update' ? originalDoc?.[field] : null) as string | null | undefined
    if (to === undefined || to === null || to === from) continue
    // On create only the headline status is interesting; defaults for the other two are noise.
    if (operation === 'create' && field !== 'status') continue
    rows.push({ at, field, from: from ?? null, to, source, note })
  }
  if (rows.length) {
    const existing = Array.isArray(data.statusHistory)
      ? data.statusHistory
      : Array.isArray(originalDoc?.statusHistory)
        ? originalDoc.statusHistory
        : []
    data.statusHistory = [...existing, ...rows]
  }
  return data
}

export const Orders: CollectionConfig = {
  slug: 'orders',
  admin: {
    useAsTitle: 'number',
    group: 'Shop',
    defaultColumns: ['number', 'status', 'paymentStatus', 'fulfilmentStatus', 'totalPaise', 'paymentMethod', 'createdAt'],
    listSearchableFields: ['number', 'contact.email', 'contact.phone'],
    description: 'Created by checkout. Totals and items are a snapshot and cannot be edited.',
  },
  access: {
    read: isAdmin,
    create: nobody,
    update: isAdmin,
    delete: nobody,
  },
  hooks: {
    // Serialises admin edits with the checkout code on the order row (HUNT-CONC-2, adminEdits.ts).
    beforeOperation: [lockOrdersBeforeUpdate],
    // A bulk edit (Orders list → Edit) where any order is refused saves nothing (adminEdits.ts).
    afterOperation: [ordersBulkAllOrNothing],
    beforeChange: [
      async ({ data, operation, req }) => {
        if (operation === 'create') {
          if (!data.number) data.number = await nextOrderNumber(req)
          if (!data.tokenNonce) data.tokenNonce = newTokenNonce()
        }
        return data
      },
      guardAdminTransitions,
      appendStatusHistory,
      bumpRevision,
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation !== 'create' || doc.tokenHash) return doc
        // Nonce is hidden, so re-read it when the create call did not return hidden fields.
        let nonce: string | undefined = doc.tokenNonce
        if (!nonce) {
          const full = await req.payload.findByID({
            collection: 'orders',
            id: doc.id,
            depth: 0,
            showHiddenFields: true,
            select: { tokenNonce: true },
            req,
          })
          nonce = (full as { tokenNonce?: string }).tokenNonce ?? undefined
        }
        if (!nonce) return doc
        const tokenHash = hashToken(deriveOrderToken(doc.id, nonce))
        // db.updateOne: no hooks/access, joins req's transaction.
        await req.payload.db.updateOne({ collection: 'orders', id: doc.id, data: { tokenHash }, req, returning: false })
        return { ...doc, tokenHash }
      },
      // checkout-backend (additive): shipped/delivered events + email, admin cancel releases stock, admin
      // confirm/refund events — all after the admin's transaction commits (src/commerce/checkout/orderHooks.ts).
      orderEffectsAfterChange,
    ],
  },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'number',
          type: 'text',
          required: true,
          unique: true,
          index: true,
          access: serverOnlyWrite,
          admin: { readOnly: true, description: 'WF-10001…' },
        },
        {
          name: 'source',
          type: 'select',
          options: options(ORDER_SOURCES),
          defaultValue: 'web',
          access: serverOnlyWrite,
          admin: { readOnly: true },
        },
      ],
    },
    // Guest access token material. Never returned by the API (hidden) and never shown in admin.
    { name: 'tokenNonce', type: 'text', hidden: true, access: serverOnlyWrite },
    { name: 'tokenHash', type: 'text', hidden: true, unique: true, index: true, access: serverOnlyWrite },
    { name: 'requestHash', type: 'text', hidden: true, access: serverOnlyWrite },
    {
      name: 'idempotencyKey',
      type: 'text',
      unique: true,
      index: true,
      access: serverOnlyWrite,
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      access: serverOnlyWrite,
      admin: { readOnly: true, position: 'sidebar', description: 'Set only when the order was placed while signed in.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          required: true,
          index: true,
          defaultValue: 'pending_payment',
          options: options(ORDER_STATUSES),
        },
        {
          name: 'paymentStatus',
          type: 'select',
          required: true,
          index: true,
          defaultValue: 'none',
          options: options(PAYMENT_STATUSES),
        },
        {
          name: 'fulfilmentStatus',
          type: 'select',
          required: true,
          index: true,
          defaultValue: 'unfulfilled',
          options: options(FULFILMENT_STATUSES),
        },
      ],
    },
    {
      name: 'contact',
      type: 'group',
      access: serverOnlyWrite,
      admin: { readOnly: true },
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'email', type: 'email', required: true, index: true },
        { name: 'phone', type: 'text', required: true, index: true, admin: { description: 'E.164' } },
      ],
    },
    {
      name: 'shippingAddress',
      type: 'group',
      access: serverOnlyWrite,
      admin: { readOnly: true },
      fields: [
        { name: 'line1', type: 'text', required: true },
        { name: 'city', type: 'text', required: true },
        { name: 'state', type: 'text', required: true },
        { name: 'pin', type: 'text', required: true, index: true },
      ],
    },
    {
      name: 'items',
      type: 'array',
      required: true,
      minRows: 1,
      access: serverOnlyWrite,
      admin: { readOnly: true, description: 'Immutable snapshot of what was bought, at the price paid.' },
      fields: [
        { name: 'product', type: 'relationship', relationTo: 'products' },
        { name: 'slug', type: 'text', required: true },
        { name: 'name', type: 'text', required: true },
        money('unitPaise'),
        { name: 'qty', type: 'number', required: true, min: 1, admin: { readOnly: true } },
        money('lineTotalPaise'),
        { name: 'image', type: 'text' },
      ],
    },
    {
      type: 'row',
      fields: [
        money('subtotalPaise'),
        money('discountPaise'),
        money('deliveryPaise'),
        money('codFeePaise'),
        money('totalPaise'),
      ],
    },
    {
      name: 'currency',
      type: 'text',
      required: true,
      defaultValue: 'INR',
      access: serverOnlyWrite,
      admin: { readOnly: true },
    },
    {
      name: 'coupon',
      type: 'group',
      access: serverOnlyWrite,
      admin: { readOnly: true },
      fields: [
        { name: 'code', type: 'text' },
        { name: 'discountPaise', type: 'number', min: 0 },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'requestedMethod',
          type: 'select',
          required: true,
          options: options(REQUESTED_METHODS),
          access: serverOnlyWrite,
          admin: { readOnly: true },
        },
        {
          name: 'paymentMethod',
          type: 'select',
          required: true,
          options: options(PAYMENT_METHODS),
          access: serverOnlyWrite,
          admin: { readOnly: true },
        },
        {
          name: 'stockState',
          type: 'select',
          required: true,
          index: true,
          defaultValue: 'reserved',
          options: options(STOCK_STATES),
          access: serverOnlyWrite,
          admin: { readOnly: true },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'reservedUntil',
          type: 'date',
          index: true,
          access: serverOnlyWrite,
          admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
        },
        {
          name: 'paidAt',
          type: 'date',
          access: serverOnlyWrite,
          admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
        },
        {
          name: 'paidVia',
          type: 'select',
          options: options(PAID_VIA),
          access: serverOnlyWrite,
          admin: { readOnly: true },
        },
        {
          name: 'confirmationSentAt',
          type: 'date',
          access: serverOnlyWrite,
          admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
        },
      ],
    },
    {
      name: 'razorpay',
      type: 'group',
      access: serverOnlyWrite,
      admin: { readOnly: true },
      fields: [
        {
          name: 'attempts',
          type: 'array',
          fields: [
            { name: 'orderId', type: 'text', required: true, index: true },
            { name: 'receipt', type: 'text', required: true },
            { name: 'amount', type: 'number', required: true },
            { name: 'status', type: 'text' },
            { name: 'createdAt', type: 'date', admin: dateTime },
          ],
        },
        { name: 'paymentId', type: 'text', unique: true, index: true },
        { name: 'method', type: 'text' },
        { name: 'capturedAt', type: 'date', admin: dateTime },
        // checkout-backend (additive): every payment Razorpay reported for this order, failed ones included.
        {
          name: 'payments',
          type: 'array',
          admin: { description: 'Attempt log: every payment seen for this order (client, callback, webhook, reconcile).' },
          fields: [
            { name: 'paymentId', type: 'text', required: true, index: true },
            { name: 'orderId', type: 'text', admin: { description: 'Razorpay order id (attempt).' } },
            { name: 'status', type: 'text' },
            { name: 'method', type: 'text' },
            { name: 'amount', type: 'number' },
            { name: 'errorCode', type: 'text' },
            { name: 'errorReason', type: 'text' },
            { name: 'errorDescription', type: 'text' },
            { name: 'via', type: 'text' },
            { name: 'at', type: 'date', admin: dateTime },
          ],
        },
      ],
    },
    {
      name: 'refunds',
      type: 'array',
      access: serverOnlyWrite,
      admin: { readOnly: true },
      fields: [
        { name: 'refundId', type: 'text', index: true },
        { name: 'paymentId', type: 'text' },
        { name: 'amountPaise', type: 'number', required: true, min: 0 },
        {
          name: 'status',
          type: 'text',
          admin: { description: 'queued (ours, not sent to Razorpay yet) | pending | processed | failed' },
        },
        { name: 'reason', type: 'text' },
        { name: 'createdAt', type: 'date', admin: dateTime },
        { name: 'processedAt', type: 'date', admin: dateTime },
        // checkout-backend (additive): idempotency receipt (WF-10001-dup-abc123) and retry bookkeeping.
        { name: 'receipt', type: 'text', index: true },
        { name: 'attempts', type: 'number' },
        { name: 'error', type: 'text' },
      ],
    },
    // checkout-backend (additive): chargebacks (payment.dispute.*) put the order on hold for a human.
    {
      name: 'dispute',
      type: 'group',
      access: serverOnlyWrite,
      admin: { readOnly: true, condition: (data) => Boolean(data?.dispute?.disputeId) },
      fields: [
        { name: 'disputeId', type: 'text' },
        { name: 'status', type: 'text' },
        { name: 'phase', type: 'text' },
        { name: 'reasonCode', type: 'text' },
        { name: 'amountPaise', type: 'number' },
        { name: 'at', type: 'date', admin: dateTime },
      ],
    },
    {
      name: 'reconciledAt',
      type: 'date',
      access: serverOnlyWrite,
      admin: {
        readOnly: true,
        position: 'sidebar',
        description: 'Last time the reconcile job asked Razorpay about this order.',
        date: { pickerAppearance: 'dayAndTime' },
      },
    },
    {
      name: 'statusHistory',
      type: 'array',
      access: serverOnlyWrite,
      admin: { readOnly: true, initCollapsed: true },
      fields: [
        { name: 'at', type: 'date', required: true, admin: dateTime },
        { name: 'field', type: 'text', required: true },
        { name: 'from', type: 'text' },
        { name: 'to', type: 'text', required: true },
        { name: 'source', type: 'text' },
        { name: 'note', type: 'text' },
      ],
    },
    { name: 'reviewReason', type: 'textarea', admin: { description: 'Why this order needs a human (set by the system).' } },
    // Optimistic concurrency for admin Saves: bumped by every write that changes a status, the review notes
    // or the chargeback (adminEdits.ts nextRevision). The admin form carries it back (hidden input), so a Save
    // from a page loaded before such a write is refused instead of erasing it (staleFormEdit).
    {
      name: 'revision',
      type: 'number',
      defaultValue: 0,
      min: 0,
      access: serverOnlyWrite,
      admin: { hidden: true, readOnly: true },
    },
    {
      name: 'consent',
      type: 'group',
      access: serverOnlyWrite,
      admin: { readOnly: true },
      fields: [
        { name: 'marketing', type: 'checkbox', defaultValue: false },
        { name: 'at', type: 'date', admin: dateTime },
        { name: 'text', type: 'text' },
      ],
    },
    {
      name: 'householdSize',
      type: 'number',
      min: 1,
      max: 20,
      access: serverOnlyWrite,
      admin: { readOnly: true, position: 'sidebar', description: 'People eating from this order (refill timing).' },
    },
  ],
  timestamps: true,
}
