import { sql } from '@payloadcms/db-postgres'
import {
  APIError,
  type CollectionAfterOperationHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeOperationHook,
  type PayloadRequest,
  ValidationError,
  type Where,
} from 'payload'

import { userIsAdmin } from '../access/roles'
import { sessionDb } from '../commerce/checkout/db'

/**
 * At least one admin must remain.
 *
 * Only admins reach orders, customers, coupons, subscribers and store settings, and only an admin can make
 * someone an admin. So the last admin demoting themselves (Account → Role → Editor) locks the shop out
 * until someone edits the database, and the last account being deleted empties `users`, which re-opens
 * Payload's first-user registration (/admin/create-first-user, POST /api/users/first-register) to any
 * anonymous visitor, whom the Users bootstrap hook makes an admin.
 *
 * Both are refused, through REST, the admin and the Local API alike. The check takes a transaction-scoped
 * advisory lock first, so two admins demoting or deleting each other at the same moment run one after the
 * other and the second sees the first one's committed change (and is refused).
 *
 * Bulk actions (Users list → select → Delete, or → Edit → Role) are one operation on many documents, and
 * Payload runs their per-document hooks concurrently in ONE transaction (where the lock is re-entrant): each
 * document's check would see the other selected admins still there. So a bulk delete / demotion is checked
 * as a whole before it starts (keepLastAdminInBulk: the selected accounts vs the admins outside them, the
 * operation then pinned to exactly those ids), and re-checked before it commits (keepLastAdminAfterBulk,
 * whose refusal rolls the whole operation back).
 */

/** Explicit error name (survives minification). */
export const LAST_ADMIN_ERROR = 'LastAdminError'
export const LAST_ADMIN = 'LAST_ADMIN'

export const lastAdminMessage = (action: 'demote' | 'delete'): string =>
  `At least one admin must remain, and this is the last one. Make another account an admin first, then ${
    action === 'demote' ? 'change this role' : 'delete this account'
  }.`

export const bulkLastAdminMessage = (action: 'demote' | 'delete'): string =>
  `At least one admin must remain, and the selection includes every admin. Leave one admin out (or make another account an admin first), then ${
    action === 'demote' ? 'change the roles' : 'delete the rest'
  }.`

export class LastAdminError extends APIError<{ code: typeof LAST_ADMIN }> {
  constructor(message: string = lastAdminMessage('delete')) {
    super(message, 409, { code: LAST_ADMIN }, true)
    this.name = LAST_ADMIN_ERROR
  }
}

/**
 * Serialises every "does another admin remain?" check (no-op outside a transaction). Taken before any users
 * row lock (accountWrites.ts takes it first for an update that sends a role), never after one.
 */
export async function lockAdminSet(req: PayloadRequest): Promise<void> {
  if (!req.transactionID) return
  const db = await sessionDb(req)
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'wf:users:admins'}, 0))`)
}

/** Admins other than `id`, as this transaction sees them after taking the lock. */
export async function otherAdmins(req: PayloadRequest, id: number | string): Promise<number> {
  await lockAdminSet(req)
  const { totalDocs } = await req.payload.count({
    collection: 'users',
    where: { and: [{ role: { equals: 'admin' } }, { id: { not_equals: id } }] },
    overrideAccess: true,
    req,
  })
  return totalDocs
}

/** users beforeChange: an admin's role may only change while another admin remains. */
export const keepLastAdminRole: CollectionBeforeChangeHook = async ({ data, operation, originalDoc, req }) => {
  if (operation !== 'update' || !data || originalDoc?.role !== 'admin') return data
  if (data.role === undefined || data.role === 'admin') return data
  if ((await otherAdmins(req, originalDoc.id)) === 0) {
    throw new ValidationError({ collection: 'users', errors: [{ path: 'role', message: lastAdminMessage('demote') }], req })
  }
  return data
}

/** users beforeDelete: an admin may only be deleted while another admin remains. */
export const keepLastAdminAccount: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await lockAdminSet(req)
  const doc = await req.payload.findByID({ collection: 'users', id, depth: 0, overrideAccess: true, disableErrors: true, req })
  if (!doc || doc.role !== 'admin') return
  if ((await otherAdmins(req, id)) === 0) throw new LastAdminError()
}

type OperationArgs = { id?: unknown; where?: Where; data?: Record<string, unknown>; overrideAccess?: boolean }

/** Bulk operations whose selection included an admin (re-checked in afterOperation). Keyed on their args. */
const bulkTouchingAdmins = new WeakMap<object, 'demote' | 'delete'>()

const refuse = (req: PayloadRequest, action: 'demote' | 'delete'): never => {
  if (action === 'delete') throw new LastAdminError(bulkLastAdminMessage('delete'))
  throw new ValidationError({ collection: 'users', errors: [{ path: 'role', message: bulkLastAdminMessage('demote') }], req })
}

/**
 * users beforeOperation: a bulk delete, or a bulk update setting a non-admin role, may only go ahead while an
 * admin outside the selection remains. Single-document operations (with an id) are left to the hooks above.
 * A REST caller who isn't an admin is left to access control (403 on delete; field access drops a role).
 */
export const keepLastAdminInBulk: CollectionBeforeOperationHook = async ({ args, operation, overrideAccess, req }) => {
  if (operation !== 'delete' && operation !== 'update') return args
  const a = args as OperationArgs
  if (a.id !== undefined || !a.where) return args
  if ((overrideAccess ?? a.overrideAccess) !== true && !userIsAdmin(req.user)) return args
  const action = operation === 'delete' ? 'delete' : 'demote'
  if (action === 'demote' && (!a.data || a.data.role === undefined || a.data.role === 'admin')) return args
  await lockAdminSet(req)
  const { docs } = await req.payload.find({
    collection: 'users',
    where: a.where,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { role: true },
    req,
  })
  if (docs.length === 0) return args
  const ids = docs.map((d) => d.id)
  if (docs.some((d) => (d as { role?: unknown }).role === 'admin')) {
    const { totalDocs } = await req.payload.count({
      collection: 'users',
      where: { and: [{ role: { equals: 'admin' } }, { id: { not_in: ids } }] },
      overrideAccess: true,
      req,
    })
    if (totalDocs === 0) refuse(req, action)
  }
  // Pinned to the accounts just checked: one that starts matching `where` meanwhile is not touched.
  const pinned = { ...args, where: { and: [a.where, { id: { in: ids } }] } }
  if (docs.some((d) => (d as { role?: unknown }).role === 'admin')) bulkTouchingAdmins.set(pinned, action)
  return pinned
}

/** users afterOperation (before the bulk operation commits): refuses, rolling it back, if no admin is left. */
export const keepLastAdminAfterBulk: CollectionAfterOperationHook = async ({ args, operation, req, result }) => {
  if (operation !== 'delete' && operation !== 'update') return result
  const action = args && bulkTouchingAdmins.get(args as object)
  if (!action) return result
  const { totalDocs } = await req.payload.count({ collection: 'users', where: { role: { equals: 'admin' } }, overrideAccess: true, req })
  if (totalDocs === 0) refuse(req, action)
  return result
}
