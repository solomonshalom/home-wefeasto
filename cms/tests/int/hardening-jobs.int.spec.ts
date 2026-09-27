import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { createCustomer, login } from './helpers/factories'
import { getTestPayload, makeReq } from './helpers/payload'
import { restDelete, restGet, restPatch, restPost } from './helpers/rest'

/**
 * cms-hardening §3: the jobs queue is server state. No customer (or guest) may write any payload-jobs*
 * collection or global. Payload's `schedule` option would add a `payload-jobs-stats` global whose default
 * access lets any signed-in user write it; the checkout jobs deliberately avoid `schedule` (Vercel Cron
 * calls /api/payments/reconcile and /api/payload-jobs/run instead). This guard fails if that changes
 * without locking the global down.
 */

let payload: Payload
let customerToken: string
let customerUser: Record<string, unknown>

beforeAll(async () => {
  payload = await getTestPayload()
  const c = await createCustomer(payload)
  const session = await login('customers', c.email)
  customerToken = session.token
  customerUser = { ...session.user, collection: 'customers' }
})

const jobCollections = () => payload.config.collections.map((c) => c.slug).filter((s) => s.startsWith('payload-jobs'))
const jobGlobals = () => payload.config.globals.map((g) => g.slug).filter((s) => s.startsWith('payload-jobs'))

describe('payload-jobs* is closed to customers and guests', () => {
  it('knows which job slugs exist (a new one must be reviewed here)', () => {
    expect(jobCollections()).toEqual(['payload-jobs'])
    // No scheduler state global: `schedule` is not used (see src/jobs/checkout/index.ts).
    expect(jobGlobals()).toEqual([])
    expect(JSON.stringify(payload.config.jobs ?? {})).not.toMatch(/"schedule"/)
  })

  it('REST: customers and guests cannot create, read, update or delete jobs', async () => {
    const job = (await payload.jobs.queue({ task: 'refillReminder' as never, input: {} as never })) as unknown as { id: number }
    for (const slug of jobCollections()) {
      for (const token of [customerToken, undefined]) {
        const who = token ? 'customer' : 'guest'
        expect((await restPost(slug, { token, body: { taskSlug: 'refillReminder', input: {} } })).status, `${who} create`).toBe(403)
        expect((await restGet(slug, { token })).status, `${who} list`).toBe(403)
        expect([403, 404], `${who} update`).toContain((await restPatch(`${slug}/${job.id}`, { token, body: { processing: true } })).status)
        expect([403, 404], `${who} delete`).toContain((await restDelete(`${slug}/${job.id}`, { token })).status)
      }
    }
    const still = await payload.findByID({ collection: 'payload-jobs', id: job.id })
    expect(still.processing).toBeFalsy()
    await payload.delete({ collection: 'payload-jobs', id: job.id })
  })

  it('access functions deny a customer every write on every payload-jobs* collection and global', async () => {
    const req = await makeReq(customerUser as never)
    for (const slug of jobCollections()) {
      const access = payload.collections[slug as 'payload-jobs'].config.access as Record<string, unknown>
      for (const op of ['create', 'update', 'delete']) {
        const fn = access[op] as ((args: unknown) => unknown) | undefined
        expect(fn, `${slug}.${op} must have an access function`).toBeTypeOf('function')
        expect(Boolean(await fn!({ req })), `${slug}.${op}`).toBe(false)
      }
    }
    for (const slug of jobGlobals()) {
      const global = payload.config.globals.find((g) => g.slug === slug)!
      const update = global.access?.update as ((args: unknown) => unknown) | undefined
      expect(update && !(await update({ req })), `${slug}.update`).toBe(true)
      expect((await restPost(`globals/${slug}`, { token: customerToken, body: {} })).status).toBe(403)
    }
  })

  it('the queue runner and job controls need the cron secret or an admin', async () => {
    expect((await restGet('payload-jobs/run', { token: customerToken })).status).toBe(401)
    expect((await restPost('payload-jobs/queue', { token: customerToken, body: { input: {}, task: 'refillReminder' } })).status).toBeGreaterThanOrEqual(401)
  })
})
