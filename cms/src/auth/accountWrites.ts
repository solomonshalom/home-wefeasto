import { sql } from '@payloadcms/db-postgres'
import {
  AuthenticationError,
  type CollectionBeforeOperationHook,
  commitTransaction,
  initTransaction,
  killTransaction,
  type PayloadHandler,
  type PayloadRequest,
} from 'payload'

import { sessionDb, tableOf } from '../commerce/checkout/db'
import { lockAdminSet } from './lastAdmin'

/**
 * No write to an account row may silently undo another one (customers, users: the `useSessions` collections).
 *
 * Payload's auth operations save an account by writing back the WHOLE row they read earlier (hash, salt,
 * reset token/expiry, sessions, name, phone, …). Login is the worst: it reads the row, spends tens of ms
 * checking the password, then appends its session with `db.updateOne({ data: user })`
 * (payload/dist/auth/sessions.js addSessionToUser). Any write that commits in between is reverted: a password
 * reset (new password refused, old one works, revoked sessions and the one-time link revived) or the
 * shopper's own "Save details". loginSessions.ts only serialises logins with each other.
 *
 *   1. Login's session append (guardLoginSessionWrite, a wrapper on the adapter's updateOne that only acts
 *      on the append of a login flagged by lockAccountForWrite) becomes: lock the row (FOR NO KEY UPDATE),
 *      re-read it, and if its password hash/salt changed since the login read it (a reset or password change
 *      committed meanwhile) refuse the login (401: it used the old password); otherwise write back the row
 *      AS IT IS NOW with only `sessions` changed: the stored ones (unexpired) + the new one.
 *   2. The other whole-row writers lock the row BEFORE they read it (lockAccountForWrite: update by id,
 *      reset-password by token, refresh by the signed-in account; wrapLogout for logout), so their read is
 *      current and a login's append (1) waits for them to commit, and vice versa.
 * FOR NO KEY UPDATE (what a plain UPDATE takes) never blocks foreign-key checks (orders → customers).
 * Lock order: the `wf:users:admins` advisory lock (lastAdmin.ts) before a users row, never after.
 */

export const LOGIN_SESSION_WRITE = 'wfLoginSessionWrite'
const APPENDED = 'wfLoginSessionAppended'
const GUARDED = Symbol.for('wefeasto.guardLoginSessionWrite')

type Row = { id?: unknown; hash?: unknown; salt?: unknown; sessions?: Session[] | null }
type Session = { id: string; createdAt?: unknown; expiresAt?: unknown }
type UpdateOneArgs = { id?: number | string; collection: string; data?: Record<string, unknown>; req?: PayloadRequest; [k: string]: unknown }
type Db = { updateOne: (args: UpdateOneArgs) => Promise<unknown>; findOne: (args: Record<string, unknown>) => Promise<unknown>; [GUARDED]?: true }

const idOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Locks the account row(s) whose `column` equals `value` (no-op outside a transaction). */
async function lockAccount(req: PayloadRequest, slug: string, column: 'id' | 'reset_password_token', value: unknown) {
  if (!req.transactionID) return
  const v = column === 'id' ? idOf(value) : typeof value === 'string' && value ? value : null
  if (v === null) return
  const db = await sessionDb(req)
  const table = tableOf(req.payload, slug)
  await db.execute(sql`SELECT "id" FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${v} FOR NO KEY UPDATE`)
}

const unexpired = (sessions: Session[] | null | undefined, now = Date.now()): Session[] =>
  (Array.isArray(sessions) ? sessions : []).filter((s) => {
    const t = new Date(s.expiresAt as string).getTime()
    return Number.isFinite(t) && t > now
  })

/** Is this updateOne the session append of a login flagged by lockAccountForWrite (and not yet handled)? */
function isLoginAppend(args: UpdateOneArgs): boolean {
  const { req, data, collection } = args
  return Boolean(
    req?.context?.[LOGIN_SESSION_WRITE] === collection &&
      !req.context[APPENDED] &&
      req.transactionID &&
      idOf(args.id) !== null &&
      data &&
      data._strategy === 'local-jwt' &&
      Array.isArray(data.sessions) &&
      data.sessions.length > 0,
  )
}

