import { sql } from '@payloadcms/db-postgres'
import {
  APIError,
  type CollectionBeforeOperationHook,
  commitTransaction,
  initTransaction,
  killTransaction,
  type PayloadHandler,
  type PayloadRequest,
  type SanitizedConfig,
} from 'payload'

import { sessionDb } from '../commerce/checkout/db'
import { lockAccountForWrite, wrapLogout } from './accountWrites'
import { getEnv } from '../env'
import { type Release, Slots } from '../lib/slots'

/**
 * Serialises logins per account for auth collections with `useSessions` (customers, users).
 *
 * Payload's login reads the account (with its `sessions` array), checks the password, then writes the whole
 * array back as "sessions it read + the new one" (payload/dist/auth/sessions.js addSessionToUser). Two
 * overlapping logins of one account each write "old + mine", so the later write drops the earlier session
 * and that freshly signed-in browser is signed out (the JWT's sid is no longer in `sessions`).
 *
 * Fix: the REST POST /api/<slug>/login endpoint runs the whole login operation in one transaction that first
 * takes a transaction-scoped advisory lock keyed on (collection, lower(email)):
 *   endpoint wrapper  → marks req.context, runs Payload's handler, commits (or rolls back on a throw);
 *   beforeOperation   → (last hook, after the rate limit / cross-site refusal) begins the transaction and
 *                       waits for pg_advisory_xact_lock; login's own read of the account then runs inside it,
 *                       after the previous login of that account committed, so it sees that session.
 * An advisory lock, not a row lock: Payload counts a wrong password (incrementLoginAttempts) on another
 * connection without the transaction, which would wait forever behind our own row lock. Waiting is capped
 * (lock_timeout 5 s → 503, try again) so a burst on one account cannot hold pool connections for long.
 * The Local API (server code, tests) is not wrapped.
 *
 * Pool safety: that transaction pins one pool connection for the whole login, and a wrong password then
 * needs a SECOND one (incrementLoginAttempts runs without req, on purpose). If every connection were held
 * by such a login, each would wait for a connection that never frees: the pool deadlocks until pg's
 * connectionTimeoutMillis (30 s) and every other request (catalog, checkout, webhooks, admin) stalls with
 * it. So at most loginSlotCount(pool max) = ⌊(max − 1) / 2⌋ serialised logins hold a transaction at once
 * (4 of 10): even when each also takes its second connection, some stay free, so they always finish and
 * the rest of the CMS keeps its connections. Further logins wait in memory (holding nothing) for a slot,
 * ≤ LOGIN_LOCK_TIMEOUT_MS, then 503 (try again). A pool too small for even one slot skips the
 * serialisation (plain Payload login).
 */

export const LOGIN_LOCK_CONTEXT = 'wfLoginLock'
const LOGIN_TX_OWNED = 'wfLoginTxOwned'
export const LOGIN_LOCK_TIMEOUT_MS = 5_000
export const LOGIN_BUSY_MESSAGE = 'Another sign-in to this account is in progress. Please try again.'
export const LOGINS_BUSY_MESSAGE = 'Too many sign-ins at once. Please try again in a moment.'

/** Serialised logins allowed to hold a transaction at once for a pool of `poolMax` connections. */
export function loginSlotCount(poolMax: number): number {
  return Number.isSafeInteger(poolMax) && poolMax > 0 ? Math.floor((poolMax - 1) / 2) : 0
}

/** The pool size actually configured on the adapter (env as the fallback). */
function poolMax(req: PayloadRequest): number {
  const db = req.payload?.db as unknown as { poolOptions?: { max?: unknown }; pool?: { options?: { max?: unknown } } }
  const max = db?.poolOptions?.max ?? db?.pool?.options?.max
  return typeof max === 'number' && Number.isSafeInteger(max) && max > 0 ? max : getEnv().databasePoolMax
}

/**
 * The process-wide login slots, sized once from the pool. Kept on globalThis: the production build can
 * bundle this module more than once (see retention/util.ts isUniqueViolation), and copies sharing one pool
 * must share one limit (sharing it when each copy has its own pool is merely conservative).
 */
const SLOTS_KEY = Symbol.for('wefeasto.loginSlots')
export function loginSlots(req: PayloadRequest): Slots {
  const g = globalThis as { [SLOTS_KEY]?: Slots }
  g[SLOTS_KEY] ??= new Slots(loginSlotCount(poolMax(req)))
  return g[SLOTS_KEY]
}

