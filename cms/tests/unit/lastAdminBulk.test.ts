import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { keepLastAdminAfterBulk, keepLastAdminInBulk, LAST_ADMIN } from '@/auth/lastAdmin'
import { Users } from '@/collections/Users'

/**
 * Bulk Delete / Edit → Role on Users (hunt r4): checked as a whole before it starts, re-checked before it
 * commits. DB behaviour: tests/int/bulkLastAdmin.int.spec.ts, tests/int/hunt-data-cms-bulk-last-admin.int.spec.ts.
 */

type Doc = { id: number; role: string }
const reqWith = (selected: Doc[], adminsOutside: number, user: unknown = { collection: 'users', role: 'admin' }) => {
  const count = vi.fn(async () => ({ totalDocs: adminsOutside }))
  const find = vi.fn(async () => ({ docs: selected }))
  return { req: { user, payload: { find, count } } as unknown as PayloadRequest, find, count }
}
const where = { id: { in: [1, 2] } }
const before = (operation: string, args: Record<string, unknown>, req: PayloadRequest, overrideAccess?: boolean) =>
  keepLastAdminInBulk({ args, operation, req, overrideAccess } as never) as Promise<Record<string, unknown>>
const after = (operation: string, args: unknown, req: PayloadRequest) =>
  keepLastAdminAfterBulk({ args, operation, req, result: { docs: [] } } as never)

describe('keepLastAdminInBulk', () => {
  it('is registered on Users (beforeOperation last, afterOperation)', () => {
    expect(Users.hooks?.beforeOperation?.at(-1)).toBe(keepLastAdminInBulk)
    expect(Users.hooks?.afterOperation).toContain(keepLastAdminAfterBulk)
  })

  it('refuses a bulk delete of every admin (409) and a bulk demotion (400 on role)', async () => {
    const { req } = reqWith([{ id: 1, role: 'admin' }, { id: 2, role: 'admin' }], 0)
    await expect(before('delete', { where, req }, req)).rejects.toMatchObject({ status: 409, data: { code: LAST_ADMIN } })
    await expect(before('update', { where, data: { role: 'editor' }, req }, req)).rejects.toMatchObject({
      status: 400,
      data: { errors: [expect.objectContaining({ path: 'role' })] },
    })
  })

  it('pins the operation to the accounts it checked when an admin remains outside them', async () => {
    const { req, count } = reqWith([{ id: 1, role: 'admin' }, { id: 2, role: 'editor' }], 1)
    const args = await before('delete', { where, req }, req)
    expect(args.where).toEqual({ and: [where, { id: { in: [1, 2] } }] })
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ where: { and: [{ role: { equals: 'admin' } }, { id: { not_in: [1, 2] } }] } }))
  })

  it('leaves single-document operations, non-demoting edits, empty selections and non-admin REST callers alone', async () => {
    const { req, find } = reqWith([{ id: 1, role: 'admin' }], 0)
    const same = (a: Record<string, unknown>) => a
    for (const [op, args] of [
      ['delete', { id: 1, where, req }],
      ['update', { id: 1, data: { role: 'editor' }, req }],
      ['update', { where, data: { name: 'x' }, req }],
      ['update', { where, data: { role: 'admin' }, req }],
      ['read', { where, req }],
    ] as const) {
      const a = args as Record<string, unknown>
      expect(await before(op, a, req)).toBe(same(a))
    }
    const editor = reqWith([{ id: 1, role: 'admin' }], 0, { collection: 'users', role: 'editor' })
    const a = { where, req: editor.req }
    expect(await before('delete', a, editor.req)).toBe(a) // access control answers 403 next
    expect(editor.find).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
    // …but the Local API (overrideAccess) is checked whoever the user is.
    const local = reqWith([{ id: 1, role: 'admin' }], 0, null)
    await expect(before('delete', { where, req: local.req }, local.req, true)).rejects.toMatchObject({ status: 409 })
    const none = reqWith([], 0)
    const empty = { where, req: none.req }
    expect(await before('delete', empty, none.req)).toBe(empty)
  })
})

describe('keepLastAdminAfterBulk (backstop before commit)', () => {
  it('refuses, rolling the operation back, when no admin is left after a bulk operation that touched admins', async () => {
    const { req } = reqWith([{ id: 1, role: 'admin' }], 1)
    const args = await before('delete', { where, req }, req)
    ;(req.payload.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ totalDocs: 0 })
    await expect(after('delete', args, req)).rejects.toMatchObject({ status: 409 })
    ;(req.payload.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ totalDocs: 1 })
    await expect(after('delete', args, req)).resolves.toEqual({ docs: [] })
  })

  it('does nothing for operations it did not check', async () => {
    const { req, count } = reqWith([], 0)
    await expect(after('delete', { where }, req)).resolves.toEqual({ docs: [] })
    await expect(after('deleteByID', { id: 1 }, req)).resolves.toEqual({ docs: [] })
    expect(count).not.toHaveBeenCalled()
  })
})
