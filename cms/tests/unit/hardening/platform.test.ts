import type { PayloadRequest, SanitizedConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { hardenVersionAccess, isVersionsEndpoint } from '@/access/hardenInternals'
import {
  CROSS_SITE_AUTH_ERROR,
  CrossSiteAuthError,
  isCrossSiteRequest,
  isGuardedAuthOperation,
  refuseCrossSiteAuth,
} from '@/auth/crossSite'
import { lockAccountForWrite } from '@/auth/accountWrites'
import { lockAccountForLogin, loginLockKey, serializeSessionLogins } from '@/auth/loginSessions'
import { optionalWholeNumber } from '@/collections/Coupons'
import { linkedProductIds } from '@/lib/productStock'

type User = PayloadRequest['user']
const admin = { id: 1, collection: 'users', role: 'admin' } as unknown as User
const editor = { id: 2, collection: 'users', role: 'editor' } as unknown as User
const customer = { id: 1, collection: 'customers' } as unknown as User

const CSRF = ['http://localhost:5173', 'http://localhost:3000']
const req = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ({ headers: new Headers(headers), payload: { config: { csrf: CSRF } }, payloadAPI: 'REST', ...extra }) as never

describe('login CSRF guard (src/auth/crossSite.ts)', () => {
  it('refuses a foreign or opaque Origin, and Sec-Fetch-Site: cross-site without one', () => {
    expect(isCrossSiteRequest(req({ Origin: 'https://evil.example' }))).toBe(true)
    expect(isCrossSiteRequest(req({ Origin: 'null' }))).toBe(true)
    expect(isCrossSiteRequest(req({ Origin: 'http://localhost:5173.evil.example' }))).toBe(true)
    expect(isCrossSiteRequest(req({ 'Sec-Fetch-Site': 'cross-site' }))).toBe(true)
    expect(isCrossSiteRequest(req({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }))).toBe(true)
  })

  it('allows the storefront, the CMS itself, same-site browsers and non-browser callers', () => {
    expect(isCrossSiteRequest(req({ Origin: 'http://localhost:5173' }))).toBe(false)
    expect(isCrossSiteRequest(req({ Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'same-origin' }))).toBe(false)
    expect(isCrossSiteRequest(req({ 'Sec-Fetch-Site': 'same-origin' }))).toBe(false)
    expect(isCrossSiteRequest(req({ 'Sec-Fetch-Site': 'none' }))).toBe(false)
    expect(isCrossSiteRequest(req({}))).toBe(false)
    // An allow-listed Origin wins (a storefront deployed on another site that calls the CMS with CORS).
    expect(isCrossSiteRequest(req({ Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site' }))).toBe(false)
  })

  it('never checks the Local API, and an empty allow-list means no allow-list (like Payload)', () => {
    expect(isCrossSiteRequest(req({ Origin: 'https://evil.example' }, { payloadAPI: 'local' }))).toBe(false)
    const open = { headers: new Headers({ Origin: 'https://evil.example' }), payload: { config: { csrf: [] } } }
    expect(isCrossSiteRequest(open as never)).toBe(false)
  })

  it('throws a public 403 with an explicit error name (logged at info, survives minification)', () => {
    let err: unknown
    try {
      refuseCrossSiteAuth(req({ Origin: 'https://evil.example' }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CrossSiteAuthError)
    expect(err).toMatchObject({ status: 403, name: CROSS_SITE_AUTH_ERROR, isPublic: true, data: { code: 'CROSS_SITE' } })
    expect(() => refuseCrossSiteAuth(req({ Origin: 'http://localhost:5173' }))).not.toThrow()
  })

  it('guards the cookie-issuing and account-acting operations only', () => {
    expect(['create', 'login', 'forgotPassword', 'resetPassword'].every(isGuardedAuthOperation)).toBe(true)
    expect(['read', 'update', 'delete', 'refresh', 'me'].some(isGuardedAuthOperation)).toBe(false)
  })
})

describe('version history access (hardenVersionAccess)', () => {
  const build = () =>
    ({
      collections: [
        {
          slug: 'orders',
          access: { readVersions: () => true },
          endpoints: [
            { path: '/versions', method: 'get', handler: () => Response.json({ crashed: true }, { status: 500 }) },
            { path: '/versions/:id', method: 'post', handler: () => Response.json({ crashed: true }, { status: 500 }) },
            { path: '/:id', method: 'get', handler: () => Response.json({ ok: true }) },
          ],
        },
        { slug: 'products', versions: { drafts: true }, access: { readVersions: () => true }, endpoints: [] },
      ],
      globals: [{ slug: 'store-settings', access: { readVersions: () => true }, endpoints: [] }],
    }) as unknown as SanitizedConfig

  it('closes history on entities without versions (nobody, and the endpoints answer 403)', async () => {
    const config = hardenVersionAccess(build())
    const [orders] = config.collections as unknown as { access: Record<string, (a: unknown) => unknown>; endpoints: any[] }[]
    const [settings] = config.globals as unknown as { access: Record<string, (a: unknown) => unknown> }[]
    for (const user of [admin, customer, null]) {
      expect(orders.access.readVersions({ req: { user } })).toBe(false)
      expect(settings.access.readVersions({ req: { user } })).toBe(false)
    }
    expect((await orders.endpoints[0].handler({ user: admin })).status).toBe(403)
    expect((await orders.endpoints[1].handler({ user: null })).status).toBe(403) // restore: guests too
    expect(await (await orders.endpoints[2].handler({ user: admin })).json()).toEqual({ ok: true })
  })

  it('keeps history on versioned entities for staff only', () => {
    const config = hardenVersionAccess(build())
    const products = (config.collections as unknown as { access: Record<string, (a: unknown) => unknown> }[])[1]
    expect([admin, editor, customer, null].map((user) => products.access.readVersions({ req: { user } }))).toEqual([true, true, false, false])
  })

  it('recognises the three version endpoints', () => {
    expect(['/versions', '/versions/:id'].every((path) => isVersionsEndpoint({ path }))).toBe(true)
    expect(['/', '/:id', '/versionsx', '/access/:id?'].some((path) => isVersionsEndpoint({ path }))).toBe(false)
  })
})

describe('serialised logins (src/auth/loginSessions.ts)', () => {
  it('keys the lock on collection + normalised email', () => {
    expect(loginLockKey('customers', '  Asha@Example.COM ')).toBe('login:customers:asha@example.com')
    expect(loginLockKey('users', 'asha@example.com')).not.toBe(loginLockKey('customers', 'asha@example.com'))
    expect(loginLockKey('customers', '')).toBeNull()
    expect(loginLockKey('customers', 42)).toBeNull()
  })

  it('wraps POST /login and appends the lock hook on session-backed auth collections only', () => {
    const login = { path: '/login', method: 'post', handler: () => Response.json({}) }
    const other = { path: '/me', method: 'get', handler: () => Response.json({}) }
    const own = () => undefined
    const config = {
      collections: [
        { slug: 'customers', auth: { useSessions: true }, hooks: { beforeOperation: [own] }, endpoints: [login, other] },
        { slug: 'stateless', auth: { useSessions: false }, hooks: {}, endpoints: [login] },
        { slug: 'orders', hooks: {}, endpoints: [] },
      ],
    } as unknown as SanitizedConfig
    serializeSessionLogins(config)
    const [customers, stateless] = config.collections as unknown as { hooks: any; endpoints: any[] }[]
    expect(customers.endpoints[0].handler).not.toBe(login.handler)
    expect(customers.endpoints[1]).toBe(other)
    expect(customers.hooks.beforeOperation).toEqual([own, lockAccountForLogin, lockAccountForWrite])
    expect(stateless.endpoints[0]).toBe(login)
    expect(stateless.hooks.beforeOperation).toBeUndefined()
  })

  it('the lock hook is inert outside the wrapped REST endpoint (Local API, other operations)', async () => {
    const args = { data: { email: 'a@b.co' } }
    const hook = (operation: string, context: Record<string, unknown>) =>
      lockAccountForLogin({ args, collection: { slug: 'customers' }, operation, req: { context } } as never)
    expect(await hook('login', {})).toBe(args)
    expect(await hook('create', { wfLoginLock: true })).toBe(args)
  })
})

describe('coupon number fields match the shared rules (optionalWholeNumber)', () => {
  it('accepts empty or a safe whole number at/above the minimum, refuses the rest', () => {
    const paise = optionalWholeNumber(0, ' (paise)')
    const count = optionalWholeNumber(1)
    expect([null, undefined, 0, 1050, Number.MAX_SAFE_INTEGER].map(paise)).toEqual([true, true, true, true, true])
    for (const v of [1050.5, -1, 1e20, Number.NaN, Infinity, '1050']) expect(paise(v), String(v)).toMatch(/whole number ≥ 0 \(paise\)/)
    expect([null, 1, 7].map(count)).toEqual([true, true, true])
    for (const v of [0, 1.5, 2.5, -3]) expect(count(v), String(v)).toMatch(/whole number ≥ 1/)
  })
})

describe('product saves lock linked products in id order (linkedProductIds)', () => {
  it('ids of goesWith at any depth, without self or duplicates, ascending', () => {
    expect(linkedProductIds([9, { id: 3 }, '7', 3, 5], 5)).toEqual([3, 7, 9])
    expect(linkedProductIds([{ id: 'x' }, null, 'abc', 2.5], 1)).toEqual([])
    expect(linkedProductIds(undefined, 1)).toEqual([])
  })
})
