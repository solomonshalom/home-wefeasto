import type { CollectionConfig } from 'payload'

import { isAdmin, isAdminField } from '../access'
import { userIsAdmin, userIsAdminOrEditor } from '../access/roles'
import { staffAuthBeforeOperation } from '../auth/customerAuth'
import { keepLastAdminAccount, keepLastAdminAfterBulk, keepLastAdminInBulk, keepLastAdminRole } from '../auth/lastAdmin'

/**
 * Staff accounts for /admin. `admin` manages everything; `editor` edits catalog, recipes and pages only.
 * The very first user (created at /admin/create-first-user) is always an admin, and the last admin can be
 * neither demoted nor deleted (src/auth/lastAdmin.ts).
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'name', 'role', 'updatedAt'],
    group: 'Settings',
  },
  auth: {
    useSessions: true,
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
    cookies: { sameSite: 'Lax', secure: process.env.NODE_ENV === 'production' },
  },
  access: {
    admin: ({ req }) => userIsAdminOrEditor(req.user),
    // Admins see everyone; editors only themselves; customers and guests nothing.
    read: ({ req }) =>
      userIsAdmin(req.user) ? true : req.user?.collection === 'users' ? { id: { equals: req.user.id } } : false,
    create: isAdmin,
    update: ({ req }) =>
      userIsAdmin(req.user) ? true : req.user?.collection === 'users' ? { id: { equals: req.user.id } } : false,
    delete: isAdmin,
    unlock: isAdmin,
  },
  hooks: {
    // Refuses cross-site login / forgot / reset / create (login CSRF, src/auth/crossSite.ts).
    // Bulk Delete / Edit → Role must leave an admin outside the selection (src/auth/lastAdmin.ts).
    beforeOperation: [staffAuthBeforeOperation, keepLastAdminInBulk],
    afterOperation: [keepLastAdminAfterBulk],
    beforeChange: [
      async ({ data, operation, req }) => {
        // Bootstrap: the first account must be able to manage the rest.
        if (operation === 'create') {
          const { totalDocs } = await req.payload.count({ collection: 'users', req })
          if (totalDocs === 0) data.role = 'admin'
        }
        return data
      },
      // The last admin can't demote themselves (src/auth/lastAdmin.ts).
      keepLastAdminRole,
    ],
    // …or be deleted: an empty users table re-opens first-user registration to anyone.
    beforeDelete: [keepLastAdminAccount],
  },
  fields: [
    { name: 'name', type: 'text', maxLength: 120 },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'editor',
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'Editor (catalog, recipes, pages)', value: 'editor' },
      ],
      saveToJWT: true,
      access: {
        // Editors cannot promote themselves.
        create: isAdminField,
        update: isAdminField,
      },
      admin: { position: 'sidebar' },
    },
  ],
  timestamps: true,
}
