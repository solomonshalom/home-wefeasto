import { paragraph, renderEmail, renderText } from '../layout'
import type { RenderedEmail } from './shared'

/**
 * Double opt-in confirmation (M6). Not a marketing email: the address is not on the list yet, so it has
 * no unsubscribe header; ignoring it is the opt-out.
 */
export function renderConfirmationEmail({ confirmUrl }: { confirmUrl: string }): RenderedEmail {
  const subject = 'Confirm your Wefeasto subscription'
  const heading = 'One tap to confirm'
  const lines = [
    'Thanks for signing up for Wefeasto breakfast recipes and offers.',
    'Tap the button to confirm it’s really you. The link works for 7 days.',
  ]
  const footerNote = "Didn't sign up? Ignore this email and you won't hear from us."
  const cta = { href: confirmUrl, label: 'Yes, subscribe me' }
  return {
    subject,
    html: renderEmail({
      heading,
      preheader: 'Confirm your email to get breakfast recipes (and a welcome treat).',
      bodyHtml: lines.map(paragraph).join('\n'),
      cta,
      footerNote,
    }),
    text: renderText({ heading, paragraphs: lines, cta, footerNote }),
  }
}
