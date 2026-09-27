import { APIError, ValidationError } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { customerAuthBeforeOperation, customerVerifyEndpoint } from '@/auth/customerAuth'
import { assertPasswordPolicy, checkPassword, PASSWORD_MAX, PASSWORD_MIN } from '@/auth/passwordPolicy'
import { AUTH_LIMITS, enforceAuthLimit, hitAuthLimit, isExemptFromAuthLimits, RATE_LIMITED_MESSAGE } from '@/auth/rateLimits'
import { Customers } from '@/collections/Customers'
import { accountEndpoints, RESEND_VERIFICATION_PATH } from '@/endpoints/account'
import { assertUniqueEndpoints, endpoints } from '@/endpoints'
import { resetRateLimits } from '@/lib/rateLimit'

let ipSeq = 0
const restReq = (ip = `192.0.2.${++ipSeq}`, user: unknown = null) =>
  ({ payloadAPI: 'REST', user, headers: new Headers({ 'x-real-ip': ip }) }) as never

const hook = (operation: string, data: Record<string, unknown> | undefined, req = restReq()) =>
  customerAuthBeforeOperation({ args: { data, req }, operation, req, collection: {}, context: {} } as never)

describe('password policy', () => {
  it(`accepts ${PASSWORD_MIN}–${PASSWORD_MAX} characters, nothing else`, () => {
    expect(PASSWORD_MIN).toBe(8)
    expect(PASSWORD_MAX).toBe(128)
    expect(checkPassword('x'.repeat(8))).toBe(true)
    expect(checkPassword('x'.repeat(128))).toBe(true)
    expect(checkPassword('x'.repeat(7))).toMatch(/at least 8/)
    expect(checkPassword('x'.repeat(129))).toMatch(/under 129/)
    for (const v of [undefined, null, '', 12345678, ['12345678']]) expect(checkPassword(v)).not.toBe(true)
  })

  it('throws a Payload ValidationError on path password (status 400, not matched by name)', () => {
    let err: unknown
    try {
      assertPasswordPolicy('short')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect(err).toMatchObject({ status: 400, data: { collection: 'customers', errors: [{ path: 'password' }] } })
  })
})

describe('customer beforeOperation hook', () => {
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

  it('enforces the password policy on create, update (when sent) and resetPassword', () => {
    expect(() => hook('create', { email: 'a@b.dev', password: 'short' })).toThrow(ValidationError)
    expect(() => hook('update', { password: 'short' })).toThrow(ValidationError)
    expect(() => hook('resetPassword', { token: 't', password: 'short' })).toThrow(ValidationError)
    expect(() => hook('resetPassword', { token: 't' })).toThrow(ValidationError)
    // Not sent → nothing to check (Payload handles "required" on create itself).
    expect(() => hook('update', { name: 'x' })).not.toThrow()
    expect(() => hook('update', { password: '' })).not.toThrow()
    expect(() => hook('create', { email: 'a@b.dev' })).not.toThrow()
    expect(() => hook('create', { email: 'a@b.dev', password: 'long-enough' })).not.toThrow()
    // Other operations pass their args through untouched.
    const args = { data: { password: 'x' } }
    expect(customerAuthBeforeOperation({ args, operation: 'read', req: restReq() } as never)).toBe(args)
  })

  it('rate-limits login per IP with a public 429 APIError carrying code + retryAfterSeconds and a Retry-After header', () => {
    const req = restReq('198.51.100.7') as { responseHeaders?: Headers }
    for (let i = 0; i < AUTH_LIMITS.login.ip.limit; i++) hook('login', { email: `u${i}@b.dev`, password: 'x' }, req as never)
    let err: any
    try {
      hook('login', { email: 'u@b.dev', password: 'x' }, req as never)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(APIError)
    expect(err.status).toBe(429)
    expect(err.isPublic).toBe(true)
    expect(err.message).toBe(RATE_LIMITED_MESSAGE)
    expect(err.data).toMatchObject({ code: 'RATE_LIMITED' })
    expect(err.data.retryAfterSeconds).toBeGreaterThan(0)
    expect(req.responseHeaders?.get('Retry-After')).toBe(String(err.data.retryAfterSeconds))
  })

  it('forgotPassword is limited per email (case-insensitive) across IPs', () => {
    const n = AUTH_LIMITS.forgotPassword.email!.limit
    for (let i = 0; i < n; i++) hook('forgotPassword', { email: 'Victim@B.dev' })
    expect(() => hook('forgotPassword', { email: ' victim@b.dev ' })).toThrow(APIError)
    expect(() => hook('forgotPassword', { email: 'other@b.dev' })).not.toThrow()
  })

  it('never limits the Local API or signed-in staff; RATE_LIMIT_DISABLED=1 disables all', () => {
    const local = { payloadAPI: 'local', headers: new Headers() } as never
    const staff = restReq('203.0.113.9', { collection: 'users', role: 'editor' })
    const customer = restReq('203.0.113.9', { collection: 'customers', id: 1 })
    expect(isExemptFromAuthLimits(local)).toBe(true)
    expect(isExemptFromAuthLimits(staff)).toBe(true)
    expect(isExemptFromAuthLimits(customer)).toBe(false)
    for (let i = 0; i < AUTH_LIMITS.signup.ip.limit + 3; i++) {
      enforceAuthLimit(local, 'signup')
      enforceAuthLimit(staff, 'signup')
    }
    process.env.RATE_LIMIT_DISABLED = '1'
    const ip = restReq('203.0.113.10')
    for (let i = 0; i < AUTH_LIMITS.signup.ip.limit + 3; i++) expect(hitAuthLimit(ip, 'signup').ok).toBe(true)
  })
})

describe('wiring', () => {
  it('customers: removeTokenFromResponses, sessions, the hook and the verify override are configured', () => {
    const auth = Customers.auth as Record<string, unknown>
    expect(auth.removeTokenFromResponses).toBe(true)
    expect(auth.useSessions).toBe(true)
    expect(Customers.hooks?.beforeOperation).toContain(customerAuthBeforeOperation)
    expect(Customers.endpoints).toContainEqual(customerVerifyEndpoint)
    expect(customerVerifyEndpoint).toMatchObject({ path: '/verify/:id', method: 'post' })
  })

  it('POST /api/store/account/resend-verification is registered once', () => {
    expect(RESEND_VERIFICATION_PATH).toBe('/store/account/resend-verification')
    expect(accountEndpoints.map((e) => `${e.method} ${e.path}`)).toEqual(['post /store/account/resend-verification'])
    expect(endpoints).toEqual(expect.arrayContaining(accountEndpoints))
    expect(() => assertUniqueEndpoints(endpoints)).not.toThrow()
    expect(AUTH_LIMITS.resendVerification).toEqual({ ip: { limit: 5, windowMs: 60_000 }, email: { limit: 1, windowMs: 600_000 } })
  })
})
