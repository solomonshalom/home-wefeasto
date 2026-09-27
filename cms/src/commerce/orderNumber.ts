import { sql } from '@payloadcms/db-postgres'
import type { PostgresAdapter } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'

/**
 * Sequential order numbers WF-10001, WF-10002, … from the `counters` collection.
 *
 * The increment is one atomic `UPDATE counters SET value = value + 1 WHERE name = $1 RETURNING *`
 * executed on the caller's transaction (pass the same `req`), so:
 *   - concurrent checkouts serialise on the counter row and always get distinct numbers;
 *   - a rolled-back checkout gives its number back (no gaps from failed attempts);
 *   - the row lock is held until the caller commits: keep checkout transactions short.
 * A missing counter row is created with INSERT … ON CONFLICT DO NOTHING on the same transaction
 * (a plain insert racing a unique index would abort the caller's whole Postgres transaction).
 */

export const ORDER_NUMBER_PREFIX = 'WF-'
export const ORDER_COUNTER = 'orders'
/** The counter's stored value before the first order; the first number is START + 1 = 10001. */
export const ORDER_COUNTER_START = 10000

export function formatOrderNumber(value: number): string {
  return `${ORDER_NUMBER_PREFIX}${value}`
}

/** Inverse of formatOrderNumber; null for anything that is not WF-<digits>. */
export function parseOrderNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /^WF-(\d{5,12})$/.exec(value.trim().toUpperCase())
  return m ? Number(m[1]) : null
}

async function drizzleFor(payload: Payload, req?: Partial<PayloadRequest>) {
  const adapter = payload.db as unknown as PostgresAdapter
  const id = req?.transactionID ? await req.transactionID : undefined
  return (id !== undefined && adapter.sessions?.[id]?.db) || adapter.drizzle
}

/** Creates the counter row if it does not exist. Safe under concurrency and inside transactions. */
export async function ensureCounter(
  payload: Payload,
  name: string,
  start: number,
  req?: Partial<PayloadRequest>,
): Promise<void> {
  const db = await drizzleFor(payload, req)
  await db.execute(
    sql`INSERT INTO "counters" ("name", "value", "updated_at", "created_at") VALUES (${name}, ${start}, now(), now()) ON CONFLICT ("name") DO NOTHING`,
  )
}

/** Atomically increments counter `name` inside req's transaction and returns the new value. */
export async function nextCounterValue(req: PayloadRequest, name: string, start = 0): Promise<number> {
  const bump = () =>
    req.payload.db.updateOne({
      collection: 'counters',
      where: { name: { equals: name } },
      data: { value: { $inc: 1 } },
      options: { atomic: true },
      req,
    }) as Promise<{ value?: number | string } | null>

  let row = await bump()
  if (!row) {
    await ensureCounter(req.payload, name, start, req)
    row = await bump()
  }
  const value = Number(row?.value)
  if (!row || !Number.isSafeInteger(value)) throw new Error(`Counter "${name}" could not be incremented`)
  return value
}

/** Next order number, e.g. 'WF-10001'. Call with the checkout transaction's `req`. */
export async function nextOrderNumber(req: PayloadRequest): Promise<string> {
  return formatOrderNumber(await nextCounterValue(req, ORDER_COUNTER, ORDER_COUNTER_START))
}
