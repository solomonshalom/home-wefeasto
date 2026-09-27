import http from 'http'
import type { AddressInfo } from 'net'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { deployHook } from '@/hooks/deployHook'

import { createProduct, loadPolicyDrafts, restoreStoreSettings, reviewedPage, seedCommittedCatalog } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restPatch, restPost } from './helpers/rest'

/**
 * End to end: REST saves of products / recipes / pages / settings → debounced POST to
 * VERCEL_DEPLOY_HOOK_URL (a local HTTP server here, debounce shortened to 2 s — long enough that a burst of REST
 * saves stays inside one window even on a heavily loaded machine). (cms-catalog)
 */

const DEBOUNCE_MS = 2000
let payload: Payload
let editorToken: string
let adminToken: string
let server: http.Server
let hits: { method: string; at: number }[] = []
const saved = { url: process.env.VERCEL_DEPLOY_HOOK_URL, debounce: process.env.DEPLOY_HOOK_DEBOUNCE_MS }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Wait past the debounce (+ request time) and return how many POSTs arrived. */
async function settle() {
  await sleep(DEBOUNCE_MS + 750)
  await deployHook.whenIdle()
  return hits.length
}

async function bySlug(collection: 'products' | 'recipes' | 'pages', slug: string) {
  const res = await payload.find({ collection, where: { slug: { equals: slug } }, limit: 1, depth: 0, overrideAccess: true })
  return res.docs[0] as Record<string, any>
}

beforeAll(async () => {
  payload = await getTestPayload()
  await seedCommittedCatalog(payload)
  editorToken = (await login('users', (await createStaff(payload, 'editor')).email)).token
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
  server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', at: Date.now() })
    res.writeHead(201, { 'content-type': 'application/json' }).end('{"job":{"id":"x"}}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.VERCEL_DEPLOY_HOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/deploy`
  process.env.DEPLOY_HOOK_DEBOUNCE_MS = String(DEBOUNCE_MS)
})

beforeEach(async () => {
  await deployHook.whenIdle()
  hits = []
})

afterAll(async () => {
  deployHook.cancel()
  process.env.VERCEL_DEPLOY_HOOK_URL = saved.url ?? ''
  if (saved.debounce === undefined) delete process.env.DEPLOY_HOOK_DEBOUNCE_MS
  else process.env.DEPLOY_HOOK_DEBOUNCE_MS = saved.debounce
  await new Promise((r) => server.close(r))
  await restoreStoreSettings(payload)
})

describe('deploy hook', () => {
  it('a burst of edits to published products and recipes triggers ONE POST after the last one', async () => {
    const muesli = await bySlug('products', 'muesli')
    const recipe = await bySlug('recipes', 'wf-muesli-breakfast-cookies')
    for (const pricePaise of [22900, 23900, muesli.pricePaise]) {
      expect((await restPatch(`products/${muesli.id}`, { token: editorToken, body: { pricePaise } })).status).toBe(200)
    }
    expect((await restPatch(`recipes/${recipe.id}`, { token: editorToken, body: { serves: recipe.serves } })).status).toBe(200)
    expect(hits).toHaveLength(0) // debounced: nothing yet
    expect(await settle()).toBe(1)
    expect(hits[0].method).toBe('POST')
  })

  it('publishing, unpublishing and deleting a published doc trigger it; editing a never-published draft does not', async () => {
    const draft = await createProduct(payload, { name: 'Quiet Draft' }, { draft: true })
    expect((await restPatch(`products/${draft.id}`, { token: editorToken, body: { calories: 90 }, query: 'draft=true' })).status).toBe(200)
    expect(await settle()).toBe(0)

    expect((await restPatch(`products/${draft.id}`, { token: editorToken, body: { _status: 'published' } })).status).toBe(200)
    expect(await settle()).toBe(1)

    expect((await restPatch(`products/${draft.id}`, { token: editorToken, body: { _status: 'draft' } })).status).toBe(200)
    expect(await settle()).toBe(2)

    await payload.update({ collection: 'products', id: draft.id, data: { _status: 'published' }, context: { skipDeployHook: true } })
    await payload.delete({ collection: 'products', id: draft.id })
    expect(await settle()).toBe(3)
  })

  it('pages: reviewing a policy draft does not trigger it; putting a page on the storefront (or taking it off) does', async () => {
    const doc = await bySlug('pages', 'shipping')
    const original = loadPolicyDrafts().pages[0]
    try {
      // The owner edits the seeded draft, then publishes it in Payload with the box unticked: not on the site.
      expect((await restPatch(`pages/${doc.id}`, { token: editorToken, body: { title: 'Shipping' }, query: 'draft=true' })).status).toBe(200)
      expect((await restPatch(`pages/${doc.id}`, { token: editorToken, body: { _status: 'published' } })).status).toBe(200)
      expect(await settle()).toBe(0)

      const reviewed = reviewedPage(original)
      const live = await restPatch(`pages/${doc.id}`, { token: editorToken, body: { bodyHtml: reviewed.bodyHtml, published: true, _status: 'published' } })
      expect(live.status, live.text).toBe(200)
      expect(await settle()).toBe(1)

      expect((await restPatch(`pages/${doc.id}`, { token: editorToken, body: { published: false } })).status).toBe(200)
      expect(await settle()).toBe(2)
    } finally {
      await payload.update({ collection: 'pages', id: doc.id, data: { ...original, _status: 'draft' } as never, context: { skipDeployHook: true } })
    }
  })

  it('store settings: public changes trigger it, server-only changes do not', async () => {
    expect((await restPost('globals/store-settings', { token: adminToken, body: { reservationMinutes: 40 } })).status).toBe(200)
    expect(await settle()).toBe(0)
    expect((await restPost('globals/store-settings', { token: adminToken, body: { deliveryFeePaise: 5900 } })).status).toBe(200)
    expect(await settle()).toBe(1)
  })

  it('a failing hook endpoint never breaks the save', async () => {
    process.env.VERCEL_DEPLOY_HOOK_URL = 'http://127.0.0.1:9/unreachable'
    try {
      const doc = await bySlug('products', 'health-mix')
      const res = await restPatch(`products/${doc.id}`, { token: editorToken, body: { calories: doc.calories } })
      expect(res.status).toBe(200)
      await sleep(DEBOUNCE_MS + 750)
      await deployHook.whenIdle()
    } finally {
      process.env.VERCEL_DEPLOY_HOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/deploy`
    }
  })
})
