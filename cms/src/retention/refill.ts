import type { Payload, Where } from 'payload'

import type { Order } from '@/payload-types'

import { isConfirmed } from '../commerce/shared/order-status.js'
import { firstName, normalizeEmail } from '../commerce/shared/validate.js'
import { renderRefillEmail } from '../email/retention/refill'
import { sendOnce } from '../email/sendOnce'
import { refillCartUrl, unsubscribeUrl } from './links'
import { recipeForProducts } from './recipes'
import { findSubscriberByEmail } from './subscribers'
import { planRefill, type RefillPlan } from './timing'
import { unsubscribeToken } from './tokens'
import { errMessage, isUniqueViolation } from './util'

/**
 * Refill reminders (S2). One email per order, a few days before the earliest product runs out.
 *
 * Scheduling (order.confirmed, order.household_updated → scheduleRefillReminder):
 *   job 'refillReminder' { orderId, number, stamp, reminder: 1 } with waitUntil = plan.remindAt, queue 'default'.
 *   `stamp` = 'h' + householdSize (0 when unanswered). A job whose stamp no longer matches the order
 *   (the household answer changed and a new job was queued) exits as 'skipped:superseded'.
 *   Duplicate events queue one job per (order, stamp): the claim is a message-log row
 *   `refill-queue:<no>:1:<stamp>` (unique key), inserted before queueing and removed if queueing fails.
 *
 * Sending (the job → runRefillReminder) re-checks everything and skips when: the order is gone, the
 * stamp is stale, the order is no longer confirmed (refunded / cancelled / needs review) or came back
 * (RTO / returned), there is no marketing consent, the address unsubscribed, has no subscriber row (never
 * recorded, or deleted by the owner) or has not CONFIRMED its subscription (a guest's ticked box only asks the
 * owner to confirm by email — see upsertCheckoutConsent; the job itself never records consent),
 * a newer confirmed order exists for the same email or phone, or `refill:<no>:1` was already sent. The send itself is sendOnce
 * with key `refill:<no>:1`, so it is exactly-once even if two jobs race.
 */

export const REFILL_TASK = 'refillReminder'
export const REFILL_QUEUE = 'default'
export const REFILL_EMAIL_TYPE = 'refill-reminder'
export const REFILL_SCHEDULED_TYPE = 'refill-scheduled'
/** v1 sends at most one reminder per order. */
export const REMINDER_NO = 1

export const refillKey = (orderNumber: string, n = REMINDER_NO): string => `refill:${orderNumber}:${n}`
export const refillQueueKey = (orderNumber: string, stamp: string, n = REMINDER_NO): string => `refill-queue:${orderNumber}:${n}:${stamp}`

/** The scheduling version of an order: its household answer (0 = not answered yet). */
export function refillStamp(order: Pick<Order, 'householdSize'>): string {
  const h = order.householdSize
  return `h${typeof h === 'number' && Number.isSafeInteger(h) && h > 0 ? h : 0}`
}

export type RefillJobInput = { orderId: number; number?: string | null; stamp: string; reminder?: number | null }

async function loadOrder(payload: Payload, id: number): Promise<Order | null> {
  return (await payload.findByID({ collection: 'orders', id, depth: 0, overrideAccess: true, disableErrors: true })) as Order | null
}

/** The order's lines with each product's current daysPerPack (by slug; missing → the timing default). */
async function refillItems(payload: Payload, order: Order) {
  const lines = (order.items ?? []).filter((i) => i && typeof i.slug === 'string')
  const slugs = [...new Set(lines.map((i) => i.slug))]
  const products = slugs.length
    ? (
        await payload.find({
          collection: 'products',
          where: { slug: { in: slugs } },
          limit: slugs.length,
          depth: 0,
          overrideAccess: true,
          select: { slug: true, daysPerPack: true },
        })
      ).docs
    : []
  const days = new Map(products.map((p) => [p.slug, p.daysPerPack ?? null]))
  return lines.map((i) => ({ slug: i.slug, name: i.name, qty: i.qty, product: i.product, daysPerPack: days.get(i.slug) ?? null }))
}

export async function planForOrder(payload: Payload, order: Order): Promise<RefillPlan | null> {
  return planRefill({ paidAt: order.paidAt ?? order.createdAt, items: await refillItems(payload, order), householdSize: order.householdSize })
}

async function logRow(payload: Payload, key: string) {
  const res = await payload.find({ collection: 'message-log', where: { key: { equals: key } }, limit: 1, depth: 0, overrideAccess: true })
  return res.docs[0] ?? null
}

export type ScheduleOutcome =
  | 'queued'
  | 'duplicate'
  | 'missing'
  | 'not-confirmed'
  | 'no-consent'
  | 'no-items'
  | 'already-sent'

export type ScheduleResult = { outcome: ScheduleOutcome; jobId?: number | string; remindAt?: Date; stamp?: string }

/**
 * Queues the reminder job for an order (re-reading it, so a stale event payload can't schedule from old
 * data). Safe to call any number of times, concurrently too.
 */
