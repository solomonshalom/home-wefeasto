import type { TaskConfig, WorkflowConfig } from 'payload'

import { REFILL_TASK, runRefillReminder } from '../../retention/refill'

/**
 * Retention jobs — OWNER: retention agent. Contract: SCRATCH/contracts/retention-backend.md.
 *
 * `refillReminder` (S2): queued by the order-event handlers in src/retention/register.ts with
 * `waitUntil` = the reminder time (10:00 IST), queue 'default'. It runs whenever Vercel Cron calls
 * GET /api/payload-jobs/run (Bearer CRON_SECRET) after that time. It re-checks the order and sends
 * `refill:<no>:1` at most once; every skip returns normally (output.result = 'skipped:<why>'), and only
 * an SMTP failure throws, so the runner retries (3×).
 */
const refillReminderTask: TaskConfig<'refillReminder'> = {
  slug: REFILL_TASK,
  label: 'Refill reminder email (S2)',
  retries: 3,
  inputSchema: [
    { name: 'orderId', type: 'number', required: true },
    { name: 'number', type: 'text' },
    /** Scheduling version: 'h' + household size (0 = unanswered). A stale stamp exits as superseded. */
    { name: 'stamp', type: 'text', required: true },
    { name: 'reminder', type: 'number' },
  ],
  outputSchema: [{ name: 'result', type: 'text' }],
  handler: async ({ input, req }) => {
    const result = await runRefillReminder(req.payload, {
      orderId: input.orderId,
      number: input.number,
      stamp: input.stamp,
      reminder: input.reminder,
    })
    req.payload.logger.info({ msg: 'refillReminder', order: input.number, result })
    return { output: { result } }
  },
}

export const retentionTasks = [refillReminderTask] as TaskConfig[]
export const retentionWorkflows: WorkflowConfig[] = []
