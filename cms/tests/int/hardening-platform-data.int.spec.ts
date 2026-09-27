import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { inTransaction } from '@/commerce/checkout/db'
import { lockOrder } from '@/commerce/checkout/orders'
import { deriveOrderToken, newTokenNonce } from '@/commerce/orderToken'
import { buildSnapshot } from '@/endpoints/catalog/data'
import type { Order } from '@/payload-types'
import { setHouseholdSize } from '@/retention/household'

import { createProduct, validateSnapshot } from './helpers/catalogFactories'
import { createOrder, createStaff, login } from './helpers/factories'
import { getTestPayload, makeReq } from './helpers/payload'
import { restDelete, restPost } from './helpers/rest'

/**
 * Hunt fixes (cms-platform): the household write reverting concurrent order changes, deadlocking saves of
 * linked products, deleting an image a product shows, and coupon numbers the shared rules call malformed.
 */

const CTX = { context: { skipDeployHook: true } }
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

describe('household answer vs other order writers', () => {
  it('waits for a writer holding the order row lock and never reverts its change', async () => {
    const tokenNonce = newTokenNonce()
    const order = (await createOrder(payload, { tokenNonce, status: 'cod_confirmed', paymentMethod: 'cod', requestedMethod: 'cod' })) as Order
    const token = deriveOrderToken(order.id, tokenNonce)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    // Like markPaid / expiry / an admin ship: lock the row, then change the order.
    const writer = inTransaction(payload, async (tx) => {
      await lockOrder(tx, order.id)
      locked()
      await held
      await tx.payload.db.updateOne({ collection: 'orders', id: order.id, data: { fulfilmentStatus: 'shipped' }, req: tx, returning: false })
    })
    await isLocked
    let done = false
    const answer = setHouseholdSize(await makeReq(), { number: order.number, token, size: 3 }).then((r) => ((done = true), r))
    await sleep(200)
    expect(done).toBe(false) // queued behind the lock
    release()
    await writer
    expect(await answer).toEqual({ outcome: 'updated' })
    const after = (await payload.findByID({ collection: 'orders', id: order.id, depth: 0 })) as Order
    expect(after).toMatchObject({ fulfilmentStatus: 'shipped', householdSize: 3, status: 'cod_confirmed' })
    expect(await setHouseholdSize(await makeReq(), { number: order.number, token, size: 3 })).toEqual({ outcome: 'unchanged' })
  })
})

describe('products linked to each other (goesWith)', () => {
  it('parallel saves of both never deadlock', async () => {
    const a = await createProduct(payload)
    const b = await createProduct(payload, { goesWith: [a.id] })
    await payload.update({ collection: 'products', id: a.id, data: { goesWith: [b.id] }, ...CTX })
    const saves = Array.from({ length: 8 }, (_, i) =>
      [a, b].map((p) => payload.update({ collection: 'products', id: p.id, data: { lowStockThreshold: 5 + (i % 3) }, ...CTX })),
    ).flat()
    const results = await Promise.allSettled(saves)
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(({ reason }) => `${String(reason?.cause?.message ?? reason)} ${String(reason?.cause?.detail ?? '')}`.trim())
    expect(failures).toEqual([])
    for (const p of [b, a]) await payload.delete({ collection: 'products', id: p.id, ...CTX })
  })
})

describe('media a product shows cannot be deleted', () => {
  const upload = () =>
    payload.create({
      collection: 'media',
      data: { alt: 'Test bowl' },
      file: { data: PNG_1PX, mimetype: 'image/png', name: `hunt-bowl-${Date.now()}.png`, size: PNG_1PX.length },
    })

  it('409 MEDIA_IN_USE while a live product (or its latest draft) uses it; deletable once it is free', async () => {
    const media = await upload()
    const product = await createProduct(payload, { image: '', imageUpload: media.id })
    const editor = await createStaff(payload, 'editor')
    const { token } = await login('users', editor.email)
    try {
      const refused = await restDelete(`media/${media.id}`, { token })
      expect(refused.status).toBe(409)
      expect(refused.body.errors[0].message).toContain(product.name)
      await expect(payload.delete({ collection: 'media', id: media.id })).rejects.toMatchObject({ status: 409 })
      // Published without the upload, a draft still uses it: still refused.
      await payload.update({ collection: 'products', id: product.id, data: { image: '/images/wefeasto/product-rolled-oats.jpg', imageUpload: null }, ...CTX })
      await payload.update({ collection: 'products', id: product.id, data: { imageUpload: media.id }, draft: true, ...CTX })
      expect((await restDelete(`media/${media.id}`, { token })).status).toBe(409)
      await payload.update({ collection: 'products', id: product.id, data: { imageUpload: null, _status: 'published' }, ...CTX })
      expect((await restDelete(`media/${media.id}`, { token })).status).toBe(200)
    } finally {
      await payload.delete({ collection: 'products', id: product.id, ...CTX })
      await payload.delete({ collection: 'media', where: { id: { equals: media.id } } }).catch(() => undefined)
    }
  })

  it('the snapshot leaves out a published product whose only image is gone, and still validates', async () => {
    const media = await upload()
    const other = await createProduct(payload) // the snapshot needs at least one product
    const product = await createProduct(payload, { image: '', imageUpload: media.id })
    try {
      // Bypass the guard, as a direct DB edit or FK cascade would.
      await payload.db.updateOne({ collection: 'products', id: product.id, data: { imageUpload: null }, returning: false })
      const snap = await buildSnapshot(payload)
      expect(snap.products.some((p) => p.slug === product.slug)).toBe(false)
      expect(snap.products.some((p) => p.slug === other.slug)).toBe(true)
      expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] })
    } finally {
      for (const p of [product, other]) await payload.delete({ collection: 'products', id: p.id, ...CTX })
      await payload.delete({ collection: 'media', id: media.id })
    }
  })
})

describe('coupon numbers the shared rules would treat as malformed are refused on save', () => {
  it('fractions and unsafe integers → 400 on that field; whole numbers save', async () => {
    const admin = await createStaff(payload, 'admin')
    const { token } = await login('users', admin.email)
    const code = () => `HNT${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`
    const cases: [string, Record<string, unknown>][] = [
      ['maxDiscountPaise', { type: 'percent', value: 10, maxDiscountPaise: 1050.5 }],
      ['minSubtotalPaise', { type: 'percent', value: 10, minSubtotalPaise: 99.5 }],
      ['usageLimit', { type: 'percent', value: 10, usageLimit: 1.5 }],
      ['perCustomerLimit', { type: 'percent', value: 10, perCustomerLimit: 2.5 }],
      ['value', { type: 'fixed', value: 1e20 }],
    ]
    for (const [field, data] of cases) {
      const res = await restPost('coupons', { body: { code: code(), active: true, ...data }, token })
      expect(res.status, field).toBe(400)
      expect(res.body.errors[0].data.errors.map((e: { path: string }) => e.path), field).toContain(field)
    }
    const ok = await restPost('coupons', {
      body: { code: code(), type: 'percent', value: 10, maxDiscountPaise: 1000, minSubtotalPaise: 9900, usageLimit: 2, perCustomerLimit: 1 },
      token,
    })
    expect(ok.status).toBe(201)
    await payload.delete({ collection: 'coupons', id: ok.body.doc.id })
  })
})
