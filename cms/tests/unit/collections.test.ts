import type { CollectionConfig, Field, GlobalConfig, PayloadRequest } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Static invariants of the collection/global configs (no database). */

type NamedField = Field & { name: string; access?: Record<string, (a: unknown) => unknown>; hidden?: boolean; unique?: boolean }

function flatten(fields: Field[]): NamedField[] {
  const out: NamedField[] = []
  for (const f of fields) {
    if ('name' in f && f.name) out.push(f as NamedField)
    if ('fields' in f && Array.isArray(f.fields) && !('name' in f && f.name)) out.push(...flatten(f.fields as Field[]))
    if (f.type === 'tabs') for (const t of f.tabs) out.push(...flatten(t.fields))
  }
  return out
}
const field = (c: { fields: Field[] }, name: string) => flatten(c.fields).find((f) => f.name === name)!

const reqAs = (user: unknown) => ({ req: { user, headers: new Headers() } as unknown as PayloadRequest })
const admin = { id: 1, collection: 'users', role: 'admin' }
const editor = { id: 2, collection: 'users', role: 'editor' }
const customer = { id: 1, collection: 'customers' }

describe('customers auth config', () => {
  const saved = process.env.NODE_ENV
  afterEach(() => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = saved
    vi.resetModules()
  })

  it('matches the SPEC (verify, lockout, 30-day Lax cookie, storefront links)', async () => {
    const { Customers } = await import('@/collections/Customers')
    const auth = Customers.auth as Exclude<CollectionConfig['auth'], boolean | undefined>
    expect(auth.maxLoginAttempts).toBe(5)
    expect(auth.lockTime).toBe(600000)
    expect(auth.tokenExpiration).toBe(30 * 24 * 60 * 60)
    expect(auth.useSessions).toBe(true)
    expect(auth.cookies).toMatchObject({ sameSite: 'Lax', secure: false })
    expect(typeof auth.verify).toBe('object')
    expect(Customers.access!.admin!(reqAs(customer) as never)).toBe(false)
  })

  it('uses Secure cookies in production', async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    vi.resetModules()
    const { Customers } = await import('@/collections/Customers')
    const auth = Customers.auth as Exclude<CollectionConfig['auth'], boolean | undefined>
    expect(auth.cookies?.secure).toBe(true)
  })
})

describe('orders config', async () => {
  const { Orders, ORDER_STATUSES, PAYMENT_STATUSES, FULFILMENT_STATUSES } = await import('@/collections/Orders')

  it('has every status enum from the SPEC', () => {
    expect(ORDER_STATUSES).toEqual([
      'pending_payment', 'payment_failed', 'paid', 'cod_pending', 'cod_confirmed',
      'expired', 'cancelled', 'needs_review', 'refunded', 'partially_refunded',
    ])
    expect(PAYMENT_STATUSES).toEqual(['none', 'created', 'attempted', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'])
    expect(FULFILMENT_STATUSES).toEqual(['unfulfilled', 'packed', 'shipped', 'delivered', 'rto', 'returned'])
  })

  it('closes REST create/delete for everyone and read/update to admins', () => {
    const a = Orders.access!
    for (const u of [admin, editor, customer, null]) {
      expect(a.create!(reqAs(u) as never)).toBe(false)
      expect(a.delete!(reqAs(u) as never)).toBe(false)
    }
    expect([admin, editor, customer, null].map((u) => a.read!(reqAs(u) as never))).toEqual([true, false, false, false])
    expect([admin, editor, customer, null].map((u) => a.update!(reqAs(u) as never))).toEqual([true, false, false, false])
  })

  it('hides token material and makes money/items server-only', () => {
    for (const name of ['tokenNonce', 'tokenHash', 'requestHash']) expect(field(Orders, name).hidden).toBe(true)
    for (const name of ['number', 'idempotencyKey', 'tokenHash']) expect(field(Orders, name).unique).toBe(true)
    for (const name of ['items', 'subtotalPaise', 'discountPaise', 'deliveryPaise', 'codFeePaise', 'totalPaise', 'number', 'contact', 'statusHistory']) {
      const f = field(Orders, name)
      expect(f.access?.update?.(reqAs(admin)), name).toBe(false)
      expect((f as { admin?: { readOnly?: boolean } }).admin?.readOnly, name).toBe(true)
    }
    expect(Orders.admin?.useAsTitle).toBe('number')
  })
})

describe('store-settings global', async () => {
  const { StoreSettings } = await import('@/globals/StoreSettings')
  const { PUBLIC_SETTINGS_DEFAULTS } = await import('@/commerce/settings')
  const g = StoreSettings as GlobalConfig

  it('has a field for every public key, readable by anyone', () => {
    for (const key of Object.keys(PUBLIC_SETTINGS_DEFAULTS)) {
      const f = field(g, key)
      expect(f, key).toBeTruthy()
      expect(f.access?.read, key).toBeUndefined()
    }
  })

  it('server-only fields are readable/updatable by admins only', () => {
    for (const key of ['reservationMinutes', 'blockedPinPrefixes', 'codBlockedPinPrefixes', 'codMaxOpenPerPhone']) {
      const f = field(g, key)
      expect(f.access?.read?.(reqAs(admin)), key).toBe(true)
      for (const u of [editor, customer, null]) expect(f.access?.read?.(reqAs(u)), key).toBe(false)
    }
    expect(g.access!.update!(reqAs(editor) as never)).toBe(false)
    expect(g.access!.update!(reqAs(admin) as never)).toBe(true)
  })
})

describe('users config', async () => {
  const { Users } = await import('@/collections/Users')
  it('only admins may set roles; editors reach /admin, customers do not', () => {
    const role = field(Users, 'role')
    expect(role.access?.update?.(reqAs(editor))).toBe(false)
    expect(role.access?.update?.(reqAs(admin))).toBe(true)
    expect(Users.access!.admin!(reqAs(editor) as never)).toBe(true)
    expect(Users.access!.admin!(reqAs(customer) as never)).toBe(false)
  })
})

describe('versioned catalog collections', async () => {
  const mods = await Promise.all([import('@/collections/Products'), import('@/collections/Recipes'), import('@/collections/Pages')])
  const cols = [mods[0].Products, mods[1].Recipes, mods[2].Pages]
  it('never expose versions to customers', () => {
    for (const c of cols) {
      expect(c.versions).toMatchObject({ drafts: true })
      expect(c.access!.readVersions!(reqAs(customer) as never), c.slug).toBe(false)
      expect(c.access!.readVersions!(reqAs(editor) as never), c.slug).toBe(true)
      expect(field(c, 'slug').unique, c.slug).toBe(true)
    }
  })
})
