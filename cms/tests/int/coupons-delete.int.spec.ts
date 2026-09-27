import { APIError, type Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { COUPON_IN_USE_ERROR, couponInUseMessage } from '@/collections/Coupons'
import { createRedemption, lockCoupon } from '@/commerce/checkout/coupons'
import { inTransaction } from '@/commerce/checkout/db'

import { createOrder, createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restDelete, restGet } from './helpers/rest'

/**
 * CPN-DEL-1: deleting a coupon an order has used must be a clear 409 refusal (retire it via Active instead),
 * not a 500 from the coupon_redemptions.coupon_id NOT NULL + ON DELETE SET NULL FK. Unused coupons still delete.
 */

let payload: Payload
let adminToken: string
let seq = 0

beforeAll(async () => {
  payload = await getTestPayload()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
})

const code = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`.toUpperCase()

async function newCoupon(prefix = 'DEL') {
  return payload.create({ collection: 'coupons', data: { code: code(prefix), type: 'percent', value: 10, usedCount: 0 } })
}

async function redeem(couponId: number, couponCode: string, status: 'reserved' | 'consumed' | 'released' = 'reserved') {
  const order = await createOrder(payload)
  await payload.create({
    collection: 'coupon-redemptions',
    data: { coupon: couponId, code: couponCode, order: order.id, email: 'del@example.com', discountPaise: 100, status },
  })
  return order
}

const exists = async (id: number) =>
  Boolean(await payload.findByID({ collection: 'coupons', id, depth: 0, overrideAccess: true, disableErrors: true }))

describe('deleting coupons (CPN-DEL-1)', () => {
  it('refuses a used coupon with 409 and admin-facing copy; the row survives, still active', async () => {
    const c = await newCoupon('USED')
    await redeem(c.id, c.code, 'consumed')

    const res = await restDelete(`coupons/${c.id}`, { token: adminToken })
    expect(res.status).toBe(409)
    expect(res.body.errors[0].message).toBe(couponInUseMessage(1))
    expect(res.body.errors[0].message).toMatch(/can't be deleted.*Active/)
    expect(res.body.errors[0].data).toEqual({ code: 'COUPON_IN_USE', orders: 1 })
    expect(res.text).not.toMatch(/Something went wrong|coupon_id|not-null|violates/i)

    const after = await restGet(`coupons/${c.id}`, { token: adminToken })
    expect(after.status).toBe(200)
    expect(after.body.active).toBe(true)
  })

  it('counts every redemption status (reserved, consumed, released) and pluralises', async () => {
    const c = await newCoupon('MANY')
    await redeem(c.id, c.code, 'reserved')
    await redeem(c.id, c.code, 'released')
    const res = await restDelete(`coupons/${c.id}`, { token: adminToken })
    expect(res.status).toBe(409)
    expect(res.body.errors[0].message).toBe(couponInUseMessage(2))
    expect(res.body.errors[0].message).toMatch(/used on 2 orders,/)
    expect(await exists(c.id)).toBe(true)

    const released = await newCoupon('REL')
    await redeem(released.id, released.code, 'released')
    expect((await restDelete(`coupons/${released.id}`, { token: adminToken })).status).toBe(409)
    expect(await exists(released.id)).toBe(true)
  })

  it('an unused coupon still deletes with 200', async () => {
    const c = await newCoupon('FREE')
    const res = await restDelete(`coupons/${c.id}`, { token: adminToken })
    expect(res.status).toBe(200)
    expect(await exists(c.id)).toBe(false)
  })

  it('the used coupon can still be retired (PATCH active:false) after the refusal', async () => {
    const c = await newCoupon('RETIRE')
    await redeem(c.id, c.code)
    expect((await restDelete(`coupons/${c.id}`, { token: adminToken })).status).toBe(409)
    const { restPatch } = await import('./helpers/rest')
    const patched = await restPatch(`coupons/${c.id}`, { token: adminToken, body: { active: false } })
    expect(patched.status).toBe(200)
    expect(patched.body.doc.active).toBe(false)
  })

  it('bulk delete (admin list view) removes the unused coupon and refuses the used one with its public message', async () => {
    const used = await newCoupon('BULKU')
    await redeem(used.id, used.code)
    const unused = await newCoupon('BULKF')
    const res = await restDelete('coupons', {
      token: adminToken,
      query: { 'where[id][in]': `${used.id},${unused.id}` },
    })
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual([expect.objectContaining({ id: used.id, isPublic: true, message: couponInUseMessage(1) })])
    expect(res.body.docs.map((d: { id: number }) => d.id)).toEqual([unused.id])
    expect(await exists(used.id)).toBe(true)
    expect(await exists(unused.id)).toBe(false)
  })

  it('the Local API refuses too, with an APIError of status 409 (matched by class/status, never by name)', async () => {
    const c = await newCoupon('LOCAL')
    await redeem(c.id, c.code)
    const err = await payload.delete({ collection: 'coupons', id: c.id, overrideAccess: true }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(APIError)
    expect((err as APIError).status).toBe(409)
    expect(await exists(c.id)).toBe(true)
  })

  it('the refusal is an expected event: config.loggingLevels logs it at info, not error', () => {
    expect(payload.config.loggingLevels[COUPON_IN_USE_ERROR as keyof typeof payload.config.loggingLevels]).toBe('info')
    expect(payload.config.loggingLevels.ValidationError).toBe('info') // Payload's defaults are kept
  })

  it('a checkout that locks the coupon first makes a concurrent delete wait and then refuse (no 500 race)', async () => {
    const c = await newCoupon('RACE')
    const order = await createOrder(payload)
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => (locked = r))
    const checkout = inTransaction(payload, async (req) => {
      await lockCoupon(req, c.id)
      locked()
      await new Promise((r) => setTimeout(r, 400))
      await createRedemption(req, { couponId: c.id, code: c.code, orderId: order.id, email: 'race@example.com', discountPaise: 100 })
    })
    await lockTaken
    const del = await restDelete(`coupons/${c.id}`, { token: adminToken })
    await checkout
    expect(del.status).toBe(409)
    expect(del.body.errors[0].message).toBe(couponInUseMessage(1))
    expect(await exists(c.id)).toBe(true)
  })
})
