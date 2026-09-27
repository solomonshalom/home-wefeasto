import type { Access, FieldAccess } from 'payload'

import { userIsAdmin } from './roles'

/** Staff user with role `admin`. */
export const isAdmin: Access = ({ req }) => userIsAdmin(req.user)

/** Field-level variant: hides/locks a field for everyone but admins (REST, GraphQL, `overrideAccess: false`). */
export const isAdminField: FieldAccess = ({ req }) => userIsAdmin(req.user)
