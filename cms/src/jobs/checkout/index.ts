import type { TaskConfig, WorkflowConfig } from 'payload'

import { reconcilePendingOrders } from '../../commerce/checkout/reconcile'

/**
 * Checkout/payment jobs — OWNER: checkout-backend. Contract: SCRATCH/contracts/checkout-backend.md.
 *
 * `reconcilePendingOrders`: asks Razorpay about unpaid orders (markPaid or expire + release stock), late
 * authorisations on recently expired orders, re-sends confirmation emails that never went out and issues
 * queued automatic refunds (src/commerce/checkout/reconcile.ts). Idempotent; safe to overlap.
 *
 * Scheduling: Vercel Cron calls GET /api/payments/reconcile every 5 minutes (cms/vercel.json), which runs the
 * same function directly. This task exists so an admin can queue a run by hand
 *   await payload.jobs.queue({ task: 'reconcilePendingOrders', input: {} })   // then GET /api/payload-jobs/run
 * Payload's own `schedule` is deliberately not used: it adds a `payload-jobs-stats` global whose default
 * access lets any signed-in customer rewrite the scheduler's state.
 */
const reconcileTask: TaskConfig<'reconcilePendingOrders'> = {
  slug: 'reconcilePendingOrders',
  label: 'Reconcile pending orders with Razorpay',
  retries: 1,
  inputSchema: [
    { name: 'limit', type: 'number' },
    { name: 'budgetMs', type: 'number' },
  ],
  outputSchema: [{ name: 'summary', type: 'json' }],
  handler: async ({ input, req }) => {
    const summary = await reconcilePendingOrders(req.payload, {
      limit: input?.limit ?? undefined,
      budgetMs: input?.budgetMs ?? undefined,
    })
    req.payload.logger.info({ msg: 'reconcilePendingOrders (job)', ...summary })
    return { output: { summary } }
  },
}

export const checkoutTasks = [reconcileTask] as TaskConfig[]
export const checkoutWorkflows: WorkflowConfig[] = []
