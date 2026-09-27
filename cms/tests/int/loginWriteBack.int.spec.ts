import crypto from 'node:crypto'
import { initTransaction, killTransaction, commitTransaction, type Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { guardLoginSessionWrite, LOGIN_SESSION_WRITE } from '@/auth/accountWrites'

import { createCustomer, PASSWORD } from './helpers/factories'
import { getTestPayload, makeReq } from './helpers/payload'
import { restGet, restPatch, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * A login never undoes another write to the account (src/auth/accountWrites.ts; hunt r4 login-writeback).
 * Deterministic: replay login's "read → (other write commits) → append session" by hand against the real
 * adapter. End to end: overlapping REST sign-ins around a reset / a profile save.
 */

let payload: Payload
const cleanup: (() => Promise<unknown>)[] = []
beforeAll(async () => {
  payload = await getTestPayload()
})
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => {})
})

async function customer(extra: Record<string, unknown> = {}) {
  const c = await createCustomer(payload, { name: 'Old Name', phone: '+919800000001', ...extra })
  cleanup.push(() => payload.delete({ collection: 'customers', id: c.id }))
  return c
}
const login = (email: string, password = PASSWORD) =>
  restPost('customers/login', { body: { email, password }, origin: STOREFRONT_ORIGIN })
const stored = (id: number | string) => payload.db.findOne<any>({ collection: 'customers', where: { id: { equals: id } } })

/** What Payload's login does after checking the password against `read`: append a session to the stale row. */
async function appendLikeLogin(read: any) {
  const req = await makeReq()
  req.context = { [LOGIN_SESSION_WRITE]: 'customers' }
  guardLoginSessionWrite(payload.db as never)
  await initTransaction(req)
  const now = new Date()
  const session = { id: crypto.randomUUID(), createdAt: now, expiresAt: new Date(now.getTime() + 3_600_000) }
  const user = { ...read, collection: 'customers', _strategy: 'local-jwt', sessions: [...(read.sessions ?? []), session], updatedAt: null }
  try {
    await payload.db.updateOne({ id: read.id, collection: 'customers', data: user, req, returning: false })
    await commitTransaction(req)
    return session.id
  } catch (err) {
    await killTransaction(req)
    throw err
  }
}

describe('login session append vs other writes (deterministic)', () => {
  it('a password change committed after the login read refuses the login (401) and keeps the new password', async () => {
    const c = await customer()
    expect((await login(c.email)).status).toBe(200)
    const read = await stored(c.id)
    await payload.update({ collection: 'customers', id: c.id, data: { password: 'Brand-New-Passw0rd' } })
    await expect(appendLikeLogin(read)).rejects.toMatchObject({ status: 401 })
    expect((await login(c.email, 'Brand-New-Passw0rd')).status).toBe(200)
    expect((await login(c.email)).status).toBe(401)
  })

  it('writes only the sessions: a profile save committed meanwhile is kept, other sessions too', async () => {
    const c = await customer({ addresses: [{ line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' }] })
    const first = await login(c.email)
    const read = await stored(c.id)
    await payload.update({ collection: 'customers', id: c.id, data: { name: 'New Name', phone: '+919800000002' } })
    const sid = await appendLikeLogin(read)
    const after = await stored(c.id)
    expect({ name: after.name, phone: after.phone, hash: after.hash }).toEqual({ name: 'New Name', phone: '+919800000002', hash: read.hash })
    expect(after.addresses.map((a: { line1: string }) => a.line1)).toEqual(['12 MG Road'])
    expect(after.sessions.map((s: { id: string }) => s.id)).toEqual([...read.sessions.map((s: { id: string }) => s.id), sid])
    expect((await restGet('customers/me', { cookie: first.cookie })).body.user?.id).toBe(c.id)
  })

  it('never revives sessions revoked meanwhile (e.g. "sign out everywhere")', async () => {
    const c = await customer()
    const first = await login(c.email)
    const read = await stored(c.id)
    await payload.db.updateOne({ id: c.id, collection: 'customers', data: { sessions: [], updatedAt: null } })
    const sid = await appendLikeLogin(read)
    expect((await stored(c.id)).sessions.map((s: { id: string }) => s.id)).toEqual([sid])
    expect((await restGet('customers/me', { cookie: first.cookie })).body.user).toBeNull()
  })

  it('plain writes (not a flagged login append) pass through untouched', async () => {
    const c = await customer()
    const req = await makeReq()
    req.context = { [LOGIN_SESSION_WRITE]: 'customers' }
    await payload.db.updateOne({ id: c.id, collection: 'customers', data: { name: 'Direct' }, req })
    expect((await stored(c.id)).name).toBe('Direct')
  })
})

const later = <T>(ms: number, fn: () => Promise<T>) => new Promise((r) => setTimeout(r, ms)).then(fn)

describe('overlapping REST sign-ins (end to end)', () => {
  it('a password reset holds: new password works, old one, old sessions and the link do not', async () => {
    for (let round = 0; round < 2; round++) {
      const c = await customer()
      const before = await login(c.email)
      expect((await restPost('customers/forgot-password', { body: { email: c.email }, origin: STOREFRONT_ORIGIN })).status).toBe(200)
      const token = (await stored(c.id)).resetPasswordToken as string
      const next = `new-password-${crypto.randomBytes(4).toString('hex')}`
      const [reset] = await Promise.all([
        later(10, () => restPost('customers/reset-password', { body: { token, password: next }, origin: STOREFRONT_ORIGIN })),
        ...[0, 1, 2, 3].map((k) => later(k * 15, () => login(c.email))),
      ])
      expect(reset.status).toBe(200)
      expect({
        newPassword: (await login(c.email, next)).status,
        oldPassword: (await login(c.email)).status,
        sessionFromBeforeTheReset: Boolean((await restGet('customers/me', { cookie: before.cookie })).body.user),
        resetLinkAgain: (await restPost('customers/reset-password', { body: { token, password: `again-${next}` }, origin: STOREFRONT_ORIGIN })).status,
      }).toEqual({ newPassword: 200, oldPassword: 401, sessionFromBeforeTheReset: false, resetLinkAgain: 403 })
    }
  })

  it('"Save details" is kept, and so is every session signed in meanwhile', async () => {
    for (let round = 0; round < 2; round++) {
      const c = await customer()
      const me = await login(c.email)
      const [save, ...signins] = await Promise.all([
        later(10, () => restPatch(`customers/${c.id}`, { cookie: me.cookie, body: { name: 'New Name', phone: '+919800000002' } })),
        ...[0, 1, 2, 3].map((k) => later(k * 15, () => login(c.email))),
      ])
      expect(save.status, save.text).toBe(200)
      const after = await stored(c.id)
      expect({ name: after.name, phone: after.phone }).toEqual({ name: 'New Name', phone: '+919800000002' })
      for (const s of [me, ...signins]) expect((await restGet('customers/me', { cookie: s.cookie })).body.user?.id).toBe(c.id)
    }
  })
})
