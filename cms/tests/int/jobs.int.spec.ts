import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { createCustomer, createStaff, login } from './helpers/factories'
import { deleteMessagesTo, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet } from './helpers/rest'

const CRON = 'test-cron-secret-0123456789'
let payload: Payload
let adminToken: string
let editorToken: string
let customerToken: string

beforeAll(async () => {
  payload = await getTestPayload()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
  editorToken = (await login('users', (await createStaff(payload, 'editor')).email)).token
  customerToken = (await login('customers', (await createCustomer(payload)).email)).token
})

describe('GET /api/payload-jobs/run access', () => {
  it('accepts Vercel Cron (Bearer CRON_SECRET) and admins', async () => {
    expect((await restGet('payload-jobs/run', { headers: { Authorization: `Bearer ${CRON}` } })).status).toBe(200)
    expect((await restGet('payload-jobs/run', { token: adminToken })).status).toBe(200)
  })

  it('refuses anonymous, wrong secrets, editors and customers', async () => {
    expect((await restGet('payload-jobs/run')).status).toBe(401)
    expect((await restGet('payload-jobs/run', { headers: { Authorization: `Bearer ${CRON}x` } })).status).toBe(401)
    expect((await restGet('payload-jobs/run', { headers: { Authorization: `Bearer ` } })).status).toBe(401)
    expect((await restGet('payload-jobs/run', { headers: { Authorization: CRON } })).status).toBe(401)
    expect((await restGet('payload-jobs/run', { token: editorToken })).status).toBe(401)
    expect((await restGet('payload-jobs/run', { token: customerToken })).status).toBe(401)
  })

  it('runs a queued sendEmail task exactly once', async () => {
    const to = uniqueEmail('job')
    await deleteMessagesTo(to)
    const input = { key: `job:${to}`, to, subject: 'Queued hello', html: '<p>hi</p>', text: 'hi' }
    await payload.jobs.queue({ task: 'sendEmail', input })
    await payload.jobs.queue({ task: 'sendEmail', input })
    const res = await restGet('payload-jobs/run', { headers: { Authorization: `Bearer ${CRON}` }, query: 'limit=10' })
    expect(res.status).toBe(200)
    expect(await waitForMessages(to)).toHaveLength(1)
    const { docs } = await payload.find({ collection: 'message-log', where: { key: { equals: input.key } } })
    expect(docs[0].status).toBe('sent')
  })
})
