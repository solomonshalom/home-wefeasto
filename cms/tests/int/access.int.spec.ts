import { GRAPHQL_POST } from '@payloadcms/next/routes'
import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { productData } from './helpers/catalogFactories'
import { createCustomer, createOrder, createStaff, login } from './helpers/factories'
import { uniqueEmail } from './helpers/mailpit'
import { config, getTestPayload } from './helpers/payload'
import { restDelete, restGet, restPatch, restPost } from './helpers/rest'

let payload: Payload
let alice: Awaited<ReturnType<typeof createCustomer>>
let bob: Awaited<ReturnType<typeof createCustomer>>
let aliceToken: string
let bobToken: string
let adminToken: string
let editorToken: string
let editorId: number

const ids: Record<string, number> = {}

beforeAll(async () => {
  payload = await getTestPayload()
  const admin = await createStaff(payload, 'admin')
  const editor = await createStaff(payload, 'editor')
  editorId = editor.id
  alice = await createCustomer(payload, { name: 'Alice' })
  bob = await createCustomer(payload, { name: 'Bob' })
  aliceToken = (await login('customers', alice.email)).token
  bobToken = (await login('customers', bob.email)).token
  adminToken = (await login('users', admin.email)).token
  editorToken = (await login('users', editor.email)).token

  // One document in every restricted collection (Local API = server rights).
  const order = await createOrder(payload, { customer: alice.id })
  ids.orders = order.id
  const coupon = await payload.create({ collection: 'coupons', data: { code: `acc-${Date.now()}`, type: 'percent', value: 10, usedCount: 0 } })
  ids.coupons = coupon.id
  ids['coupon-redemptions'] = (
    await payload.create({
      collection: 'coupon-redemptions',
      data: { coupon: coupon.id, code: coupon.code, order: order.id, email: alice.email, discountPaise: 100, status: 'reserved' },
    })
  ).id
  ids['payment-events'] = (
    await payload.create({
      collection: 'payment-events',
      data: { eventId: `evt_${Date.now()}`, event: 'payment.captured', receivedAt: new Date().toISOString(), payload: { x: 1 } },
    })
  ).id
  ids.subscribers = (await payload.create({ collection: 'subscribers', data: { email: uniqueEmail('sub'), status: 'pending' } })).id
  ids['message-log'] = (await payload.create({ collection: 'message-log', data: { key: `k-${Date.now()}`, to: 'x@y.dev', status: 'sent' } })).id
  ids.counters = (await payload.find({ collection: 'counters', where: { name: { equals: 'orders' } } })).docs[0].id
})

describe('customers: self only', () => {
  it('a customer lists only themselves', async () => {
    const res = await restGet('customers', { token: aliceToken })
    expect(res.status).toBe(200)
    expect(res.body.totalDocs).toBe(1)
    expect(res.body.docs[0].email).toBe(alice.email)
  })

  it('customer A cannot read customer B', async () => {
    const res = await restGet(`customers/${bob.id}`, { token: aliceToken })
    expect([403, 404]).toContain(res.status)
    expect(res.text).not.toContain(bob.email)
    const where = await restGet('customers', { token: aliceToken, query: `where[email][equals]=${encodeURIComponent(bob.email)}` })
    expect(where.body.totalDocs).toBe(0)
  })

  it('customer A cannot update or delete customer B', async () => {
    const upd = await restPatch(`customers/${bob.id}`, { body: { name: 'Hacked' }, token: aliceToken })
    expect([403, 404]).toContain(upd.status)
    const bulk = await restPatch('customers', {
      body: { name: 'Hacked' },
      token: aliceToken,
      query: `where[id][equals]=${bob.id}`,
    })
    expect(bulk.body?.docs?.length ?? 0).toBe(0)
    const del = await restDelete(`customers/${bob.id}`, { token: aliceToken })
    expect([403, 404]).toContain(del.status)
    const fresh = await payload.findByID({ collection: 'customers', id: bob.id })
    expect(fresh.name).toBe('Bob')
  })

  it('customers cannot delete themselves (admin only) and anonymous cannot list customers', async () => {
    expect((await restDelete(`customers/${alice.id}`, { token: aliceToken })).status).toBe(403)
    expect((await restGet('customers')).status).toBe(403)
    expect((await restGet(`customers/${alice.id}`)).status).toBe(403)
  })

  it('bob reads his own record by id', async () => {
    const res = await restGet(`customers/${bob.id}`, { token: bobToken })
    expect(res.status).toBe(200)
    expect(res.body.email).toBe(bob.email)
  })
})

