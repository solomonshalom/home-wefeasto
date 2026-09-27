import { describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import {
  isSupersedable,
  orderCartSignature,
  ownedByCustomer,
  sessionCustomerId,
  stillSupersedable,
  SUPERSEDE_STATUSES,
  supersededStock,
  supersedeWhere,
  supersedeWindowMinutes,
} from '@/commerce/checkout/supersede'
import { cartSignature } from '@/commerce/shared/cart-links.js'

/** The supersede rules shared by placeOrder and POST /store/quote (PI-SF-1, PI-SF-2). */

const NOW = Date.parse('2026-09-26T10:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 7,
    number: 'WF-10007',
    status: 'pending_payment',
    paymentStatus: 'created',
    paymentMethod: 'online',
    stockState: 'reserved',
    items: [
      { slug: 'muesli', name: 'Muesli', unitPaise: 25000, qty: 2, lineTotalPaise: 50000 },
      { slug: 'cornflakes', name: 'Cornflakes', unitPaise: 17500, qty: 1, lineTotalPaise: 17500 },
    ],
    razorpay: { attempts: [] },
    createdAt: minutesAgo(5),
    updatedAt: minutesAgo(5),
    ...overrides,
  } as unknown as Order
}

const bag = cartSignature([
  { slug: 'cornflakes', qty: 1 },
  { slug: 'muesli', qty: 2 },
])
const check = { cartSig: bag, now: NOW, windowMinutes: 30 }

describe('isSupersedable', () => {
  it('an unpaid online order for the same bag, in any order of lines, within the window', () => {
    expect(orderCartSignature(order())).toBe(bag)
    expect(isSupersedable(order(), check)).toBe(true)
  })

  it.each(SUPERSEDE_STATUSES)('status %s qualifies (expired included: PI-SF-2)', (status) => {
    expect(isSupersedable(order({ status, stockState: status === 'expired' ? 'released' : 'reserved' }), check)).toBe(true)
  })

  it.each(['paid', 'cod_pending', 'cod_confirmed', 'cancelled', 'needs_review', 'refunded', 'partially_refunded'] as const)(
    'status %s does not',
    (status) => {
      expect(isSupersedable(order({ status }), check)).toBe(false)
    },
  )

  it.each(['none', 'created', 'attempted', 'failed'] as const)('paymentStatus %s qualifies', (paymentStatus) => {
    expect(isSupersedable(order({ paymentStatus }), check)).toBe(true)
  })

  it.each(['authorized', 'captured', 'refunded', 'partially_refunded'] as const)('paymentStatus %s does not (money arrived)', (paymentStatus) => {
    expect(isSupersedable(order({ paymentStatus } as Partial<Order>), check)).toBe(false)
  })

  it('never an order with a payment id, a COD order, another bag or one older than the window', () => {
    expect(isSupersedable(order({ razorpay: { paymentId: 'pay_X', attempts: [] } } as Partial<Order>), check)).toBe(false)
    expect(isSupersedable(order({ paymentMethod: 'cod' }), check)).toBe(false)
    expect(isSupersedable(order(), { ...check, cartSig: cartSignature([{ slug: 'muesli', qty: 2 }]) })).toBe(false)
    expect(isSupersedable(order(), { ...check, cartSig: cartSignature([{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }]) })).toBe(false)
    expect(isSupersedable(order({ createdAt: minutesAgo(29.9) }), check)).toBe(true)
    expect(isSupersedable(order({ createdAt: minutesAgo(30) }), check)).toBe(false)
    expect(isSupersedable(order({ createdAt: '' }), check)).toBe(false)
  })
})

describe('window, stock and the DB pre-filter', () => {
  it('the window is max(reservationMinutes, 30)', () => {
    expect(supersedeWindowMinutes(15)).toBe(30)
    expect(supersedeWindowMinutes(45)).toBe(45)
    expect(supersedeWindowMinutes(Number.NaN)).toBe(30)
  })

  it('only still-reserved orders give their units back', () => {
    const extra = supersededStock([order(), order({ stockState: 'released', items: [{ slug: 'oats', qty: 3 }] as never })])
    expect(Object.fromEntries(extra)).toEqual({ muesli: 2, cornflakes: 1 })
    expect(supersededStock([order({ stockState: 'released' })]).size).toBe(0)
  })

  it('placeOrder pre-filter (signed-in branch): the customer, the three statuses, online, unpaid, window, not this key', () => {
    const where = supersedeWhere({ customerId: 42, key: 'k', now: NOW, windowMinutes: 30 }) as { and: Record<string, unknown>[] }
    expect(where.and).toEqual([
      { customer: { equals: 42 } },
      { status: { in: ['pending_payment', 'payment_failed', 'expired'] } },
      { paymentMethod: { equals: 'online' } },
      { paymentStatus: { in: ['none', 'created', 'attempted', 'failed'] } },
      { createdAt: { greater_than: minutesAgo(30) } },
      { idempotencyKey: { not_equals: 'k' } },
    ])
    // Never keyed on the phone or email: neither proves the order is the checkout's own (SUP-OWN-1).
    expect(JSON.stringify(where)).not.toMatch(/contact/)
  })
})

