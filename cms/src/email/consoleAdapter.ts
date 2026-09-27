import type { EmailAdapter, SendEmailOptions } from 'payload'

/**
 * Dev fallback when SMTP_HOST is empty. Unlike Payload's built-in fallback (which only logs the subject),
 * this logs recipient, subject and every link in the message, so verify/reset links are usable locally.
 */
export const consoleEmailAdapter =
  ({ fromName, fromAddress }: { fromName: string; fromAddress: string }): EmailAdapter =>
  ({ payload }) => ({
    name: 'console',
    defaultFromAddress: fromAddress,
    defaultFromName: fromName,
    sendEmail: async (message: SendEmailOptions) => {
      const html = typeof message.html === 'string' ? message.html : ''
      const text = typeof message.text === 'string' ? message.text : ''
      const links = [...new Set([...`${html} ${text}`.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, '&')))]
      payload.logger.info(
        `[email:console] to=${JSON.stringify(message.to)} subject=${JSON.stringify(message.subject)}` +
          (links.length ? `\n  links:\n    ${links.join('\n    ')}` : ''),
      )
      return { accepted: [message.to], messageId: `console-${Date.now()}` }
    },
  })
