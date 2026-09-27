import type { Payload, PayloadRequest, Where } from 'payload'

import type { Order, Subscriber } from '@/payload-types'

import { normalizeEmail } from '../commerce/shared/validate.js'
import { renderConfirmationEmail } from '../email/retention/confirmation'
import { sendOnce, type SendOnceResult } from '../email/sendOnce'
import { erasedSince } from './erasure'
import { confirmUrl } from './links'
import { CONFIRM_TOKEN_TTL_MS, hashToken, isTokenShape, newConfirmToken, unsubscribeTokenHash } from './tokens'
import { isUniqueViolation, relId, toDate } from './util'

/**
 * Newsletter subscribers (M6, double opt-in) and the checkout consent upsert.
 *
 *   (none) ──POST──▶ pending ──confirm link──▶ confirmed ──unsubscribe──▶ unsubscribed
 *                      ▲  └──POST again (≥10 min later): new link          │
 *                      └──────────────────POST (re-subscribe)──────────────┘
 *   checkout consent (order.confirmed with consent.marketing), see upsertCheckoutConsent:
 *     signed-in verified account, same email ──▶ confirmed at once (source 'checkout'), unless an unsubscribe
 *                                               NEWER than the order's consent (the latest choice wins);
 *     any other order (guest, COD…)          ──▶ the owner confirms by email: (none) → pending + link,
 *                                               pending → new link, unsubscribed → STAYS unsubscribed + a
 *                                               link that re-subscribes it only when clicked.
 *
 * Race safety: state changes are conditional single-row updates (`db.updateOne(..., {atomic:true})`,
 * null when the row no longer matches), and creates rely on the unique `email`. Nothing here runs in the
 * caller's transaction (no `req` is passed), so a unique violation never aborts someone else's work.
 * Admin / REST saves lock the row and never move it onto the list (./subscriberWrites.ts), so a conditional
 * update here waits for such a save and is never undone by the stale copy a form sends back.
 */

export const NEWSLETTER_SOURCE = 'newsletter'
export const CHECKOUT_SOURCE = 'checkout'
export const NEWSLETTER_CONSENT_TEXT =
  'Newsletter sign-up: breakfast recipes, new products and offers from Wefeasto by email. Confirmed by email (double opt-in).'
export const CHECKOUT_CONSENT_FALLBACK_TEXT = 'Ticked the marketing email box at checkout.'
/** At most one confirmation email per address per 10 minutes. */
export const CONFIRM_EMAIL_COOLDOWN_MS = 10 * 60 * 1000

type Opts = { now?: Date }