describe('ownership (SUP-OWN-1)', () => {
  it('sessionCustomerId: only a positive safe integer', () => {
    expect(sessionCustomerId(7)).toBe(7)
    for (const v of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '7', null, undefined, {}]) expect(sessionCustomerId(v)).toBeNull()
  })

  it('ownedByCustomer: the customer relation (id or populated) equals the session customer', () => {
    expect(ownedByCustomer(order({ customer: 42 } as Partial<Order>), 42)).toBe(true)
    expect(ownedByCustomer(order({ customer: { id: 42 } } as Partial<Order>), 42)).toBe(true)
    expect(ownedByCustomer(order({ customer: 43 } as Partial<Order>), 42)).toBe(false)
    expect(ownedByCustomer(order({ customer: null } as Partial<Order>), 42)).toBe(false)
    expect(ownedByCustomer(order(), 42)).toBe(false)
    // A guest checkout owns nothing, not even an order that has no customer either.
    expect(ownedByCustomer(order({ customer: null } as Partial<Order>), null)).toBe(false)
    expect(ownedByCustomer(order({ customer: 0 } as Partial<Order>), 0)).toBe(false)
  })
})

describe('stillSupersedable: the in-transaction re-check (SUP-OWN-1)', () => {
  const PHONE = '+919800000001'
  const withPhone = (phone: string, o: Partial<Order> = {}) => order({ contact: { name: 'A', email: 'a@x.in', phone }, ...o } as Partial<Order>)
  const none = { orders: [], byRef: new Set<number | string>() }
  const ref = { orders: [], byRef: new Set<number | string>([7]) }

  it('a shared phone (and email) alone never qualifies: a guest checkout may not cancel a stranger\'s order', () => {
    expect(stillSupersedable(withPhone(PHONE), none, check)).toBe(false)
    expect(stillSupersedable(withPhone(PHONE), none, { ...check, customerId: null })).toBe(false)
    // …and a signed-in checkout only its own customer's orders.
    expect(stillSupersedable(withPhone(PHONE, { customer: 43 } as Partial<Order>), none, { ...check, customerId: 42 })).toBe(false)
    expect(stillSupersedable(withPhone(PHONE, { customer: null } as Partial<Order>), none, { ...check, customerId: 42 })).toBe(false)
  })

  it('the signed-in customer\'s own order qualifies, whatever its phone', () => {
    expect(stillSupersedable(withPhone('+919800000002', { customer: 42 } as Partial<Order>), none, { ...check, customerId: 42 })).toBe(true)
  })

  it('the order named by a verified guest reference may have another phone', () => {
    expect(stillSupersedable(withPhone('+919800000002'), ref, check)).toBe(true)
    // …but only that order.
    expect(stillSupersedable(withPhone('+919800000002', { id: 8 } as Partial<Order>), ref, check)).toBe(false)
  })

  it('neither the reference nor the session lifts the other rules (money arrived meanwhile, other bag, too old)', () => {
    const other = '+919800000002'
    for (const [targets, args, extra] of [
      [ref, check, {}],
      [none, { ...check, customerId: 42 }, { customer: 42 }],
    ] as const) {
      const o = (x: Partial<Order> = {}) => withPhone(other, { ...extra, ...x } as Partial<Order>)
      expect(stillSupersedable(o({ paymentStatus: 'authorized' } as Partial<Order>), targets, args)).toBe(false)
      expect(stillSupersedable(o({ razorpay: { paymentId: 'pay_X', attempts: [] } } as Partial<Order>), targets, args)).toBe(false)
      expect(stillSupersedable(o({ status: 'cancelled' }), targets, args)).toBe(false)
      expect(stillSupersedable(o(), targets, { ...args, cartSig: cartSignature([{ slug: 'muesli', qty: 2 }]) })).toBe(false)
      expect(stillSupersedable(o({ createdAt: minutesAgo(31) }), targets, args)).toBe(false)
      expect(stillSupersedable(o({ paymentMethod: 'cod' }), targets, args)).toBe(false)
    }
  })
})
