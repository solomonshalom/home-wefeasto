import { APIError } from 'payload'
import type { CollectionBeforeDeleteHook, CollectionBeforeOperationHook, CollectionConfig, Where } from 'payload'

import { isAdmin } from '../access'
import { userIsAdmin } from '../access/roles'
import { lockRow } from '../commerce/checkout/db'

/**
 * Discount codes, applied by link (`/cart?offer=CODE`), validated server-side at quote and checkout by
 * `$shared/coupons.js` `evaluateCoupon`. `code` is stored trimmed + uppercased and is unique.
 * `usedCount` is bumped atomically when an order is paid (never by hand).
 */
export const normalizeCouponCode = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value

/** Copy shown (REST 409, admin toast) when a delete is refused because orders reference the coupon. */
export const couponInUseMessage = (orders: number): string =>
  `This offer has been used on ${orders} order${orders === 1 ? '' : 's'}, so it can't be deleted. ` +
  'Untick "Active" to retire it instead.'

/**
 * The refusal. `name` is a string literal (not constructor.name, which minification mangles) so
 * payload.config's `loggingLevels` can log this expected admin refusal at info instead of error + stack.
 * Nothing maps it by name: REST callers see status 409 and `data.code` COUPON_IN_USE.
 */
export const COUPON_IN_USE_ERROR = 'CouponInUseError'
export class CouponInUseError extends APIError<{ code: 'COUPON_IN_USE'; orders: number }> {
  constructor(orders: number) {
    super(couponInUseMessage(orders), 409, { code: 'COUPON_IN_USE', orders }, true)
    this.name = COUPON_IN_USE_ERROR
  }
}

/**
 * Refuses to delete a coupon any order has used (a coupon-redemptions row in any status: reserved,
 * consumed or released). Those rows keep the order's coupon history, and `coupon` is required there, so
 * the FK's ON DELETE SET NULL would otherwise fail as a 500 not-null violation.
 *
 * Runs inside the delete's transaction: the coupon row is locked first (checkout takes the same lock before
 * it inserts a redemption and then re-reads the coupon), so a concurrent checkout either commits before
 * the count sees it, or waits and then finds the coupon gone (422 COUPON_INVALID). Throws a public
 * APIError 409 (CouponInUseError); callers map it by status, never by err.name.
 */
export const refuseDeleteWhenRedeemed: CollectionBeforeDeleteHook = async ({ id, req }) => {
  if (req.transactionID) await lockRow(req, 'coupons', id)
  const { totalDocs } = await req.payload.count({
    collection: 'coupon-redemptions',
    where: { coupon: { equals: id } },
    overrideAccess: true,
    req,
  })
  if (totalDocs > 0) throw new CouponInUseError(totalDocs)
}

/**
 * usedCount is server-owned: checkout's consumeRedemption bumps it with an atomic `$inc` when an order is
 * paid. Payload's update writes the WHOLE document, so an admin Save (the form always submits usedCount as
 * it was loaded) or a REST PATCH echoing a loaded doc would write a stale count back over that increment and
 * a single-use code would be accepted again. Two guards:
 *   - the field refuses updates from REST / the admin (field access; Payload then keeps the stored value);
 *   - every update first locks the coupon row(s) inside its transaction, before Payload reads originalDoc,
 *     so the value it keeps is the latest committed one and a concurrent `$inc` waits for (or precedes) it.
 * Lock order stays orders → products → coupons: this only ever locks coupons.
 */
export const lockCouponsBeforeUpdate: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'update' || !req.transactionID) return args
  // REST from a non-admin is refused by access control right after this: don't let it hold locks.
  if (req.payloadAPI !== 'local' && !userIsAdmin(req.user)) return args
  const a = args as { id?: number | string | null; where?: Where }
  if (a.id !== undefined && a.id !== null) {
    if (Number.isSafeInteger(Number(a.id))) await lockRow(req, 'coupons', a.id)
    return args
  }
  if (a.where) {
    const res = await req.payload.find({
      collection: 'coupons',
      where: a.where,
      pagination: false,
      depth: 0,
      select: { code: true },
      overrideAccess: true,
      req,
    })
    const ids = res.docs.map((d) => Number(d.id)).sort((x, y) => x - y)
    for (const id of ids) await lockRow(req, 'coupons', id)
  }
  return args
}

const PAISE_HINT = ' (paise, whole rupees: ₹10 is 1000)'

/**
 * Optional money field of a coupon: empty, or whole rupees in paise ≥ min. Stricter than the shared rules
 * (which honour any safe integer): the shop shows whole rupees, so a ₹10.50 discount would show as ₹11 off
 * while the order is charged 50 paise more than the total shown (`$shared` floors percent discounts to whole
 * rupees for the same reason).
 */
export const optionalWholeRupees =
  (min: number) =>
  (value: unknown): true | string => {
    if (value === null || value === undefined) return true
    return Number.isSafeInteger(value) && (value as number) >= min && (value as number) % 100 === 0
      ? true
      : `Must be whole rupees in paise${min > 0 ? `, at least ${min}` : ''}${PAISE_HINT}.`
  }

