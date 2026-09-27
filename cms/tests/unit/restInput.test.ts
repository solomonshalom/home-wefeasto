import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { bodyError, guardRestInput, INVALID_JSON, INVALID_TEXT } from '@/lib/restGuards'
import { checkQuery, checkRouteId, checkWhere, INVALID_QUERY, isInt4, resolvePath } from '@/lib/restInput'

/** Malformed REST input → 4xx before Payload touches the database (hunt r4). REST: tests/int/malformedRest.int.spec.ts. */

const productFields = [
  { name: 'slug', type: 'text' },
  { name: 'sortOrder', type: 'number' },
  { name: 'category', type: 'select', options: [{ label: 'Flakes', value: 'Flakes' }, 'Oats'] },
  { name: 'homeFeatured', type: 'checkbox' },
  { name: 'goesWith', type: 'relationship', relationTo: 'products', hasMany: true },
  { name: 'imageUpload', type: 'upload', relationTo: 'media' },
  { name: 'anyDoc', type: 'relationship', relationTo: ['products', 'media'] },
  { name: 'partners', type: 'array', flattenedFields: [{ name: 'url', type: 'text' }] },
  { name: 'seo', type: 'group', flattenedFields: [{ name: 'title', type: 'text' }] },
  { name: 'createdAt', type: 'date' },
  { name: 'tags', type: 'text', hasMany: true },
] as never[]
const payload = {
  db: { defaultIDType: 'number' },
  collections: {
    products: { config: { flattenedFields: productFields } },
    media: { config: { flattenedFields: [{ name: 'alt', type: 'text' }] } },
    codes: { config: { customIDType: 'text', flattenedFields: [] } },
  },
} as never
const where = (w: unknown) => () => checkWhere(payload, 'products', productFields, w)
const refused = (w: unknown) => expect(where(w)).toThrow(expect.objectContaining({ status: 400, data: { code: INVALID_QUERY } }))

describe('isInt4', () => {
  it('accepts what an integer column holds, nothing else', () => {
    for (const v of [1, '1', '007', '-5', 2147483647, '-2147483648']) expect(isInt4(v), String(v)).toBe(true)
    for (const v of ['abc', '1.5', '2147483648', '99999999999999999999', '', ' 1', 1.5, null, true, '1e3']) expect(isInt4(v), String(v)).toBe(false)
  })
})

describe('resolvePath', () => {
  it('follows groups, arrays and single relationships; stops at polymorphic ones and unknown names', () => {
    expect(resolvePath(payload, 'products', productFields, 'id')).toEqual({ type: 'id', ids: true })
    expect(resolvePath(payload, 'products', productFields, 'goesWith')).toMatchObject({ type: 'relationship', ids: true, hasMany: true })
    expect(resolvePath(payload, 'products', productFields, 'goesWith.slug')).toMatchObject({ type: 'text' })
    expect(resolvePath(payload, 'products', productFields, 'goesWith.id')).toEqual({ type: 'id', ids: true })
    expect(resolvePath(payload, 'products', productFields, 'imageUpload.alt')).toMatchObject({ type: 'text' })
    expect(resolvePath(payload, 'products', productFields, 'partners.url')).toMatchObject({ type: 'text' })
    expect(resolvePath(payload, 'products', productFields, 'partners.id')).toEqual({ type: 'text' })
    expect(resolvePath(payload, 'products', productFields, 'seo.title')).toMatchObject({ type: 'text' })
    expect(resolvePath(payload, 'products', productFields, 'category')).toMatchObject({ options: ['Flakes', 'Oats'] })
    expect(resolvePath(payload, 'products', productFields, 'anyDoc')).toMatchObject({ polymorphic: true })
    for (const p of ['anyDoc.value', 'nope', 'slug.x', 'partners', 'seo']) expect(resolvePath(payload, 'products', productFields, p), p).toBeUndefined()
    expect(resolvePath(payload, 'codes', [], 'id')).toEqual({ type: 'text' })
  })
})

describe('checkWhere', () => {
  it('accepts what the admin and our code send', () => {
    for (const w of [
      { slug: { equals: 'x' }, sortOrder: { greater_than: '3' } },
      { slug: { like: 'corn' }, tags: { all: ['a'] } },
      { category: { in: 'Flakes,Oats' }, homeFeatured: { equals: 'true' } },
      { id: { in: ['5', '4'] }, goesWith: { exists: 'true' } },
      { goesWith: { equals: '' }, imageUpload: { equals: null } },
      { and: [{ id: { not_in: { 0: '1', 1: '2' } } }, { or: [{ 'goesWith.slug': { equals: 'm' } }] }] },
      { anyDoc: { equals: 'whatever' } },
      { createdAt: { less_than_equal: 'not a date' } }, // Payload copes with odd dates itself
      { unknownPath: { near: 'x' } }, // left to Payload's own "cannot be queried"
    ]) {
      expect(where(w), JSON.stringify(w)).not.toThrow()
    }
  })

  it('refuses operators the field type has no meaning for', () => {
    for (const w of [
      { goesWith: { near: '1,2' } },
      { slug: { within: '1' } },
      { slug: { all: 'a' } },
      { homeFeatured: { like: 'x' } },
      { createdAt: { contains: '2' } },
      { goesWith: { all: '1' } },
      { anyDoc: { in: '1' } },
      { or: [{ slug: { intersects: '1' } }] },
      { slug: { bogus: 'x' } },
    ])
      refused(w)
  })

  it('refuses values the column cannot hold', () => {
    for (const w of [
      { id: { equals: 'abc' } },
      { id: { in: 'a,b' } },
      { id: { in: '' } },
      { id: { greater_than: '99999999999999' } },
      { goesWith: { equals: 'abc' } },
      { imageUpload: { not_in: ['1', 'x'] } },
      { category: { equals: 'bogus' } },
      { category: { equals: '' } },
      { homeFeatured: { equals: 'maybe' } },
      { homeFeatured: { in: '' } },
    ])
      refused(w)
  })

  it('refuses a NUL character anywhere in a value (Postgres cannot compare it)', () => {
    for (const w of [{ slug: { equals: 'a\u0000b' } }, { unknownPath: { in: ['x', 'a\u0000'] } }, { or: [{ slug: { like: '\u0000' } }] }]) refused(w)
    expect(where({ slug: { equals: 'a\\u0000b' } })).not.toThrow() // a literal backslash-u is fine
  })

  it('refuses a malformed tree', () => {
    for (const w of ['abc', ['x'], { slug: 'abc' }, { slug: ['a'] }, { and: 'x' }]) refused(w)
  })
})

