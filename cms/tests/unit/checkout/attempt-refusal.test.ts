import { describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import { attemptRefusal } from '@/commerce/checkout/attempts'

/**
 * HUNT-CONC-R3-1: createAttempt records (and hands out) a Razorpay order only if, under the order lock, the
 * order still wants money. attemptRefusal is that re-check.
 */

const attempts = (n: number) => Array.from({ length: n }, (_, i) => ({ orderId: `order_T${i}`, receipt: `WF-1-a${i + 1}`, amount: 100 }))
const order = (over: Partial<Order> & { attempts?: number } = {}): Order => {
  const { attempts: n = 1, ...rest } = over
  return {
    id: 1,
    number: 'WF-10001',
    status: 'pending_payment',
    paymentStatus: 'created',
    paymentMethod: 'online',
    requestedMethod: 'upi',
    razorpay: { attempts: attempts(n) },
    ...rest,
  } as unknown as Order
}

describe('attemptRefusal', () => {
  it('an unpaid online order waiting for money may get a sheet', () => {
    expect(attemptRefusal(order())).toBeNull()
    expect(attemptRefusal(order({ status: 'payment_failed', paymentStatus: 'failed' }))).toBeNull()
    expect(attemptRefusal(order({ attempts: 0, paymentStatus: 'none' }))).toBeNull()
  })

  it("'paid' once money arrived (status, payment id or authorised/captured)", () => {
    expect(attemptRefusal(order({ status: 'paid', paymentStatus: 'captured' }))).toBe('paid')
    expect(attemptRefusal(order({ paymentStatus: 'authorized' }))).toBe('paid')
    expect(attemptRefusal(order({ razorpay: { attempts: attempts(1), paymentId: 'pay_X' } } as never))).toBe('paid')
    expect(attemptRefusal(order({ status: 'refunded', paymentStatus: 'refunded' }))).toBe('paid')
  })

  it("'not_payable' for cancelled, expired, in review, COD", () => {
    for (const status of ['cancelled', 'expired', 'needs_review'] as const) expect(attemptRefusal(order({ status }))).toBe('not_payable')
    expect(attemptRefusal(order({ status: 'cod_pending', paymentMethod: 'cod', requestedMethod: 'cod' }))).toBe('not_payable')
  })

  it('the attempt cap applies to recording a NEW attempt, not to handing back one a racing caller recorded', () => {
    expect(attemptRefusal(order({ attempts: 10 }))).toBe('not_payable')
    expect(attemptRefusal(order({ attempts: 10 }), { recording: false })).toBeNull()
    expect(attemptRefusal(order({ status: 'cancelled', attempts: 2 }), { recording: false })).toBe('not_payable')
  })
})
