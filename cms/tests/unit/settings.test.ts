import { describe, expect, it } from 'vitest'

import {
  normalizeStoreSettings,
  PUBLIC_SETTINGS_DEFAULTS,
  SERVER_ONLY_SETTINGS_KEYS,
  SERVER_SETTINGS_DEFAULTS,
} from '@/commerce/settings'

describe('store settings normalisation (CMS wrapper over $shared/settings.js)', () => {
  it('uses the canonical public keys and values', () => {
    expect(PUBLIC_SETTINGS_DEFAULTS).toEqual({
      freeDeliveryThresholdPaise: 49900,
      deliveryFeePaise: 4900,
      codEnabled: true,
      codMaxPaise: 200000,
      codFeePaise: 0,
      codMinSubtotalPaise: 0,
      maxOrderPaise: 5000000,
      topUpDiscoveryBiasPaise: 5000,
      shippingPromiseText: 'Ships in 1–2 days · delivered in 3–7 days',
      announcement: { enabled: false, text: '', href: '' },
      supportWhatsappE164: '+919845262777',
      legal: {
        entityName: '',
        address: '',
        fssaiLicence: '',
        gstin: '',
        grievanceOfficer: { name: '', designation: '', email: '', phone: '' },
      },
      welcomeOffer: { percent: 10, maxDiscountPaise: 7500, validDays: 30 },
    })
    expect(SERVER_SETTINGS_DEFAULTS).toEqual({
      reservationMinutes: 30,
      blockedPinPrefixes: [],
      codBlockedPinPrefixes: [],
      codMaxOpenPerPhone: 2,
    })
    expect([...SERVER_ONLY_SETTINGS_KEYS].sort()).toEqual(
      ['blockedPinPrefixes', 'codBlockedPinPrefixes', 'codMaxOpenPerPhone', 'reservationMinutes'].sort(),
    )
  })

  it('fills defaults for empty input and splits public/server', () => {
    for (const raw of [undefined, null, {}, [], 'x']) {
      const s = normalizeStoreSettings(raw)
      expect(s.public).toEqual(PUBLIC_SETTINGS_DEFAULTS)
      expect(s.server).toEqual(SERVER_SETTINGS_DEFAULTS)
    }
  })

  it('never leaks server keys (or unknown keys) into the public part', () => {
    const s = normalizeStoreSettings({
      reservationMinutes: 45,
      blockedPinPrefixes: ['744'],
      codBlockedPinPrefixes: ['19'],
      codMaxOpenPerPhone: 1,
      id: 3,
      globalType: 'store-settings',
      updatedAt: '2026-01-01',
    })
    expect(Object.keys(s.public).sort()).toEqual(Object.keys(PUBLIC_SETTINGS_DEFAULTS).sort())
    expect(s.server).toEqual({ reservationMinutes: 45, blockedPinPrefixes: ['744'], codBlockedPinPrefixes: ['19'], codMaxOpenPerPhone: 1 })
  })

  it('keeps valid overrides and drops malformed ones', () => {
    const s = normalizeStoreSettings({
      deliveryFeePaise: 5900,
      freeDeliveryThresholdPaise: 499.5,
      codEnabled: 'yes',
      announcement: { enabled: true, text: 'Hi', href: 7 },
      blockedPinPrefixes: ['744', 'abc', '', '1234567'],
    })
    expect(s.public.deliveryFeePaise).toBe(5900)
    expect(s.public.freeDeliveryThresholdPaise).toBe(49900)
    expect(s.public.codEnabled).toBe(true)
    expect(s.public.announcement).toEqual({ enabled: true, text: 'Hi', href: '' })
    expect(s.server.blockedPinPrefixes).toEqual(['744'])
  })
})
