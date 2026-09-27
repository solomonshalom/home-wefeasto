import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { inTransaction, sessionDb } from '@/commerce/checkout/db'
import { returnStock, takeStock } from '@/commerce/checkout/stock'
import { ALLOW_STOCK_SET } from '@/lib/productStock'

import { createProduct } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPatch } from './helpers/rest'

/**
 * cms-hardening §2: an admin save can never undo stock reservations (lost update → oversell).
 * `stock` is read-only in the admin; `stockAdjust` (virtual) changes it atomically by ±N.
 */

let payload: Payload
let editorToken: string
let editor: Awaited<ReturnType<typeof createStaff>>

beforeAll(async () => {
  payload = await getTestPayload()
  editor = await createStaff(payload, 'editor')
  editorToken = (await login('users', editor.email)).token
})

const fresh = (stock = 50) => createProduct(payload, { stock })

/** Live stock (main row) and the latest version row's stock. */
async function stockRows(id: number): Promise<{ live: number; version: number | null }> {
  const db = await sessionDb({ payload })
  const main = (await db.execute(sql`SELECT stock FROM products WHERE id = ${id}`)) as unknown as { rows: { stock: number }[] }
  const ver = (await db.execute(
    sql`SELECT version_stock FROM _products_v WHERE parent_id = ${id} AND latest = true ORDER BY id DESC LIMIT 1`,
  )) as unknown as { rows: { version_stock: number | null }[] }
  const v = ver.rows[0]?.version_stock
  return { live: Number(main.rows[0].stock), version: v === null || v === undefined ? null : Number(v) }
}

const reserve = (id: number, qty: number) => inTransaction(payload, (req) => takeStock(req, id, qty))
const release = (id: number, qty: number) => inTransaction(payload, (req) => returnStock(req, id, qty))
const patch = (id: number, body: Record<string, unknown>) => restPatch(`products/${id}`, { token: editorToken, body, query: 'depth=0' })
const fieldErrors = (res: { body: any }) => res.body?.errors?.[0]?.data?.errors ?? []

type PauseHook = (args: { data?: Record<string, unknown>; req: { context?: Record<string, unknown> } }) => Promise<unknown>

/** Temporarily adds a collection hook to products (removed by the returned function). */
function addHook(kind: 'beforeValidate' | 'beforeChange', hook: PauseHook) {
  const hooks = payload.collections.products.config.hooks as unknown as Record<string, unknown[]>
  hooks[kind].push(hook)
  return () => {
    hooks[kind].splice(hooks[kind].indexOf(hook), 1)
  }
}

function gate() {
  let open!: () => void
  let reached!: () => void
  const opened = new Promise<void>((r) => (open = r))
  const arrived = new Promise<void>((r) => (reached = r))
  return { open, opened, reached, arrived }
}

describe('stock adjust by ±N', () => {
  it('adds and removes packs atomically; the response shows stockOnHand and an empty stockAdjust', async () => {
    const p = await fresh(50)
    const add = await patch(p.id, { stockAdjust: 20 })
    expect(add.status).toBe(200)
    expect(add.body.doc).toMatchObject({ stock: 70, stockOnHand: 70, stockAdjust: null })
    const remove = await patch(p.id, { stockAdjust: -3, pricePaise: 26900 })
    expect(remove.status).toBe(200)
    expect(remove.body.doc).toMatchObject({ stock: 67, pricePaise: 26900 })
    expect(await stockRows(p.id)).toEqual({ live: 67, version: 67 })
    // String input from a form works too; 0 / empty is a no-op.
    expect((await patch(p.id, { stockAdjust: '5' })).body.doc.stock).toBe(72)
    expect((await patch(p.id, { stockAdjust: 0 })).body.doc.stock).toBe(72)
    expect((await patch(p.id, { stockAdjust: null })).body.doc.stock).toBe(72)
  })

  it('never below 0: removing more than is on hand → 400 on stockAdjust, nothing changes', async () => {
    const p = await fresh(4)
    const res = await patch(p.id, { stockAdjust: -5, pricePaise: 29900 })
    expect(res.status).toBe(400)
    expect(fieldErrors(res)[0]).toMatchObject({ path: 'stockAdjust' })
    expect(fieldErrors(res)[0].message).toMatch(/at most 4/)
    const after = await payload.findByID({ collection: 'products', id: p.id })
    expect(after.stock).toBe(4)
    expect(after.pricePaise).toBe(p.pricePaise)
    expect((await patch(p.id, { stockAdjust: -4 })).body.doc.stock).toBe(0)
  })

  it('rejects junk adjustments (fractions, huge numbers, text)', async () => {
    const p = await fresh(10)
    for (const v of [1.5, 'ten', 2_000_000, -2_000_000]) {
      const res = await patch(p.id, { stockAdjust: v })
      expect(res.status, String(v)).toBe(400)
      expect(fieldErrors(res)[0].path).toBe('stockAdjust')
    }
    expect((await stockRows(p.id)).live).toBe(10)
  })

  it('on create, stockAdjust is added to the opening stock', async () => {
    const p = await createProduct(payload, { stock: 0, stockAdjust: 12 })
    expect(p.stock).toBe(12)
    await expect(createProduct(payload, { stock: 2, stockAdjust: -3 })).rejects.toMatchObject({ status: 400 })
  })

  it('stock fields stay invisible to customers and guests', async () => {
    const p = await fresh(9)
    const pub = await restGet(`products/${p.id}`)
    expect(pub.status).toBe(200)
    expect(pub.body.stock).toBeUndefined()
    expect(pub.body.stockOnHand).toBeUndefined()
    expect(pub.body.stockAdjust).toBeUndefined()
  })
})

