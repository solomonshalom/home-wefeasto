import type { PayloadRequest } from 'payload'

/**
 * Role predicates on `req.user`. Two auth collections exist: `users` (staff: admin | editor) and
 * `customers` (storefront shoppers). IDs overlap between them, so every check looks at `user.collection`
 * first: customer #1 must never match staff user #1.
 */

export type StaffRole = 'admin' | 'editor'
export type AuthUser = PayloadRequest['user']

const roleOf = (user: AuthUser): string | undefined =>
  user && user.collection === 'users' ? ((user as { role?: string | null }).role ?? undefined) : undefined

export const userIsStaff = (user: AuthUser): boolean => roleOf(user) === 'admin' || roleOf(user) === 'editor'
export const userIsAdmin = (user: AuthUser): boolean => roleOf(user) === 'admin'
export const userIsAdminOrEditor = userIsStaff
export const userIsCustomer = (user: AuthUser): boolean => Boolean(user && user.collection === 'customers')
