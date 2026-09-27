import { ValidationError } from 'payload'
import { describe, expect, it } from 'vitest'

import { Products } from '@/collections/Products'
import { parseStockAdjust, productStockBeforeChange, STOCK_ADJUST_MAX } from '@/lib/productStock'

type AnyField = { name?: string; type?: string; fields?: AnyField[]; tabs?: { fields: AnyField[] }[]; [k: string]: unknown }

function findField(fields: AnyField[], name: string): AnyField | undefined {
  for (const f of fields) {
    if (f.name === name) return f
    const nested = f.fields ?? f.tabs?.flatMap((t) => t.fields)
    const hit = nested && findField(nested, name)
    if (hit) return hit
  }
  return undefined
}

describe('parseStockAdjust', () => {
  it('empty-ish → 0; whole numbers (also as strings) within ±1,000,000 → the number', () => {
    for (const v of [null, undefined, '', 0]) expect(parseStockAdjust(v)).toBe(0)
    expect(parseStockAdjust(20)).toBe(20)
    expect(parseStockAdjust(-3)).toBe(-3)
    expect(parseStockAdjust(' 7 ')).toBe(7)
    expect(parseStockAdjust(STOCK_ADJUST_MAX)).toBe(STOCK_ADJUST_MAX)
  })

  it('anything else is a ValidationError on stockAdjust', () => {
    for (const v of [1.5, 'ten', NaN, Infinity, STOCK_ADJUST_MAX + 1, -STOCK_ADJUST_MAX - 1, {}, [], true]) {
      let err: unknown
      try {
        parseStockAdjust(v)
      } catch (e) {
        err = e
      }
      expect(err, String(v)).toBeInstanceOf(ValidationError)
      expect(err).toMatchObject({ status: 400, data: { errors: [{ path: 'stockAdjust' }] } })
    }
  })
})

describe('productStockBeforeChange on create (no DB)', () => {
  const run = (data: Record<string, unknown>) =>
    productStockBeforeChange({ data, operation: 'create', req: { context: {} }, context: {} } as never)

  it('adds stockAdjust to the opening stock and strips the virtual fields', async () => {
    expect(await run({ stock: 5, stockAdjust: 10, stockOnHand: 99 })).toEqual({ stock: 15 })
    expect(await run({ stockAdjust: 3 })).toEqual({ stock: 3 })
    expect(await run({ stock: 4 })).toEqual({ stock: 4 })
  })

  it('refuses to open below zero', async () => {
    await expect(run({ stock: 2, stockAdjust: -3 })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('Products stock fields', () => {
  const fields = Products.fields as AnyField[]

  it('stock is kept out of the admin form; the live value is shown read-only; ±N is virtual', () => {
    const stock = findField(fields, 'stock')!
    expect((stock.admin as { disabled?: boolean }).disabled).toBe(true)
    const onHand = findField(fields, 'stockOnHand')!
    expect(onHand).toMatchObject({ type: 'number', virtual: true })
    expect((onHand.admin as { readOnly?: boolean }).readOnly).toBe(true)
    const adjust = findField(fields, 'stockAdjust')!
    expect(adjust).toMatchObject({ type: 'number', virtual: true })
    // Editable in the admin: Payload forces virtual fields read-only unless admin.readOnly is exactly false.
    expect((adjust.admin as { readOnly?: boolean }).readOnly).toBe(false)
    // afterRead-empty: the form always opens blank.
    const afterRead = (adjust.hooks as { afterRead: ((a: unknown) => unknown)[] }).afterRead
    expect(afterRead[0]({ value: 7 })).toBeNull()
    expect(Products.hooks?.beforeChange).toContain(productStockBeforeChange)
    expect(Products.admin?.defaultColumns).toContain('stockOnHand')
  })
})
