import type { Access, CollectionSlug } from 'payload'

import { userIsAdmin } from './roles'

/**
 * Only the signed-in user's own document, and only when they belong to `slug`
 * (customer #7 gets `{ id: 7 }` on `customers`, nothing on `users`).
 */
export const isSelf =
  (slug: CollectionSlug): Access =>
  ({ req }) =>
    req.user && req.user.collection === slug ? { id: { equals: req.user.id } } : false

/** Admins see everything; members of `slug` see only themselves; everyone else nothing. */
export const isAdminOrSelf =
  (slug: CollectionSlug): Access =>
  (args) =>
    userIsAdmin(args.req.user) ? true : isSelf(slug)(args)
