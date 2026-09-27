import { APIError } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  FieldAccess,
  PayloadRequest,
  Where,
} from 'payload'

import type { Coupon, Subscriber } from '@/payload-types'

import { userIsAdmin } from '../access/roles'
import { lockRow } from '../commerce/checkout/db'
import { welcomeCouponNote } from './codes'
import { sendConfirmation } from './subscribers'
import { CONFIRM_TOKEN_TTL_MS, hashToken, newConfirmToken, unsubscribeTokenHash } from './tokens'
import { relId, toDate } from './util'

/**
 * Writes to `subscribers` that don't come from the retention code: the admin UI's Save, REST PATCH, bulk edit,
 * scripts. The row is the record of consent, and the retention code changes it with conditional single-row
 * updates (src/retention/subscribers.ts). Payload's update writes the WHOLE document and the admin form submits
 * every field as it was loaded, so a Save of an unrelated field (source, consent note) used to write back the
 * status the page was opened with: someone who unsubscribed meanwhile was put back on the list (hunt w5).
 *
 *   - Server-owned fields (`serverOwned` field access): timestamps, token hashes and the welcome coupon are
 *     written by the retention code only; REST / admin updates keep the stored values.
 *   - status: consent comes from the address owner only (DPDP, double opt-in). A REST / admin write may take
 *     someone OFF the list ('unsubscribed', stamped now), never put anyone on it: a form loaded before the row
 *     last changed (or a REST body that doesn't say when it was loaded) keeps the stored status whatever it
 *     sends, and an up-to-date form that asks for 'pending'/'confirmed' is refused (400). Unsubscribing from a
 *     stale form is refused (409): they may have signed up again since.
 *   - email: unsubscribe links carry HMAC(email) and are matched by the stored hash, so the hash is recomputed
 *     from the email on every write. A changed address has not consented yet: a pending or confirmed row becomes
 *     pending and the new address is emailed a confirmation link (after the write); an unsubscribed row stays
 *     unsubscribed. The welcome coupon follows the address.
 *   - Every update locks its row(s) first (in its transaction, before Payload reads the document), so these
 *     checks see the latest committed row and a concurrent unsubscribe waits for the Save, then applies.
 */

/** Written only by the retention code (Local API, overrideAccess). */
export const serverOwned: { create: FieldAccess; update: FieldAccess } = { create: () => false, update: () => false }

/** REST (the admin UI, scripts over HTTP) as opposed to the server's own Local API calls. */
const isRestWrite = (req: PayloadRequest): boolean => req.payloadAPI !== 'local'

/** req.context key: subscriber id → the updatedAt the submitting form was loaded with (the admin UI sends it). */
const FORM_LOADED_AT = 'wfSubscriberFormLoadedAt'
/** req.context key: subscriber id → the confirm token for a changed address, emailed by afterSubscriberWrite. */
const NEW_ADDRESS_TOKEN = 'wfSubscriberNewAddressToken'

function contextMap(req: PayloadRequest, key: string): Record<string, string> {
  const ctx = (req.context ??= {}) as Record<string, unknown>
  const existing = ctx[key]
  if (existing && typeof existing === 'object') return existing as Record<string, string>
  const created: Record<string, string> = {}
  ctx[key] = created
  return created
}

export const SUBSCRIBER_WRITE_ERROR = 'SubscriberWriteError'
export const staleSubscriberFormMessage =
  'This subscriber changed after you opened the page (they may have confirmed, unsubscribed or signed up again). ' +
  'Reload the page to see the latest, then make your change again.'
export const ownerConsentOnlyMessage =
  'Only the subscriber can join the list or confirm, with the link we email them (newsletter form or checkout box). ' +
  "Here you can only unsubscribe them: choose 'unsubscribed'."

/**
 * A refused admin / REST write: 409 SUBSCRIBER_CHANGED (stale form) or 400 OWNER_CONSENT_ONLY. The name is a
 * literal (minification mangles constructor names); callers map it by status and data.code.
 */
export class SubscriberWriteError extends APIError<{ code: 'SUBSCRIBER_CHANGED' | 'OWNER_CONSENT_ONLY' }> {
  constructor(code: 'SUBSCRIBER_CHANGED' | 'OWNER_CONSENT_ONLY') {
    const stale = code === 'SUBSCRIBER_CHANGED'
    super(stale ? staleSubscriberFormMessage : ownerConsentOnlyMessage, stale ? 409 : 400, { code }, true)
    this.name = SUBSCRIBER_WRITE_ERROR
  }
}

/** Locks the subscriber row(s) an update will write (ascending ids) and notes the form's load time. */
export const lockSubscribersBeforeUpdate: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'update') return args
  const a = args as { id?: number | string | null; where?: Where; data?: unknown }
  const hasId = a.id !== undefined && a.id !== null
  if (isRestWrite(req) && hasId) {
    const loaded = (a.data as { updatedAt?: unknown } | null | undefined)?.updatedAt
    if (toDate(loaded)) contextMap(req, FORM_LOADED_AT)[String(a.id)] = String(loaded)
  }
  if (!req.transactionID) return args
  // REST from a non-admin is refused by access control right after this: don't let it hold locks.
  if (isRestWrite(req) && !userIsAdmin(req.user)) return args
  if (hasId) {
    if (Number.isSafeInteger(Number(a.id))) await lockRow(req, 'subscribers', a.id as number | string)
    return args
  }
  if (a.where) {
    const res = await req.payload.find({
      collection: 'subscribers',
      where: a.where,
      pagination: false,
      depth: 0,
      select: { email: true },
      overrideAccess: true,
      req,
    })
    const ids = res.docs.map((d) => Number(d.id)).sort((x, y) => x - y)
    for (const id of ids) await lockRow(req, 'subscribers', id)
  }
  return args
}

