import type { Access, FieldAccess } from 'payload'

import { userIsAdminOrEditor } from './roles'

/** Any staff user (admin or editor). Editors manage catalog, recipes and pages only. */
export const isAdminOrEditor: Access = ({ req }) => userIsAdminOrEditor(req.user)

export const isAdminOrEditorField: FieldAccess = ({ req }) => userIsAdminOrEditor(req.user)
