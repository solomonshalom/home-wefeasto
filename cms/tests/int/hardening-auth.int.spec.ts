import type { Payload } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PASSWORD_MAX, PASSWORD_MIN } from '@/auth/passwordPolicy'
import { AUTH_LIMITS } from '@/auth/rateLimits'
import { resetRateLimits } from '@/lib/rateLimit'

import { createCustomer, createStaff, login, PASSWORD } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { jwtOf, restGet, restPatch, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * cms-hardening §1: customer auth responses without the JWT, the 8–128 password policy and the rate
 * limits on Payload's built-in customer auth operations. (resend-verification: hardening-resend.int.spec.ts)
 */

let payload: Payload
let seq = 0
/** A client IP nobody else uses, so each test gets fresh rate-limit buckets. */
const freshIp = () => `10.77.${Math.floor(++seq / 250)}.${(seq % 250) + 1}`

beforeAll(async () => {
  payload = await getTestPayload()
})

const post = (path: string, body: unknown, ip?: string, extra: Record<string, unknown> = {}) =>
  restPost(path, { body, origin: STOREFRONT_ORIGIN, ...(ip ? { headers: { 'x-real-ip': ip } } : {}), ...extra })

const fieldErrors = (res: { body: any }) => res.body?.errors?.[0]?.data?.errors ?? []

async function resetLinkToken(email: string): Promise<string> {
  await deleteMessagesTo(email)
  expect((await post('customers/forgot-password', { email })).status).toBe(200)
  const [summary] = await waitForMessages(email, { subject: 'Reset your Wefeasto password' })
  const link = extractLinks((await getMessage(summary.ID)).HTML).find((l) => l.includes('/reset-password?token='))!
  return new URL(link).searchParams.get('token')!
}

describe('removeTokenFromResponses: the JWT lives only in the HttpOnly cookie', () => {
  it('login, me, refresh-token and reset-password never return the token in JSON', async () => {
    const me = await createCustomer(payload)
    const res = await post('customers/login', { email: me.email, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeUndefined()
    expect(res.body.user.email).toBe(me.email)
    expect(typeof res.body.exp).toBe('number')
    const jwt = jwtOf(res)
    expect(jwt.split('.')).toHaveLength(3)
    expect(res.text).not.toContain(jwt)
    expect(res.setCookie.find((c) => c.startsWith('payload-token='))).toMatch(/HttpOnly/i)

    const meRes = await restGet('customers/me', { cookie: res.cookie })
    expect(meRes.body.user.email).toBe(me.email)
    expect(meRes.body.token).toBeUndefined()
    expect(meRes.text).not.toContain(jwt)
    // Server-to-server: the cookie value still works as a bearer JWT.
    expect((await restGet('customers/me', { token: jwt })).body.user.email).toBe(me.email)

    const refresh = await restPost('customers/refresh-token', { cookie: res.cookie })
    expect(refresh.status).toBe(200)
    expect(refresh.body.refreshedToken).toBeUndefined()
    expect(refresh.body.token).toBeUndefined()
    expect(refresh.cookie).toMatch(/^payload-token=/)
    expect(refresh.text).not.toContain(refresh.cookie!.replace('payload-token=', ''))

    const token = await resetLinkToken(me.email)
    const reset = await post('customers/reset-password', { token, password: 'Brand-new-passw0rd' })
    expect(reset.status).toBe(200)
    expect(reset.body.token).toBeUndefined()
    expect(reset.cookie).toMatch(/^payload-token=/)
    expect(reset.text).not.toContain(reset.cookie!.replace('payload-token=', ''))
  })

  it('staff (users) logins are unchanged: the admin keeps its token in the body', async () => {
    const admin = await createStaff(payload, 'admin')
    const res = await post('users/login', { email: admin.email, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
  })
})

describe(`password policy (${PASSWORD_MIN}–${PASSWORD_MAX} characters)`, () => {
  const short = 'x'.repeat(PASSWORD_MIN - 1)
  const long = 'x'.repeat(PASSWORD_MAX + 1)

  it('signup: too short / too long → 400 VALIDATION on path password; 8 and 128 are fine', async () => {
    for (const password of [short, long, '', 12345678]) {
      const email = uniqueEmail('pw-signup')
      const res = await post('customers', { email, password, name: 'Asha' })
      expect(res.status, JSON.stringify(password)).toBe(400)
      expect(fieldErrors(res)[0]?.path).toBe('password')
      expect((await payload.find({ collection: 'customers', where: { email: { equals: email } } })).totalDocs).toBe(0)
    }
    expect(fieldErrors(await post('customers', { email: uniqueEmail('pw'), password: short }))[0].message).toMatch(/at least 8/)
    for (const password of ['x'.repeat(PASSWORD_MIN), 'y'.repeat(PASSWORD_MAX)]) {
      expect((await post('customers', { email: uniqueEmail('pw-ok'), password })).status).toBe(201)
    }
  })

  it('change password (PATCH self): a short one is refused and the old password keeps working', async () => {
    const me = await createCustomer(payload)
    const { token } = await login('customers', me.email)
    const bad = await restPatch(`customers/${me.id}`, { body: { password: short }, token })
    expect(bad.status).toBe(400)
    expect(fieldErrors(bad)[0].path).toBe('password')
    expect((await post('customers/login', { email: me.email, password: PASSWORD })).status).toBe(200)
    // An empty password in a profile PATCH is "no change" (Payload ignores it), not an error.
    expect((await restPatch(`customers/${me.id}`, { body: { name: 'Asha K', password: '' }, token })).status).toBe(200)
    const good = await restPatch(`customers/${me.id}`, { body: { password: 'Longer-passw0rd' }, token })
    expect(good.status).toBe(200)
    expect((await post('customers/login', { email: me.email, password: 'Longer-passw0rd' })).status).toBe(200)
  })

  it('reset-password: a short password is refused without consuming the token', async () => {
    const me = await createCustomer(payload)
    const token = await resetLinkToken(me.email)
    const bad = await post('customers/reset-password', { token, password: short })
    expect(bad.status).toBe(400)
    expect(fieldErrors(bad)[0].path).toBe('password')
    expect((await post('customers/reset-password', { token, password: 'Good-enough-pw' })).status).toBe(200)
  })

  it('applies to staff-created customers and the Local API too', async () => {
    const admin = await createStaff(payload, 'admin')
    const { token } = await login('users', admin.email)
    const res = await restPost('customers', { body: { email: uniqueEmail('staff-made'), password: short }, token })
    expect(res.status).toBe(400)
    await expect(
      payload.create({ collection: 'customers', data: { email: uniqueEmail('local'), password: short }, disableVerificationEmail: true }),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('rate limits on the built-in customer auth operations', () => {
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

  /** Payload-shaped 429 with our code + Retry-After. */
  function expectLimited(res: { status: number; headers: Headers; body: any }) {
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(res.body.errors[0].data).toMatchObject({ code: 'RATE_LIMITED' })
    expect(res.body.errors[0].message).toMatch(/too many attempts/i)
  }

  it(`login: ${AUTH_LIMITS.login.ip.limit}/min per IP, then 429 even with the right password; other IPs unaffected`, async () => {
    const me = await createCustomer(payload)
    const ip = freshIp()
    for (let i = 0; i < AUTH_LIMITS.login.ip.limit; i++) {
      const res = await post('customers/login', { email: uniqueEmail('nobody'), password: 'wrong-password' }, ip)
      expect(res.status).toBe(401)
    }
    expectLimited(await post('customers/login', { email: me.email, password: PASSWORD }, ip))
    expect((await post('customers/login', { email: me.email, password: PASSWORD }, freshIp())).status).toBe(200)
  })

  it(`signup: ${AUTH_LIMITS.signup.ip.limit} per 10 min per IP; nothing is created once limited`, async () => {
    const ip = freshIp()
    for (let i = 0; i < AUTH_LIMITS.signup.ip.limit; i++) {
      expect((await post('customers', { email: uniqueEmail('spam'), password: PASSWORD }, ip)).status).toBe(201)
    }
    const email = uniqueEmail('spam-over')
    expectLimited(await post('customers', { email, password: PASSWORD }, ip))
    expect((await payload.find({ collection: 'customers', where: { email: { equals: email } } })).totalDocs).toBe(0)
  })

  it(`forgot-password: ${AUTH_LIMITS.forgotPassword.email!.limit}/hour per email (across IPs) and ${AUTH_LIMITS.forgotPassword.ip.limit}/10 min per IP`, async () => {
    const victim = uniqueEmail('bombed')
    for (let i = 0; i < AUTH_LIMITS.forgotPassword.email!.limit; i++) {
      expect((await post('customers/forgot-password', { email: victim }, freshIp())).status).toBe(200)
    }
    expectLimited(await post('customers/forgot-password', { email: victim.toUpperCase() }, freshIp()))

    const ip = freshIp()
    for (let i = 0; i < AUTH_LIMITS.forgotPassword.ip.limit; i++) {
      expect((await post('customers/forgot-password', { email: uniqueEmail('fp') }, ip)).status).toBe(200)
    }
    expectLimited(await post('customers/forgot-password', { email: uniqueEmail('fp') }, ip))
  })

  it(`reset-password and verify: ${AUTH_LIMITS.resetPassword.ip.limit} per 10 min per IP (token guessing)`, async () => {
    const ip = freshIp()
    for (let i = 0; i < AUTH_LIMITS.resetPassword.ip.limit; i++) {
      expect((await post('customers/reset-password', { token: `guess-${i}`, password: 'Guess-passw0rd' }, ip)).status).toBe(403)
    }
    expectLimited(await post('customers/reset-password', { token: 'guess-x', password: 'Guess-passw0rd' }, ip))

    const ip2 = freshIp()
    for (let i = 0; i < AUTH_LIMITS.verify.ip.limit; i++) {
      const res = await restPost(`customers/verify/guess-${i}`, { origin: STOREFRONT_ORIGIN, headers: { 'x-real-ip': ip2 } })
      expect(res.status).toBe(403)
      expect(res.body.errors[0].message).toMatch(/Verification token is invalid/)
    }
    expectLimited(await restPost('customers/verify/guess-x', { origin: STOREFRONT_ORIGIN, headers: { 'x-real-ip': ip2 } }))
  })

  it('the verify override still verifies (same 200 body as Payload) under the limit', async () => {
    const email = uniqueEmail('verify-ok')
    await deleteMessagesTo(email)
    expect((await post('customers', { email, password: PASSWORD }, freshIp())).status).toBe(201)
    const [summary] = await waitForMessages(email, { subject: 'Confirm your Wefeasto account' })
    const link = extractLinks((await getMessage(summary.ID)).HTML).find((l) => l.includes('/login?verify='))!
    const token = new URL(link).searchParams.get('verify')!
    const ok = await restPost(`customers/verify/${token}`, { origin: STOREFRONT_ORIGIN, headers: { 'x-real-ip': freshIp() } })
    expect(ok.status).toBe(200)
    expect(ok.body.message).toMatch(/verified/i)
    expect((await post('customers/login', { email, password: PASSWORD })).status).toBe(200)
  })

  it('staff (admin UI) and the Local API are never limited; staff logins are not customer logins', async () => {
    const admin = await createStaff(payload, 'admin')
    const { token } = await login('users', admin.email)
    const ip = freshIp()
    for (let i = 0; i < AUTH_LIMITS.signup.ip.limit + 2; i++) {
      const res = await restPost('customers', { body: { email: uniqueEmail('by-staff'), password: PASSWORD }, token, headers: { 'x-real-ip': ip } })
      expect(res.status).toBe(201)
    }
    for (let i = 0; i < AUTH_LIMITS.signup.ip.limit + 2; i++) await createCustomer(payload)
    for (let i = 0; i < AUTH_LIMITS.login.ip.limit + 2; i++) {
      expect((await post('users/login', { email: admin.email, password: PASSWORD }, ip)).status).toBe(200)
    }
  })

  it('RATE_LIMIT_DISABLED=1 turns the auth limits off', async () => {
    process.env.RATE_LIMIT_DISABLED = '1'
    const ip = freshIp()
    for (let i = 0; i < AUTH_LIMITS.login.ip.limit + 3; i++) {
      expect((await post('customers/login', { email: uniqueEmail('x'), password: 'wrong-password' }, ip)).status).toBe(401)
    }
  })
})
