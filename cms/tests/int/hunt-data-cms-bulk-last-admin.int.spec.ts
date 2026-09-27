import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restDelete, restPatch, restPost } from './helpers/rest'

/**
 * HUNT data-cms (round 4): the "at least one admin must remain" guard (src/auth/lastAdmin.ts, the round-3
 * fix) is bypassed by the admin's BULK actions: Users list → select the admins → Delete, or → Edit → Role →
 * Editor. Those are one REST call on many docs (DELETE /api/users?where[…], PATCH /api/users?where[…]), and
 * Payload runs the per-document hooks of a bulk delete/update CONCURRENTLY inside ONE shared transaction
 * (collections/operations/delete.js: `docs.map(async doc => …)` + Promise.all). The advisory lock the guard
 * takes is re-entrant for that same transaction, so it serialises nothing: every document's hook counts
 * "other admins" before any of the deletes/demotions ran, sees the others, and lets its own go through.
 *
 * Result: zero admins. After a bulk delete of every account the users table is empty and Payload's
 * first-user registration (/admin/create-first-user) is open to any anonymous visitor, who becomes an admin
 * (orders, customer PII, coupons, settings); after a bulk demote nobody can reach orders or settings.
 *
 * Correct behaviour: the bulk action is refused (or leaves one admin), exactly like the single-document one.
 */

let payload: Payload
let demoted: (number | string)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
})

/** Makes `keep` the only admins (every other admin → editor, restored after the test). */
async function onlyAdmins(keep: (number | string)[]) {
  const others = await payload.find({
    collection: 'users',
    where: { and: [{ role: { equals: 'admin' } }, { id: { not_in: keep } }] },
    pagination: false,
    depth: 0,
  })
  for (const u of others.docs) await payload.update({ collection: 'users', id: u.id, data: { role: 'editor' } })
  demoted = others.docs.map((u) => u.id)
}

afterEach(async () => {
  for (const id of demoted) await payload.update({ collection: 'users', id, data: { role: 'admin' } }).catch(() => {})
  demoted = []
})

const adminCount = async () => (await payload.count({ collection: 'users', where: { role: { equals: 'admin' } } })).totalDocs

describe('bulk actions cannot remove the last admin', () => {
  it('bulk Delete of every admin (Users list → select → Delete) leaves one admin', async () => {
    const a = await createStaff(payload, 'admin')
    const b = await createStaff(payload, 'admin')
    await onlyAdmins([a.id, b.id])
    expect(await adminCount()).toBe(2)
    const { token } = await login('users', a.email)
    const res = await restDelete('users', { token, query: `where[id][in]=${a.id},${b.id}` })
    expect(await adminCount(), `bulk DELETE → ${res.status} ${res.text.slice(0, 300)}`).toBeGreaterThanOrEqual(1)
  })

  it('bulk Edit → Role: Editor on every admin leaves one admin', async () => {
    const a = await createStaff(payload, 'admin')
    const b = await createStaff(payload, 'admin')
    await onlyAdmins([a.id, b.id])
    const { token } = await login('users', a.email)
    const res = await restPatch('users', { token, query: `where[id][in]=${a.id},${b.id}`, body: { role: 'editor' } })
    expect(await adminCount(), `bulk PATCH → ${res.status} ${res.text.slice(0, 300)}`).toBeGreaterThanOrEqual(1)
  })

  it('a one-owner shop that bulk-deletes all its accounts does not hand /admin to the next visitor', async () => {
    const a = await createStaff(payload, 'admin')
    const b = await createStaff(payload, 'admin')
    const others = await payload.find({ collection: 'users', where: { id: { not_in: [a.id, b.id] } }, pagination: false, depth: 0 })
    for (const u of others.docs) await payload.delete({ collection: 'users', id: u.id })
    const { token } = await login('users', a.email)
    const del = await restDelete('users', { token, query: `where[id][in]=${a.id},${b.id}` })

    const email = `hunt-intruder-bulk-${Date.now()}@example.test`
    const reg = await restPost('users/first-register', { body: { email, password: 'Intruder-Passw0rd!', 'confirm-password': 'Intruder-Passw0rd!' } })
    const intruder = await payload.find({ collection: 'users', where: { email: { equals: email } }, depth: 0 })
    try {
      expect(
        intruder.docs.map((u) => u.role),
        `bulk delete → ${del.status} ${del.text.slice(0, 160)}; anonymous first-register → ${reg.status} ${reg.text.slice(0, 160)}`,
      ).toEqual([])
    } finally {
      // The intruder is now the only admin: add one back first, or the last-admin guard refuses the cleanup.
      if (intruder.docs.length) await createStaff(payload, 'admin')
      for (const u of intruder.docs) await payload.delete({ collection: 'users', id: u.id })
    }
  })
})
