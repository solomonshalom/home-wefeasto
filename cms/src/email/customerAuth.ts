import { getEnv } from '../env'
import { paragraph, renderEmail } from './layout'

/**
 * Customer account emails (sent by Payload's built-in auth flows on the `customers` collection).
 * Links go to the storefront, which calls the Payload REST endpoints:
 *   verify:  STOREFRONT_URL/login?verify=<token>           -> POST /api/customers/verify/<token>
 *   reset:   STOREFRONT_URL/reset-password?token=<token>   -> POST /api/customers/reset-password {token,password}
 */

type MaybeUser = { name?: unknown; email?: unknown } | null | undefined

const firstName = (user: MaybeUser): string => {
  const name = typeof user?.name === 'string' ? user.name.trim() : ''
  return name ? name.split(/\s+/)[0] : ''
}

export function verifyEmailUrl(token: string): string {
  return `${getEnv().storefrontUrl}/login?verify=${encodeURIComponent(token)}`
}

export function resetPasswordUrl(token: string): string {
  return `${getEnv().storefrontUrl}/reset-password?token=${encodeURIComponent(token)}`
}

export const VERIFY_EMAIL_SUBJECT = 'Confirm your Wefeasto account'
export const RESET_PASSWORD_SUBJECT = 'Reset your Wefeasto password'

export function verifyEmailHtml({ token, user }: { token: string; user?: MaybeUser }): string {
  const hi = firstName(user) ? `Hi ${firstName(user)},` : 'Hi there,'
  return renderEmail({
    heading: 'Confirm your email',
    preheader: 'One tap to finish setting up your Wefeasto account.',
    bodyHtml:
      paragraph(hi) +
      paragraph('Thanks for creating a Wefeasto account. Confirm your email address to sign in and track your orders.'),
    cta: { href: verifyEmailUrl(token), label: 'Confirm my email' },
    footerNote: "Didn't sign up? You can ignore this email — no account will be activated.",
  })
}

export function resetPasswordHtml({ token, user }: { token?: string; user?: MaybeUser }): string {
  const hi = firstName(user) ? `Hi ${firstName(user)},` : 'Hi there,'
  return renderEmail({
    heading: 'Reset your password',
    preheader: 'Use this link within the hour to choose a new password.',
    bodyHtml:
      paragraph(hi) +
      paragraph('We received a request to reset the password for your Wefeasto account. The link works for one hour.'),
    cta: { href: resetPasswordUrl(token ?? ''), label: 'Choose a new password' },
    footerNote: "Didn't ask for this? Ignore this email — your password stays the same.",
  })
}
