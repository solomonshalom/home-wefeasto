import crypto from 'crypto'
import type { Payload } from 'payload'

import { VERIFY_EMAIL_SUBJECT, verifyEmailHtml } from '../email/customerAuth'

export type ResendOutcome = 'sent' | 'no_account' | 'already_verified'

/**
 * Re-sends the signup verification email to an existing, unverified customer with a FRESH token (the
 * previous link stops working). Same subject, template and link format as the email Payload sends at
 * signup (STOREFRONT_URL/login?verify=<40 hex chars>). Unknown or verified addresses: nothing happens.
 *
 * The outcome is for logs and tests only: the endpoint answers 200 {ok:true} whatever it is.
 */
export async function resendVerificationEmail(payload: Payload, email: string): Promise<ResendOutcome> {
  const found = await payload.find({
    collection: 'customers',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    showHiddenFields: true,
  })
  const user = found.docs[0]
  if (!user) return 'no_account'
  if (user._verified === true) return 'already_verified'

  // Same token shape Payload generates at signup (crypto.randomBytes(20).toString('hex')).
  const token = crypto.randomBytes(20).toString('hex')
  // One conditional UPDATE of the token column only: never re-opens an account verified meanwhile.
  const updated = await payload.db.updateOne({
    collection: 'customers',
    where: { and: [{ id: { equals: user.id } }, { _verified: { not_equals: true } }] },
    data: { _verificationToken: token },
  })
  if (!updated) return 'already_verified'

  await payload.sendEmail({
    to: user.email,
    subject: VERIFY_EMAIL_SUBJECT,
    html: verifyEmailHtml({ token, user }),
  })
  return 'sent'
}
