import { sql } from '@payloadcms/db-postgres'
import type { PostgresAdapter } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  createLocalReq,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
  type RequestContext,
  ValidationError,
} from 'payload'

/**
 * Transactions and row locks for the checkout domain (Postgres only).
 *
 * Every order mutation runs as   inTransaction(payload, async (req) => { await lockOrder(req, id); … })
 * so concurrent writers of one order (client verify, redirect callback, webhook, reconcile, retry) are
 * serialised on the order row and each sees the previous one's committed result. Array fields
 * (attempts, payments, refunds, history) are rewritten as a whole by payload.update, so the lock is what
 * keeps them from losing updates.
 *
 * Lock order (deadlock avoidance), everywhere: orders (ascending id) → products (ascending id) →
 * coupons → counters. Claim-style inserts that may hit a unique index (payment-events, message-log) run
 * OUTSIDE these transactions: a unique violation aborts a Postgres transaction.
 */

/** Context flag on every write made by checkout code (the Orders admin-effects hook skips those). */
export const CHECKOUT_CONTEXT = 'wfCheckout'

export async function newReq(payload: Payload, context: RequestContext = {}): Promise<PayloadRequest> {
  return createLocalReq({ context: { [CHECKOUT_CONTEXT]: true, ...context } }, payload)
}

/** The drizzle handle for req's transaction (or the pool when there is none). */
export async function sessionDb(req: Partial<PayloadRequest> & { payload: Payload }) {
  const adapter = req.payload.db as unknown as PostgresAdapter
  const id = req.transactionID ? await req.transactionID : undefined
  return (id !== undefined && adapter.sessions?.[id as string]?.db) || adapter.drizzle
}

/** Postgres table name of a collection (e.g. 'coupon-redemptions' → 'coupon_redemptions'). */
export function tableOf(payload: Payload, slug: string): string {
  const adapter = payload.db as unknown as PostgresAdapter
  const name = adapter.tableNameMap?.get(slug.replace(/-/g, '_')) ?? slug.replace(/-/g, '_')
  return name
}

/** SELECT … FOR UPDATE on one row of `slug` inside req's transaction. Returns false when the row is missing. */
export async function lockRow(req: PayloadRequest, slug: string, id: number | string): Promise<boolean> {
  if (!req.transactionID) throw new Error(`lockRow(${slug}): no transaction on req`)
  const db = await sessionDb(req)
  const table = tableOf(req.payload, slug)
  const res = (await db.execute(sql`SELECT "id" FROM ${sql.identifier(table)} WHERE "id" = ${Number(id)} FOR UPDATE`)) as unknown as {
    rows?: unknown[]
  }
  return Boolean(res?.rows?.length)
}

/**
 * Transaction-scoped advisory locks on arbitrary keys (e.g. `cod-open:+91…`), for rules that span rows that
 * don't exist yet ("at most N open COD orders per phone"): two checkouts for the same key run one after the
 * other, and the second one's count sees the first one's committed order. Keys are taken in sorted order, and
 * only at the START of a checkout transaction (before any row lock), so they can't join a lock cycle with the
 * row-lock order below. Released at commit/rollback.
 */
export async function lockKeys(req: PayloadRequest, keys: string[]): Promise<void> {
  if (!req.transactionID) throw new Error('lockKeys: no transaction on req')
  const db = await sessionDb(req)
  for (const key of [...new Set(keys)].sort()) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wf:${key}`}, 0))`)
  }
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } }
  const code = e?.code ?? e?.cause?.code
  return typeof code === 'string' ? code : undefined
}

/** Deadlock (40P01) or serialization failure (40001): safe to retry the whole transaction. */
export const isRetryableTxError = (err: unknown): boolean => ['40P01', '40001'].includes(pgCode(err) ?? '')

type FieldErrors = { status?: unknown; data?: { errors?: { path?: string | null }[] } }

/**
 * A Payload ValidationError, detected by class or by shape (status 400 + data.errors[]).
 *
 * Never by `err.name`: APIError sets `this.name = this.constructor.name`, and the minified production build
 * renames the class (the name arrives as e.g. 'u'), so a name check passes in dev and in the unminified tests
 * and fails only after `next build`. The shape check also covers a second copy of the payload module (a
 * different class identity).
 */
export function isPayloadValidationError(err: unknown): boolean {
  if (err instanceof ValidationError) return true
  const e = err as FieldErrors
  return e?.status === 400 && Array.isArray(e.data?.errors)
}

const snakeCase = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/**
 * A unique-index violation, as Payload reports it (a ValidationError on `path`; the drizzle adapter names the
 * field, or the column when it can't map the constraint) or raw from Postgres (23505).
 */
export function isUniqueViolation(err: unknown, path?: string): boolean {
  if (isPayloadValidationError(err)) {
    const errors = (err as FieldErrors).data?.errors ?? []
    if (!path) return errors.length > 0
    const column = snakeCase(path)
    return errors.some((x) => x?.path === path || x?.path === column)
  }
  return pgCode(err) === '23505'
}

/**
 * Runs `fn` inside a fresh transaction on a new Local-API req (context flag CHECKOUT_CONTEXT set) and
 * commits it; any throw rolls back and is re-thrown. Deadlocks/serialization failures are retried.
 */
export async function inTransaction<T>(
  payload: Payload,
  fn: (req: PayloadRequest) => Promise<T>,
  { context = {}, retries = 2 }: { context?: RequestContext; retries?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const req = await newReq(payload, context)
    await initTransaction(req)
    try {
      const out = await fn(req)
      await commitTransaction(req)
      return out
    } catch (err) {
      await killTransaction(req)
      if (attempt < retries && isRetryableTxError(err)) {
        await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)))
        continue
      }
      throw err
    }
  }
}
