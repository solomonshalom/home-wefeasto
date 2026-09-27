import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

let payload: Payload
let adminToken: string

beforeAll(async () => {
  payload = await getTestPayload()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
})

const suffix = () => Date.now().toString(36).toUpperCase()

describe('coupons', () => {
  it('stores codes trimmed and uppercased, and treats case variants as duplicates', async () => {
    const base = `welcome-${suffix()}`
    const res = await restPost('coupons', { token: adminToken, body: { code: `  ${base}  `, type: 'percent', value: 10 } })
    expect(res.status).toBe(201)
    expect(res.body.doc.code).toBe(base.toUpperCase())
    const dupe = await restPost('coupons', { token: adminToken, body: { code: base.toUpperCase(), type: 'fixed', value: 500 } })
    expect(dupe.status).toBe(400)
    const dupe2 = await restPost('coupons', { token: adminToken, body: { code: base.toLowerCase(), type: 'fixed', value: 500 } })
    expect(dupe2.status).toBe(400)
  })

  it('validates code format and values per type', async () => {
    const bad = [
      { code: 'A', type: 'percent', value: 10 },
      { code: 'HAS SPACE', type: 'percent', value: 10 },
      { code: `P0-${suffix()}`, type: 'percent', value: 0 },
      { code: `P101-${suffix()}`, type: 'percent', value: 101 },
      { code: `F0-${suffix()}`, type: 'fixed', value: 0 },
      { code: `FR-${suffix()}`, type: 'fixed', value: 10.5 },
    ]
    for (const body of bad) {
      const res = await restPost('coupons', { token: adminToken, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    const ok = await restPost('coupons', { token: adminToken, body: { code: `SHIP-${suffix()}`, type: 'free_delivery', value: 0 } })
    expect(ok.status).toBe(201)
  })

  it('normalises boundEmail and uppercases via the Local API too', async () => {
    const doc = await payload.create({
      collection: 'coupons',
      data: { code: `bound-${suffix()}`, type: 'percent', value: 10, usedCount: 0, boundEmail: '  Asha@Example.COM ' },
    })
    expect(doc.code).toMatch(/^BOUND-/)
    expect(doc.boundEmail).toBe('asha@example.com')
  })

  it('coupon-redemptions allow one row per order', async () => {
    const coupon = await payload.create({ collection: 'coupons', data: { code: `R-${suffix()}`, type: 'percent', value: 5, usedCount: 0 } })
    const { createOrder } = await import('./helpers/factories')
    const order = await createOrder(payload)
    const data = { coupon: coupon.id, code: coupon.code, order: order.id, email: 'a@b.dev', discountPaise: 100, status: 'reserved' as const }
    await payload.create({ collection: 'coupon-redemptions', data })
    await expect(payload.create({ collection: 'coupon-redemptions', data })).rejects.toThrow()
  })

  it('subscribers are unique by lowercased email', async () => {
    const email = `News-${suffix()}@Example.com`
    const a = await payload.create({ collection: 'subscribers', data: { email, status: 'pending' } })
    expect(a.email).toBe(email.toLowerCase())
    await expect(payload.create({ collection: 'subscribers', data: { email: email.toUpperCase(), status: 'pending' } })).rejects.toThrow()
  })
})
