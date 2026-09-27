import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { getStoreSettings, PUBLIC_SETTINGS_DEFAULTS, SERVER_SETTINGS_DEFAULTS } from '@/commerce/settings'

import { createCustomer, createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

const SERVER_ONLY = ['reservationMinutes', 'blockedPinPrefixes', 'codBlockedPinPrefixes', 'codMaxOpenPerPhone']
const PUBLIC_KEYS = Object.keys(PUBLIC_SETTINGS_DEFAULTS)

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

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]))

describe('store-settings global', () => {
  it('serves every public key with its default on a fresh database', async () => {
    const res = await restGet('globals/store-settings')
    expect(res.status).toBe(200)
    for (const key of PUBLIC_KEYS) expect(res.body, key).toHaveProperty(key)
    expect(pick(res.body, PUBLIC_KEYS)).toEqual(PUBLIC_SETTINGS_DEFAULTS)
  })

  it('getStoreSettings() returns normalised public + server settings', async () => {
    const s = await getStoreSettings(payload)
    expect(s.public).toEqual(PUBLIC_SETTINGS_DEFAULTS)
    expect(s.server).toEqual(SERVER_SETTINGS_DEFAULTS)
    expect(Object.keys(s.public).sort()).toEqual([...PUBLIC_KEYS].sort())
  })

  it('admins update settings; server-only values stay hidden from anonymous, customers and editors', async () => {
    const update = await restPost('globals/store-settings', {
      token: adminToken,
      body: {
        deliveryFeePaise: 5900,
        announcement: { enabled: true, text: 'Free delivery this weekend', href: '/shop' },
        reservationMinutes: 45,
        blockedPinPrefixes: ['744', '682559'],
        codBlockedPinPrefixes: ['19'],
        codMaxOpenPerPhone: 1,
      },
    })
    expect(update.status).toBe(200)

    for (const [who, token] of [
      ['anonymous', undefined],
      ['customer', customerToken],
      ['editor', editorToken],
    ] as const) {
      const res = await restGet('globals/store-settings', { token })
      expect(res.status, who).toBe(200)
      expect(res.body.deliveryFeePaise, who).toBe(5900)
      expect(res.body.announcement, who).toEqual({ enabled: true, text: 'Free delivery this weekend', href: '/shop' })
      for (const key of SERVER_ONLY) expect(res.body, `${who} must not see ${key}`).not.toHaveProperty(key)
      expect(res.text, who).not.toContain('682559')
    }

    const admin = await restGet('globals/store-settings', { token: adminToken })
    expect(admin.body.reservationMinutes).toBe(45)
    expect(admin.body.blockedPinPrefixes).toEqual(['744', '682559'])
    expect(admin.body.codBlockedPinPrefixes).toEqual(['19'])
    expect(admin.body.codMaxOpenPerPhone).toBe(1)

    const s = await getStoreSettings(payload)
    expect(s.server).toEqual({
      reservationMinutes: 45,
      blockedPinPrefixes: ['744', '682559'],
      codBlockedPinPrefixes: ['19'],
      codMaxOpenPerPhone: 1,
    })
    expect(s.public.deliveryFeePaise).toBe(5900)
    for (const key of SERVER_ONLY) expect(s.public).not.toHaveProperty(key)
  })

  it('only admins may update settings', async () => {
    for (const token of [undefined, customerToken, editorToken]) {
      const res = await restPost('globals/store-settings', { token, body: { deliveryFeePaise: 1 } })
      expect(res.status).toBe(403)
    }
    // Server-only fields sent by non-admins never land either.
    const g = await payload.findGlobal({ slug: 'store-settings' })
    expect(g.deliveryFeePaise).not.toBe(1)
  })

  it('rejects malformed values', async () => {
    const bad = await restPost('globals/store-settings', { token: adminToken, body: { deliveryFeePaise: 49.5 } })
    expect(bad.status).toBe(400)
    const badPin = await restPost('globals/store-settings', { token: adminToken, body: { blockedPinPrefixes: ['7a4'] } })
    expect(badPin.status).toBe(400)
  })
})
