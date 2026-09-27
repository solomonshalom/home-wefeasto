import type { Access } from 'payload'

import { userIsAdminOrEditor } from './roles'

/**
 * Read access for `versions.drafts` collections: staff (admin/editor) see drafts; the public only
 * published docs. Also applies to `?draft=true` reads, so draft prices never leak.
 */
export const publishedOrAdmin: Access = ({ req }) =>
  userIsAdminOrEditor(req.user) ? true : { _status: { equals: 'published' } }