const lower = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '')
const sameInstant = (a: unknown, b: unknown): boolean => (toDate(a)?.getTime() ?? null) === (toDate(b)?.getTime() ?? null)

/**
 * The submitting form against the stored row (every retention state change stamps updatedAt): 'stale' when it
 * was loaded before the row's last change, 'fresh' when not, 'unknown' when it didn't say (REST callers).
 */
function formState(req: PayloadRequest, stored: Pick<Subscriber, 'id' | 'updatedAt'>): 'stale' | 'fresh' | 'unknown' {
  const loaded = toDate(contextMap(req, FORM_LOADED_AT)[String(stored.id)])
  const current = toDate(stored.updatedAt)
  if (!loaded || !current) return 'unknown'
  return loaded.getTime() < current.getTime() ? 'stale' : 'fresh'
}

export const guardSubscriberWrite: CollectionBeforeChangeHook<Subscriber> = ({ data, operation, originalDoc, req }) => {
  const email = lower(data.email)
  // The link in every marketing email is HMAC(email): keep the stored hash in step with the address.
  if (email) data.unsubscribeTokenHash = unsubscribeTokenHash(email)
  if (operation !== 'update' || !originalDoc) return data

  const now = new Date()
  const before = originalDoc.status
  if (isRestWrite(req) && data.status !== before) {
    const form = formState(req, originalDoc)
    if (data.status === 'unsubscribed') {
      // They may have signed up again after this page was loaded: don't undo that from an old copy.
      if (form === 'stale') throw new SubscriberWriteError('SUBSCRIBER_CHANGED')
    } else if (form === 'fresh') {
      // Only the address owner puts an address on the list (the sign-up link, the checkout box).
      throw new SubscriberWriteError('OWNER_CONSENT_ONLY')
    } else {
      // A stale form (or a REST body) echoing the status it was loaded with: the stored one stands.
      data.status = before
    }
  }
  if (data.status === 'unsubscribed' && before !== 'unsubscribed') {
    // Taken off the list here rather than by their link: record when, like unsubscribeByToken, so an older
    // checkout consent can't re-subscribe them ('unsubscribed-later'), and void any pending confirm link.
    if (isRestWrite(req) || sameInstant(data.unsubscribedAt, originalDoc.unsubscribedAt)) data.unsubscribedAt = now.toISOString()
    data.confirmTokenHash = null
    data.confirmTokenExpiresAt = null
  }

  if (email && email !== lower(originalDoc.email)) {
    if (data.status === 'unsubscribed') {
      data.confirmTokenHash = null
      data.confirmTokenExpiresAt = null
    } else {
      // The consent on this row was given for the old address: the new one's owner confirms by email.
      const token = newConfirmToken()
      Object.assign(data, {
        status: 'pending',
        confirmedAt: null,
        consentAt: null,
        confirmTokenHash: hashToken(token),
        confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS).toISOString(),
        lastConfirmSentAt: now.toISOString(),
      })
      contextMap(req, NEW_ADDRESS_TOKEN)[String(originalDoc.id)] = token
    }
  }
  return data
}

/** The welcome coupon is the person's: when their address is corrected, it follows (if still bound to the old one). */
async function rebindWelcomeCoupon(req: PayloadRequest, couponId: number | null, from: string, to: string): Promise<void> {
  if (couponId === null) return
  const coupon = (await req.payload.findByID({
    collection: 'coupons',
    id: couponId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })) as Coupon | null
  if (!coupon || lower(coupon.boundEmail) !== from) return
  await req.payload.db.updateOne({
    collection: 'coupons',
    id: couponId,
    data: {
      boundEmail: to,
      ...(coupon.note === welcomeCouponNote(from) ? { note: welcomeCouponNote(to) } : {}),
      updatedAt: new Date().toISOString(),
    },
    returning: false,
    req,
  })
}

export const afterSubscriberWrite: CollectionAfterChangeHook<Subscriber> = async ({ doc, previousDoc, operation, req }) => {
  if (operation !== 'update' || !previousDoc) return doc
  const from = lower(previousDoc.email)
  const to = lower(doc.email)
  if (!from || !to || from === to) return doc
  await rebindWelcomeCoupon(req, relId(doc.welcomeCoupon), from, to)
  const tokens = contextMap(req, NEW_ADDRESS_TOKEN)
  const token = tokens[String(doc.id)]
  delete tokens[String(doc.id)]
  if (token) {
    // Inside the update's transaction (it holds the row): sendConfirmation's failure reset must use req.
    const result = await sendConfirmation(req.payload, { id: doc.id, email: to }, token, new Date(), req)
    if (result === 'failed') req.payload.logger.warn({ msg: 'subscriber address changed: the confirmation email could not be sent', subscriber: doc.id })
  }
  return doc
}