export async function findSubscriberByEmail(payload: Payload, email: string): Promise<Subscriber | null> {
  const res = await payload.find({
    collection: 'subscribers',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  return (res.docs[0] as Subscriber | undefined) ?? null
}

async function findByHash(payload: Payload, field: 'confirmTokenHash' | 'unsubscribeTokenHash', hash: string): Promise<Subscriber | null> {
  const res = await payload.find({
    collection: 'subscribers',
    where: { [field]: { equals: hash } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  return (res.docs[0] as Subscriber | undefined) ?? null
}

async function findSubscriberById(payload: Payload, id: number): Promise<Subscriber | null> {
  try {
    return (await payload.findByID({ collection: 'subscribers', id, depth: 0, overrideAccess: true, showHiddenFields: true })) as Subscriber
  } catch {
    return null
  }
}

/** Conditional update of one subscriber row; null when `where` no longer matches (lost a race). */
async function claimUpdate(payload: Payload, where: Where[], data: Record<string, unknown>): Promise<Subscriber | null> {
  return (await payload.db.updateOne({
    collection: 'subscribers',
    where: { and: where },
    data: { ...data, updatedAt: new Date().toISOString() },
    options: { atomic: true },
  })) as Subscriber | null
}

/* ------------------------------------------------------------------ sign-up (POST /api/store/newsletter) */

export type SubscribeOutcome =
  /** new address: pending + confirmation email */
  | 'created'
  /** pending address, cooldown over: new link emailed (the previous link stops working) */
  | 'resent'
  /** unsubscribed address signing up again: pending + confirmation email */
  | 'resubscribed'
  /** pending address inside the 10-minute cooldown: nothing sent */
  | 'throttled'
  /** already on the list: nothing sent */
  | 'already-confirmed'

export type SubscribeResult = { outcome: SubscribeOutcome; email?: SendOnceResult; subscriberId?: number }

/**
 * Emails the double-opt-in link for `token`. On failure it clears `lastConfirmSentAt`, so the next sign-up
 * attempt gets a link at once. Pass `req` when the caller's transaction holds the subscriber row (a
 * collection hook): the reset must run in that transaction, or it would wait for the lock the caller holds.
 */
export async function sendConfirmation(
  payload: Payload,
  sub: Pick<Subscriber, 'id' | 'email'>,
  token: string,
  sentAt: Date,
  req?: PayloadRequest,
): Promise<SendOnceResult> {
  const { subject, html, text } = renderConfirmationEmail({ confirmUrl: confirmUrl(token) })
  const result = await sendOnce({
    key: `newsletter-confirm:${sub.email}:${sentAt.getTime()}`,
    type: 'newsletter-confirm',
    to: sub.email,
    subject,
    html,
    text,
    payload,
  })
  if (result === 'failed') {
    // Let the next sign-up attempt through at once instead of waiting out the cooldown.
    await payload.db.updateOne({
      collection: 'subscribers',
      id: sub.id,
      data: { lastConfirmSentAt: null, updatedAt: new Date().toISOString() },
      returning: false,
      ...(req ? { req } : {}),
    })
  }
  return result
}

/**
 * The work behind POST /api/store/newsletter for a valid, normalised email. The HTTP answer is the same
 * whatever this returns (no membership oracle); the outcome is for logs and tests.
 */
export async function requestSubscription(payload: Payload, email: string, { now = new Date() }: Opts = {}): Promise<SubscribeResult> {
  let sub = await findSubscriberByEmail(payload, email)
  const token = newConfirmToken()
  const tokenFields = {
    confirmTokenHash: hashToken(token),
    confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS).toISOString(),
    lastConfirmSentAt: now.toISOString(),
  }

  if (!sub) {
    try {
      const created = (await payload.create({
        collection: 'subscribers',
        data: {
          email,
          status: 'pending',
          source: NEWSLETTER_SOURCE,
          consentText: NEWSLETTER_CONSENT_TEXT,
          unsubscribeTokenHash: unsubscribeTokenHash(email),
          ...tokenFields,
        },
        depth: 0,
        overrideAccess: true,
      })) as Subscriber
      return { outcome: 'created', subscriberId: created.id, email: await sendConfirmation(payload, created, token, now) }
    } catch (err) {
      if (!isUniqueViolation(err, 'email')) throw err
      // A concurrent request created it first: treat it as an existing (fresh, so throttled) row.
      sub = await findSubscriberByEmail(payload, email)
      if (!sub) throw err
    }
  }

  if (sub.status === 'confirmed') return { outcome: 'already-confirmed', subscriberId: sub.id }

  if (sub.status === 'unsubscribed') {
    // Only the address owner can unsubscribe (the link is in their inbox), so this transition is not
    // throttled: someone who unsubscribes and changes their mind gets their link straight away.
    const claimed = await claimUpdate(payload, [{ id: { equals: sub.id } }, { status: { equals: 'unsubscribed' } }], {
      status: 'pending',
      source: NEWSLETTER_SOURCE,
      consentText: NEWSLETTER_CONSENT_TEXT,
      unsubscribeTokenHash: unsubscribeTokenHash(email),
      ...tokenFields,
    })
    if (!claimed) return { outcome: 'throttled', subscriberId: sub.id }
    return { outcome: 'resubscribed', subscriberId: sub.id, email: await sendConfirmation(payload, sub, token, now) }
  }

  // pending: a new link at most every 10 minutes (the claim is the throttle, so concurrent sign-ups
  // send one email).
  const cutoff = new Date(now.getTime() - CONFIRM_EMAIL_COOLDOWN_MS).toISOString()
  const claimed = await claimUpdate(
    payload,
    [
      { id: { equals: sub.id } },
      { status: { equals: 'pending' } },
      { or: [{ lastConfirmSentAt: { exists: false } }, { lastConfirmSentAt: { less_than_equal: cutoff } }] },
    ],
    tokenFields,
  )
  if (!claimed) return { outcome: 'throttled', subscriberId: sub.id }
  return { outcome: 'resent', subscriberId: sub.id, email: await sendConfirmation(payload, sub, token, now) }
}

/* ------------------------------------------------------------ confirm (GET /api/store/newsletter/confirm) */

export type ConfirmOutcome = 'confirmed' | 'already-confirmed' | 'expired' | 'invalid'

/**
 * Confirms the subscriber whose pending link this is. Idempotent: an already-confirmed subscriber's link
 * keeps answering 'already-confirmed' (until it is replaced or they unsubscribe). Returns the subscriber
 * (fresh) when confirmed, so the caller can send the welcome email.
 *
 * An UNSUBSCRIBED row can carry a link too: the re-confirmation a later checkout consent box emailed
 * (askOwnerToConfirm). Unsubscribing clears the confirm token, so a matching token on an unsubscribed row
 * was always issued after the unsubscribe, and clicking it is the owner's own newer choice.
 */
export async function confirmSubscription(
  payload: Payload,
  token: unknown,
  { now = new Date() }: Opts = {},
): Promise<{ outcome: ConfirmOutcome; subscriber?: Subscriber }> {
  if (!isTokenShape(token)) return { outcome: 'invalid' }
  const hash = hashToken(token)
  const sub = await findByHash(payload, 'confirmTokenHash', hash)
  if (!sub) return { outcome: 'invalid' }
  if (sub.status === 'confirmed') return { outcome: 'already-confirmed', subscriber: sub }

  const expires = toDate(sub.confirmTokenExpiresAt)
  if (!expires || expires.getTime() <= now.getTime()) return { outcome: 'expired' }

  const won = await claimUpdate(
    payload,
    [{ id: { equals: sub.id } }, { status: { in: ['pending', 'unsubscribed'] } }, { confirmTokenHash: { equals: hash } }],
    { status: 'confirmed', confirmedAt: now.toISOString(), consentAt: now.toISOString() },
  )
  const fresh = await findSubscriberById(payload, sub.id)
  if (won && fresh) return { outcome: 'confirmed', subscriber: fresh }
  // Lost a race: a concurrent click confirmed it (fine), or a new link replaced this one.
  if (fresh?.status === 'confirmed') return { outcome: 'already-confirmed', subscriber: fresh }
  return { outcome: 'expired' }
}

/* ------------------------------------------------------ unsubscribe (GET/POST /api/store/newsletter/unsubscribe) */

export type UnsubscribeOutcome = 'unsubscribed' | 'already-unsubscribed' | 'invalid'

export async function unsubscribeByToken(payload: Payload, token: unknown, { now = new Date() }: Opts = {}): Promise<UnsubscribeOutcome> {
  if (!isTokenShape(token)) return 'invalid'
  const sub = await findByHash(payload, 'unsubscribeTokenHash', hashToken(token))
  if (!sub) return 'invalid'
  if (sub.status === 'unsubscribed') return 'already-unsubscribed'
  const done = await claimUpdate(payload, [{ id: { equals: sub.id } }, { status: { not_equals: 'unsubscribed' } }], {
    status: 'unsubscribed',
    unsubscribedAt: now.toISOString(),
    // An old confirm link must never re-subscribe them.
    confirmTokenHash: null,
    confirmTokenExpiresAt: null,
  })
  return done ? 'unsubscribed' : 'already-unsubscribed'
}

/* ------------------------------------------------------------------ checkout consent (order.confirmed) */

export type ConsentOutcome =
  /** proven address: new subscriber, confirmed at once */
  | 'created'
  /** proven address: pending → confirmed */
  | 'confirmed'
  /** proven address: unsubscribed before this order's consent → confirmed */
  | 'reconfirmed'
  | 'unchanged'
  | 'no-consent'
  | 'invalid-email'
  /** they unsubscribed AFTER this order's consent: the newer choice wins */
  | 'unsubscribed-later'
  /** the owner erased the address (Subscribers → delete) AFTER this order's consent: it stays off the list */
  | 'erased'
  /** unproven address: new PENDING subscriber + the double-opt-in confirmation email */
  | 'pending'
  /** unproven address, already pending: a new confirmation link (cooldown permitting) */
  | 'resent'
  /** unproven address that unsubscribed: STAYS unsubscribed; a confirmation link re-subscribes it on click */
  | 'reconfirm-sent'
  /** unproven address: a confirmation email went out < 10 minutes ago, nothing sent */
  | 'throttled'

type ConsentOrder = Pick<Order, 'contact' | 'consent' | 'createdAt'> & { customer?: Order['customer'] }

/**
 * The order proves the address only when it was placed signed in, by a verified customer account whose
 * email is the order's email (they proved it by clicking the account verification link). A guest order —
 * cash on delivery especially, which costs nothing — proves nothing: anyone can type anyone's email.
 */
export async function orderProvesAddress(payload: Payload, order: ConsentOrder, email: string): Promise<boolean> {
  const id = relId(order.customer)
  if (id === null) return false
  const customer = (await payload.findByID({
    collection: 'customers',
    id,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    disableErrors: true,
  })) as { email?: string | null; _verified?: boolean | null } | null
  return Boolean(customer && customer._verified === true && normalizeEmail(customer.email) === email)
}

/**
 * The checkout consent box (order.confirmed with consent.marketing). Consent must come from the address
 * owner (DPDP; double opt-in), so:
 *   - proven address (orderProvesAddress): subscribed at once, status confirmed, source 'checkout', no email;
 *     an unsubscribe NEWER than the order's consent still wins.
 *   - otherwise: the owner confirms by email, exactly like the newsletter form — a new address becomes
 *     PENDING (source 'checkout') with the confirmation email; a pending one gets a new link (10-minute
 *     cooldown); an unsubscribed one STAYS unsubscribed and gets a link that re-subscribes it only when
 *     clicked. An order never turns an unsubscribe into a subscription by itself.
 *   - the owner erased the address (Subscribers → delete, DPDP) at or after this order's consent: nothing
 *     ('erased'); only a newer consent (a new order's box, the newsletter form) brings it back (./erasure.ts).
 * Idempotent: a repeated `order.confirmed` is 'unchanged', 'throttled', 'unsubscribed-later' or 'erased'.
 */
export async function upsertCheckoutConsent(payload: Payload, order: ConsentOrder, { now = new Date() }: Opts = {}): Promise<ConsentOutcome> {
  if (order?.consent?.marketing !== true) return 'no-consent'
  const email = normalizeEmail(order.contact?.email)
  if (!email) return 'invalid-email'
  const consentAt = toDate(order.consent.at) ?? toDate(order.createdAt) ?? now
  const consentText = (typeof order.consent.text === 'string' && order.consent.text.trim()) || CHECKOUT_CONSENT_FALLBACK_TEXT

  const sub = await findSubscriberByEmail(payload, email)
  if (sub?.status === 'confirmed') return 'unchanged'
  if (sub?.status === 'unsubscribed') {
    const unsubscribedAt = toDate(sub.unsubscribedAt)
    if (unsubscribedAt && unsubscribedAt.getTime() >= consentAt.getTime()) return 'unsubscribed-later'
  }
  // A missing (or re-created, not yet confirmed) row may be the owner's erasure: an older checkbox never
  // undoes it, whether this is the order's first confirmation or a repeated one (hunt w5 r2).
  if (await erasedSince(payload, email, consentAt)) return 'erased'
  if (await orderProvesAddress(payload, order, email)) return confirmFromOrder(payload, email, sub, { consentAt, consentText, now })
  return askOwnerToConfirm(payload, email, sub, { consentText, now })
}

type ConsentArgs = { consentAt: Date; consentText: string; now: Date }

async function confirmFromOrder(payload: Payload, email: string, found: Subscriber | null, { consentAt, consentText, now }: ConsentArgs): Promise<ConsentOutcome> {
  const confirmed = {
    status: 'confirmed',
    source: CHECKOUT_SOURCE,
    consentText,
    consentAt: consentAt.toISOString(),
    confirmedAt: now.toISOString(),
    unsubscribeTokenHash: unsubscribeTokenHash(email),
  } as const
  let sub = found
  if (!sub) {
    try {
      await payload.create({ collection: 'subscribers', data: { email, ...confirmed }, depth: 0, overrideAccess: true })
      return 'created'
    } catch (err) {
      if (!isUniqueViolation(err, 'email')) throw err
      sub = await findSubscriberByEmail(payload, email)
      if (!sub) throw err
    }
  }
  if (sub.status === 'confirmed') return 'unchanged'
  const won = await claimUpdate(payload, [{ id: { equals: sub.id } }, { status: { equals: sub.status } }], confirmed)
  if (!won) return 'unchanged'
  return sub.status === 'unsubscribed' ? 'reconfirmed' : 'confirmed'
}

async function askOwnerToConfirm(payload: Payload, email: string, found: Subscriber | null, { consentText, now }: Omit<ConsentArgs, 'consentAt'>): Promise<ConsentOutcome> {
  const token = newConfirmToken()
  const tokenFields = {
    confirmTokenHash: hashToken(token),
    confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS).toISOString(),
    lastConfirmSentAt: now.toISOString(),
  }
  let sub = found
  if (!sub) {
    try {
      const created = (await payload.create({
        collection: 'subscribers',
        data: { email, status: 'pending', source: CHECKOUT_SOURCE, consentText, unsubscribeTokenHash: unsubscribeTokenHash(email), ...tokenFields },
        depth: 0,
        overrideAccess: true,
      })) as Subscriber
      await sendConfirmation(payload, created, token, now)
      return 'pending'
    } catch (err) {
      if (!isUniqueViolation(err, 'email')) throw err
      sub = await findSubscriberByEmail(payload, email)
      if (!sub) throw err
      if (sub.status === 'confirmed') return 'unchanged'
    }
  }
  // pending or unsubscribed: a new link at most every 10 minutes; the status itself never changes here.
  const cutoff = new Date(now.getTime() - CONFIRM_EMAIL_COOLDOWN_MS).toISOString()
  const claimed = await claimUpdate(
    payload,
    [
      { id: { equals: sub.id } },
      { status: { equals: sub.status } },
      { or: [{ lastConfirmSentAt: { exists: false } }, { lastConfirmSentAt: { less_than_equal: cutoff } }] },
    ],
    tokenFields,
  )
  if (!claimed) return 'throttled'
  await sendConfirmation(payload, sub, token, now)
  return sub.status === 'unsubscribed' ? 'reconfirm-sent' : 'resent'
}
