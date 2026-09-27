import type { CollectionConfig, FieldAccess } from 'payload'
import { ValidationError } from 'payload'

import { anyone, isAdmin, isAdminField, isAdminOrSelf } from '../access'
import { userIsAdmin } from '../access/roles'
import { customerAuthBeforeOperation, customerVerifyEndpoint } from '../auth/customerAuth'
import { addCustomerEditBase, EDIT_BASE_FIELD, mergeStaleCustomerForm, noteCustomerForm } from '../auth/customerEdits'
import {
  RESET_PASSWORD_SUBJECT,
  resetPasswordHtml,
  VERIFY_EMAIL_SUBJECT,
  verifyEmailHtml,
} from '../email/customerAuth'

/**
 * Storefront shoppers (separate from staff `users`). Email + password, email verification required,
 * session-backed JWT in the HttpOnly `payload-token` cookie (SameSite=Lax; Secure in production).
 *
 * REST (via the storefront's same-origin /api proxy):
 *   POST /api/customers {email,password,name?,phone?,marketingOptIn?}  signup → verification email
 *   POST /api/customers/verify/:token · /login · /logout · /refresh-token · /forgot-password · /reset-password
 *   GET  /api/customers/me → { user | null }
 * Guests never need an account to check out; guest orders are never linked to accounts by email.
 *
 * Hardening (SCRATCH/contracts/cms-hardening.md, src/auth/*):
 *   - removeTokenFromResponses: login / me / refresh-token / reset-password never put the JWT in the JSON
 *     body; the session lives only in the HttpOnly cookie. Server-to-server callers read the cookie value.
 *   - Password policy 8–128 characters on signup, change and reset (400 ValidationError, path `password`).
 *   - Per-IP (and per-email) rate limits on signup, login, forgot/reset password and verify → 429.
 *   - POST /api/store/account/resend-verification {email} (src/endpoints/account) re-sends the link.
 *   - An admin Save from a page loaded before the row changed (the customer verified, saved an address…)
 *     keeps those changes instead of writing the old values back (src/auth/customerEdits.ts, `editBase`).
 */

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30

/** Protected fields: only admins (or server code with overrideAccess) may write them. */
const adminWriteOnly: { create: FieldAccess; update: FieldAccess } = {
  create: isAdminField,
  update: isAdminField,
}

const isLocalApi = (req: { payloadAPI?: string }) => req.payloadAPI === 'local'

export const Customers: CollectionConfig = {
  slug: 'customers',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'name', 'phone', '_verified', 'createdAt'],
    group: 'Shop',
    listSearchableFields: ['email', 'name', 'phone'],
  },
  auth: {
    verify: {
      generateEmailSubject: () => VERIFY_EMAIL_SUBJECT,
      generateEmailHTML: ({ token, user }) => verifyEmailHtml({ token, user }),
    },
    forgotPassword: {
      generateEmailSubject: () => RESET_PASSWORD_SUBJECT,
      generateEmailHTML: (args) => resetPasswordHtml({ token: args?.token, user: args?.user }),
    },
    maxLoginAttempts: 5,
    lockTime: 600_000,
    tokenExpiration: THIRTY_DAYS_SECONDS,
    useSessions: true,
    removeTokenFromResponses: true,
    cookies: {
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
    },
  },
  access: {
    // Customers can never sign in to /admin.
    admin: () => false,
    create: anyone,
    read: isAdminOrSelf('customers'),
    update: isAdminOrSelf('customers'),
    delete: isAdmin,
    unlock: isAdmin,
  },
  // Matched before Payload's default /verify/:id (rate limit, then Payload's own verify operation).
  endpoints: [customerVerifyEndpoint],
  hooks: {
    beforeOperation: [customerAuthBeforeOperation, noteCustomerForm],
    beforeChange: [
      mergeStaleCustomerForm,
      ({ data, operation, originalDoc, req }) => {
        const trusted = isLocalApi(req) || userIsAdmin(req.user)
        if (!trusted) {
          // Payload lets *any* signed-in user write `_verified`. Over REST only admins may.
          if (operation === 'create') data._verified = false
          else if ('_verified' in data) data._verified = originalDoc?._verified
          // Changing the login email would bypass verification.
          if (
            operation === 'update' &&
            typeof data.email === 'string' &&
            originalDoc?.email &&
            data.email.trim().toLowerCase() !== String(originalDoc.email).toLowerCase()
          ) {
            throw new ValidationError({
              collection: 'customers',
              errors: [{ path: 'email', message: 'Email changes are not supported yet. Contact support.' }],
            })
          }
        }
        // marketingOptInAt is server-owned: stamped when the opt-in flips on, cleared when it flips off. A REST
        // body (the admin form echoes the read-only value it loaded) never moves it by itself.
        if (operation === 'update' && originalDoc && !isLocalApi(req)) data.marketingOptInAt = originalDoc.marketingOptInAt ?? null
        if (typeof data.marketingOptIn === 'boolean') {
          const was = Boolean(originalDoc?.marketingOptIn)
          if (data.marketingOptIn && !was) data.marketingOptInAt = new Date().toISOString()
          if (!data.marketingOptIn) data.marketingOptInAt = null
        }
        return data
      },
    ],
    afterRead: [addCustomerEditBase],
  },
  fields: [
    { name: 'name', type: 'text', maxLength: 100 },
    {
      name: 'phone',
      type: 'text',
      admin: { description: 'E.164, e.g. +919876543210' },
      validate: (value: unknown) =>
        value === null || value === undefined || value === '' || /^\+[1-9]\d{7,14}$/.test(String(value))
          ? true
          : 'Enter the phone number in international format, e.g. +919876543210.',
    },
    {
      name: 'addresses',
      type: 'array',
      maxRows: 5,
      labels: { singular: 'Address', plural: 'Addresses' },
      fields: [
        { name: 'label', type: 'text', maxLength: 40 },
        { name: 'line1', type: 'text', required: true, maxLength: 200 },
        { name: 'city', type: 'text', required: true, maxLength: 80 },
        { name: 'state', type: 'text', required: true, maxLength: 80 },
        {
          name: 'pin',
          type: 'text',
          required: true,
          validate: (value: unknown) => (/^[1-9]\d{5}$/.test(String(value ?? '')) ? true : 'Enter a 6-digit PIN code.'),
        },
        { name: 'isDefault', type: 'checkbox', defaultValue: false },
      ],
    },
    { name: 'marketingOptIn', type: 'checkbox', defaultValue: false },
    {
      name: 'marketingOptInAt',
      type: 'date',
      access: adminWriteOnly,
      admin: { readOnly: true, position: 'sidebar', description: 'Set automatically when the customer opts in.' },
    },
    {
      // What the admin page was loaded with (hashes; set by addCustomerEditBase for admins, never stored): the
      // Save sends it back so a stale form can't undo the customer's newer changes (src/auth/customerEdits.ts).
      name: EDIT_BASE_FIELD,
      type: 'text',
      virtual: true,
      access: { read: isAdminField, create: () => false, update: () => false },
      admin: { hidden: true, readOnly: true, disableListColumn: true, disableListFilter: true },
    },
  ],
  timestamps: true,
}
