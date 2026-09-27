import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { LAST_ADMIN } from '@/auth/lastAdmin'

import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restDelete, restPatch } from './helpers/rest'

/**
 * Bulk Delete / Edit → Role on Users is checked as a whole (src/auth/lastAdmin.ts keepLastAdminInBulk):
 * refused only when no admin outside the selection would remain; otherwise it goes through untouched, and the
 * operation only touches the accounts that matched when it was checked. Repro: hunt-data-cms-bulk-last-admin.
 */

let payload: Payload
let demoted: (number | string)[] = []
const cleanup: (() => Promise<unknown>)[] = []

beforeAll(async () => {
  payload = await getTestPayload()
})

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
  while (cleanup.length) await cleanup.pop()!().catch(() => {})
})

const roleOf = async (id: number | string) =>
  (await payload.findByID({ collection: 'users', id, depth: 0, disableErrors: true }))?.role ?? 'deleted'

describe('bulk actions on Users vs the last admin', () => {
  it('refuses a bulk delete of every admin with 409 LAST_ADMIN and deletes nothing (editors in the selection too)', async () => {
    const a = await createStaff(payload, 'admin')
    const b = await createStaff(payload, 'admin')
    const e = await createStaff(payload, 'editor')
    cleanup.push(() => payload.delete({ collection: 'users', id: e.id }))
    await onlyAdmins([a.id, b.id])
    const { token } = await login('users', a.email)
    const res = await restDelete('users', { token, query: `where[id][in]=${a.id},${b.id},${e.id}` })
    expect(res.status, res.text).toBe(409)
    expect(res.body.errors[0].data).toMatchObject({ code: LAST_ADMIN })
    expect(res.body.errors[0].message).toMatch(/At least one admin must remain/)
    expect([await roleOf(a.id), await roleOf(b.id), await roleOf(e.id)]).toEqual(['admin', 'admin', 'editor'])
  })

  it('refuses a bulk demotion of every admin with 400 on role and changes nobody', async () => {
    const a = await createStaff(payload, 'admin')
    const b = await createStaff(payload, 'admin')
    await onlyAdmins([a.id, b.id])
    const { token } = await login('users', a.email)
    const res = await restPatch('users', { token, query: `where[id][in]=${a.id},${b.id}`, body: { role: 'editor' } })
    expect(res.status, res.text).toBe(400)
    expect(res.text).toMatch(/role/)
    expect([await roleOf(a.id), await roleOf(b.id)]).toEqual(['admin', 'admin'])
  })

  it('lets a bulk delete / demotion through while an admin outside the selection remains', async () => {
    const a = await createStaff(payload, 'admin')
    const b = await createStaff(payload, 'admin')
    const c = await createStaff(payload, 'admin')
    await onlyAdmins([a.id, b.id, c.id])
    const { token } = await login('users', a.email)
    const patch = await restPatch('users', { token, query: `where[id][in]=${b.id}`, body: { role: 'editor' } })
    expect(patch.status, patch.text).toBe(200)
    expect(await roleOf(b.id)).toBe('editor')
    const del = await restDelete('users', { token, query: `where[id][in]=${b.id},${c.id}` })
    expect(del.status, del.text).toBe(200)
    expect(del.body.docs.map((d: { id: number }) => d.id).sort()).toEqual([b.id, c.id].sort())
    expect([await roleOf(a.id), await roleOf(b.id), await roleOf(c.id)]).toEqual(['admin', 'deleted', 'deleted'])
  })

  it('bulk edits that keep the role (or promote) are not counted', async () => {
    const a = await createStaff(payload, 'admin')
    await onlyAdmins([a.id])
    const e = await createStaff(payload, 'editor')
    cleanup.push(() => payload.delete({ collection: 'users', id: e.id }))
    const { token } = await login('users', a.email)
    const rename = await restPatch('users', { token, query: `where[id][in]=${a.id},${e.id}`, body: { name: 'Renamed' } })
    expect(rename.status, rename.text).toBe(200)
    const promote = await restPatch('users', { token, query: `where[id][in]=${a.id},${e.id}`, body: { role: 'admin' } })
    expect(promote.status, promote.text).toBe(200)
    expect(await roleOf(e.id)).toBe('admin')
  })

  it('the Local API is held to the same rule', async () => {
    const a = await createStaff(payload, 'admin')
    await onlyAdmins([a.id])
    await expect(payload.delete({ collection: 'users', where: { role: { equals: 'admin' } } })).rejects.toMatchObject({ status: 409 })
    await expect(
      payload.update({ collection: 'users', where: { role: { equals: 'admin' } }, data: { role: 'editor' } }),
    ).rejects.toMatchObject({ status: 400 })
    expect(await roleOf(a.id)).toBe('admin')
  })
})
