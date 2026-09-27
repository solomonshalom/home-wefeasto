import type { JobsConfig } from 'payload'

import { canManageJobs, canRunJobs } from './access'
import { checkoutTasks, checkoutWorkflows } from './checkout'
import { retentionTasks, retentionWorkflows } from './retention'
import { systemTasks } from './system'

/**
 * Jobs queue. NO autoRun (serverless): Vercel Cron calls GET /api/payload-jobs/run?limit=…&queue=…
 * with `Authorization: Bearer $CRON_SECRET` (see vercel.json in the CMS project). Add tasks to the
 * area registry (./checkout, ./retention), not here.
 */
export const jobs: JobsConfig = {
  access: {
    run: canRunJobs,
    queue: canManageJobs,
    cancel: canManageJobs,
  },
  tasks: [...systemTasks, ...checkoutTasks, ...retentionTasks],
  workflows: [...checkoutWorkflows, ...retentionWorkflows],
}
