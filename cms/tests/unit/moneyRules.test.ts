/**
 * Money the shop shows or charges is whole rupees (hunt round 2): Store settings fees/thresholds/caps and coupon
 * amounts, and the welcome offer's "Largest discount" 0 meaning "no cap" everywhere.
 */
import { describe, expect, it } from 'vitest'

import { optionalWholeRupees } from '@/collections/Coupons'
import { buildWelcomeCoupon, evaluateCoupon } from '@/commerce/shared/coupons.js'
import { isWholeRupees, wholeRupees } from '@/endpoints/catalog/rules'
import { renderWelcomeEmail } from '@/email/retention/welcome'

const NOW = Date.parse('2026-09-26T06:00:00Z')

describe('wholeRupees / optionalWholeRupees', () => {
  it('accept safe multiples of 100 at or above the minimum', () => {
    expect([0, 100, 4900, 5_000_000].map((v) => isWholeRupees(v))).toEqual([true, true, true, true])
    expect(wholeRupees(100)(4900, {} as never)).toBe(true)
    expect(optionalWholeRupees(100)(null)).toBe(true)
    expect(optionalWholeRupees(0)(49900)).toBe(true)
  })

  it('refuse paise that are not whole rupees, fractions, below-minimum and unsafe values', () => {
    for (const v of [4940, 1050, 99, 49.5, -100, 1e20, Number.NaN, '4900']) expect(isWholeRupees(v), String(v)).toBe(false)
    expect(wholeRupees(0)(4940, {} as never)).toMatch(/whole rupees/)
    expect(wholeRupees(100)(0, {} as never)).toMatch(/at least ₹1/)
    expect(optionalWholeRupees(100)(0)).toMatch(/at least 100/)
    expect(optionalWholeRupees(0)(7550)).toMatch(/whole rupees/)
  })
})

describe('welcome offer: "Largest discount" 0 = no cap', () => {
  const settings = (maxDiscountPaise: number) => ({ welcomeOffer: { percent: 10, maxDiscountPaise, validDays: 30 } })

  it('buildWelcomeCoupon stores no cap for 0, the cap otherwise', () => {
    expect(buildWelcomeCoupon({ code: 'HELLO-AB12', email: 'a@b.co', now: NOW, settings: settings(0) }).maxDiscountPaise).toBeNull()
    expect(buildWelcomeCoupon({ code: 'HELLO-AB12', email: 'a@b.co', now: NOW, settings: settings(7500) }).maxDiscountPaise).toBe(7500)
  })

  it('checkout gives the full percent, and the email promises exactly that', () => {
    const coupon = buildWelcomeCoupon({ code: 'HELLO-AB12', email: 'a@b.co', now: NOW, settings: settings(0) })
    const r = evaluateCoupon(coupon, { subtotalPaise: 100000, now: NOW, email: 'a@b.co', isFirstOrder: true, customerUsageCount: 0 })
    expect(r).toMatchObject({ error: null, discountPaise: 10000 })
    const email = renderWelcomeEmail({
      offer: { code: coupon.code, percent: 10, maxDiscountPaise: coupon.maxDiscountPaise ?? null, endsAt: String(coupon.endsAt), url: 'https://x/cart?offer=HELLO-AB12' },
      recipes: [],
      unsubscribeUrl: 'https://x/u',
      shopUrl: 'https://x/shop',
    })
    expect(email.text).toContain('10% off your first order.')
    expect(email.text).not.toContain('up to')
  })
})
