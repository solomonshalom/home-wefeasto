import { ValidationError } from 'payload'

/**
 * Customer password rule (server side). Payload's own check only asks for 3 characters; the storefront
 * (src/lib/session.js PASSWORD_MIN / PASSWORD_MAX) asks for 8–128, and this makes the CMS agree, so a
 * script or a hand-rolled request can't set a weaker password than the UI allows.
 *
 * Applied to customers on create (signup), update (change password) and reset-password, for every
 * caller (REST, admin UI, Local API). Failure is Payload's ValidationError on path `password`:
 *   400 { errors: [{ name, message, data: { collection: 'customers', errors: [{ path: 'password', message }] } }] }
 * which the storefront maps to WEAK_PASSWORD / LONG_PASSWORD.
 */

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

export const PASSWORD_TOO_SHORT = `Choose a password with at least ${PASSWORD_MIN} characters.`
export const PASSWORD_TOO_LONG = `Keep your password under ${PASSWORD_MAX + 1} characters.`

/** true when acceptable, else the customer-facing message. Counts UTF-16 code units, like the storefront. */
export function checkPassword(value: unknown): true | string {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN) return PASSWORD_TOO_SHORT
  if (value.length > PASSWORD_MAX) return PASSWORD_TOO_LONG
  return true
}

/** Throws a ValidationError (path `password`) unless `value` passes checkPassword. */
export function assertPasswordPolicy(value: unknown, collection = 'customers'): void {
  const result = checkPassword(value)
  if (result === true) return
  throw new ValidationError({ collection, errors: [{ path: 'password', message: result }] })
}
