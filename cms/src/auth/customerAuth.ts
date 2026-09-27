import {
  type CollectionBeforeOperationHook,
  type Endpoint,
  headersWithCors,
  type PayloadRequest,
  ValidationError,
  verifyEmailOperation,
} from 'payload'

import { isGuardedAuthOperation, refuseCrossSiteAuth } from './crossSite'
import { assertPasswordPolicy } from './passwordPolicy'
import { enforceAuthLimit } from './rateLimits'

/**
 * Hardening for Payload's built-in customer auth operations (collection `customers`).
 *
 * beforeOperation (runs before any DB work):
 *   create / login / forgotPassword / resetPassword → first refuse cross-site requests (403, see crossSite.ts)
 *   create          → rate limit `signup` (per IP), then the password policy
 *   update          → the password policy when a new password is sent
 *   login           → rate limit `login` (per IP)
 *   forgotPassword  → rate limit `forgotPassword` (per IP + per email)
 *   resetPassword   → rate limit `resetPassword` (per IP), then the password policy
 * Rate limits skip the Local API and signed-in staff (admin UI); the password policy applies to everyone.
 *
 * verifyEmail has no beforeOperation hook, so POST /api/customers/verify/:id is overridden by a collection
 * endpoint (collection endpoints are matched before Payload's defaults) that rate-limits and then runs
 * Payload's own verifyEmailOperation: same responses (200 / 403 "Verification token is invalid.").
 */

type Data = Record<string, unknown> | undefined

const dataOf = (args: unknown): Data => {
  const d = (args as { data?: unknown } | undefined)?.data
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : undefined
}

/** Operations whose `data.email` Payload uses (its email field hook lower-cases it: a non-string crashed it). */
const EMAIL_OPERATIONS = new Set(['create', 'update', 'login', 'forgotPassword', 'unlock'])

/**
 * A sent email must be a string: `{ email: [...] }` or `{ email: 42 }` is a 400 on `email`, not a TypeError
 * (500) in Payload's email field hook. Runs first, for customers and staff alike. (hunt r4 malformed-rest-500)
 */
export function assertEmailIsText(collection: string, operation: string, data: Data, req: PayloadRequest): void {
  if (!EMAIL_OPERATIONS.has(operation) || !data) return
  const { email } = data
  if (email === undefined || email === null || typeof email === 'string') return
  throw new ValidationError({ collection, errors: [{ path: 'email', message: 'Enter a valid email address.' }], req })
}

/** A password was sent (Payload ignores an empty one on update). */
const sentPassword = (data: Data): boolean =>
  Boolean(data) && data!.password !== undefined && data!.password !== null && data!.password !== ''

export const customerAuthBeforeOperation: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (isGuardedAuthOperation(operation)) refuseCrossSiteAuth(req)
  const data = dataOf(args)
  assertEmailIsText('customers', operation, data, req)
  switch (operation) {
    case 'create':
      enforceAuthLimit(req, 'signup')
      // Missing password on create: left to Payload ("required"). Anything sent must pass the policy.
      if (data && data.password !== undefined) assertPasswordPolicy(data.password)
      break
    case 'update':
      if (sentPassword(data)) assertPasswordPolicy(data!.password)
      break
    case 'login':
      enforceAuthLimit(req, 'login')
      break
    case 'forgotPassword':
      enforceAuthLimit(req, 'forgotPassword', { email: data?.email })
      break
    case 'resetPassword':
      enforceAuthLimit(req, 'resetPassword')
      assertPasswordPolicy(data?.password)
      break
    default:
      break
  }
  return args
}

/**
 * Staff (`users`) auth operations: the same cross-site refusal (a forged staff login would put a browser in
 * the attacker's admin session). Rate limits and the password policy stay customer-only.
 */
export const staffAuthBeforeOperation: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (isGuardedAuthOperation(operation)) refuseCrossSiteAuth(req)
  assertEmailIsText('users', operation, dataOf(args), req)
  return args
}

/** POST /api/customers/verify/:id — rate-limited wrapper around Payload's verifyEmailOperation. */
export const customerVerifyEndpoint: Endpoint = {
  path: '/verify/:id',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    enforceAuthLimit(req, 'verify')
    const token = String(req.routeParams?.id ?? '')
    await verifyEmailOperation({ collection: req.payload.collections.customers, req, token })
    return Response.json(
      { message: req.t('authentication:accountVerified') },
      { headers: headersWithCors({ headers: new Headers(), req }), status: 200 },
    )
  },
}
