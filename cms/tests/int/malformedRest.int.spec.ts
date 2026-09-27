import { REST_POST } from '@payloadcms/next/routes'
import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { isExpectedRefusal } from '@/lib/logging'
import config from '@/payload.config'

import { createCustomer, createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { API_BASE, restDelete, restGet, restPatch, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * Malformed REST input is a 4xx with no error-level log, never a 500 (src/lib/restInput.ts, restGuards.ts,
 * auth/customerAuth.ts assertEmailIsText; hunt r4 malformed-rest-500). Valid queries keep working.
 */

let payload: Payload
let errorLog: { mock: { calls: unknown[][] }; mockRestore: () => void } | undefined
const cleanup: (() => Promise<unknown>)[] = []
beforeAll(async () => {
  payload = await getTestPayload()
})
afterEach(async () => {
  errorLog?.mockRestore()
  while (cleanup.length) await cleanup.pop()!().catch(() => {})
})
/** Error-level log calls that stay at error level (quietExpectedRefusals re-issues 4xx refusals at info). */
const watchErrors = () => {
  const spy = vi.spyOn(payload.logger, 'error') as unknown as NonNullable<typeof errorLog>
  errorLog = spy
  const downgraded = (c: unknown[]) =>
    c.length === 1 && Object.keys(c[0] as object).join() === 'err' && isExpectedRefusal((c[0] as { err: unknown }).err)
  return () => spy.mock.calls.filter((c: unknown[]) => !downgraded(c)).map((c: unknown[]) => JSON.stringify(c).slice(0, 200))
}

const post = REST_POST(config)
async function multipart(path: string, payloadField: string) {
  const fd = new FormData()
  fd.append('_payload', payloadField)
  const url = `${API_BASE}/${path}`
  const res = await post(new Request(url, { method: 'POST', body: fd, headers: { Origin: STOREFRONT_ORIGIN } }), {
    params: Promise.resolve({ slug: path.split('/') }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('anonymous malformed queries → 4xx', () => {
  it.each([
    ['products/abc', 404],
    ['products/99999999999999999999', 404],
    ['products/2147483648', 404],
    ['products/1.5', 404],
    ['products?page=-5', 400],
    ['products?page=0', 400],
    ['products?page=abc', 400],
    ['products?limit=1.5', 400],
    ['products?limit=-1', 400],
    ['products?where[goesWith][near]=1,2', 400],
    ['products?where[slug][near]=1', 400],
    ['products?where[slug][all]=a', 400],
    ['products?where[or][0][slug][within]=1', 400],
    ['products?where[id][in]=a,b', 400],
    ['products?where[id][equals]=99999999999999', 400],
    ['products?where[goesWith][equals]=abc', 400],
    ['products?where[imageUpload][in]=abc', 400],
    ['products?where[_status][equals]=bogus', 400],
    ['products?where[category][equals]=bogus', 400],
    ['products?where[homeFeatured][equals]=abc', 400],
    ['products?where[createdAt][like]=2020', 400],
    ['products?where[goesWith.slug][near]=1', 400],
    ['products?where={bad', 400],
    ['products?where[slug]=abc', 400],
    ['products/count?where[goesWith][near]=1', 400],
    ['products/versions/abc', 404],
    ['recipes/abc', 404],
    ['pages/abc', 404],
    ['media/abc', 404],
  ])('GET %s → %i', async (path, status) => {
    const errors = watchErrors()
    const [p, q] = path.split('?')
    const res = await restGet(p, { query: q })
    expect(res.status, res.text.slice(0, 200)).toBe(status)
    expect(errors()).toEqual([])
  })

  it('valid queries still answer 200', async () => {
    for (const q of [
      'where[slug][equals]=cornflakes',
      'where[slug][like]=corn',
      'where[category][in]=Flakes,Oats',
      'where[id][in][0]=1&where[id][in][1]=2',
      'where[goesWith][exists]=true',
      'where[goesWith][in]=1,2',
      'where[homeFeatured][equals]=true',
      'where[createdAt][greater_than]=2020-01-01',
      'where[sortOrder][less_than_equal]=100',
      'where[and][0][_status][equals]=published&where[and][1][slug][not_equals]=x',
      'where[goesWith.slug][equals]=muesli',
      'where={"slug":{"equals":"muesli"}}',
      'page=2&limit=5',
      'limit=0',
    ]) {
      const res = await restGet('products', { query: q })
      expect(res.status, `${q}: ${res.text.slice(0, 200)}`).toBe(200)
    }
  })
})

describe('malformed bodies → 400', () => {
  it('signup / login with a non-string email, a non-object JSON body or a broken multipart _payload', async () => {
    const errors = watchErrors()
    const origin = STOREFRONT_ORIGIN
    for (const email of [['a@b.co'], 42, { a: 1 }]) {
      const res = await restPost('customers', { body: { email, password: 'Long-enough-1' }, origin })
      expect(res.status, JSON.stringify(email)).toBe(400)
      expect(res.body.errors[0].data.errors[0].path).toBe('email')
      expect((await restPost('users/login', { body: { email, password: 'x' }, origin })).status).toBe(400)
    }
    for (const raw of ['null', '"str"', '42']) {
      const res = await restPost('customers', { rawBody: raw, contentType: 'application/json', origin })
      expect(res.status, raw).toBe(400)
    }
    for (const path of ['customers/login', 'customers', 'users/login']) {
      const res = await multipart(path, '{bad')
      expect(res.status, path).toBe(400)
      expect(res.body.errors[0].message).toMatch(/Invalid JSON/)
    }
    expect(errors()).toEqual([])
  })

  it('a NUL character in auth input or a where filter is a 400 (never a failed query logged with its parameters)', async () => {
    const errors = watchErrors()
    const NUL = '\u0000'
    const origin = STOREFRONT_ORIGIN
    const email = `nul-${Date.now()}@example.test`
    const results = {
      signup: await restPost('customers', { body: { email, password: 'Long-enough-1', name: `Asha${NUL}K` }, origin }),
      login: await restPost('customers/login', { body: { email: `a${NUL}${email}`, password: 'Long-enough-1' }, origin }),
      forgot: await restPost('customers/forgot-password', { body: { email: `a${NUL}${email}` }, origin }),
      reset: await restPost('customers/reset-password', { body: { token: `t${NUL}x`, password: 'Long-enough-1' }, origin }),
      verify: await restPost(`customers/verify/a${encodeURIComponent(NUL)}b`, { body: {}, origin }),
      staffLogin: await restPost('users/login', { body: { email: `a${NUL}b@example.test`, password: 'x-password-123' }, origin }),
      where: await restGet('products', { query: 'where[slug][equals]=a%00b' }),
    }
    const statuses = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.status]))
    expect(Object.values(statuses).every((s) => s >= 400 && s < 500), JSON.stringify(statuses)).toBe(true)
    expect(errors()).toEqual([])
  })

  it('signed in: a customer reading /customers/abc gets 404, and PATCHing their email to an array gets 400', async () => {
    const c = await createCustomer(payload)
    cleanup.push(() => payload.delete({ collection: 'customers', id: c.id }))
    const { cookie } = await login('customers', c.email)
    const errors = watchErrors()
    expect((await restGet('customers/abc', { cookie })).status).toBe(404)
    const res = await restPatch(`customers/${c.id}`, { cookie, body: { email: ['x@y.co'] } })
    expect(res.status, res.text).toBe(400)
    expect(errors()).toEqual([])
    expect((await restPatch(`customers/${c.id}`, { cookie, body: { name: 'Still fine' } })).status).toBe(200)
  })

  it('staff: bulk operations with a malformed where are refused before touching anything', async () => {
    const a = await createStaff(payload, 'admin')
    const { token } = await login('users', a.email)
    const errors = watchErrors()
    expect((await restDelete('products', { token, query: 'where[id][in]=a,b' })).status).toBe(400)
    expect((await restPatch('products', { token, query: 'where[goesWith][near]=1', body: { name: 'x' } })).status).toBe(400)
    expect((await restGet('users/abc', { token })).status).toBe(404)
    expect(errors()).toEqual([])
  })
})