describe('absolute stock writes', () => {
  it('REST: a stock number different from the live one → 400 on stock; the same number is a no-op', async () => {
    const p = await fresh(30)
    const res = await patch(p.id, { stock: 999, pricePaise: 30900 })
    expect(res.status).toBe(400)
    expect(fieldErrors(res)[0]).toMatchObject({ path: 'stock' })
    expect(fieldErrors(res)[0].message).toMatch(/Adjust stock by/)
    expect(await stockRows(p.id)).toEqual({ live: 30, version: 30 })
    const same = await patch(p.id, { stock: 30, pricePaise: 30900 })
    expect(same.status).toBe(200)
    expect(same.body.doc).toMatchObject({ stock: 30, pricePaise: 30900 })
  })

  it('Local API: rejected too, unless context.allowStockSet (seed, tests)', async () => {
    const p = await fresh(30)
    await expect(payload.update({ collection: 'products', id: p.id, data: { stock: 5 } })).rejects.toMatchObject({ status: 400 })
    const set = await payload.update({ collection: 'products', id: p.id, data: { stock: 5 }, context: { [ALLOW_STOCK_SET]: true } })
    expect(set.stock).toBe(5)
    expect(await stockRows(p.id)).toEqual({ live: 5, version: 5 })
    await expect(
      payload.update({ collection: 'products', id: p.id, data: { stock: -1 }, context: { [ALLOW_STOCK_SET]: true } }),
    ).rejects.toMatchObject({ status: 400 })
  })

})

describe('admin saves vs concurrent reservations (lost update)', () => {
  it('a save that read the product BEFORE a reservation committed does not write the stale stock back', async () => {
    const p = await fresh(50)
    const g = gate()
    // Pause the admin save after Payload has read the (then current) document, before it writes.
    const remove = addHook('beforeValidate', async ({ data, req }) => {
      if (req.context?.pauseStale) {
        g.reached()
        await g.opened
      }
      return data
    })
    try {
      const save = payload.update({
        collection: 'products',
        id: p.id,
        data: { pricePaise: 27900 },
        user: editor as never,
        overrideAccess: false,
        context: { pauseStale: true },
      })
      await g.arrived
      await reserve(p.id, 3) // commits while the save holds a stale copy (stock 50)
      expect((await stockRows(p.id)).live).toBe(47)
      g.open()
      const saved = await save
      expect(saved.pricePaise).toBe(27900)
      expect(saved.stock).toBe(47)
      expect(await stockRows(p.id)).toEqual({ live: 47, version: 47 })
    } finally {
      g.open()
      remove()
    }
  })

  it('a reservation arriving while an adjust holds the row waits for it; both apply', async () => {
    const p = await fresh(50)
    const g = gate()
    // Pause AFTER productStockBeforeChange locked the row and applied +10.
    const remove = addHook('beforeChange', async ({ data, req }) => {
      if (req.context?.pauseLocked) {
        g.reached()
        await g.opened
      }
      return data
    })
    try {
      const save = patchWithContext(p.id, { stockAdjust: 10 }, { pauseLocked: true })
      await g.arrived
      let reserved = false
      const reservation = reserve(p.id, 4).then((ok) => ((reserved = ok), ok))
      await new Promise((r) => setTimeout(r, 150))
      expect(reserved).toBe(false) // blocked on the row lock
      g.open()
      const [saved, ok] = await Promise.all([save, reservation])
      expect(saved.stock).toBe(60)
      expect(ok).toBe(true)
      expect(await stockRows(p.id)).toEqual({ live: 56, version: 56 })
    } finally {
      g.open()
      remove()
    }
  })

  it('storm: 40 reservations, 10 releases and 12 admin saves (6 adjusting) in parallel never lose a unit', async () => {
    const p = await fresh(200)
    const ops: Promise<unknown>[] = []
    let taken = 0
    for (let i = 0; i < 40; i++) ops.push(reserve(p.id, 2).then((ok) => ok && (taken += 2)))
    for (let i = 0; i < 10; i++) ops.push(release(p.id, 1))
    for (let i = 0; i < 12; i++) {
      const body: Record<string, unknown> = { pricePaise: 25000 + (i % 3) * 100 }
      if (i % 2 === 0) body.stockAdjust = i % 4 === 0 ? 5 : -5
      ops.push(patch(p.id, body).then((r) => expect(r.status, r.text).toBe(200)))
    }
    await Promise.all(ops)
    const adjusts = 3 * 5 - 3 * 5 // i=0,4,8 add 5; i=2,6,10 remove 5
    expect(taken).toBe(80)
    const expected = 200 - taken + 10 + adjusts
    expect(await stockRows(p.id)).toEqual({ live: expected, version: expected })
  })
})

/** Local-API update as the editor (REST semantics) with a request context. */
function patchWithContext(id: number, data: Record<string, unknown>, context: Record<string, unknown>) {
  return payload.update({ collection: 'products', id, data: data as never, user: editor as never, overrideAccess: false, context })
}
