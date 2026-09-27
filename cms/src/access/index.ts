import type { Access } from 'payload'

export { isAdmin, isAdminField } from './isAdmin'
export { isAdminOrEditor, isAdminOrEditorField } from './isAdminOrEditor'
export { isAdminOrSelf, isSelf } from './isSelf'
export { publishedOrAdmin } from './publishedOrAdmin'
export { userIsAdmin, userIsAdminOrEditor, userIsCustomer, userIsStaff } from './roles'
export type { AuthUser, StaffRole } from './roles'

export const anyone: Access = () => true
/** Nobody through REST/GraphQL; server code uses the Local API (overrideAccess defaults to true). */
export const nobody: Access = () => false