describe('commerce collections are closed to customers and guests', () => {
  const closed = ['orders', 'payment-events', 'coupons', 'coupon-redemptions', 'subscribers', 'message-log', 'counters'] as const

  for (const slug of closed) {
    it(`${slug}: no list or read-by-id for customers or anonymous`, async () => {
      for (const token of [aliceToken, undefined]) {
        const list = await restGet(slug, { token })
        expect(list.status, `${slug} list`).toBe(403)
        const one = await restGet(`${slug}/${ids[slug]}`, { token })
        expect([403, 404], `${slug} by id`).toContain(one.status)
        expect(one.body?.id).toBeUndefined()
      }
    })

    it(`${slug}: no REST writes for customers or anonymous`, async () => {
      for (const token of [aliceToken, undefined]) {
        expect((await restPost(slug, { body: { key: 'x', name: 'x' }, token })).status, `${slug} create`).toBe(403)
        expect([403, 404]).toContain((await restPatch(`${slug}/${ids[slug]}`, { body: {}, token })).status)
        expect([403, 404]).toContain((await restDelete(`${slug}/${ids[slug]}`, { token })).status)
      }
    })
  }

  it('even the owner of an order cannot read it through the collection API', async () => {
    const res = await restGet(`orders/${ids.orders}`, { token: aliceToken })
    expect([403, 404]).toContain(res.status)
  })

  it('nobody creates orders over REST — not anonymous, not customers, not admins', async () => {
    const body = { totalPaise: 1, items: [{ slug: 'x', name: 'x', unitPaise: 1, qty: 1, lineTotalPaise: 1 }] }
    expect((await restPost('orders', { body })).status).toBe(403)
    expect((await restPost('orders', { body, token: aliceToken })).status).toBe(403)
    expect((await restPost('orders', { body, token: adminToken })).status).toBe(403)
    expect((await restDelete(`orders/${ids.orders}`, { token: adminToken })).status).toBe(403)
  })
})

describe('staff roles', () => {
  it('admins read orders, but never the hidden token fields', async () => {
    const res = await restGet(`orders/${ids.orders}`, { token: adminToken })
    expect(res.status).toBe(200)
    expect(res.body.number).toMatch(/^WF-\d{5,}$/)
    for (const hidden of ['tokenNonce', 'tokenHash', 'requestHash']) expect(res.body).not.toHaveProperty(hidden)
    const list = await restGet('orders', { token: adminToken })
    expect(list.status).toBe(200)
    expect(list.text).not.toMatch(/tokenNonce|tokenHash|requestHash/)
  })

  it('admins can change fulfilment status but not money, items or identity over REST', async () => {
    await payload.update({ collection: 'orders', id: ids.orders, data: { status: 'paid', paymentStatus: 'captured' } })
    const res = await restPatch(`orders/${ids.orders}`, {
      token: adminToken,
      body: {
        fulfilmentStatus: 'packed',
        totalPaise: 1,
        subtotalPaise: 1,
        number: 'WF-1',
        items: [{ slug: 'free', name: 'Free', unitPaise: 0, qty: 99, lineTotalPaise: 0 }],
        contact: { name: 'x', email: 'x@y.dev', phone: '+910000000000' },
      },
    })
    expect(res.status).toBe(200)
    const order = await payload.findByID({ collection: 'orders', id: ids.orders })
    expect(order.fulfilmentStatus).toBe('packed')
    expect(order.totalPaise).toBe(49800)
    expect(order.subtotalPaise).toBe(49800)
    expect(order.number).not.toBe('WF-1')
    expect(order.items).toHaveLength(1)
    expect(order.items[0].slug).toBe('rolled-oats')
    expect(order.contact.name).toBe('Asha Rao')
  })

  it('editors cannot read orders, customers, coupons or other staff, nor promote themselves', async () => {
    expect((await restGet('orders', { token: editorToken })).status).toBe(403)
    expect((await restGet('customers', { token: editorToken })).status).toBe(403)
    expect((await restGet('coupons', { token: editorToken })).status).toBe(403)
    const users = await restGet('users', { token: editorToken })
    expect(users.status).toBe(200)
    expect(users.body.totalDocs).toBe(1) // only themselves
    const promote = await restPatch(`users/${editorId}`, { body: { role: 'admin' }, token: editorToken })
    expect(promote.status).toBe(200)
    expect((await payload.findByID({ collection: 'users', id: editorId })).role).toBe('editor')
    expect((await restPost('users', { body: { email: uniqueEmail('x'), password: 'Passw0rd!x', role: 'admin' }, token: editorToken })).status).toBe(403)
  })

  it('editors manage catalog content; customers cannot', async () => {
    const slug = `ed-${Date.now()}`
    const created = await restPost('products', { body: { name: 'Muesli', slug, _status: 'draft' }, token: editorToken })
    expect(created.status).toBe(201)
    expect((await restPost('products', { body: { name: 'X', slug: `${slug}-c` }, token: aliceToken })).status).toBe(403)
    expect((await restPost('products', { body: { name: 'X', slug: `${slug}-a` } })).status).toBe(403)
  })
})

