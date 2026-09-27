import { type Payload, type PayloadRequest, ValidationError } from 'payload'

/**
 * Exactly-once email send, guarded by the unique `message-log.key`.
 *
 *   const result = await sendOnce({ key: `confirm:${order.number}`, type: 'order-confirmation',
 *     to: order.contact.email, subject, html, text, order: order.id, req })
 *   // 'sent' | 'duplicate' | 'failed'
 *
 * 1. Claim: insert { key, status: 'pending' }. A unique conflict means someone else owns (or already
 *    sent) this message → 'duplicate'. A row left 'failed', or 'pending' for longer than `staleAfterMs`
 *    (a crash between claim and send), is re-claimed atomically so retries can deliver it.
 * 2. Send via payload.sendEmail (nodemailer SMTP, or the console adapter when SMTP_HOST is empty).
 * 3. Mark the row 'sent' (+ sentAt) or 'failed' (+ error). Never throws for SMTP errors: returns 'failed'.
 *
 * The claim runs OUTSIDE req's transaction on purpose: a unique violation inside a Postgres transaction
 * would abort the caller's whole transaction, and a claim that rolled back with the caller could let a
 * second copy through. So call sendOnce AFTER your transaction has committed (e.g. after markPaid).
 */

export type SendOnceArgs = {
  /** Unique idempotency key, e.g. `confirm:WF-10001`, `refill:WF-10001:1`. */
  key: string
  to: string
  subject: string
  html: string
  text?: string
  /** Free-form category for the admin list, e.g. 'order-confirmation'. */
  type?: string
  /** Order id this message is about (relationship on the log row). */
  order?: number | string | null
  /** Either req (preferred inside endpoints/hooks) or a Payload instance (scripts/jobs). */
  req?: PayloadRequest
  payload?: Payload
  /** Re-claim a row stuck in 'pending' after this long. Default 15 minutes. */
  staleAfterMs?: number
  /** Optional sender override (defaults to EMAIL_FROM). */
  from?: string
  /**
   * Optional extra MIME headers, passed through to nodemailer. Marketing emails use it for
   * `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click unsubscribe).
   */
  headers?: Record<string, string>
}

export type SendOnceResult = 'sent' | 'duplicate' | 'failed'

/**
 * The claim insert hit the unique `key` index (Payload ValidationError on 'key'). Not by `err.name`: the
 * production build minifies class names ('ValidationError' → 'u'). instanceof, or the same shape (400 +
 * data.errors[].path) for an error from a second bundled copy of the payload module.
 */
const isUniqueKeyViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; data?: { errors?: unknown } | null }
  if (!(err instanceof ValidationError) && e.status !== 400) return false
  const errors = e.data?.errors
  return Array.isArray(errors) && errors.some((x) => Boolean(x) && typeof x === 'object' && (x as { path?: unknown }).path === 'key')
}

type LogRow = { id: number | string }

async function claim(payload: Payload, args: SendOnceArgs, staleAfterMs: number): Promise<LogRow | null> {
  try {
    const row = await payload.create({
      collection: 'message-log',
      data: {
        key: args.key,
        type: args.type,
        to: args.to,
        subject: args.subject,
        order: args.order === undefined || args.order === null ? undefined : Number(args.order),
        status: 'pending',
        attempts: 1,
      },
      depth: 0,
      overrideAccess: true,
    })
    return { id: row.id }
  } catch (err) {
    if (!isUniqueKeyViolation(err)) throw err
  }
  // Existing row: re-claim it only if it failed or went stale while pending.
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString()
  const reclaimed = (await payload.db.updateOne({
    collection: 'message-log',
    where: {
      and: [
        { key: { equals: args.key } },
        {
          or: [
            { status: { equals: 'failed' } },
            { and: [{ status: { equals: 'pending' } }, { updatedAt: { less_than: staleBefore } }] },
          ],
        },
      ],
    },
    data: { status: 'pending', attempts: { $inc: 1 }, updatedAt: new Date().toISOString(), error: null },
    options: { atomic: true },
  })) as LogRow | null
  return reclaimed ? { id: reclaimed.id } : null
}

export async function sendOnce(args: SendOnceArgs): Promise<SendOnceResult> {
  const payload = args.req?.payload ?? args.payload
  if (!payload) throw new Error('sendOnce: pass req or payload')
  if (!args.key || !args.to) throw new Error('sendOnce: key and to are required')

  const row = await claim(payload, args, args.staleAfterMs ?? 15 * 60 * 1000)
  if (!row) return 'duplicate'

  try {
    await payload.sendEmail({
      to: args.to,
      subject: args.subject,
      html: args.html,
      ...(args.text ? { text: args.text } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.headers && Object.keys(args.headers).length ? { headers: args.headers } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    payload.logger.error({ err, msg: `sendOnce: sending "${args.key}" failed` })
    await payload.db.updateOne({
      collection: 'message-log',
      id: row.id,
      data: { status: 'failed', error: message.slice(0, 500), updatedAt: new Date().toISOString() },
      returning: false,
    })
    return 'failed'
  }

  const now = new Date().toISOString()
  await payload.db.updateOne({
    collection: 'message-log',
    id: row.id,
    data: { status: 'sent', sentAt: now, updatedAt: now, error: null },
    returning: false,
  })
  return 'sent'
}
