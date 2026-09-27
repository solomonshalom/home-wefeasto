import { sql } from '@payloadcms/db-postgres'
import { type CollectionBeforeChangeHook, type PayloadRequest, ValidationError } from 'payload'

import { sessionDb, tableOf } from '../commerce/checkout/db'

/**
 * Product stock is operational state, not content: orders reserve and release it concurrently with admin
 * edits. A Payload update writes the WHOLE document, including the `stock` it read when the operation (or
 * the admin form) started, so a plain save could write back a stale number and silently undo reservations
 * made in between (lost update → oversell). This hook makes every product update stock-safe:
 *
 *   1. Lock the product row (SELECT … FOR UPDATE in the update's transaction) and read the live stock.
 *      Concurrent reservations (src/commerce/checkout/stock.ts) wait for this save, or this save waits for
 *      them; either way nothing is lost. The save takes FOR UPDATE on its row anyway (Payload writes the row
 *      with INSERT … ON CONFLICT DO UPDATE, which locks FOR UPDATE because its SET list has key columns), so
 *      the lock is taken up front, not upgraded later.
 *      The products it links to (goesWith) get FOR KEY SHARE, the lock the foreign-key checks take when the
 *      save rewrites products_rels / _products_v_rels, and ALL of these are taken in ascending id order.
 *      Otherwise two saves of products linked to each other deadlock: each holds its own row FOR UPDATE and
 *      its FK check waits for the other's (HUNT-CONC-3). KEY SHARE does not block checkout's stock updates.
 *   2. An absolute `stock` different from both the stock this operation started from and the live stock is
 *      REJECTED (400 ValidationError on `stock`), unless `context.allowStockSet` (seed, tests, scripts).
 *      A stock value that was merely carried along (unchanged, or stale) is ignored.
 *   3. `stockAdjust` (virtual, never stored): ±N packs, applied with one atomic conditional
 *      `payload.db.updateOne({ atomic: true, $inc })` that can never take stock below 0 (400 on
 *      `stockAdjust` when it would), mirrored onto the latest version row like checkout's stock.ts.
 *   4. `data.stock` is set to the exact post-adjust value, so the main row and the new version row agree.
 *   Restoring an old version keeps the live stock.
 *
 * On create, `stock` (default 0) plus `stockAdjust` is the opening stock.
 */

export const ALLOW_STOCK_SET = 'allowStockSet'
export const STOCK_ADJUST_MAX = 1_000_000

const stockError = (path: 'stock' | 'stockAdjust', message: string) =>
  new ValidationError({ collection: 'products', errors: [{ path, message }] })

/** null/''/0 → 0; a whole number within ±1,000,000 → it; anything else → ValidationError. */
export function parseStockAdjust(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || Math.abs(n) > STOCK_ADJUST_MAX) {
    throw stockError('stockAdjust', 'Enter a whole number of packs, e.g. 20 to add or -3 to remove.')
  }
  return n
}

const asStock = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v == null ? null : Number(v))

const relIdOf = (v: unknown): number | null => {
  const id = v && typeof v === 'object' && 'id' in (v as object) ? (v as { id: unknown }).id : v
  const n = typeof id === 'string' && id.trim() !== '' ? Number(id) : id
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null
}

/** Product ids this save's relationship rows will point at (goesWith), without `self`, ascending. */
export function linkedProductIds(goesWith: unknown, self: number | string): number[] {
  const ids = (Array.isArray(goesWith) ? goesWith : []).map(relIdOf).filter((n): n is number => n !== null && n !== Number(self))
  return [...new Set(ids)].sort((a, b) => a - b)
}

/**
 * Locks, in ascending id order: linked products FOR KEY SHARE, this product FOR UPDATE (returning its live
 * stock). null when this product's row is gone.
 */