export async function scheduleRefillReminder(payload: Payload, orderId: number, { now = new Date() }: { now?: Date } = {}): Promise<ScheduleResult> {
  const order = await loadOrder(payload, orderId)
  if (!order) return { outcome: 'missing' }
  if (!isConfirmed(order.status)) return { outcome: 'not-confirmed' }
  if (order.consent?.marketing !== true) return { outcome: 'no-consent' }
  const sent = await logRow(payload, refillKey(order.number))
  if (sent && sent.status !== 'failed') return { outcome: 'already-sent' }
  const plan = await planForOrder(payload, order)
  if (!plan) return { outcome: 'no-items' }

  const stamp = refillStamp(order)
  const claimKey = refillQueueKey(order.number, stamp)
  let claimId: number
  try {
    const row = await payload.create({
      collection: 'message-log',
      data: {
        key: claimKey,
        type: REFILL_SCHEDULED_TYPE,
        order: order.id,
        to: order.contact?.email,
        subject: `Refill reminder scheduled for ${plan.remindAt.toISOString()} (${plan.eaters} eating, runs out in ~${Math.round(plan.runOutDays)} days)`,
        status: 'sent',
        sentAt: now.toISOString(),
        attempts: 1,
      },
      depth: 0,
      overrideAccess: true,
    })
    claimId = row.id
  } catch (err) {
    if (isUniqueViolation(err, 'key')) return { outcome: 'duplicate', stamp }
    throw err
  }

  try {
    const job = await payload.jobs.queue({
      task: REFILL_TASK,
      queue: REFILL_QUEUE,
      input: { orderId: order.id, number: order.number, stamp, reminder: REMINDER_NO },
      waitUntil: plan.remindAt,
    })
    return { outcome: 'queued', jobId: job.id, remindAt: plan.remindAt, stamp }
  } catch (err) {
    // Give the next event a chance to queue it.
    await payload.delete({ collection: 'message-log', id: claimId, overrideAccess: true }).catch(() => {})
    throw err
  }
}

export type RefillRunResult =
  | 'sent'
  | 'skipped:missing'
  | 'skipped:superseded'
  | 'skipped:inactive'
  | 'skipped:no-consent'
  | 'skipped:no-email'
  | 'skipped:unsubscribed'
  /** no confirmed subscriber row (pending, or none: never recorded / deleted): marketing needs the owner's consent */
  | 'skipped:unconfirmed'
  | 'skipped:reordered'
  | 'skipped:already-sent'
  | 'skipped:no-items'

const RETURNED = new Set(['rto', 'returned'])

/** A confirmed order for the same email or phone, created after this one. */
async function hasNewerOrder(payload: Payload, order: Order, email: string): Promise<boolean> {
  const sameCustomer: Where[] = [{ 'contact.email': { equals: email } }]
  if (order.contact?.phone) sameCustomer.push({ 'contact.phone': { equals: order.contact.phone } })
  const res = await payload.find({
    collection: 'orders',
    where: {
      and: [
        { id: { not_equals: order.id } },
        { createdAt: { greater_than: order.createdAt } },
        { status: { in: ['paid', 'cod_pending', 'cod_confirmed', 'partially_refunded'] } },
        { or: sameCustomer },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    select: { number: true },
  })
  return res.docs.length > 0
}

/**
 * The job body: re-check, then send `refill:<no>:1` once. Throws only when the email could not be sent
 * (so the jobs runner retries); every skip is a normal return.
 */
export async function runRefillReminder(payload: Payload, input: RefillJobInput): Promise<RefillRunResult> {
  const order = await loadOrder(payload, Number(input.orderId))
  if (!order) return 'skipped:missing'
  if (refillStamp(order) !== input.stamp) return 'skipped:superseded'
  if (!isConfirmed(order.status) || RETURNED.has(order.fulfilmentStatus)) return 'skipped:inactive'
  if (order.consent?.marketing !== true) return 'skipped:no-consent'
  const email = normalizeEmail(order.contact?.email)
  if (!email) return 'skipped:no-email'

  // Consent is recorded once, by the order.confirmed consent handler. A missing row is never a reason to record
  // it here from the order's old checkbox: it may be the owner's erasure (Subscribers → delete, DPDP), and
  // consent given before that must not put the address back on the list (hunt w5).
  const sub = await findSubscriberByEmail(payload, email)
  if (sub?.status === 'unsubscribed') return 'skipped:unsubscribed'
  if (!sub || sub.status !== 'confirmed') return 'skipped:unconfirmed'
  const key = refillKey(order.number, Number(input.reminder) || REMINDER_NO)
  const existing = await logRow(payload, key)
  if (existing && existing.status !== 'failed') return 'skipped:already-sent'
  if (await hasNewerOrder(payload, order, email)) return 'skipped:reordered'

  const items = await refillItems(payload, order)
  const plan = planRefill({ paidAt: order.paidAt ?? order.createdAt, items, householdSize: order.householdSize })
  if (!plan) return 'skipped:no-items'

  let recipe = null
  try {
    recipe = await recipeForProducts(payload, items)
  } catch (err) {
    payload.logger.warn({ msg: 'refill reminder: recipe lookup failed; sending without one', order: order.number, err: errMessage(err) })
  }
  const rendered = renderRefillEmail({
    firstName: firstName(order.contact?.name),
    orderNumber: order.number,
    items: items.map((i) => ({ name: i.name, qty: i.qty })),
    runsOutAt: plan.runsOutAt,
    refillUrl: refillCartUrl(items),
    recipe,
    unsubscribeUrl: unsubscribeUrl(unsubscribeToken(email)),
  })
  const result = await sendOnce({ key, type: REFILL_EMAIL_TYPE, order: order.id, to: email, payload, ...rendered })
  if (result === 'failed') throw new Error(`refill reminder ${key} could not be sent; the job will retry`)
  return result === 'sent' ? 'sent' : 'skipped:already-sent'
}
