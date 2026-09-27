import type { PayloadRequest, SanitizedConfig } from 'payload'
import { afterEach, describe, expect, it } from 'vitest'

import { isAdmin, isAdminOrEditor, isAdminOrSelf, isSelf, publishedOrAdmin } from '@/access'
import { hardenInternalCollections } from '@/access/hardenInternals'
import { userIsAdmin, userIsCustomer, userIsStaff } from '@/access/roles'
import { assertUniqueEndpoints } from '@/endpoints'
import { canManageJobs, canRunJobs } from '@/jobs/access'

type User = PayloadRequest['user']
const admin = { id: 1, collection: 'users', role: 'admin' } as unknown as User
const editor = { id: 2, collection: 'users', role: 'editor' } as unknown as User
const noRole = { id: 3, collection: 'users', role: null } as unknown as User
const customer = { id: 1, collection: 'customers' } as unknown as User // same id as the admin!

const args = (user: User, headers: Record<string, string> = {}) =>
  ({ req: { user, headers: new Headers(headers) } as unknown as PayloadRequest }) as Parameters<typeof isAdmin>[0]

describe('role predicates', () => {
  it('distinguish staff roles and customers by collection, never by id', () => {
    expect([admin, editor, noRole, customer, null].map(userIsAdmin)).toEqual([true, false, false, false, false])
    expect([admin, editor, noRole, customer, null].map(userIsStaff)).toEqual([true, true, false, false, false])
    expect([admin, editor, noRole, customer, null].map(userIsCustomer)).toEqual([false, false, false, true, false])
  })
})

describe('collection access helpers', () => {
  it('isAdmin / isAdminOrEditor', () => {
    expect([admin, editor, customer, null].map((u) => isAdmin(args(u)))).toEqual([true, false, false, false])
    expect([admin, editor, customer, null].map((u) => isAdminOrEditor(args(u)))).toEqual([true, true, false, false])
  })

  it('isSelf only matches members of the given collection', () => {
    expect(isSelf('customers')(args(customer))).toEqual({ id: { equals: 1 } })
    expect(isSelf('customers')(args(admin))).toBe(false) // staff #1 is not customer #1
    expect(isSelf('customers')(args(null))).toBe(false)
    expect(isAdminOrSelf('customers')(args(admin))).toBe(true)
    expect(isAdminOrSelf('customers')(args(editor))).toBe(false)
    expect(isAdminOrSelf('customers')(args(customer))).toEqual({ id: { equals: 1 } })
  })

  it('publishedOrAdmin lets staff see drafts', () => {
    expect(publishedOrAdmin(args(admin))).toBe(true)
    expect(publishedOrAdmin(args(editor))).toBe(true)
    expect(publishedOrAdmin(args(customer))).toEqual({ _status: { equals: 'published' } })
    expect(publishedOrAdmin(args(null))).toEqual({ _status: { equals: 'published' } })
  })
})

describe('jobs access', () => {
  const saved = process.env.CRON_SECRET
  afterEach(() => {
    process.env.CRON_SECRET = saved
  })

  it('accepts Bearer CRON_SECRET or an admin', () => {
    process.env.CRON_SECRET = 'cron-secret-value-123'
    expect(canRunJobs(args(null, { authorization: 'Bearer cron-secret-value-123' }))).toBe(true)
    expect(canRunJobs(args(null, { authorization: 'bearer   cron-secret-value-123 ' }))).toBe(true)
    expect(canRunJobs(args(admin))).toBe(true)
  })

  it('refuses wrong/missing secrets, editors and customers', () => {
    process.env.CRON_SECRET = 'cron-secret-value-123'
    for (const h of ['', 'Bearer', 'Bearer cron-secret-value-12', 'cron-secret-value-123', 'Basic cron-secret-value-123', 'JWT x']) {
      expect(canRunJobs(args(null, { authorization: h })), h).toBe(false)
    }
    expect(canRunJobs(args(editor))).toBe(false)
    expect(canRunJobs(args(customer, { authorization: 'Bearer nope' }))).toBe(false)
  })

  it('an empty CRON_SECRET never matches', () => {
    process.env.CRON_SECRET = ''
    expect(canRunJobs(args(null, { authorization: 'Bearer ' }))).toBe(false)
    expect(canRunJobs(args(null, { authorization: 'Bearer undefined' }))).toBe(false)
  })

  it('queue/cancel are admin-only', () => {
    expect([admin, editor, customer, null].map((u) => canManageJobs(args(u)))).toEqual([true, false, false, false])
  })
})

describe('hardenInternalCollections', () => {
  it('limits internal collections to staff while keeping the original rule for staff', () => {
    const original = ({ req }: { req: PayloadRequest }) => (req.user ? { user: { equals: req.user.id } } : false)
    const config = {
      collections: [
        { slug: 'payload-locked-documents', access: { create: () => true, read: () => true, update: () => true, delete: () => true } },
        {
          slug: 'payload-preferences',
          access: { read: original, update: original, delete: original },
          endpoints: [{ path: '/:key', method: 'post', handler: () => Response.json({ ok: true }) }],
        },
        { slug: 'orders', access: { read: () => true } },
      ],
    } as unknown as SanitizedConfig
    hardenInternalCollections(config)
    const [locks, prefs, orders] = config.collections as unknown as { access: Record<string, (a: unknown) => unknown> }[]
    expect(locks.access.read(args(customer))).toBe(false)
    expect(locks.access.create(args(customer))).toBe(false)
    expect(locks.access.read(args(editor))).toBe(true)
    expect(prefs.access.read(args(customer))).toBe(false)
    expect(prefs.access.read(args(admin))).toEqual({ user: { equals: 1 } })
    expect(prefs.access.create(args(customer))).toBe(false)
    expect(prefs.access.create(args(admin))).toBe(true)
    expect(orders.access.read(args(customer))).toBe(true) // untouched
  })

  it('wraps internal custom endpoints so non-staff get 403', async () => {
    const config = {
      collections: [
        {
          slug: 'payload-preferences',
          access: {},
          endpoints: [{ path: '/:key', method: 'post', handler: () => Response.json({ ok: true }) }],
        },
      ],
    } as unknown as SanitizedConfig
    hardenInternalCollections(config)
    const [prefs] = config.collections as unknown as { endpoints: { handler: (r: unknown) => Promise<Response> | Response }[] }[]
    const asCustomer = await prefs.endpoints[0].handler({ user: customer })
    expect(asCustomer.status).toBe(403)
    const anon = await prefs.endpoints[0].handler({ user: null })
    expect(anon.status).toBe(403)
    const asEditor = await prefs.endpoints[0].handler({ user: editor })
    expect(await asEditor.json()).toEqual({ ok: true })
  })
})

describe('endpoint registry', () => {
  it('rejects duplicate METHOD + path registrations', () => {
    const h = () => new Response()
    expect(() => assertUniqueEndpoints([{ path: '/store/a', method: 'get', handler: h }, { path: '/store/a', method: 'post', handler: h }])).not.toThrow()
    expect(() => assertUniqueEndpoints([{ path: '/store/a', method: 'get', handler: h }, { path: '/store/a', method: 'get', handler: h }])).toThrow(
      /Duplicate custom endpoint: GET \/store\/a/,
    )
    expect(() => assertUniqueEndpoints()).not.toThrow()
  })
})