describe('drafts and versions', () => {
  it('draft catalog docs and their versions are invisible to customers and guests', async () => {
    const slug = `draft-${Date.now()}`
    // Drafts may be incomplete; publishing needs every required catalog field, so the published doc
    // comes from the catalog factory (complete data) rather than a hand-written stub.
    const draft = await payload.create({ collection: 'products', data: { name: 'Secret Granola', slug }, draft: true })
    const published = await payload.create({
      collection: 'products',
      data: productData({ name: 'Public Oats', slug: `${slug}-pub`, _status: 'published' }) as never,
      context: { skipDeployHook: true },
    })
    expect(draft._status).toBe('draft')
    expect(published._status).toBe('published')
    // Filter to this test's two slugs so other files' catalog rows cannot push them past a page.
    const mine = `where[slug][in]=${slug},${published.slug}&limit=100`
    for (const token of [aliceToken, undefined]) {
      const list = await restGet('products', { token, query: mine })
      expect(list.status).toBe(200)
      const slugs = list.body.docs.map((d: { slug: string }) => d.slug)
      expect(slugs).toEqual([published.slug])
      expect((await restGet(`products/${published.id}`, { token })).status).toBe(200)
      expect((await restGet(`products/${draft.id}`, { token })).status).toBe(404)
      expect((await restGet(`products/${draft.id}`, { token, query: 'draft=true' })).status).toBe(404)
      const drafts = await restGet('products', { token, query: `draft=true&${mine}` })
      expect(drafts.status).toBe(200)
      expect(drafts.body.docs.map((d: { slug: string }) => d.slug)).toEqual([published.slug])
      expect(drafts.text).not.toContain('Secret Granola')
      for (const c of ['products', 'recipes', 'pages']) {
        expect((await restGet(`${c}/versions`, { token })).status, `${c}/versions`).toBe(403)
      }
    }
    const staff = await restGet(`products/${draft.id}`, { token: editorToken, query: 'draft=true' })
    expect(staff.status).toBe(200)
    const staffDrafts = await restGet('products', { token: editorToken, query: `draft=true&${mine}` })
    expect(staffDrafts.body.docs.map((d: { slug: string }) => d.slug).sort()).toEqual([slug, published.slug].sort())
    expect((await restGet('products/versions', { token: editorToken })).status).toBe(200)
  })
})

describe('payload internals', () => {
  it('customers cannot touch admin locks or preferences; staff can', async () => {
    for (const slug of ['payload-locked-documents', 'payload-preferences']) {
      expect((await restGet(slug, { token: aliceToken })).status, slug).toBe(403)
      expect((await restGet(slug)).status, slug).toBe(403)
      expect((await restGet(slug, { token: adminToken })).status, slug).toBe(200)
    }
    // The preferences /:key endpoints bypass access functions in Payload; they are wrapped too.
    for (const token of [aliceToken, undefined]) {
      expect((await restPost('payload-preferences/some-key', { token, body: { value: { x: 1 } } })).status).toBe(403)
      expect((await restGet('payload-preferences/some-key', { token })).status).toBe(403)
      expect((await restDelete('payload-preferences/some-key', { token })).status).toBe(403)
    }
    expect((await payload.count({ collection: 'payload-preferences' })).totalDocs).toBe(0)
    expect((await restPost('payload-preferences/nav', { token: adminToken, body: { value: { open: true } } })).status).toBe(200)
    expect((await restGet('payload-preferences/nav', { token: adminToken })).status).toBe(200)

    const lock = await restPost('payload-locked-documents', {
      body: { document: { relationTo: 'orders', value: ids.orders }, user: { relationTo: 'customers', value: alice.id } },
      token: aliceToken,
    })
    expect(lock.status).toBe(403)
  })

  it('jobs and kv are closed; GraphQL is disabled', async () => {
    expect((await restGet('payload-jobs', { token: aliceToken })).status).toBe(403)
    expect((await restGet('payload-kv', { token: aliceToken })).status).toBe(403)
    const gql = await GRAPHQL_POST(config)(
      new Request('http://localhost:3000/api/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ Orders { docs { id } } }' }),
      }),
    )
    expect(gql.status).toBeGreaterThanOrEqual(400)
  })
})
