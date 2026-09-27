import type { Payload } from 'payload'

import type { Coupon, Subscriber } from '@/payload-types'

import { getStoreSettings } from '../commerce/settings'
import { buildWelcomeCoupon } from '../commerce/shared/coupons.js'
import { isConfirmed } from '../commerce/shared/order-status.js'
import { renderWelcomeEmail } from '../email/retention/welcome'
import { sendOnce, type SendOnceResult } from '../email/sendOnce'
import { codeLengthForAttempt, welcomeCode, welcomeCouponNote } from './codes'
import { offerUrl, storefrontUrl, unsubscribeUrl } from './links'
import { pickWelcomeRecipes } from './recipes'
import { unsubscribeToken } from './tokens'
import { isUniqueViolation, relId } from './util'

/**
 * Welcome offer (S6) + welcome email (M6), once per address, on its first newsletter confirmation.
 *
 * The coupon is `$shared` buildWelcomeCoupon(settings.welcomeOffer): percent (10), capped
 * (maxDiscountPaise 7500), usageLimit 1, perCustomerLimit 1, firstOrderOnly, boundEmail = the subscriber,
 * startsAt = now, endsAt = now + validDays (exclusive). Checkout validates it with evaluateCoupon.
 * The code is `HELLO-XXXX` (Crockford base32), retried on a unique collision.
 */

export const WELCOME_EMAIL_TYPE = 'newsletter-welcome'
export const welcomeKey = (email: string): string => `welcome:${email}`
const MAX_CODE_ATTEMPTS = 10

/** Statuses that count as "has already ordered" for a first-order-only code ($shared isConfirmed + refunded). */
export async function hasPlacedOrder(payload: Payload, email: string): Promise<boolean> {
  const res = await payload.find({
    collection: 'orders',
    where: { 'contact.email': { equals: email } },
    limit: 20,
    depth: 0,
    overrideAccess: true,
    select: { status: true },
  })
  return res.docs.some((o) => isConfirmed(o.status) || o.status === 'refunded')
}

/** Code for the n-th attempt (0-based). Injectable for tests. */
export type CodeGenerator = (attempt: number) => string
const defaultGenerator: CodeGenerator = (attempt) => welcomeCode(codeLengthForAttempt(attempt))

async function createUniqueCoupon(payload: Payload, email: string, now: Date, generate: CodeGenerator): Promise<Coupon> {
  const { public: settings } = await getStoreSettings(payload)
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const data = buildWelcomeCoupon({ code: generate(attempt), email, now, settings })
    try {
      return (await payload.create({
        collection: 'coupons',
        data: {
          ...data,
          value: data.value ?? 0,
          startsAt: data.startsAt ? new Date(data.startsAt).toISOString() : null,
          endsAt: data.endsAt ? new Date(data.endsAt).toISOString() : null,
          note: welcomeCouponNote(email),
        },
        depth: 0,
        overrideAccess: true,
      })) as Coupon
    } catch (err) {
      if (!isUniqueViolation(err, 'code')) throw err
    }
  }
  throw new Error(`Could not generate a unique welcome code after ${MAX_CODE_ATTEMPTS} attempts`)
}

/**
 * The subscriber's welcome coupon, creating and linking it on first call. Concurrent calls create at most
 * one linked coupon: the link is a conditional update (`welcomeCoupon IS NULL`) and a loser deletes its
 * own, never-sent coupon and returns the winner's.
 */
export async function ensureWelcomeCoupon(
  payload: Payload,
  sub: Pick<Subscriber, 'id' | 'email' | 'welcomeCoupon'>,
  now = new Date(),
  generate: CodeGenerator = defaultGenerator,
): Promise<Coupon> {
  const existingId = relId(sub.welcomeCoupon)
  if (existingId !== null) {
    const found = await payload.findByID({ collection: 'coupons', id: existingId, depth: 0, overrideAccess: true, disableErrors: true })
    if (found) return found as Coupon
  }
  const coupon = await createUniqueCoupon(payload, sub.email, now, generate)
  const linked = await payload.db.updateOne({
    collection: 'subscribers',
    where: {
      and: [
        { id: { equals: sub.id } },
        existingId === null ? { welcomeCoupon: { exists: false } } : { welcomeCoupon: { equals: existingId } },
      ],
    },
    data: { welcomeCoupon: coupon.id, updatedAt: new Date().toISOString() },
    options: { atomic: true },
  })
  if (linked) return coupon
  await payload.delete({ collection: 'coupons', id: coupon.id, overrideAccess: true })
  const fresh = await payload.findByID({ collection: 'subscribers', id: sub.id, depth: 1, overrideAccess: true })
  const winner = fresh.welcomeCoupon
  if (winner && typeof winner === 'object') return winner as Coupon
  throw new Error(`Welcome coupon link for subscriber ${sub.id} lost a race and no winner was found`)
}

export type WelcomeResult = { result: SendOnceResult | 'already-sent' | 'not-confirmed'; code: string | null }

/**
 * Sends the welcome email once per address (message-log key `welcome:<email>`). With no earlier order
 * for the address it carries the personal code (created here if needed) and the /cart?offer= link;
 * with one it carries recipes only, since a first-order code could never apply.
 */
export async function ensureWelcome(payload: Payload, sub: Subscriber, { now = new Date() }: { now?: Date } = {}): Promise<WelcomeResult> {
  if (sub.status !== 'confirmed') return { result: 'not-confirmed', code: null }
  const key = welcomeKey(sub.email)
  const logged = await payload.find({
    collection: 'message-log',
    where: { and: [{ key: { equals: key } }, { status: { equals: 'sent' } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (logged.docs.length) return { result: 'already-sent', code: null }

  const coupon = (await hasPlacedOrder(payload, sub.email)) ? null : await ensureWelcomeCoupon(payload, sub, now)
  const recipes = await pickWelcomeRecipes(payload, 2)
  const email = renderWelcomeEmail({
    offer: coupon
      ? {
          code: coupon.code,
          percent: coupon.value,
          maxDiscountPaise: coupon.maxDiscountPaise ?? null,
          endsAt: coupon.endsAt ?? now,
          url: offerUrl(coupon.code),
        }
      : null,
    recipes,
    unsubscribeUrl: unsubscribeUrl(unsubscribeToken(sub.email)),
    shopUrl: storefrontUrl('/shop'),
  })
  const result = await sendOnce({ key, type: WELCOME_EMAIL_TYPE, to: sub.email, payload, ...email })
  return { result, code: coupon?.code ?? null }
}
