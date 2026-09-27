import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { CUSTOMER_CHANGED, EDIT_BASE_FIELD } from '@/auth/customerEdits'
import type { Customer } from '@/payload-types'

import { createCustomer, createStaff, login, PASSWORD } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPatch, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * HUNT w5 r2: an admin Save of a customer from a page opened a moment earlier used to write the whole stale
 * form over the row: the customer who verified meanwhile was un-verified (refused at login) and an address
 * they saved was deleted. src/auth/customerEdits.ts merges per field against what the page was loaded with.
 */

let payload: Payload
let adminToken: string

beforeAll(async () => {
  payload = await getTestPayload()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
})

const row = async (id: number) => (await payload.findByID({ collection: 'customers', id, depth: 0, showHiddenFields: true })) as Customer

/** What the admin page loads (the REST document as an admin reads it), minus what a form never sends. */
async function loadForm(id: number): Promise<Record<string, unknown>> {
  const res = await restGet(`customers/${id}`, { token: adminToken, query: 'depth=0' })
  expect(res.status).toBe(200)
  const { id: _id, createdAt: _c, sessions: _s, ...form } = res.body as Record<string, unknown>
  return form
}

const adminSave = (id: number, body: Record<string, unknown>) => restPatch(`customers/${id}`, { token: adminToken, body, query: 'depth=0' })
const customerLogin = (email: string) => restPost('customers/login', { body: { email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })
const address = { label: 'Home', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001', isDefault: true }

describe('an admin Save from a page loaded before the customer changed', () => {
  it('does not un-verify a customer who verified after the page was loaded; the name fix is saved', async () => {
    const c = await createCustomer(payload, { _verified: false, name: 'Asha K' })
    const form = await loadForm(c.id)
    expect(form._verified).toBe(false)
    expect(typeof form[EDIT_BASE_FIELD]).toBe('string')

    const token = (await row(c.id))._verificationToken
    expect((await restPost(`customers/verify/${token}`, { origin: STOREFRONT_ORIGIN })).status).toBe(200)

    const res = await adminSave(c.id, { ...form, name: 'Asha K. Kumar' })
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect(await row(c.id)).toMatchObject({ name: 'Asha K. Kumar', _verified: true })
    expect((await customerLogin(c.email)).status).toBe(200)
  })

  it("keeps an address the customer saved meanwhile, and their marketing opt-in with its timestamp", async () => {
    const c = await createCustomer(payload, { name: 'Ravi' })
    const form = await loadForm(c.id)
    const me = await login('customers', c.email)
    const own = await restPatch(`customers/${c.id}`, { token: me.token, body: { addresses: [address], marketingOptIn: true } })
    expect(own.status, own.text.slice(0, 300)).toBe(200)
    const optedIn = await row(c.id)
    expect(optedIn.marketingOptInAt).toBeTruthy()

    const res = await adminSave(c.id, { ...form, phone: '+919812345678' })
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    const after = await row(c.id)
    expect(after).toMatchObject({ phone: '+919812345678', marketingOptIn: true, marketingOptInAt: optedIn.marketingOptInAt })
    expect(after.addresses).toMatchObject([{ line1: '12 MG Road', pin: '560001' }])
  })

  it('refuses (409) a field both the page and the customer changed; the customer\'s value stays', async () => {
    const c = await createCustomer(payload, { name: 'Meera' })
    const form = await loadForm(c.id)
    const me = await login('customers', c.email)
    expect((await restPatch(`customers/${c.id}`, { token: me.token, body: { name: 'Meera Nair' } })).status).toBe(200)

    const res = await adminSave(c.id, { ...form, name: 'Meera N.' })
    expect(res.status, res.text.slice(0, 300)).toBe(409)
    expect(res.body.errors?.[0]?.data).toMatchObject({ code: CUSTOMER_CHANGED, errors: [{ path: 'name' }] })
    expect((await row(c.id)).name).toBe('Meera Nair')

    // Reloaded: the edit goes through.
    expect((await adminSave(c.id, { ...(await loadForm(c.id)), name: 'Meera N.' })).status).toBe(200)
    expect((await row(c.id)).name).toBe('Meera N.')
  })

  it('an up-to-date page can still un-verify, and a second Save from a reloaded page works', async () => {
    const c = await createCustomer(payload)
    const res = await adminSave(c.id, { ...(await loadForm(c.id)), _verified: false })
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect((await row(c.id))._verified).toBe(false)
    // The response carries the new base: saving again from it is not stale.
    const { id: _id, createdAt: _c, sessions: _s, ...doc } = res.body.doc as Record<string, unknown>
    const next = { ...doc, name: 'Second save' }
    expect((await adminSave(c.id, { ...next, _verified: true })).status).toBe(200)
    expect(await row(c.id)).toMatchObject({ name: 'Second save', _verified: true })
  })

  it('failed logins and reset requests (bookkeeping) never make a page stale', async () => {
    const c = await createCustomer(payload, { name: 'Kiran' })
    const form = await loadForm(c.id)
    expect((await restPost('customers/login', { body: { email: c.email, password: 'wrong-password-123' }, origin: STOREFRONT_ORIGIN })).status).toBe(401)
    expect((await restPost('customers/forgot-password', { body: { email: c.email }, origin: STOREFRONT_ORIGIN })).status).toBe(200)
    const res = await adminSave(c.id, { ...form, name: 'Kiran R' })
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect((await row(c.id)).name).toBe('Kiran R')
  })

  it('plain REST writes (no base) are unchanged; customers never see the base', async () => {
    const c = await createCustomer(payload, { name: 'Dev' })
    expect((await adminSave(c.id, { phone: '+919800000001' })).status).toBe(200)
    expect((await row(c.id)).phone).toBe('+919800000001')

    const me = await login('customers', c.email)
    const mine = await restGet('customers/me', { token: me.token })
    expect(mine.status).toBe(200)
    expect(JSON.stringify(mine.body)).not.toContain(EDIT_BASE_FIELD)
    const byId = await restGet(`customers/${c.id}`, { token: me.token })
    expect(byId.status).toBe(200)
    expect(byId.body[EDIT_BASE_FIELD]).toBeUndefined()
    // A base a customer makes up changes nothing for them: their own writes are still guarded as before.
    const forged = await restPatch(`customers/${c.id}`, { token: me.token, body: { name: 'Dev K', _verified: false, [EDIT_BASE_FIELD]: '{}' } })
    expect(forged.status).toBe(200)
    expect(await row(c.id)).toMatchObject({ name: 'Dev K', _verified: true })
  })
})
