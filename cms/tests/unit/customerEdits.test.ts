import { describe, expect, it } from 'vitest'

import {
  CUSTOMER_CHANGED,
  decodeEditBase,
  EDIT_BASE_FIELD,
  encodeEditBase,
  fingerprints,
  mergeStaleCustomerForm,
  noteCustomerForm,
} from '@/auth/customerEdits'
import { erasureKey } from '@/retention/erasure'

/** src/auth/customerEdits.ts: the per-field three-way merge of an admin Save against what the page loaded. */

const addr = { id: 'a1', label: 'Home', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001', isDefault: true }
const loaded = { id: 7, email: 'asha@example.com', name: 'Asha K', phone: null, addresses: [], marketingOptIn: false, _verified: false }

type Req = { payloadAPI: string; context: Record<string, unknown>; user?: unknown }
const restReq = (): Req => ({ payloadAPI: 'REST', context: {} })

/** Runs the two hooks the way Payload does for PATCH /api/customers/7 with `body`, against the stored `live` row. */
async function save(body: Record<string, unknown>, live: Record<string, unknown>, req: Req = restReq()) {
  await (noteCustomerForm as (a: unknown) => unknown)({ args: { id: 7, data: body }, operation: 'update', req })
  const data = { ...live, ...body } // by beforeChange Payload has merged the stored row under the body
  return (mergeStaleCustomerForm as (a: unknown) => Record<string, unknown>)({ data, operation: 'update', originalDoc: live, req })
}

const form = (extra: Record<string, unknown> = {}) => ({ ...loaded, [EDIT_BASE_FIELD]: encodeEditBase(loaded), ...extra })

describe('fingerprints', () => {
  it('treat null / empty / 0-row forms of the same value alike, and ignore array row ids', () => {
    expect(fingerprints({ name: null, phone: undefined, addresses: 0 })).toEqual(fingerprints({ name: '', phone: '', addresses: [] }))
    expect(fingerprints({ addresses: [addr] })).toEqual(fingerprints({ addresses: [{ ...addr, id: 'other' }] }))
    expect(fingerprints({ email: ' Asha@Example.com ' })).toEqual(fingerprints({ email: 'asha@example.com' }))
    expect(fingerprints({ addresses: [addr] })).not.toEqual(fingerprints({ addresses: [{ ...addr, pin: '560002' }] }))
    expect(fingerprints({ addresses: 2 })).toEqual({}) // a bare row count can't be compared
  })

  it('decodes only well-formed bases', () => {
    expect(decodeEditBase(encodeEditBase(loaded))).toEqual(fingerprints(loaded))
    for (const bad of [undefined, null, 5, '', 'not json', '[1]', 'x'.repeat(2000)]) expect(decodeEditBase(bad)).toBeNull()
  })
})

describe('an admin Save merged against the live row', () => {
  it('keeps a verification that happened after the page loaded; applies the name edit', async () => {
    const data = await save(form({ name: 'Asha K. Kumar' }), { ...loaded, _verified: true })
    expect(data).toMatchObject({ name: 'Asha K. Kumar', _verified: true })
  })

  it("keeps the customer's newer addresses and opt-in when the page didn't touch them", async () => {
    const live = { ...loaded, addresses: [addr], marketingOptIn: true }
    const data = await save(form({ addresses: 0, phone: '+919812345678' }), live)
    expect(data).toMatchObject({ addresses: [addr], marketingOptIn: true, phone: '+919812345678' })
  })

  it('refuses a field both sides changed to different values (409 CUSTOMER_CHANGED on that path)', async () => {
    const err = await save(form({ name: 'Asha N' }), { ...loaded, name: 'Asha Kumar' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 409, data: { code: CUSTOMER_CHANGED, errors: [{ path: 'name' }] } })
  })

  it('accepts both sides making the same change, and any change when nothing moved', async () => {
    expect(await save(form({ name: 'Asha Kumar' }), { ...loaded, name: 'Asha Kumar' })).toMatchObject({ name: 'Asha Kumar' })
    expect(await save(form({ _verified: true, name: 'X' }), loaded)).toMatchObject({ _verified: true, name: 'X' })
  })

  it('does nothing without a base, for the Local API, or for creates', async () => {
    const live = { ...loaded, _verified: true }
    expect(await save({ ...loaded, name: 'Y' }, live)).toMatchObject({ _verified: false, name: 'Y' })
    expect(await save(form({ name: 'Z' }), live, { payloadAPI: 'local', context: {} })).toMatchObject({ _verified: false })
    const data = { name: 'N' }
    const req = restReq()
    expect((mergeStaleCustomerForm as (a: unknown) => unknown)({ data, operation: 'create', req })).toBe(data)
  })
})

describe('erasure markers', () => {
  it('hash the normalised address and never contain it', () => {
    expect(erasureKey(' Asha@Example.com ')).toBe(erasureKey('asha@example.com'))
    expect(erasureKey('asha@example.com')).toMatch(/^erasure:[0-9a-f]{64}$/)
    expect(erasureKey('asha@example.com')).not.toBe(erasureKey('asha2@example.com'))
  })
})
