import { APIError, type PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { COUPON_IN_USE_ERROR, CouponInUseError, Coupons, couponInUseMessage, refuseDeleteWhenRedeemed } from '@/collections/Coupons'

/** CPN-DEL-1: the Coupons beforeDelete guard (DB behaviour is covered in tests/int/coupons-delete.int.spec.ts). */

const fakeReq = (totalDocs: number) => {
  const count = vi.fn(async () => ({ totalDocs }))
  return { count, req: { payload: { count }, transactionID: undefined } as unknown as PayloadRequest }
}
const run = (req: PayloadRequest, id: number) =>
  refuseDeleteWhenRedeemed({ id, req, collection: Coupons as never, context: {} } as never)

describe('Coupons beforeDelete guard', () => {
  it('is registered on the collection', () => {
    expect(Coupons.hooks?.beforeDelete).toContain(refuseDeleteWhenRedeemed)
  })

  it('lets an unused coupon through, counting redemptions of that coupon with the request (same transaction)', async () => {
    const { count, req } = fakeReq(0)
    await expect(run(req, 42)).resolves.toBeUndefined()
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'coupon-redemptions', where: { coupon: { equals: 42 } }, overrideAccess: true, req }),
    )
  })

  it('refuses a used coupon with a public APIError 409 carrying COUPON_IN_USE (status, not class name, is the contract)', async () => {
    const { req } = fakeReq(3)
    const err = await run(req, 7).then(
      () => null,
      (e: unknown) => e as APIError,
    )
    expect(err).toBeInstanceOf(APIError)
    expect(err?.status).toBe(409)
    expect(err?.isPublic).toBe(true)
    expect(err?.data).toEqual({ code: 'COUPON_IN_USE', orders: 3 })
    expect(err?.message).toBe(couponInUseMessage(3))
    // A literal name (for config.loggingLevels → info) that minification cannot mangle.
    expect(err).toBeInstanceOf(CouponInUseError)
    expect(err?.name).toBe(COUPON_IN_USE_ERROR)
    expect(COUPON_IN_USE_ERROR).toBe('CouponInUseError')
  })

  it('copy tells the admin to retire the offer instead, singular and plural', () => {
    expect(couponInUseMessage(1)).toBe('This offer has been used on 1 order, so it can\'t be deleted. Untick "Active" to retire it instead.')
    expect(couponInUseMessage(5)).toMatch(/^This offer has been used on 5 orders, so it can't be deleted\. /)
  })
})
