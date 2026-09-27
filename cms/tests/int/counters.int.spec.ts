import { commitTransaction, initTransaction, killTransaction, type Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { nextCounterValue, nextOrderNumber, parseOrderNumber } from '@/commerce/orderNumber'

import { makeReq, getTestPayload } from './helpers/payload'

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

/** Runs fn inside its own transaction on a fresh req; commits (or rolls back when rollback=true). */
async function inTransaction<T>(fn: (req: Awaited<ReturnType<typeof makeReq>>) => Promise<T>, rollback = false): Promise<T> {
  const req = await makeReq()
  await initTransaction(req)
  try {
    const result = await fn(req)
    if (rollback) await killTransaction(req)
    else await commitTransaction(req)
    return result
  } catch (err) {
    await killTransaction(req)
    throw err
  }
}

describe('order numbers', () => {
  it('50 concurrent transactions get 50 distinct, consecutive WF- numbers', async () => {
    const before = await inTransaction((req) => nextOrderNumber(req))
    const start = parseOrderNumber(before)!
    const numbers = await Promise.all(Array.from({ length: 50 }, () => inTransaction((req) => nextOrderNumber(req))))
    expect(new Set(numbers).size).toBe(50)
    const values = numbers.map((n) => parseOrderNumber(n)!).sort((a, b) => a - b)
    expect(values[0]).toBe(start + 1)
    expect(values[49]).toBe(start + 50)
    for (const n of numbers) expect(n).toMatch(/^WF-\d{5}$/)
  })

  it('a rolled-back transaction gives its number back', async () => {
    const a = await inTransaction((req) => nextOrderNumber(req))
    const rolledBack = await inTransaction((req) => nextOrderNumber(req), true)
    const b = await inTransaction((req) => nextOrderNumber(req))
    expect(parseOrderNumber(rolledBack)).toBe(parseOrderNumber(a)! + 1)
    expect(b).toBe(rolledBack)
  })

  it('creates a missing counter inside the caller transaction, even under concurrency', async () => {
    const name = `test-counter-${Date.now()}`
    const values = await Promise.all(Array.from({ length: 20 }, () => inTransaction((req) => nextCounterValue(req, name, 500))))
    expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => 501 + i))
  })

  it('works without a transaction (autocommit)', async () => {
    const req = await makeReq()
    const n1 = parseOrderNumber(await nextOrderNumber(req))!
    const n2 = parseOrderNumber(await nextOrderNumber(req))!
    expect(n2).toBe(n1 + 1)
  })

  it('the orders counter exists after boot and starts at 10000', async () => {
    const { docs } = await payload.find({ collection: 'counters', where: { name: { equals: 'orders' } } })
    expect(docs).toHaveLength(1)
    expect(docs[0].value).toBeGreaterThanOrEqual(10000)
  })
})
