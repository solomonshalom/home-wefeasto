import type { Payload } from 'payload'

import { uniqueEmail } from './mailpit'
import { jwtOf, restPost, STOREFRONT_ORIGIN } from './rest'

/**
 * Test data builders. All use the Local API with overrideAccess (the default), so they bypass REST
 * access rules on purpose; assert access rules through the REST helpers instead.
 */

export const PASSWORD = 'Str0ng-Passw0rd!'

export async function createStaff(payload: Payload, role: 'admin' | 'editor' = 'admin', email = uniqueEmail(role)) {
  const user = await payload.create({ collection: 'users', data: { email, password: PASSWORD, role } })
  // The first user is forced to admin by the Users hook; re-apply the requested role. The last admin can't be
  // demoted (src/auth/lastAdmin.ts), so another admin is created first.
  if (user.role !== role) {
    await payload.create({ collection: 'users', data: { email: uniqueEmail('admin'), password: PASSWORD, role: 'admin' } })
    await payload.update({ collection: 'users', id: user.id, data: { role } })
  }
  return { ...user, role, password: PASSWORD }
}

/** A verified customer (Local API create with _verified: true skips the email). */
export async function createCustomer(payload: Payload, overrides: Record<string, unknown> = {}) {
  const email = (overrides.email as string) ?? uniqueEmail('customer')
  const doc = await payload.create({
    collection: 'customers',
    data: { email, password: PASSWORD, name: 'Test Customer', _verified: true, ...overrides },
    disableVerificationEmail: true,
  })
  return { ...doc, password: PASSWORD }
}

/**
 * Logs in over REST and returns the JWT + cookie. The JWT comes from the Set-Cookie payload-token:
 * customers never get it in the JSON body (auth.removeTokenFromResponses).
 */
export async function login(collection: 'customers' | 'users', email: string, password = PASSWORD) {
  const res = await restPost(`${collection}/login`, { body: { email, password }, origin: STOREFRONT_ORIGIN })
  if (res.status !== 200) throw new Error(`login ${collection} ${email} → ${res.status} ${res.text}`)
  return { token: jwtOf(res), cookie: res.cookie as string, user: res.body.user }
}

let orderSeq = 0
/** Minimal valid order via the Local API (number/tokenNonce/tokenHash are filled in by the collection). */
export async function createOrder(payload: Payload, overrides: Record<string, unknown> = {}) {
  orderSeq += 1
  return payload.create({
    collection: 'orders',
    data: {
      contact: { name: 'Asha Rao', email: uniqueEmail('order'), phone: '+919876543210' },
      shippingAddress: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
      items: [{ slug: 'rolled-oats', name: 'Rolled Oats', unitPaise: 24900, qty: 2, lineTotalPaise: 49800 }],
      subtotalPaise: 49800,
      discountPaise: 0,
      deliveryPaise: 0,
      codFeePaise: 0,
      totalPaise: 49800,
      requestedMethod: 'upi',
      paymentMethod: 'online',
      status: 'pending_payment',
      idempotencyKey: `test-${Date.now()}-${orderSeq}-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    } as any,
  })
}
