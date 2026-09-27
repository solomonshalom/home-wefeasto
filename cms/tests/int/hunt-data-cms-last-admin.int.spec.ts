import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restDelete, restPatch, restPost } from './helpers/rest'

/**
 * HUNT data-cms (round 3): the shop's only admin can demote or delete themselves, leaving nobody who can
 * reach orders, customers, coupons, subscribers or store settings.
 *
 * `users.role` is admin-writable (field access isAdminField) and `users` delete is isAdmin, with no
 * "last admin" guard. One stray click in /admin/account (Role → Editor, Save) or on Delete in the Users
 * list, and the account that remains is an editor: editors can't promote anyone, and
 * /admin/create-first-user only exists while there are no users at all. Recovery needs direct DB access.
 * Worse, in a one-account shop a self-delete empties `users`, which re-opens Payload's first-user
 * registration (POST /api/users/first-register, /admin/create-first-user) to ANY anonymous visitor, and the
 * Users hook makes that first user an admin: orders, customer PII, coupons and settings are theirs.
 *
 * Correct behaviour: a change that would leave zero admins (demoting or deleting the last one) is refused.
 */

let payload: Payload
let demoted: (number | string)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
})

/** Makes `keep` the only admin (other admins → editor, restored after the test). */
async function onlyAdmin(keep: number | string) {
  const others = await payload.find({
    collection: 'users',
    where: { and: [{ role: { equals: 'admin' } }, { id: { not_equals: keep } }] },
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

describe('the last admin cannot remove themselves', () => {
  it('PATCH own role → editor is refused while no other admin exists', async () => {
    const me = await createStaff(payload, 'admin')
    await onlyAdmin(me.id)
    expect(await adminCount()).toBe(1)
    const { token } = await login('users', me.email)
    const res = await restPatch(`users/${me.id}`, { token, body: { role: 'editor' } })
    const after = await payload.findByID({ collection: 'users', id: me.id, depth: 0 })
    expect(after.role, `PATCH → ${res.status} ${res.text.slice(0, 200)}`).toBe('admin')
    expect(await adminCount()).toBe(1)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('DELETE own account is refused while no other admin exists', async () => {
    const me = await createStaff(payload, 'admin')
    await onlyAdmin(me.id)
    const { token } = await login('users', me.email)
    const res = await restDelete(`users/${me.id}`, { token })
    const left = await adminCount()
    expect(left, `DELETE → ${res.status} ${res.text.slice(0, 200)}`).toBe(1)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('a one-admin shop whose admin deletes their account does not hand /admin to the next visitor', async () => {
    // A single-owner shop: one staff account. (Other files' staff are finished with; later files create their own.)
    const me = await createStaff(payload, 'admin')
    const others = await payload.find({ collection: 'users', where: { id: { not_equals: me.id } }, pagination: false, depth: 0 })
    for (const u of others.docs) await payload.delete({ collection: 'users', id: u.id })
    const { token } = await login('users', me.email)
    const del = await restDelete(`users/${me.id}`, { token })

    // Anyone on the internet: /admin shows "Create first user" when the users table is empty.
    const email = `hunt-intruder-${Date.now()}@example.test`
    const reg = await restPost('users/first-register', { body: { email, password: 'Intruder-Passw0rd!', 'confirm-password': 'Intruder-Passw0rd!' } })
    const intruder = await payload.find({ collection: 'users', where: { email: { equals: email } }, depth: 0 })
    try {
      expect(
        intruder.docs.map((u) => u.role),
        `self-delete → ${del.status}; anonymous first-register → ${reg.status} ${reg.text.slice(0, 160)}`,
      ).toEqual([])
    } finally {
      for (const u of intruder.docs) await payload.delete({ collection: 'users', id: u.id })
    }
  })
})
