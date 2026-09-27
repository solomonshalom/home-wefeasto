import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { loginSlotCount } from '@/auth/loginSessions'
import { getEnv } from '@/env'

import { createCustomer } from './helpers/factories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * Hunt round 2 (cms-platform, auth): serialised REST logins (src/auth/loginSessions.ts) pin a pool
 * connection each, and a wrong password needs a second one (Payload's incrementLoginAttempts runs without
 * req). As many concurrent wrong-password logins as the pool has connections used to deadlock the pool
 * for connectionTimeoutMillis (30 s), stalling every other request; now at most ⌊(max − 1) / 2⌋ logins
 * hold a transaction at once.
 */

let payload: Payload
const POOL = getEnv().databasePoolMax // 20 in the int env

beforeAll(async () => {
  payload = await getTestPayload()
})

describe('wrong-password login bursts never exhaust the DB pool', () => {
  it(`${POOL} concurrent wrong-password logins all answer 401 quickly, and other requests are not stalled`, async () => {
    expect(loginSlotCount(POOL)).toBeLessThan(POOL / 2)
    const emails = await Promise.all(Array.from({ length: POOL }, async () => (await createCustomer(payload, { email: uniqueEmail('r2-pool') })).email))

    const t0 = Date.now()
    const timed = <T>(p: Promise<T>) => p.then((r) => ({ r, ms: Date.now() - t0 }))
    const logins = emails.map((email) =>
      timed(restPost('customers/login', { body: { email, password: 'not-the-password-1' }, origin: STOREFRONT_ORIGIN })),
    )
    await new Promise((r) => setTimeout(r, 100))
    const other = timed(restGet('store/catalog'))
    const [done, catalog] = await Promise.all([Promise.all(logins), other])

    const summary = `${done.map((d) => `${d.r.status}@${d.ms}`).join(' ')} | catalog ${catalog.r.status}@${catalog.ms}`
    expect(done.map((d) => d.r.status), summary).toEqual(Array(POOL).fill(401))
    expect(Math.max(...done.map((d) => d.ms)), summary).toBeLessThan(15_000)
    expect(catalog.r.status).toBe(200)
    expect(catalog.ms, summary).toBeLessThan(15_000)
  })

  it('correct-password logins of one account still serialise and all keep their session', async () => {
    const c = await createCustomer(payload, { email: uniqueEmail('r2-same') })
    const res = await Promise.all(Array.from({ length: 6 }, () => restPost('customers/login', { body: { email: c.email, password: c.password }, origin: STOREFRONT_ORIGIN })))
    expect(res.map((r) => r.status)).toEqual(Array(6).fill(200))
    const doc = await payload.findByID({ collection: 'customers', id: c.id, depth: 0, showHiddenFields: true })
    expect((doc as { sessions?: unknown[] }).sessions?.length).toBe(6)
  })
})
