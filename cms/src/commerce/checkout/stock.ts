import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { sessionDb, tableOf } from './db'

/**
 * Stock reservations (SPEC §0 "Stock"). Every change is ONE conditional UPDATE on the product row
 * (payload.db.updateOne with atomic:true → `UPDATE products SET stock = stock - q WHERE id = ? AND stock >= q`),
 * joined to req's transaction, so stock can never go below 0 and concurrent checkouts serialise on the row.
 * Lines are always processed in ascending product id (deadlock-free with any other multi-line writer).
 *
 * Products have drafts, and Payload merges every later edit (admin UI or Local API update) onto the
 * LATEST VERSION row, not the main table. A reservation that only touched the main table would be undone
 * by the next edit of the product (the stale `version_stock` would be written back). So each change is
 * mirrored onto the product's latest version row in the same transaction.
 */

export type StockLine = { productId: number | string; slug: string; qty: number }

const sorted = (lines: StockLine[]) =>
  [...lines].filter((l) => l.qty > 0).sort((a, b) => Number(a.productId) - Number(b.productId))

async function mirrorVersion(req: PayloadRequest, productId: number | string, delta: number): Promise<void> {
  const db = await sessionDb(req)
  const table = tableOf(req.payload, 'products')
  await db.execute(
    sql`UPDATE ${sql.identifier(`_${table}_v`)} SET "version_stock" = GREATEST(COALESCE("version_stock", 0) + ${delta}, 0)
        WHERE "parent_id" = ${Number(productId)} AND "latest" = true`,
  )
}

/** Atomically takes `qty` of one product if at least that much is in stock. */
export async function takeStock(req: PayloadRequest, productId: number | string, qty: number): Promise<boolean> {
  const row = await req.payload.db.updateOne({
    collection: 'products',
    where: { and: [{ id: { equals: productId } }, { stock: { greater_than_equal: qty } }] },
    data: { stock: { $inc: -qty } },
    options: { atomic: true },
    req,
  })
  if (!row) return false
  await mirrorVersion(req, productId, -qty)
  return true
}

/** Puts `qty` back (release after expiry/cancel, or compensation). */
export async function returnStock(req: PayloadRequest, productId: number | string, qty: number): Promise<void> {
  await req.payload.db.updateOne({
    collection: 'products',
    where: { id: { equals: productId } },
    data: { stock: { $inc: qty } },
    options: { atomic: true },
    req,
  })
  await mirrorVersion(req, productId, qty)
}

/**
 * Reserves every line or none: on the first line that cannot be served, the lines already taken are
 * given back (inside the same transaction) and the failing line is reported.
 */
export async function reserveLines(
  req: PayloadRequest,
  lines: StockLine[],
): Promise<{ ok: true } | { ok: false; failed: StockLine }> {
  const done: StockLine[] = []
  for (const line of sorted(lines)) {
    if (await takeStock(req, line.productId, line.qty)) {
      done.push(line)
      continue
    }
    for (const d of done) await returnStock(req, d.productId, d.qty)
    return { ok: false, failed: line }
  }
  return { ok: true }
}

export async function releaseLines(req: PayloadRequest, lines: StockLine[]): Promise<void> {
  for (const line of sorted(lines)) await returnStock(req, line.productId, line.qty)
}

/** Order items → stock lines (items without a product relation cannot be reserved and are skipped). */
export function orderStockLines(order: { items?: { product?: unknown; slug: string; qty: number }[] | null }): StockLine[] {
  const lines: StockLine[] = []
  for (const it of order.items ?? []) {
    const p = it.product as number | { id: number } | null | undefined
    const productId = p && typeof p === 'object' ? p.id : p
    if (productId) lines.push({ productId, slug: it.slug, qty: it.qty })
  }
  return lines
}

/**
 * An order that ENDED before its goods left (cancelled, or refunded in full) while still holding stock:
 * fulfilment unfulfilled/packed and stock reserved or committed. Its lines go back on the shelf, the same rule
 * for an admin cancel, an admin Status → refunded and a refund webhook / Dashboard refund (hunt w5 r2).
 */
export function holdsUnshippedStock(order: { fulfilmentStatus?: string | null; stockState?: string | null }): boolean {
  const unshipped = order.fulfilmentStatus === 'unfulfilled' || order.fulfilmentStatus === 'packed'
  return unshipped && (order.stockState === 'reserved' || order.stockState === 'committed')
}
