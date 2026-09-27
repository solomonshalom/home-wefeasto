import type { Payload } from 'payload'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { paragraph, renderEmail, renderText } from '@/email/layout'
import { sendOnce } from '@/email/sendOnce'

import { createOrder } from './helpers/factories'
import { deleteMessagesTo, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

const message = (to: string, subject: string) => ({
  to,
  subject,
  html: renderEmail({ heading: subject, bodyHtml: paragraph('Your breakfast is on its way.') }),
  text: renderText({ heading: subject, paragraphs: ['Your breakfast is on its way.'] }),
})

async function logRow(key: string) {
  const { docs } = await payload.find({ collection: 'message-log', where: { key: { equals: key } } })
  return docs
}

describe('sendOnce', () => {
  it('sends exactly one email under 8 concurrent calls with the same key', async () => {
    const to = uniqueEmail('once')
    await deleteMessagesTo(to)
    const key = `confirm:${to}`
    const req = await makeReq()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sendOnce({ key, type: 'order-confirmation', req, ...message(to, 'Order confirmed') })),
    )
    expect(results.filter((r) => r === 'sent')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(7)

    await waitForMessages(to)
    const all = await settleAndList(to, 1000)
    expect(all).toHaveLength(1)
    const full = await getMessage(all[0].ID)
    expect(full.Subject).toBe('Order confirmed')
    expect(full.Text).toContain('Your breakfast is on its way.')
    expect(full.HTML).toContain('Wefeasto')

    const rows = await logRow(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'sent', to, type: 'order-confirmation', attempts: 1 })
    expect(rows[0].sentAt).toBeTruthy()

    // Later retries stay duplicates.
    expect(await sendOnce({ key, payload, ...message(to, 'Order confirmed') })).toBe('duplicate')
    expect(await settleAndList(to, 300)).toHaveLength(1)
  })

  it('different keys to the same person are separate messages', async () => {
    const to = uniqueEmail('twokeys')
    await deleteMessagesTo(to)
    expect(await sendOnce({ key: `a:${to}`, payload, ...message(to, 'First') })).toBe('sent')
    expect(await sendOnce({ key: `b:${to}`, payload, ...message(to, 'Second') })).toBe('sent')
    expect(await waitForMessages(to, { count: 2 })).toHaveLength(2)
  })

  it('links the log row to an order', async () => {
    const order = await createOrder(payload)
    const to = uniqueEmail('order')
    const key = `confirm:${order.number}`
    expect(await sendOnce({ key, order: order.id, payload, ...message(to, `Order ${order.number} confirmed`) })).toBe('sent')
    const [row] = await logRow(key)
    expect(typeof row.order === 'object' ? row.order?.id : row.order).toBe(order.id)
  })

  it('marks SMTP failures as failed without throwing, and a later retry delivers once', async () => {
    const to = uniqueEmail('retry')
    await deleteMessagesTo(to)
    const key = `retry:${to}`
    const spy = vi.spyOn(payload, 'sendEmail').mockRejectedValueOnce(new Error('SMTP 421 try later'))
    try {
      expect(await sendOnce({ key, payload, ...message(to, 'Retry me') })).toBe('failed')
    } finally {
      spy.mockRestore()
    }
    const [failed] = await logRow(key)
    expect(failed).toMatchObject({ status: 'failed', error: 'SMTP 421 try later' })
    expect(await settleAndList(to, 300)).toHaveLength(0)

    // Concurrent retries: exactly one re-claims the failed row.
    const results = await Promise.all(Array.from({ length: 5 }, () => sendOnce({ key, payload, ...message(to, 'Retry me') })))
    expect(results.filter((r) => r === 'sent')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4)
    await waitForMessages(to)
    expect(await settleAndList(to, 500)).toHaveLength(1)
    const [row] = await logRow(key)
    expect(row).toMatchObject({ status: 'sent', attempts: 2 })
    expect(row.error ?? null).toBeNull()
  })

  it('re-claims a row stuck in pending past the stale window, but not a fresh one', async () => {
    const to = uniqueEmail('stale')
    await deleteMessagesTo(to)
    const key = `stale:${to}`
    const row = await payload.create({ collection: 'message-log', data: { key, to, status: 'pending', attempts: 1 } })
    expect(await sendOnce({ key, payload, ...message(to, 'Stale') })).toBe('duplicate')
    // Age the claim.
    await payload.db.updateOne({
      collection: 'message-log',
      id: row.id,
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      returning: false,
    })
    expect(await sendOnce({ key, payload, ...message(to, 'Stale') })).toBe('sent')
    await waitForMessages(to)
  })

  it('rejects missing arguments', async () => {
    await expect(sendOnce({ key: '', to: 'a@b.dev', subject: 's', html: 'h', payload })).rejects.toThrow()
    await expect(sendOnce({ key: 'k', to: 'a@b.dev', subject: 's', html: 'h' })).rejects.toThrow()
  })
})
