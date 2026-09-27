import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { createCustomer, createStaff, login, PASSWORD } from './helpers/factories'
import { uniqueEmail } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost, STOREFRONT_ORIGIN } from './helpers/rest'

/**
 * Hunt fixes (cms-platform): login CSRF (src/auth/crossSite.ts), overlapping logins losing a session
 * (src/auth/loginSessions.ts), and customers reaching /versions (src/access/hardenInternals.ts).
 */

const EVIL = 'https://evil.example'
const CMS_ORIGIN = 'http://localhost:3000'
let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
})

/** The body an HTML form sends: JSON in a `_payload` part of multipart/form-data (no CORS preflight). */
function formPayload(data: unknown) {
  const boundary = `----wf${Math.random().toString(16).slice(2)}`
  const rawBody = `--${boundary}\r\nContent-Disposition: form-data; name="_payload"\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--\r\n`
  return { rawBody, contentType: `multipart/form-data; boundary=${boundary}` }
}

const signedIn = async (collection: 'customers' | 'users', cookie: string | null) =>
  Boolean(cookie) && (await restGet(`${collection}/me`, { cookie, origin: STOREFRONT_ORIGIN })).body?.user != null

describe('login CSRF: auth writes from another site are refused', () => {
  it('a cross-site form login (multipart _payload, foreign Origin) → 403 and no session cookie', async () => {
    const c = await createCustomer(payload)
    const res = await restPost('customers/login', { ...formPayload({ email: c.email, password: PASSWORD }), origin: EVIL })
    expect(res.status).toBe(403)
    expect(res.body.errors[0]).toMatchObject({ message: 'Sign-in requests must come from the Wefeasto website.' })
    expect(res.cookie).toBeNull()
    // Control: the same form body from the storefront signs in.
    const ok = await restPost('customers/login', { ...formPayload({ email: c.email, password: PASSWORD }), origin: STOREFRONT_ORIGIN })
    expect(ok.status).toBe(200)
    expect(await signedIn('customers', ok.cookie)).toBe(true)
  })

  it('an opaque Origin or Sec-Fetch-Site: cross-site is refused; server-to-server (no Origin) still works', async () => {
    const c = await createCustomer(payload)
    const body = { email: c.email, password: PASSWORD }
    expect((await restPost('customers/login', { body, origin: 'null' })).status).toBe(403)
    expect((await restPost('customers/login', { body, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    const direct = await restPost('customers/login', { body, origin: null })
    expect(direct.status).toBe(200)
    expect(direct.cookie).toBeTruthy()
  })

  it('signup, forgot-password and reset-password from another site → 403, nothing happens', async () => {
    const email = uniqueEmail('csrf-signup')
    const signup = await restPost('customers', { body: { email, password: PASSWORD }, origin: EVIL })
    expect(signup.status).toBe(403)
    expect((await payload.find({ collection: 'customers', where: { email: { equals: email } } })).totalDocs).toBe(0)
    const c = await createCustomer(payload)
    expect((await restPost('customers/forgot-password', { body: { email: c.email }, origin: EVIL })).status).toBe(403)
    const reset = await restPost('customers/reset-password', { body: { token: 'x'.repeat(40), password: PASSWORD }, origin: EVIL })
    expect(reset.status).toBe(403)
  })

  it('staff login: refused cross-site, allowed from the admin (CMS origin)', async () => {
    const staff = await createStaff(payload, 'editor')
    const body = { email: staff.email, password: PASSWORD }
    const evil = await restPost('users/login', { ...formPayload(body), origin: EVIL })
    expect(evil.status).toBe(403)
    expect(evil.cookie).toBeNull()
    const admin = await restPost('users/login', { body, origin: CMS_ORIGIN })
    expect(admin.status).toBe(200)
    expect(admin.body.token).toBeTruthy()
  })
})

describe('overlapping logins of one account keep every session', () => {
  it('customers: parallel logins all stay signed in (sessions are not lost)', async () => {
    const c = await createCustomer(payload)
    for (let round = 0; round < 3; round++) {
      const logins = await Promise.all([0, 1, 2].map(() => restPost('customers/login', { body: { email: c.email, password: PASSWORD }, origin: STOREFRONT_ORIGIN })))
      expect(logins.map((r) => r.status), `round ${round}`).toEqual([200, 200, 200])
      expect(await Promise.all(logins.map((r) => signedIn('customers', r.cookie))), `round ${round}`).toEqual([true, true, true])
    }
    const doc = await payload.findByID({ collection: 'customers', id: c.id, showHiddenFields: true, depth: 0 })
    expect((doc as { sessions?: unknown[] }).sessions).toHaveLength(9)
  })

  it('staff: parallel logins all keep working; a wrong password in the mix neither blocks nor breaks them', async () => {
    const staff = await createStaff(payload, 'admin')
    const started = Date.now()
    const [a, bad, b] = await Promise.all([
      restPost('users/login', { body: { email: staff.email, password: PASSWORD }, origin: CMS_ORIGIN }),
      restPost('users/login', { body: { email: staff.email, password: 'wrong-password-1' }, origin: CMS_ORIGIN }),
      restPost('users/login', { body: { email: staff.email, password: PASSWORD }, origin: CMS_ORIGIN }),
    ])
    expect(Date.now() - started).toBeLessThan(5_000)
    expect([a.status, bad.status, b.status]).toEqual([200, 401, 200])
    for (const r of [a, b]) expect((await restGet('users/me', { token: r.body.token })).body.user?.id).toBe(staff.id)
  })
})

describe('version history is not reachable by customers (and never a 500)', () => {
  it('customer on non-versioned collections and the store-settings global → 403', async () => {
    const c = await createCustomer(payload)
    const { cookie } = await login('customers', c.email)
    const paths = ['orders', 'customers', 'coupons', 'users', 'payment-events', 'media', 'payload-jobs', 'globals/store-settings']
    for (const p of paths) {
      const res = await restGet(`${p}/versions`, { cookie, query: 'limit=1' })
      expect(res.status, p).toBe(403)
    }
    expect((await restGet('products/versions', { cookie, query: 'limit=1' })).status).toBe(403)
  })

  it('guests cannot trigger a restore on a collection without versions; staff keep product history', async () => {
    expect((await restPost('orders/versions/1')).status).toBe(403)
    expect((await restPost('globals/store-settings/versions/1')).status).toBe(403)
    const staff = await createStaff(payload, 'editor')
    const { token } = await login('users', staff.email)
    expect((await restGet('products/versions', { token, query: 'limit=1' })).status).toBe(200)
    expect((await restGet('orders/versions', { token, query: 'limit=1' })).status).toBe(403)
  })
})
