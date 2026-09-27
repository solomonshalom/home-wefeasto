/**
 * Serialised REST logins never exhaust the DB pool (src/auth/loginSessions.ts + src/lib/slots.ts).
 *
 * A serialised login pins one pool connection for its transaction, and a wrong password needs a second one
 * (Payload's incrementLoginAttempts runs without req). With every connection held that way the pool
 * deadlocks for connectionTimeoutMillis, so only ⌊(max − 1) / 2⌋ logins may hold a transaction at once.
 */
import { describe, expect, it } from 'vitest'

import { loginSlotCount } from '@/auth/loginSessions'
import { Slots } from '@/lib/slots'

describe('loginSlotCount', () => {
  it('leaves room for every slot holder’s second connection plus other traffic', () => {
    for (const max of [1, 2, 3, 4, 5, 10, 20, 50]) {
      const k = loginSlotCount(max)
      // k holders + k second connections < max: at least one connection is never pinned by a login.
      expect(2 * k, `pool ${max}`).toBeLessThan(max)
    }
    expect([1, 2, 3, 10, 20].map(loginSlotCount)).toEqual([0, 0, 1, 4, 9])
    expect([0, -3, 2.5, Number.NaN].map(loginSlotCount)).toEqual([0, 0, 0, 0])
  })
})

describe('Slots', () => {
  it('grants up to size at once, then queues first-come-first-served', async () => {
    const s = new Slots(2)
    const a = await s.acquire(1000)
    const b = await s.acquire(1000)
    expect(s.inUse).toBe(2)
    const order: string[] = []
    const c = s.acquire(1000).then((r) => (order.push('c'), r))
    const d = s.acquire(1000).then((r) => (order.push('d'), r))
    expect(s.waiting).toBe(2)
    a!()
    const rc = await c
    b!()
    const rd = await d
    expect(order).toEqual(['c', 'd'])
    expect(s.inUse).toBe(2)
    rc!()
    rd!()
    expect(s.inUse).toBe(0)
    expect(s.waiting).toBe(0)
  })

  it('a release is one-shot (a double release never frees a slot twice)', async () => {
    const s = new Slots(1)
    const r = await s.acquire(100)
    r!()
    r!()
    expect(s.inUse).toBe(0)
    const again = await s.acquire(100)
    expect(s.inUse).toBe(1)
    expect(await s.acquire(20)).toBeNull()
    again!()
  })

  it('gives up after the timeout and drops out of the queue', async () => {
    const s = new Slots(1)
    const held = await s.acquire(100)
    const t0 = Date.now()
    expect(await s.acquire(40)).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30)
    expect(s.waiting).toBe(0)
    held!()
    expect(s.inUse).toBe(0)
  })

  it('size 0 never grants', async () => {
    expect(await new Slots(0).acquire(10)).toBeNull()
  })
})
