import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { emitOrderEvent } from '@/commerce/events'
import { deriveOrderToken, newTokenNonce } from '@/commerce/orderToken'
import type { Order, PayloadJob, Product } from '@/payload-types'
import { registerRetentionHandlers } from '@/retention/register'

import { createProduct } from './helpers/catalogFactories'
import { createOrder } from './helpers/factories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * POST /api/store/orders/household {number, token, size} ("Breakfast for how many?" on /order):
 * guest-token protected, stores householdSize, emits order.household_updated → the refill reminder is
 * re-queued with the new size.
 */

const PAID_AT = '2031-01-15T06:00:00.000Z' // 11:30 IST
let payload: Payload
let oats: Product

beforeAll(async () => {
  payload = await getTestPayload()
  registerRetentionHandlers()
  oats = (await createProduct(payload, { daysPerPack: 14 })) as Product
})

async function placed(status: Order['status'] = 'paid'): Promise<{ order: Order; token: string }> {
  const tokenNonce = newTokenNonce()
  const order = (await createOrder(payload, {
    tokenNonce,
    contact: { name: 'Asha Rao', email: uniqueEmail('household'), phone: `+9195${String(Date.now()).slice(-8)}` },
    items: [{ product: oats.id, slug: oats.slug, name: oats.name, unitPaise: oats.pricePaise, qty: 2, lineTotalPaise: oats.pricePaise! * 2 }],
    subtotalPaise: oats.pricePaise! * 2,
    totalPaise: oats.pricePaise! * 2,
    status,
    paymentStatus: status === 'paid' ? 'captured' : 'none',
    paidAt: status === 'paid' ? PAID_AT : null,
    consent: { marketing: true, at: new Date().toISOString(), text: 'Email me.' },
  })) as Order
  return { order, token: deriveOrderToken(order.id, tokenNonce) }
}

const post = (body: unknown) => restPost('store/orders/household', { body })

async function jobsFor(orderId: number): Promise<PayloadJob[]> {
  const res = await payload.find({ collection: 'payload-jobs', where: { taskSlug: { equals: 'refillReminder' } }, pagination: false, limit: 0 })
  return (res.docs as PayloadJob[]).filter((j) => (j.input as { orderId?: number })?.orderId === orderId)
}

const stampAt = (jobs: PayloadJob[]) =>
  Object.fromEntries(jobs.map((j) => [(j.input as { stamp: string }).stamp, new Date(j.waitUntil!).toISOString()]))

describe('POST /api/store/orders/household', () => {
  it('stores the answer and re-queues the reminder for the new household size', async () => {
    const { order, token } = await placed()
    await emitOrderEvent(await makeReq(), { type: 'order.confirmed', order, source: 'test' })
    expect(stampAt(await jobsFor(order.id))).toEqual({ h0: '2031-01-24T04:30:00.000Z' }) // 2×14/2 = 14 → +9

    const res = await post({ number: order.number, token, size: 3 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect((await payload.findByID({ collection: 'orders', id: order.id })).householdSize).toBe(3)
    // 2×14/3 = 9.33 → round(7.0) − 2 = +5 days.
    expect(stampAt(await jobsFor(order.id))).toEqual({ h0: '2031-01-24T04:30:00.000Z', h3: '2031-01-20T04:30:00.000Z' })

    // Same answer again: nothing new. "4+" arrives as 4 (a digit string is fine too).
    expect((await post({ number: order.number, token, size: 3 })).status).toBe(200)
    expect(await jobsFor(order.id)).toHaveLength(2)
    expect((await post({ number: ` ${order.number} `, token, size: '4' })).status).toBe(200)
    expect(stampAt(await jobsFor(order.id))).toMatchObject({ h4: '2031-01-18T04:30:00.000Z' }) // 7 → +3
  })

  it('unknown order and wrong token get the same 404', async () => {
    const { order, token } = await placed()
    const wrong = await post({ number: order.number, token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, size: 2 })
    const unknown = await post({ number: 'WF-99999999', token, size: 2 })
    const junk = await post({ number: 'nope', token, size: 2 })
    const missing = await post({ number: order.number, size: 2 })
    for (const r of [wrong, unknown, junk, missing]) {
      expect(r.status).toBe(404)
      expect(r.text).toBe(unknown.text)
    }
    expect(unknown.body.error.code).toBe('NOT_FOUND')
    // Even with a bad size, a bad token says nothing more.
    expect((await post({ number: order.number, token: 'x', size: 0 })).status).toBe(404)
    expect((await payload.findByID({ collection: 'orders', id: order.id })).householdSize ?? null).toBeNull()
  })

  it('size must be a whole number from 1 to 20', async () => {
    const { order, token } = await placed()
    for (const size of [0, -1, 21, 2.5, '2.5', 'abc', '', null, true, [2]]) {
      const res = await post({ number: order.number, token, size })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION', details: { fields: { size: 'INVALID' } } })
    }
    expect((await post({ number: order.number, token, size: 20 })).status).toBe(200)
    expect((await post({ number: order.number, token, size: 1 })).status).toBe(200)
  })

  it('an unconfirmed order stores the answer but queues nothing', async () => {
    const { order, token } = await placed('pending_payment')
    expect((await post({ number: order.number, token, size: 2 })).status).toBe(200)
    expect((await payload.findByID({ collection: 'orders', id: order.id })).householdSize).toBe(2)
    expect(await jobsFor(order.id)).toHaveLength(0)
  })

  it('JSON only', async () => {
    expect((await restPost('store/orders/household', { rawBody: 'number=WF-10001', contentType: 'application/x-www-form-urlencoded' })).status).toBe(415)
    expect((await restPost('store/orders/household', { rawBody: '{', contentType: 'application/json' })).status).toBe(400)
  })
})
