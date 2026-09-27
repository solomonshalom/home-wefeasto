import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { createCustomer, PASSWORD } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { jwtOf, restGet, restPatch, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

const STOREFRONT_URL = 'http://localhost:5173'

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

async function signup(email: string, extra: Record<string, unknown> = {}) {
  return restPost('customers', { body: { email, password: PASSWORD, name: 'Asha Rao', ...extra }, origin: STOREFRONT_ORIGIN })
}

function tokenFromLink(link: string, param: string): string {
  const url = new URL(link)
  const token = url.searchParams.get(param)
  if (!token) throw new Error(`no ${param} in ${link}`)
  return token
}

describe('customer signup → verify → login → me → logout', () => {
  it('runs the whole account lifecycle over REST with a Mailpit-delivered verification link', async () => {
    const email = uniqueEmail('signup')
    await deleteMessagesTo(email)

    const created = await signup(email)
    expect(created.status).toBe(201)
    expect(created.body.doc.email).toBe(email)
    expect(created.body.doc._verified).toBeUndefined() // not readable by the anonymous signer-upper
    expect(created.text).not.toContain('_verificationToken')
    expect(created.text).not.toMatch(/"hash"|"salt"/)

    // Verification email: branded, links to the storefront (not /admin).
    const [summary] = await waitForMessages(email, { subject: 'Confirm your Wefeasto account' })
    const msg = await getMessage(summary.ID)
    expect(msg.From.Address).toBe('test@wefeasto.com')
    const links = extractLinks(msg.HTML)
    const verifyLink = links.find((l) => l.startsWith(`${STOREFRONT_URL}/login?verify=`))
    expect(verifyLink, `links: ${links.join(', ')}`).toBeTruthy()
    expect(links.some((l) => l.includes('/admin'))).toBe(false)
    expect(msg.HTML).toContain('#ff8d5e')
    const token = tokenFromLink(verifyLink!, 'verify')

    // Unverified accounts cannot log in (Payload answers 403 "Please verify your email…").
    const early = await restPost('customers/login', { body: { email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    expect(early.status).toBe(403)
    expect(early.body.errors[0].message).toMatch(/verify your email/i)
    expect(early.cookie).toBeNull()

    // Wrong token → rejected, account stays unverified.
    const bad = await restPost('customers/verify/not-a-real-token', { origin: STOREFRONT_ORIGIN })
    expect(bad.status).toBeGreaterThanOrEqual(400)

    const verified = await restPost(`customers/verify/${token}`, { origin: STOREFRONT_ORIGIN })
    expect(verified.status).toBe(200)
    // Tokens are single-use.
    const again = await restPost(`customers/verify/${token}`, { origin: STOREFRONT_ORIGIN })
    expect(again.status).toBeGreaterThanOrEqual(400)

    const login = await restPost('customers/login', { body: { email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    expect(login.status).toBe(200)
    expect(login.body.user.email).toBe(email)
    // removeTokenFromResponses: the JWT is only in the HttpOnly cookie, never in the JSON body.
    expect(login.body.token).toBeUndefined()
    expect(login.text).not.toContain(jwtOf(login))
    const cookieHeader = login.setCookie.find((c) => c.startsWith('payload-token='))!
    expect(cookieHeader).toMatch(/HttpOnly/i)
    expect(cookieHeader).toMatch(/SameSite=Lax/i)
    expect(cookieHeader).not.toMatch(/Secure/) // secure only in production
    // ~30 days
    const exp = login.body.exp * 1000
    expect(exp - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000)
    expect(exp - Date.now()).toBeLessThanOrEqual(30 * 24 * 3600 * 1000 + 5000)

    // /me via cookie (browser-like, same-site Origin) and via JWT header.
    const meCookie = await restGet('customers/me', { cookie: login.cookie })
    expect(meCookie.status).toBe(200)
    expect(meCookie.body.user.email).toBe(email)
    const meJwt = await restGet('customers/me', { token: jwtOf(login) })
    expect(meJwt.body.user.email).toBe(email)

    // Cookie from an origin outside the CSRF allowlist is ignored (no ambient authority cross-site).
    const evil = await restGet('customers/me', { cookie: login.cookie, origin: 'https://evil.example' })
    expect(evil.body.user).toBeNull()
    // …and so is a cookie with no Origin/Sec-Fetch-Site (server-to-server must use the JWT header).
    const noOrigin = await restGet('customers/me', { cookie: login.cookie, origin: null })
    expect(noOrigin.body.user).toBeNull()

    const logout = await restPost('customers/logout', { cookie: login.cookie })
    expect(logout.status).toBe(200)
    expect(logout.cookie).toBeNull() // cookie cleared
    // Session revoked server-side: the old JWT no longer works either.
    const after = await restGet('customers/me', { token: jwtOf(login) })
    expect(after.status).toBe(200)
    expect(after.body.user).toBeNull()
    const anon = await restGet('customers/me')
    expect(anon.body.user).toBeNull()
  })

  it('rejects duplicate signups without leaking the existing account', async () => {
    const email = uniqueEmail('dupe')
    expect((await signup(email)).status).toBe(201)
    const dupe = await signup(email)
    expect(dupe.status).toBe(400)
    expect(dupe.text).not.toMatch(/hash|salt|_verificationToken/)
  })

  it('anonymous signup cannot set protected fields', async () => {
    const email = uniqueEmail('protected')
    const res = await signup(email, {
      _verified: true,
      marketingOptInAt: '2001-01-01T00:00:00.000Z',
      loginAttempts: 99,
      lockUntil: '2999-01-01T00:00:00.000Z',
      role: 'admin',
      marketingOptIn: false,
    })
    expect(res.status).toBe(201)
    const doc = await payload.findByID({ collection: 'customers', id: res.body.doc.id, showHiddenFields: true })
    expect(doc._verified).toBe(false)
    expect(doc.marketingOptInAt ?? null).toBeNull()
    expect(doc.loginAttempts ?? 0).toBe(0)
    expect(doc.lockUntil ?? null).toBeNull()
    expect((doc as unknown as Record<string, unknown>).role).toBeUndefined()
    // Still cannot log in: not verified.
    const login = await restPost('customers/login', { body: { email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    expect(login.status).toBe(403)
  })

  it('a signed-in customer cannot create a pre-verified account for someone else', async () => {
    const me = await createCustomer(payload)
    const login = await restPost('customers/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    const victim = uniqueEmail('victim')
    const res = await restPost('customers', {
      body: { email: victim, password: PASSWORD, _verified: true },
      token: jwtOf(login),
    })
    expect(res.status).toBe(201)
    const doc = await payload.findByID({ collection: 'customers', id: res.body.doc.id })
    expect(doc._verified).toBe(false)
  })

  it('stamps marketingOptInAt server-side and clears it on opt-out', async () => {
    const email = uniqueEmail('optin')
    const before = Date.now()
    const res = await signup(email, { marketingOptIn: true, marketingOptInAt: '2001-01-01T00:00:00.000Z' })
    expect(res.status).toBe(201)
    const doc = await payload.findByID({ collection: 'customers', id: res.body.doc.id })
    expect(doc.marketingOptIn).toBe(true)
    expect(new Date(doc.marketingOptInAt!).getTime()).toBeGreaterThanOrEqual(before - 1000)

    await payload.update({ collection: 'customers', id: doc.id, data: { _verified: true } })
    const login = await restPost('customers/login', { body: { email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    const off = await restPatch(`customers/${doc.id}`, { body: { marketingOptIn: false }, token: jwtOf(login) })
    expect(off.status).toBe(200)
    const after = await payload.findByID({ collection: 'customers', id: doc.id })
    expect(after.marketingOptIn).toBe(false)
    expect(after.marketingOptInAt ?? null).toBeNull()
  })

  it('customers can edit their profile but not their login email or _verified flag', async () => {
    const me = await createCustomer(payload)
    const loggedIn = await restPost('customers/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    const ok = await restPatch(`customers/${me.id}`, {
      body: {
        name: 'Asha R',
        phone: '+919812345678',
        addresses: [{ label: 'Home', line1: '1 Lake View', city: 'Kochi', state: 'Kerala', pin: '682001' }],
      },
      token: jwtOf(loggedIn),
    })
    expect(ok.status).toBe(200)
    expect(ok.body.doc.name).toBe('Asha R')
    expect(ok.body.doc.addresses).toHaveLength(1)

    const badPhone = await restPatch(`customers/${me.id}`, { body: { phone: '98123 45678' }, token: jwtOf(loggedIn) })
    expect(badPhone.status).toBe(400)
    const badPin = await restPatch(`customers/${me.id}`, {
      body: { addresses: [{ line1: 'x', city: 'y', state: 'z', pin: '012345' }] },
      token: jwtOf(loggedIn),
    })
    expect(badPin.status).toBe(400)

    const emailChange = await restPatch(`customers/${me.id}`, { body: { email: uniqueEmail('new') }, token: jwtOf(loggedIn) })
    expect(emailChange.status).toBe(400)
    const still = await payload.findByID({ collection: 'customers', id: me.id })
    expect(still.email).toBe(me.email)

    const unverify = await restPatch(`customers/${me.id}`, { body: { _verified: false }, token: jwtOf(loggedIn) })
    expect(unverify.status).toBe(200)
    expect((await payload.findByID({ collection: 'customers', id: me.id }))._verified).toBe(true)
  })
})

describe('forgot / reset password', () => {
  it('emails a storefront reset link; the token resets the password once', async () => {
    const me = await createCustomer(payload)
    await deleteMessagesTo(me.email)

    const forgot = await restPost('customers/forgot-password', { body: { email: me.email }, origin: STOREFRONT_ORIGIN })
    expect(forgot.status).toBe(200)
    const [summary] = await waitForMessages(me.email, { subject: 'Reset your Wefeasto password' })
    const msg = await getMessage(summary.ID)
    const link = extractLinks(msg.HTML).find((l) => l.startsWith(`${STOREFRONT_URL}/reset-password?token=`))
    expect(link).toBeTruthy()
    const token = tokenFromLink(link!, 'token')

    const newPassword = 'N3w-Passw0rd-for-test!'
    const reset = await restPost('customers/reset-password', {
      body: { token, password: newPassword },
      origin: STOREFRONT_ORIGIN,
    })
    expect(reset.status).toBe(200)

    const oldLogin = await restPost('customers/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    expect(oldLogin.status).toBe(401)
    const newLogin = await restPost('customers/login', { body: { email: me.email, password: newPassword }, origin: STOREFRONT_ORIGIN })
    expect(newLogin.status).toBe(200)

    const reuse = await restPost('customers/reset-password', { body: { token, password: 'Another-Passw0rd!' }, origin: STOREFRONT_ORIGIN })
    expect(reuse.status).toBeGreaterThanOrEqual(400)
  })

  it('answers 200 for unknown emails and sends nothing (no account enumeration)', async () => {
    const ghost = uniqueEmail('ghost')
    const res = await restPost('customers/forgot-password', { body: { email: ghost }, origin: STOREFRONT_ORIGIN })
    expect(res.status).toBe(200)
    expect(await settleAndList(ghost)).toHaveLength(0)
  })
})

describe('lockout', () => {
  it('locks the account after 5 bad passwords, even for the right password', async () => {
    const me = await createCustomer(payload)
    for (let i = 0; i < 5; i++) {
      const res = await restPost('customers/login', { body: { email: me.email, password: `wrong-${i}` }, origin: STOREFRONT_ORIGIN })
      expect(res.status).toBe(401)
    }
    const locked = await restPost('customers/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    expect(locked.status).toBe(401)
    expect(locked.cookie).toBeNull()
    const doc = await payload.findByID({ collection: 'customers', id: me.id, showHiddenFields: true })
    expect(doc.lockUntil).toBeTruthy()
    const lockMs = new Date(doc.lockUntil!).getTime() - Date.now()
    expect(lockMs).toBeGreaterThan(9 * 60 * 1000)
    expect(lockMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5000)
  })

  it('a successful login before the limit resets the counter', async () => {
    const me = await createCustomer(payload)
    for (let i = 0; i < 4; i++) {
      await restPost('customers/login', { body: { email: me.email, password: 'nope' }, origin: STOREFRONT_ORIGIN })
    }
    expect((await restPost('customers/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })).status).toBe(200)
    const doc = await payload.findByID({ collection: 'customers', id: me.id, showHiddenFields: true })
    expect(doc.loginAttempts ?? 0).toBe(0)
  })
})

describe('customers and the admin panel', () => {
  it('a customer token is not a staff session', async () => {
    const me = await createCustomer(payload)
    const loggedIn = await restPost('customers/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    const staffMe = await restGet('users/me', { token: jwtOf(loggedIn) })
    expect(staffMe.body.user).toBeNull()
    const users = await restGet('users', { token: jwtOf(loggedIn) })
    expect(users.status).toBe(403)
    // Customers cannot sign in through the staff collection with their credentials.
    const staffLogin = await restPost('users/login', { body: { email: me.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
    expect(staffLogin.status).toBe(401)
    // The customers collection's admin access is closed.
    const access = await restGet('access', { token: jwtOf(loggedIn) })
    expect(access.status).toBe(200)
    expect(access.body.canAccessAdmin ?? false).toBe(false)
  })
})
