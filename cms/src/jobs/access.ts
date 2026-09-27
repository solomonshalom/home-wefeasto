import type { PayloadRequest } from 'payload'

import { userIsAdmin } from '../access/roles'
import { getEnv } from '../env'
import { timingSafeEqualStr } from '../commerce/orderToken'

/**
 * Who may trigger GET /api/payload-jobs/run: Vercel Cron (Authorization: Bearer $CRON_SECRET) or a
 * signed-in admin. An empty CRON_SECRET never matches.
 */
export function canRunJobs({ req }: { req: PayloadRequest }): boolean {
  if (userIsAdmin(req.user)) return true
  const secret = getEnv().cronSecret
  if (!secret) return false
  const header = req.headers?.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return Boolean(m && timingSafeEqualStr(m[1], secret))
}

/** Queue/cancel jobs by hand: admins only (server code uses the Local API). */
export function canManageJobs({ req }: { req: PayloadRequest }): boolean {
  return userIsAdmin(req.user)
}
