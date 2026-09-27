import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { parseOrderNumber } from '@/commerce/orderNumber'
import { deriveOrderToken, hashToken, newTokenNonce, verifyOrderToken } from '@/commerce/orderToken'

import { createOrder } from './helpers/factories'
import { getTestPayload } from './helpers/payload'

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

describe('orders collection (Local API)', () => {
  it('assigns number, nonce and tokenHash on create', async () => {
    const order = await createOrder(payload)
    expect(order.number).toMatch(/^WF-\d{5,}$/)
    expect(parseOrderNumber(order.number)).toBeGreaterThan(10000)
    // hidden fields are not returned by default…
    expect(order).not.toHaveProperty('tokenNonce')
    // …but are stored.
    const full = await payload.findByID({ collection: 'orders', id: order.id, showHiddenFields: true })
    expect(full.tokenNonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const token = deriveOrderToken(order.id, full.tokenNonce!)
    expect(full.tokenHash).toBe(hashToken(token))
    expect(verifyOrderToken(full, token)).toBe(true)
    expect(verifyOrderToken(full, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(false)
    // Items (arrays) survived the tokenHash write.
    expect(full.items).toHaveLength(1)
    expect(full.items[0]).toMatchObject({ slug: 'rolled-oats', qty: 2, unitPaise: 24900, lineTotalPaise: 49800 })
    // Lookup by hash works.
    const found = await payload.find({ collection: 'orders', where: { tokenHash: { equals: hashToken(token) } } })
    expect(found.docs.map((d) => d.id)).toEqual([order.id])
  })

  it('keeps a caller-supplied nonce and number', async () => {
    const nonce = newTokenNonce()
    const order = await createOrder(payload, { tokenNonce: nonce, number: 'WF-99999' })
    expect(order.number).toBe('WF-99999')
    const full = await payload.findByID({ collection: 'orders', id: order.id, showHiddenFields: true })
    expect(full.tokenNonce).toBe(nonce)
    expect(full.tokenHash).toBe(hashToken(deriveOrderToken(order.id, nonce)))
  })

  it('applies the documented defaults', async () => {
    const order = await createOrder(payload)
    expect(order).toMatchObject({
      status: 'pending_payment',
      paymentStatus: 'none',
      fulfilmentStatus: 'unfulfilled',
      stockState: 'reserved',
      currency: 'INR',
      source: 'web',
    })
  })

  it('enforces unique idempotencyKey and number', async () => {
    const a = await createOrder(payload)
    await expect(createOrder(payload, { idempotencyKey: a.idempotencyKey })).rejects.toThrow()
    await expect(createOrder(payload, { number: a.number })).rejects.toThrow()
  })

  it('rejects non-integer money and empty items', async () => {
    await expect(createOrder(payload, { totalPaise: 10.5 })).rejects.toThrow()
    await expect(createOrder(payload, { items: [] })).rejects.toThrow()
    await expect(createOrder(payload, { status: 'shipped' })).rejects.toThrow()
  })

  it('records status history for every status change, labelled by context', async () => {
    const order = await createOrder(payload)
    expect(order.statusHistory).toHaveLength(1)
    expect(order.statusHistory![0]).toMatchObject({ field: 'status', from: null, to: 'pending_payment', source: 'system' })

    const paid = await payload.update({
      collection: 'orders',
      id: order.id,
      data: { status: 'paid', paymentStatus: 'captured' },
      context: { statusSource: 'webhook', statusNote: 'payment.captured pay_123' },
    })
    const rows = paid.statusHistory!
    expect(rows).toHaveLength(3)
    expect(rows.slice(1).map((r) => [r.field, r.from, r.to, r.source, r.note])).toEqual([
      ['status', 'pending_payment', 'paid', 'webhook', 'payment.captured pay_123'],
      ['paymentStatus', 'none', 'captured', 'webhook', 'payment.captured pay_123'],
    ])

    // An update that does not change a status adds nothing.
    const same = await payload.update({ collection: 'orders', id: order.id, data: { reviewReason: 'n/a' } })
    expect(same.statusHistory).toHaveLength(3)
  })

  it('supports razorpay attempts lookups by nested order id and unique payment id', async () => {
    const rzp = `order_${Date.now()}`
    const order = await createOrder(payload, {
      razorpay: { attempts: [{ orderId: rzp, receipt: 'WF-x-a1', amount: 49800, status: 'created', createdAt: new Date().toISOString() }] },
    })
    const found = await payload.find({ collection: 'orders', where: { 'razorpay.attempts.orderId': { equals: rzp } } })
    expect(found.docs.map((d) => d.id)).toEqual([order.id])

    const pay = `pay_${Date.now()}`
    await payload.update({ collection: 'orders', id: order.id, data: { razorpay: { ...order.razorpay, paymentId: pay } } })
    const other = await createOrder(payload)
    await expect(
      payload.update({ collection: 'orders', id: other.id, data: { razorpay: { paymentId: pay } } }),
    ).rejects.toThrow()
  })

  it('atomic conditional updates work on orders (the markPaid building block)', async () => {
    const order = await createOrder(payload)
    const claim = () =>
      payload.db.updateOne({
        collection: 'orders',
        where: { and: [{ id: { equals: order.id } }, { status: { in: ['pending_payment', 'payment_failed', 'expired'] } }] },
        data: { status: 'paid' },
        options: { atomic: true },
      })
    const results = await Promise.all([claim(), claim(), claim()])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('admin status edits follow the shared state machine', () => {
  let adminToken: string
  beforeAll(async () => {
    const { createStaff, login } = await import('./helpers/factories')
    adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
  })

  const patch = async (id: number, body: Record<string, unknown>) => {
    const { restPatch } = await import('./helpers/rest')
    return restPatch(`orders/${id}`, { token: adminToken, body })
  }

  it('allows event-table transitions and records them as admin', async () => {
    const order = await createOrder(payload)
    const res = await patch(order.id, { status: 'cancelled' })
    expect(res.status).toBe(200)
    const doc = await payload.findByID({ collection: 'orders', id: order.id })
    expect(doc.status).toBe('cancelled')
    expect(doc.statusHistory!.at(-1)).toMatchObject({ field: 'status', from: 'pending_payment', to: 'cancelled' })
    expect(doc.statusHistory!.at(-1)!.source).toMatch(/^admin:\d+$/)
  })

  it('rejects impossible jumps (pending → refunded, refunded → paid)', async () => {
    const order = await createOrder(payload)
    const bad = await patch(order.id, { status: 'refunded' })
    expect(bad.status).toBe(400)
    expect((await payload.findByID({ collection: 'orders', id: order.id })).status).toBe('pending_payment')

    const refunded = await createOrder(payload, { status: 'refunded' })
    expect((await patch(refunded.id, { status: 'paid' })).status).toBe(400)
  })

  it('fulfilment only moves forward, and only for paid / confirmed COD orders', async () => {
    const unpaid = await createOrder(payload)
    expect((await patch(unpaid.id, { fulfilmentStatus: 'packed' })).status).toBe(400)

    const cod = await createOrder(payload, { status: 'cod_pending', requestedMethod: 'cod', paymentMethod: 'cod' })
    expect((await patch(cod.id, { fulfilmentStatus: 'shipped' })).status).toBe(400)
    expect((await patch(cod.id, { status: 'cod_confirmed' })).status).toBe(200)
    expect((await patch(cod.id, { fulfilmentStatus: 'shipped' })).status).toBe(200)
    expect((await patch(cod.id, { fulfilmentStatus: 'packed' })).status).toBe(400) // backwards
    expect((await patch(cod.id, { fulfilmentStatus: 'delivered' })).status).toBe(200)
    const doc = await payload.findByID({ collection: 'orders', id: cod.id })
    expect(doc.fulfilmentStatus).toBe('delivered')
    expect(doc.statusHistory!.filter((r) => r.field === 'fulfilmentStatus').map((r) => r.to)).toEqual(['shipped', 'delivered'])
  })

  it('payment status never goes backwards over REST', async () => {
    const order = await createOrder(payload, { status: 'paid', paymentStatus: 'captured' })
    expect((await patch(order.id, { paymentStatus: 'failed' })).status).toBe(400)
    expect((await patch(order.id, { paymentStatus: 'refunded' })).status).toBe(200)
  })

  it('server code (Local API) is not blocked by the admin guard', async () => {
    const order = await createOrder(payload, { status: 'refunded' })
    const updated = await payload.update({ collection: 'orders', id: order.id, data: { status: 'needs_review' } })
    expect(updated.status).toBe('needs_review')
  })
})