/**
 * Optional count / paise field. Exactly what the shared rules accept ($shared/coupons.js isWellFormed:
 * null, or a safe integer ≥ 0): a coupon that saves is a coupon checkout honours. Anything else (₹10.50 typed
 * into a paise field, 1.5 uses, 1e20) would save fine and then fail closed as INACTIVE for every shopper.
 * Replaces Payload's default number validation, so `min` is checked here too.
 */
export const optionalWholeNumber =
  (min: number, hint = '') =>
  (value: unknown): true | string => {
    if (value === null || value === undefined) return true
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? true : `Must be a whole number ≥ ${min}${hint}.`
  }

export const Coupons: CollectionConfig = {
  slug: 'coupons',
  admin: {
    useAsTitle: 'code',
    group: 'Shop',
    defaultColumns: ['code', 'type', 'value', 'active', 'usedCount', 'endsAt'],
  },
  access: { read: isAdmin, create: isAdmin, update: isAdmin, delete: isAdmin },
  hooks: {
    beforeOperation: [lockCouponsBeforeUpdate],
    beforeDelete: [refuseDeleteWhenRedeemed],
    beforeValidate: [
      ({ data }) => {
        if (data && 'code' in data) data.code = normalizeCouponCode(data.code)
        if (data && typeof data.boundEmail === 'string') data.boundEmail = data.boundEmail.trim().toLowerCase() || null
        return data
      },
    ],
  },
  fields: [
    {
      name: 'code',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: (value: unknown) =>
        /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(String(value ?? ''))
          ? true
          : 'Use 3–32 letters, digits, "-" or "_" (stored in capitals).',
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      defaultValue: 'percent',
      options: [
        { label: 'Percent off', value: 'percent' },
        { label: 'Fixed amount off (paise)', value: 'fixed' },
        { label: 'Free delivery', value: 'free_delivery' },
      ],
    },
    {
      name: 'value',
      type: 'number',
      required: true,
      defaultValue: 0,
      min: 0,
      admin: { step: 1, description: 'Percent (1–100) for percent coupons; paise in whole rupees for fixed (₹50 is 5000); ignored for free delivery.' },
      validate: (value: unknown, { siblingData }: { siblingData: Record<string, unknown> }) => {
        if (!Number.isSafeInteger(value) || (value as number) < 0) return 'Must be a whole number ≥ 0.'
        if (siblingData?.type === 'percent' && ((value as number) < 1 || (value as number) > 100))
          return 'Percent must be between 1 and 100.'
        if (siblingData?.type === 'fixed' && ((value as number) < 100 || (value as number) % 100 !== 0))
          return `Fixed discount must be whole rupees in paise, at least ₹1${PAISE_HINT}.`
        return true
      },
    },
    {
      name: 'maxDiscountPaise',
      type: 'number',
      min: 0,
      // ≥ ₹1: a ₹0 cap would be a code that gives nothing but still uses up a redemption. Empty = no cap.
      validate: optionalWholeRupees(100),
      admin: { step: 100, description: 'Cap for percent coupons (paise, whole rupees). Empty = no cap.' },
    },
    { name: 'minSubtotalPaise', type: 'number', min: 0, validate: optionalWholeRupees(0), admin: { step: 100 } },
    {
      type: 'row',
      fields: [
        { name: 'startsAt', type: 'date', admin: { date: { pickerAppearance: 'dayAndTime' } } },
        { name: 'endsAt', type: 'date', index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
      ],
    },
    {
      name: 'usageLimit',
      type: 'number',
      min: 1,
      validate: optionalWholeNumber(1),
      admin: { step: 1, description: 'Total paid orders allowed. Empty = unlimited.' },
    },
    {
      name: 'usedCount',
      type: 'number',
      required: true,
      defaultValue: 0,
      min: 0,
      validate: (value: unknown) => (value === null || value === undefined ? 'Required.' : optionalWholeNumber(0)(value)),
      // Server-owned (see lockCouponsBeforeUpdate): REST / admin updates keep the stored count.
      access: { update: () => false },
      admin: { readOnly: true, description: 'Paid orders that used this offer. Counted automatically.' },
    },
    {
      name: 'perCustomerLimit',
      type: 'number',
      min: 1,
      validate: optionalWholeNumber(1),
      admin: { step: 1, description: 'Per email address. Empty = unlimited.' },
    },
    { name: 'firstOrderOnly', type: 'checkbox', defaultValue: false },
    { name: 'boundEmail', type: 'email', index: true, admin: { description: 'Only this email can use it (welcome codes).' } },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: { description: 'Untick to retire the offer. An offer used on any order cannot be deleted, only retired.' },
    },
    { name: 'note', type: 'text', admin: { description: 'Internal note (campaign, who issued it).' } },
  ],
  timestamps: true,
}