async function lockLiveStock(req: PayloadRequest, id: number | string, linked: number[] = []): Promise<number | null> {
  const db = await sessionDb(req)
  const table = sql.identifier(tableOf(req.payload, 'products'))
  const self = Number(id)
  const keyShare = async (ids: number[]) => {
    if (!ids.length) return
    await db.execute(sql`SELECT "id" FROM ${table} WHERE "id" IN (${sql.join(ids.map((n) => sql`${n}`), sql`, `)}) ORDER BY "id" FOR KEY SHARE`)
  }
  await keyShare(linked.filter((n) => n < self))
  const res = (await db.execute(sql`SELECT "stock" FROM ${table} WHERE "id" = ${self} FOR UPDATE`)) as unknown as {
    rows?: { stock: unknown }[]
  }
  await keyShare(linked.filter((n) => n > self))
  const row = res?.rows?.[0]
  return row ? Number(row.stock ?? 0) : null
}

async function mirrorLatestVersion(req: PayloadRequest, id: number | string, delta: number): Promise<void> {
  const db = await sessionDb(req)
  const table = tableOf(req.payload, 'products')
  await db.execute(
    sql`UPDATE ${sql.identifier(`_${table}_v`)} SET "version_stock" = GREATEST(COALESCE("version_stock", 0) + ${delta}, 0)
        WHERE "parent_id" = ${Number(id)} AND "latest" = true`,
  )
}

/** Atomic ±delta on the live row (never below 0) + the latest version row. false when it would go negative. */
export async function applyStockDelta(req: PayloadRequest, id: number | string, delta: number): Promise<boolean> {
  if (!delta) return true
  const row = await req.payload.db.updateOne({
    collection: 'products',
    where: { and: [{ id: { equals: id } }, { stock: { greater_than_equal: Math.max(0, -delta) } }] },
    data: { stock: { $inc: delta } },
    options: { atomic: true },
    req,
  })
  if (!row) return false
  await mirrorLatestVersion(req, id, delta)
  return true
}

export const productStockBeforeChange: CollectionBeforeChangeHook = async ({ data, operation, originalDoc, req }) => {
  if (!data) return data
  const adjust = parseStockAdjust(data.stockAdjust)
  delete data.stockAdjust
  delete data.stockOnHand

  if (operation === 'create') {
    if (adjust) {
      const base = asStock(data.stock) ?? 0
      // An invalid opening stock is left to the field validator (path `stock`).
      if (Number.isSafeInteger(base) && base + adjust < 0) {
        throw stockError('stockAdjust', `You can't remove ${-adjust} packs: the opening stock is ${base}.`)
      }
      data.stock = base + adjust
    }
    return data
  }

  const id = originalDoc?.id
  if (operation !== 'update' || id === undefined || id === null) return data
  const goesWith = data.goesWith !== undefined ? data.goesWith : originalDoc?.goesWith
  const live = await lockLiveStock(req, id, linkedProductIds(goesWith, id))
  if (live === null) return data // the row is gone; Payload reports the missing document itself

  const allowSet = Boolean(req.context?.[ALLOW_STOCK_SET])
  const restoring = Boolean(req.context?.isRestoringVersion)
  const sent = asStock(data.stock)
  const startedFrom = asStock(originalDoc?.stock)
  // After Payload's merge, data.stock is the value this operation started from unless the caller sent one.
  const explicit = !restoring && sent !== null && (startedFrom === null || sent !== startedFrom)

  let target = live
  if (explicit && sent !== live) {
    if (!allowSet) {
      throw stockError(
        'stock',
        `Stock can't be set to a number directly (it is ${live} right now and orders change it). Use "Adjust stock by" with +N or -N packs.`,
      )
    }
    if (!Number.isSafeInteger(sent) || (sent as number) < 0) {
      throw stockError('stock', 'Enter a whole number of packs (0 or more).')
    }
    target = sent as number
  }
  if (adjust) {
    if (target + adjust < 0) {
      throw stockError('stockAdjust', `Only ${target} in stock: you can remove at most ${target}.`)
    }
    target += adjust
  }
  if (target !== live && !(await applyStockDelta(req, id, target - live))) {
    // Unreachable while the row lock is held; kept for callers without a transaction.
    throw stockError('stockAdjust', 'Stock changed while saving. Reload the page and try again.')
  }
  data.stock = target
  return data
}
