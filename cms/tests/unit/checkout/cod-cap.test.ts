import { describe, expect, it } from 'vitest'

import { codCapAllowsAny, quoteSettings } from '@/commerce/checkout/quote'
import { normalizeStoreSettings } from '@/commerce/settings'
import { codReasonCopy } from '@/commerce/shared/errors.js'
import { quote } from '@/commerce/shared/pricing.js'

/**
 * Hunt round 2 (data-cms): Store settings → "Most open COD orders allowed per phone number" = 0.
 * The quote used to offer COD (the cap is server-only and was never applied to the quote) and the checkout
 * then refused every COD order with TOO_MANY_OPEN ("You already have cash-on-delivery orders on the way")
 * even for a first-time customer. A cap below 1 now reports COD as DISABLED up front.
 */

const settingsWith = (server: Record<string, unknown>) => normalizeStoreSettings({ codEnabled: true, ...server })

const catalog = [
  { slug: 'muesli', name: 'Muesli', pricePaise: 29900, stock: 10, inStock: true, maxPerOrder: 10, codAllowed: true },
]

const priced = (server: Record<string, unknown>) =>
  quote({ items: [{ slug: 'muesli', qty: 1 }], catalog, settings: quoteSettings(settingsWith(server)), method: 'cod', context: {} })

describe('open-COD cap of 0 (codMaxOpenPerPhone)', () => {
  it('codCapAllowsAny: 1 and up allow a COD order; 0 (or garbage) allows none', () => {
    expect(codCapAllowsAny(1)).toBe(true)
    expect(codCapAllowsAny(1000)).toBe(true)
    for (const v of [0, -1, Number.NaN, 0.5]) expect(codCapAllowsAny(v)).toBe(false)
  })

  it('cap 0 → the server quote reports COD unavailable with the truthful DISABLED reason', () => {
    const q = priced({ codMaxOpenPerPhone: 0 })
    expect(q).toMatchObject({ codAvailable: false, codUnavailableReason: 'DISABLED' })
    expect(codReasonCopy(q.codUnavailableReason as string)).not.toMatch(/already have/i)
  })

  it('cap 1+ leaves the quote untouched (the per-phone count stays the checkout\'s job)', () => {
    for (const cap of [1, 2, 1000]) expect(priced({ codMaxOpenPerPhone: cap })).toMatchObject({ codAvailable: true, codUnavailableReason: null })
    const s = settingsWith({ codMaxOpenPerPhone: 2 })
    expect(quoteSettings(s)).toEqual({ ...s.public, ...s.server })
  })

  it('a store with COD switched off stays DISABLED whatever the cap', () => {
    const s = normalizeStoreSettings({ codEnabled: false, codMaxOpenPerPhone: 5 })
    expect(quoteSettings(s).codEnabled).toBe(false)
  })
})
