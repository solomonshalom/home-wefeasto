import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { CollectionAfterDeleteHook, Payload, PayloadRequest } from 'payload'

import { sessionDb, tableOf } from '../commerce/checkout/db'
import { normalizeEmail } from '../commerce/shared/validate.js'
import { toDate } from './util'

/**
 * Erasure of a marketing address (DPDP): the owner deletes the person's row in Customers → Subscribers.
 *
 * The row is gone, but every order keeps its (immutable) checkout-consent checkbox, and `order.confirmed` can be
 * emitted again for an old order: an admin resolving a review back to paid (e.g. after a chargeback was won),
 * reconcile re-emitting it with a late confirmation email, a late authorisation of an order placed before the
 * erasure. With no trace of the erasure, the consent handler found no row and re-created it from that older
 * consent: confirmed at once for a verified account's order, or pending + a confirmation email to the person who
 * asked to be forgotten; the refill reminder queued at the first confirmation then sent marketing (hunt w5 r2).
 *
 * So every subscriber delete (admin UI, bulk delete, REST, Local API) records an erasure marker in the message
 * log: key `erasure:<sha256 of the address>` (a one-way hash, never the address itself), `sentAt` = the latest
 * erasure. Consent given at or before that instant never puts the address back (upsertCheckoutConsent →
 * 'erased'); consent given after it (a new order's box, the newsletter form's double opt-in) works as usual.
 * The marker is written in the delete's own transaction, with an upsert that can't fail on the unique key, so
 * a delete and its marker commit (or roll back) together.
 */

export const ERASURE_TYPE = 'subscriber-erased'
const ERASURE_SUBJECT = 'Subscriber deleted: consent given before this will not add the address again'

/** The message-log key of an address's erasure marker (normalised address, one-way hash). */
export function erasureKey(email: string): string {
  const normalized = normalizeEmail(email) ?? String(email).trim().toLowerCase()
  return `erasure:${createHash('sha256').update(`wf-subscriber-erasure:${normalized}`).digest('hex')}`
}

/** Records (or moves forward) the erasure marker of `email`, inside req's transaction when it has one. */
export async function recordErasure(req: PayloadRequest, email: string, at: Date = new Date()): Promise<void> {
  const db = await sessionDb(req)
  const table = sql.identifier(tableOf(req.payload, 'message-log'))
  const when = at.toISOString()
  await db.execute(sql`
    INSERT INTO ${table} AS "t" ("key", "type", "subject", "status", "attempts", "sent_at", "updated_at", "created_at")
    VALUES (${erasureKey(email)}, ${ERASURE_TYPE}, ${ERASURE_SUBJECT}, 'sent', 0, ${when}, now(), now())
    ON CONFLICT ("key") DO UPDATE SET "sent_at" = GREATEST("t"."sent_at", EXCLUDED."sent_at"), "updated_at" = now()`)
}

/** When `email` was last erased (Subscribers → delete), or null if it never was. */
export async function lastErasedAt(payload: Payload, email: string): Promise<Date | null> {
  const res = await payload.find({
    collection: 'message-log',
    where: { key: { equals: erasureKey(email) } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    select: { sentAt: true },
  })
  return toDate((res.docs[0] as { sentAt?: string | null } | undefined)?.sentAt)
}

/** Was `email` erased at or after `consentAt`? Then that consent must not put it back on the list. */
export async function erasedSince(payload: Payload, email: string, consentAt: Date): Promise<boolean> {
  const at = await lastErasedAt(payload, email)
  return at !== null && at.getTime() >= consentAt.getTime()
}

/** Subscribers afterDelete: every deleted row leaves an erasure marker for its address. */
export const recordSubscriberErasure: CollectionAfterDeleteHook = async ({ doc, req }) => {
  const email = (doc as { email?: unknown } | null)?.email
  if (typeof email === 'string' && email.trim()) await recordErasure(req, email)
  return doc
}