describe('checkQuery / checkRouteId', () => {
  const req = (query: Record<string, unknown>, routeParams: Record<string, unknown> = {}) =>
    ({ query, routeParams, payload }) as unknown as PayloadRequest

  it('page ≥ 1 and limit ≥ 0, whole and bounded', () => {
    for (const q of [{ page: '1' }, { page: '20', limit: '0' }, { limit: '100' }, {}]) expect(() => checkQuery(req(q), 'products', productFields)).not.toThrow()
    for (const q of [{ page: '-5' }, { page: '0' }, { page: 'abc' }, { page: '1.5' }, { page: '1e12' }, { limit: '-1' }, { limit: '1.5' }, { page: ['1', '2'] }])
      expect(() => checkQuery(req(q), 'products', productFields), JSON.stringify(q)).toThrow(expect.objectContaining({ status: 400 }))
  })

  it('parses a JSON where / data (400 when broken) and checks the result', () => {
    const r = req({ where: '{"slug":{"equals":"x"}}' })
    checkQuery(r, 'products', productFields)
    expect(r.query.where).toEqual({ slug: { equals: 'x' } })
    for (const q of [{ where: '{bad' }, { data: '{bad' }, { where: '{"goesWith":{"near":"1"}}' }])
      expect(() => checkQuery(req(q), 'products', productFields)).toThrow(expect.objectContaining({ status: 400 }))
  })

  it('an id that cannot exist in an integer column is a 404', () => {
    for (const id of ['abc', '99999999999999999999', '1.5']) expect(() => checkRouteId(req({}, { id }), true)).toThrow(expect.objectContaining({ status: 404 }))
    for (const id of ['1', undefined]) expect(() => checkRouteId(req({}, { id }), true)).not.toThrow()
    expect(() => checkRouteId(req({}, { id: 'abc' }), false)).not.toThrow() // text ids
  })
})

describe('bodyError / guardRestInput', () => {
  const r = (type: string, data?: unknown) => ({ headers: new Headers({ 'content-type': type }), data }) as unknown as PayloadRequest
  it('maps only body-caused crashes to 400 INVALID_JSON', () => {
    const syntax = new SyntaxError('Unexpected token')
    expect(bodyError(r('multipart/form-data; boundary=x'), syntax)).toMatchObject({ status: 400, data: { code: INVALID_JSON } })
    expect(bodyError(r('application/json', null), new TypeError('x'))).toMatchObject({ status: 400 })
    expect(bodyError(r('application/json', 'str'), new TypeError('x'))).toMatchObject({ status: 400 })
    // Text Postgres can't store (NUL): SQLSTATE 22021 on the driver error or its cause, GET requests too.
    const nul = Object.assign(new Error('Failed query: insert …'), { cause: { code: '22021' } })
    expect(bodyError(r('application/json', { a: 1 }), nul)).toMatchObject({ status: 400, data: { code: INVALID_TEXT } })
    expect(bodyError(r(''), nul, false)).toMatchObject({ status: 400, data: { code: INVALID_TEXT } })
    const other = Object.assign(new Error('deadlock'), { cause: { code: '40P01' } })
    expect(bodyError(r(''), other, false)).toBe(other)
    for (const [req, err] of [
      [r('multipart/form-data', { a: 1 }), syntax], // data parsed: the error came later
      [r('multipart/form-data'), new TypeError('x')],
      [r('application/json', { a: 1 }), new TypeError('x')],
      [r('application/json', null), Object.assign(new Error('refused'), { status: 403 })],
    ] as const)
      expect(bodyError(req, err)).toBe(err)
  })

  it('wraps every endpoint; only the default ones check the query string', async () => {
    const h = async () => new Response('ok')
    const config = {
      collections: [{ slug: 'products', flattenedFields: productFields, endpoints: [{ path: '/:id', method: 'get', handler: h }, { path: '/me', method: 'get', handler: h }] }],
      globals: [{ slug: 'settings', flattenedFields: [], endpoints: [{ path: '/', method: 'post', handler: h }] }],
    } as never
    guardRestInput(config)
    const c = (config as any).collections[0].endpoints
    expect(c[0].handler).not.toBe(h)
    expect(c[1].handler).not.toBe(h)
    expect((config as any).globals[0].endpoints[0].handler).not.toBe(h)
    const req = (routeParams: object) => ({ query: { page: '-1' }, routeParams, payload, headers: new Headers() }) as never
    await expect(c[0].handler(req({ id: '1' }))).rejects.toMatchObject({ status: 400 }) // GET /:id checks the query
    await expect(c[0].handler(req({ id: 'abc' }))).rejects.toMatchObject({ status: 404 })
    expect(await (await c[1].handler(req({}))).text()).toBe('ok') // GET /me: not a query endpoint
  })
})