/** Slot releases by login, keyed on its req.context (shared by the endpoint wrapper and the hook). */
const heldSlots = new WeakMap<object, Release>()

/** Advisory-lock key for one account's logins; null when there is no usable email. */
export function loginLockKey(slug: string, email: unknown): string | null {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : ''
  return e ? `login:${slug}:${e}` : null
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } }
  const code = e?.code ?? e?.cause?.code
  return typeof code === 'string' ? code : undefined
}

/** Waits (≤ LOGIN_LOCK_TIMEOUT_MS) for the account's login lock inside req's transaction. */
async function takeLoginLock(req: PayloadRequest, key: string): Promise<void> {
  const db = await sessionDb(req)
  const prev = (await db.execute(sql`SELECT current_setting('lock_timeout') AS v`)) as unknown as { rows?: { v: string }[] }
  const restore = prev?.rows?.[0]?.v ?? '0'
  await db.execute(sql`SELECT set_config('lock_timeout', ${`${LOGIN_LOCK_TIMEOUT_MS}ms`}, true)`)
  try {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
  } catch (err) {
    // 55P03 lock_not_available: the transaction is aborted; the endpoint wrapper rolls it back.
    if (pgCode(err) === '55P03') throw new APIError(LOGIN_BUSY_MESSAGE, 503, { code: 'LOGIN_BUSY' }, true)
    throw err
  }
  await db.execute(sql`SELECT set_config('lock_timeout', ${restore}, true)`)
}

/** beforeOperation('login'), appended after the collection's own hooks by serializeSessionLogins. */
export const lockAccountForLogin: CollectionBeforeOperationHook = async ({ args, collection, operation, req }) => {
  if (operation !== 'login' || !req.context?.[LOGIN_LOCK_CONTEXT] || req.transactionID) return args
  const key = loginLockKey(collection.slug, (args as { data?: { email?: unknown } })?.data?.email)
  if (!key) return args
  const pool = loginSlots(req)
  if (pool.size < 1) return args
  const release = await pool.acquire(LOGIN_LOCK_TIMEOUT_MS)
  if (!release) throw new APIError(LOGINS_BUSY_MESSAGE, 503, { code: 'LOGIN_BUSY' }, true)
  heldSlots.set(req.context, release)
  await initTransaction(req)
  req.context[LOGIN_TX_OWNED] = true
  await takeLoginLock(req, key)
  return args
}

/** Wraps Payload's login handler: commits the transaction lockAccountForLogin began, or rolls it back. */
export function serializedLoginHandler(handler: PayloadHandler): PayloadHandler {
  return async (req) => {
    req.context = req.context ?? {}
    req.context[LOGIN_LOCK_CONTEXT] = true
    try {
      const res = await handler(req)
      if (req.context[LOGIN_TX_OWNED] && req.transactionID) await commitTransaction(req)
      return res
    } catch (err) {
      // Payload's login already rolled back when it failed inside its own try; this is then a no-op.
      if (req.context[LOGIN_TX_OWNED]) await killTransaction(req)
      throw err
    } finally {
      // The transaction's connection is back in the pool: let the next login in.
      heldSlots.get(req.context)?.()
      heldSlots.delete(req.context)
    }
  }
}

/**
 * Config post-processor, on every session-backed auth collection: wraps POST /login (and POST /logout, see
 * accountWrites.ts) and appends the login lock hook, then the account-row lock hook (accountWrites.ts: a
 * login's session append never reverts another write to the account, and vice versa).
 */
export function serializeSessionLogins(config: SanitizedConfig): SanitizedConfig {
  for (const collection of config.collections) {
    const auth = collection.auth
    if (!auth || !auth.useSessions || auth.disableLocalStrategy || !Array.isArray(collection.endpoints)) continue
    let wrapped = false
    let logout = false
    collection.endpoints = collection.endpoints.map((endpoint) => {
      if (endpoint.method !== 'post') return endpoint
      if (!logout && endpoint.path === '/logout') {
        logout = true
        return { ...endpoint, handler: wrapLogout(collection.slug, endpoint.handler) }
      }
      if (wrapped || endpoint.path !== '/login') return endpoint
      wrapped = true
      return { ...endpoint, handler: serializedLoginHandler(endpoint.handler) }
    })
    const hooks = [...(collection.hooks.beforeOperation ?? [])]
    if (wrapped) hooks.push(lockAccountForLogin)
    hooks.push(lockAccountForWrite)
    collection.hooks.beforeOperation = hooks
  }
  return config
}