/** Installs (once per adapter) the login-append guard described in (1). */
export function guardLoginSessionWrite(db: Db): void {
  if (!db || typeof db.updateOne !== 'function' || db[GUARDED]) return
  const updateOne = db.updateOne
  db.updateOne = async function guardedUpdateOne(this: Db, args: UpdateOneArgs) {
    if (!isLoginAppend(args)) return updateOne.call(this, args)
    const req = args.req!
    req.context[APPENDED] = true
    const read = args.data as Row
    const added = (read.sessions as Session[])[(read.sessions as Session[]).length - 1]
    await lockAccount(req, args.collection, 'id', args.id)
    const current = (await this.findOne({ collection: args.collection, req, where: { id: { equals: args.id } } })) as Row | null
    // The password changed (or the account went) after this login checked the old one: it did not happen.
    if (!current || current.hash !== read.hash || current.salt !== read.salt) throw new AuthenticationError(req.t)
    const stored = unexpired(current.sessions).filter((s) => s.id !== added.id)
    // The row as it is now (read under the lock) + the new session. The whole row, not just `sessions`: the
    // adapter replaces every array field of an update (a missing one, e.g. addresses, would be emptied).
    return updateOne.call(this, {
      ...args,
      data: { ...current, sessions: [...stored, added], updatedAt: null },
      returning: false,
    })
  }
  db[GUARDED] = true
}

/**
 * Server code (Local API, or overrideAccess — e.g. forgot-password's own update), staff, or the account
 * itself: a REST caller refused by access control next locks nothing.
 */
const mayWrite = (req: PayloadRequest, slug: string, id: unknown, overrideAccess?: boolean): boolean =>
  overrideAccess === true ||
  req.payloadAPI === 'local' ||
  req.user?.collection === 'users' ||
  (req.user?.collection === slug && String(req.user.id) === String(id))

/**
 * beforeOperation on the session-backed auth collections (appended last by serializeSessionLogins):
 *   login          → flags the request for guardLoginSessionWrite (installed on first use);
 *   update (by id) → locks that row; resetPassword → the row holding the token; refresh → the caller's row.
 */
export const lockAccountForWrite: CollectionBeforeOperationHook = async ({ args, collection, operation, overrideAccess, req }) => {
  const a = args as { id?: unknown; data?: { token?: unknown } }
  switch (operation) {
    case 'login':
      guardLoginSessionWrite(req.payload.db as unknown as Db)
      req.context = req.context ?? {}
      req.context[LOGIN_SESSION_WRITE] = collection.slug
      break
    case 'update': {
      if (a.id === undefined || !mayWrite(req, collection.slug, a.id, overrideAccess ?? (args as { overrideAccess?: boolean }).overrideAccess))
        break
      // Lock order: the admin-set lock before a users row (keepLastAdminRole takes it for a role change).
      if (collection.slug === 'users' && (args as { data?: { role?: unknown } }).data?.role !== undefined) await lockAdminSet(req)
      await lockAccount(req, collection.slug, 'id', a.id)
      break
    }
    case 'resetPassword':
      await lockAccount(req, collection.slug, 'reset_password_token', a.data?.token)
      break
    case 'refresh':
      if (req.user?.collection === collection.slug) await lockAccount(req, collection.slug, 'id', req.user.id)
      break
    default:
      break
  }
  return args
}

/** POST /logout: runs in a transaction that first locks the caller's row (Payload's logout rewrites it whole). */
export function wrapLogout(slug: string, handler: PayloadHandler): PayloadHandler {
  return async (req) => {
    if (req.user?.collection !== slug || idOf(req.user.id) === null) return handler(req)
    const owned = await initTransaction(req)
    try {
      await lockAccount(req, slug, 'id', req.user.id)
      const res = await handler(req)
      if (owned && req.transactionID) await commitTransaction(req)
      return res
    } catch (err) {
      if (owned) await killTransaction(req)
      throw err
    }
  }
}
