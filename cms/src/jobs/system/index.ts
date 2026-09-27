import type { TaskConfig } from 'payload'

import { sendOnce } from '../../email/sendOnce'

/**
 * Foundation tasks (cms-foundation). `sendEmail` delivers one message through sendOnce with retries:
 *   await payload.jobs.queue({ task: 'sendEmail', input: { key, to, subject, html, text } })
 * A 'duplicate' result counts as success; 'failed' throws so the jobs runner retries (3×).
 */
const sendEmailTask: TaskConfig<'sendEmail'> = {
    slug: 'sendEmail',
    label: 'Send email (exactly once)',
    retries: 3,
    inputSchema: [
      { name: 'key', type: 'text', required: true },
      { name: 'to', type: 'text', required: true },
      { name: 'subject', type: 'text', required: true },
      { name: 'html', type: 'textarea', required: true },
      { name: 'text', type: 'textarea' },
      { name: 'type', type: 'text' },
      { name: 'order', type: 'number' },
    ],
    outputSchema: [{ name: 'result', type: 'text' }],
    handler: async ({ input, req }) => {
      const result = await sendOnce({
        key: input.key,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text ?? undefined,
        type: input.type ?? undefined,
        order: input.order ?? undefined,
        req,
      })
      if (result === 'failed') throw new Error(`sendEmail ${input.key} failed; will retry`)
      return { output: { result } }
    },
}

export const systemTasks = [sendEmailTask] as TaskConfig[]
