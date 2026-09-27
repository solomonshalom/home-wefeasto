import type { Payload } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AUTH_LIMITS } from '@/auth/rateLimits'
import { resendVerificationEmail } from '@/auth/resendVerification'
import { resetRateLimits } from '@/lib/rateLimit'

import { createCustomer, PASSWORD } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/** cms-hardening §1d: POST /api/store/account/resend-verification {email}. */

const STOREFRONT_URL = 'http://localhost:5173'
const SUBJECT = 'Confirm your Wefeasto account'
const PATH = 'store/account/resend-verification'

let payload: Payload
let seq = 0
const freshIp = () => `10.88.${Math.floor(++seq / 250)}.${(seq % 250) + 1}`

beforeAll(async () => {
  payload = await getTestPayload()
})

const resend = (email: unknown, ip = freshIp()) =>
  restPost(PATH, { body: { email }, origin: STOREFRONT_ORIGIN, headers: { 'x-real-ip': ip } })

async function verifyTokens(email: string, count: number): Promise<string[]> {
  const msgs = await waitForMessages(email, { subject: SUBJECT, count })
  const tokens: string[] = []
  for (const m of msgs) {
    const full = await getMessage(m.ID)
    const link = extractLinks(full.HTML).find((l) => l.startsWith(`${STOREFRONT_URL}/login?verify=`))
    expect(link, 'verify link').toBeTruthy()
    tokens.push(new URL(link!).searchParams.get('verify')!)
  }
  return tokens
}

describe('POST /api/store/account/resend-verification', () => {
  it('unverified customer: a fresh token by email (same template); the old link stops working', async () => {
    const email = uniqueEmail('resend')
    await deleteMessagesTo(email)
    const signup = await restPost('customers', { body: { email, password: PASSWORD, name: 'Asha Rao' }, origin: STOREFRONT_ORIGIN })
    expect(signup.status).toBe(201)
    const [first] = await verifyTokens(email, 1)
    expect(first).toMatch(/^[a-f0-9]{40}$/)

    const res = await resend(email.toUpperCase())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers.get('cache-control')).toBe('no-store')

    const tokens = await verifyTokens(email, 2)
    const fresh = tokens.find((t) => t !== first)!
    expect(fresh).toMatch(/^[a-f0-9]{40}$/)
    const msgs = await waitForMessages(email, { subject: SUBJECT, count: 2 })
    const html = (await getMessage(msgs[0].ID)).HTML
    expect(html).toContain('Hi Asha,')
    expect(html).toContain('Confirm my email')

    expect((await restPost(`customers/verify/${first}`, { origin: STOREFRONT_ORIGIN })).status).toBe(403)
    expect((await restPost(`customers/verify/${fresh}`, { origin: STOREFRONT_ORIGIN })).status).toBe(200)
    expect((await restPost('customers/login', { body: { email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })).status).toBe(200)
  })

  it('no account oracle: unknown and verified addresses get the same 200 and no email', async () => {
    const ghost = uniqueEmail('ghost')
    const verified = await createCustomer(payload)
    await deleteMessagesTo(verified.email)
    const a = await resend(ghost)
    const b = await resend(verified.email)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.text).toBe(b.text)
    expect(await settleAndList(ghost)).toHaveLength(0)
    expect(await settleAndList(verified.email)).toHaveLength(0)
  })

  it('only touches the verification token (profile and addresses survive)', async () => {
    const email = uniqueEmail('resend-keep')
    const doc = await payload.create({
      collection: 'customers',
      data: {
        email,
        password: PASSWORD,
        name: 'Ravi',
        phone: '+919812345678',
        addresses: [{ label: 'Home', line1: '1 Lake View', city: 'Kochi', state: 'Kerala', pin: '682001' }],
      },
      disableVerificationEmail: true,
    })
    const before = await payload.findByID({ collection: 'customers', id: doc.id, showHiddenFields: true })
    expect(await resendVerificationEmail(payload, email)).toBe('sent')
    const after = await payload.findByID({ collection: 'customers', id: doc.id, showHiddenFields: true })
    expect(after._verificationToken).toMatch(/^[a-f0-9]{40}$/)
    expect(after._verificationToken).not.toBe(before._verificationToken)
    expect(after._verified).toBe(false)
    expect(after.name).toBe('Ravi')
    expect(after.phone).toBe('+919812345678')
    expect(after.addresses).toHaveLength(1)
    expect(after.addresses![0]).toMatchObject({ line1: '1 Lake View', pin: '682001' })
    expect(await resendVerificationEmail(payload, uniqueEmail('none'))).toBe('no_account')
  })

  it('malformed input → 400 VALIDATION / 415; a honeypot-free body is all it needs', async () => {
    for (const email of ['', 'not-an-email', 42, null, 'a@b']) {
      const res = await resend(email)
      expect(res.status, String(email)).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION', details: { fields: { email: 'INVALID' } } })
    }
    const raw = await restPost(PATH, { rawBody: 'email=x@y.dev', contentType: 'application/x-www-form-urlencoded' })
    expect(raw.status).toBe(415)
    const bad = await restPost(PATH, { rawBody: '{nope', contentType: 'application/json' })
    expect(bad.body.error.code).toBe('INVALID_JSON')
  })

  describe('limits', () => {
    let saved: string | undefined
    beforeEach(() => {
      saved = process.env.RATE_LIMIT_DISABLED
      process.env.RATE_LIMIT_DISABLED = '0'
      resetRateLimits()
    })
    afterEach(() => {
      process.env.RATE_LIMIT_DISABLED = saved
      resetRateLimits()
    })

    it('one email per address per 10 minutes: a repeat answers 200 and sends nothing', async () => {
      const email = uniqueEmail('resend-once')
      await payload.create({ collection: 'customers', data: { email, password: PASSWORD }, disableVerificationEmail: true })
      await deleteMessagesTo(email)
      expect((await resend(email)).status).toBe(200)
      await waitForMessages(email, { subject: SUBJECT })
      const again = await resend(email) // different IP, same address
      expect(again.status).toBe(200)
      expect(again.body).toEqual({ ok: true })
      expect(await settleAndList(email)).toHaveLength(1)
    })

    it(`${AUTH_LIMITS.resendVerification.ip.limit}/min per IP → 429 RATE_LIMITED with Retry-After`, async () => {
      const ip = freshIp()
      for (let i = 0; i < AUTH_LIMITS.resendVerification.ip.limit; i++) {
        expect((await resend(uniqueEmail('flood'), ip)).status).toBe(200)
      }
      const limited = await resend(uniqueEmail('flood'), ip)
      expect(limited.status).toBe(429)
      expect(limited.body.error.code).toBe('RATE_LIMITED')
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      // Malformed requests count too (they are checked after the IP limit).
      expect((await resend('junk', ip)).status).toBe(429)
    })
  })
})
