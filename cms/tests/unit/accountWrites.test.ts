import { PgDialect } from 'drizzle-orm/pg-core'
import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { guardLoginSessionWrite, LOGIN_SESSION_WRITE, lockAccountForWrite } from '@/auth/accountWrites'

/**
 * Account writes never undo each other (hunt r4 login-writeback): which operations lock the account row, and
 * the login-append guard's pass-through. DB behaviour: tests/int/loginWriteBack.int.spec.ts.
 */

const dialect = new PgDialect()
const reqWith = (over: Record<string, unknown> = {}) => {
  const execute = vi.fn(async (_q: unknown) => ({ rows: [] as unknown[] }))
  const db = { sessions: { tx: { db: { execute } } }, tableNameMap: new Map(), drizzle: { execute } }
  const req = { transactionID: 'tx', context: {}, payloadAPI: 'REST', payload: { db }, ...over } as unknown as PayloadRequest
  const statements = () =>
    execute.mock.calls.map(([q]) => {
      const { sql, params } = dialect.sqlToQuery(q as never)
      return { sql, params }
    })
  return { req, execute, statements }
}
const run = (operation: string, args: Record<string, unknown>, req: PayloadRequest, slug = 'customers', overrideAccess?: boolean) =>
  lockAccountForWrite({ args, collection: { slug }, operation, req, overrideAccess } as never)

describe('lockAccountForWrite', () => {
  it('locks the row before update by id (the account itself, staff, server code), FOR NO KEY UPDATE', async () => {
    for (const over of [{ user: { collection: 'customers', id: 7 } }, { user: { collection: 'users', id: 1 } }, { payloadAPI: 'local', user: null }]) {
      const { req, statements } = reqWith(over)
      await run('update', { id: 7, data: { name: 'x' } }, req)
      expect(statements()).toEqual([{ sql: 'SELECT "id" FROM "customers" WHERE "id" = $1 FOR NO KEY UPDATE', params: [7] }])
    }
  })

  it('does not lock for another customer, a guest, a bulk update, a malformed id or outside a transaction', async () => {
    for (const [over, args] of [
      [{ user: { collection: 'customers', id: 8 } }, { id: 7 }],
      [{ user: null }, { id: 7 }],
      [{ payloadAPI: 'local' }, { where: { id: { equals: 7 } } }],
      [{ payloadAPI: 'local' }, { id: 'abc' }],
      [{ payloadAPI: 'local' }, { id: '99999999999999999999' }],
      [{ payloadAPI: 'local', transactionID: undefined }, { id: 7 }],
    ] as const) {
      const { req, execute } = reqWith(over)
      await run('update', args, req)
      expect(execute, JSON.stringify([over, args])).not.toHaveBeenCalled()
    }
  })

  it("a guest's request running an overrideAccess update (forgot-password's token write) locks too", async () => {
    const { req, statements } = reqWith({ user: null })
    await run('update', { id: 7, data: { resetPasswordToken: 't' } }, req, 'customers', true)
    expect(statements()).toHaveLength(1)
  })

  it('reset-password locks the row holding the token; refresh the signed-in account', async () => {
    const reset = reqWith()
    await run('resetPassword', { data: { token: 'tok123', password: 'x' } }, reset.req)
    expect(reset.statements()).toEqual([
      { sql: 'SELECT "id" FROM "customers" WHERE "reset_password_token" = $1 FOR NO KEY UPDATE', params: ['tok123'] },
    ])
    const refresh = reqWith({ user: { collection: 'customers', id: 5 } })
    await run('refresh', {}, refresh.req)
    expect(refresh.statements()[0]?.params).toEqual([5])
    const blank = reqWith()
    await run('resetPassword', { data: { token: '' } }, blank.req)
    expect(blank.execute).not.toHaveBeenCalled()
  })

  it('a users update sending a role takes the admin-set lock BEFORE the row lock (lock order)', async () => {
    const { req, statements } = reqWith({ user: { collection: 'users', id: 1 } })
    await run('update', { id: 2, data: { role: 'editor' } }, req, 'users')
    const sqls = statements().map((s) => s.sql)
    expect(sqls[0]).toMatch(/pg_advisory_xact_lock/)
    expect(sqls[1]).toBe('SELECT "id" FROM "users" WHERE "id" = $1 FOR NO KEY UPDATE')
  })

  it('login flags the request and installs the append guard once', async () => {
    const updateOne = vi.fn(async () => null)
    const { req } = reqWith()
    ;(req.payload.db as any).updateOne = updateOne
    ;(req.payload.db as any).findOne = vi.fn()
    await run('login', { data: { email: 'a@b.co' } }, req)
    expect(req.context[LOGIN_SESSION_WRITE]).toBe('customers')
    const guarded = (req.payload.db as any).updateOne
    expect(guarded).not.toBe(updateOne)
    guardLoginSessionWrite(req.payload.db as never)
    expect((req.payload.db as any).updateOne).toBe(guarded)
  })

  it('the guard passes through every write that is not a flagged login append', async () => {
    const updateOne = vi.fn(async (_args: unknown) => 'written')
    const findOne = vi.fn()
    const db = { updateOne, findOne }
    guardLoginSessionWrite(db as never)
    const session = { id: 's1', createdAt: new Date(), expiresAt: new Date(Date.now() + 1000) }
    const loginData = { _strategy: 'local-jwt', sessions: [session], hash: 'h', salt: 's' }
    for (const args of [
      { id: 1, collection: 'customers', data: loginData, req: { context: {}, transactionID: 'tx' } }, // not flagged
      { id: 1, collection: 'users', data: loginData, req: { context: { [LOGIN_SESSION_WRITE]: 'customers' }, transactionID: 'tx' } },
      { id: 1, collection: 'customers', data: { name: 'x' }, req: { context: { [LOGIN_SESSION_WRITE]: 'customers' }, transactionID: 'tx' } },
      { id: 1, collection: 'customers', data: loginData, req: { context: { [LOGIN_SESSION_WRITE]: 'customers' } } }, // no tx
    ]) {
      expect(await db.updateOne(args as never)).toBe('written')
    }
    expect(findOne).not.toHaveBeenCalled()
    expect(updateOne).toHaveBeenCalledTimes(4)
  })
})
