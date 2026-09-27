import { describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import { formHistoryRows, refundingPrimaryPayment, staleStatusEdit } from '@/commerce/checkout/adminEdits'
import { moneyArrived } from '@/commerce/checkout/orders'
import { orderCartSignature, paidMeanwhile } from '@/commerce/checkout/supersede'

/** Pure guards added in hunt round 1 (cms-checkout): admin edits, paid supersede refs. */

const NOW = Date.parse('2026-09-26T10:00:00.000Z')
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 9,
    number: 'WF-10009',
    status: 'paid',
    paymentStatus: 'captured',
    fulfilmentStatus: 'unfulfilled',
    paymentMethod: 'online',
    items: [{ slug: 'muesli', name: 'Muesli', unitPaise: 25000, qty: 1, lineTotalPaise: 25000 }],
    razorpay: { attempts: [], paymentId: 'pay_A' },
    refunds: [],
    statusHistory: [
      { at: at(10), field: 'status', to: 'pending_payment', source: 'checkout' },
      { at: at(5), field: 'status', from: 'pending_payment', to: 'paid', source: 'webhook' },
    ],
    createdAt: at(10),
    ...overrides,
  } as unknown as Order
}

describe('staleStatusEdit (admin Save from a form loaded before a status change)', () => {
  // The live order has 2 history rows; a form loaded before the payment landed carries 1.
  it('refuses a form loaded with fewer history rows that would write a different status value', () => {
    const live = order({ status: 'needs_review' })
    expect(staleStatusEdit({ status: 'paid', fulfilmentStatus: 'packed' }, live, 1)).toBe('status')
    expect(staleStatusEdit({ status: 'needs_review', fulfilmentStatus: 'packed' }, live, 1)).toBe('fulfilmentStatus')
  })

  it('lets through an up-to-date form, a stale form that leaves the status fields as they are, and REST calls', () => {
    const live = order()
    expect(staleStatusEdit({ status: 'paid', fulfilmentStatus: 'packed' }, live, 2)).toBeNull()
    expect(staleStatusEdit({ status: 'paid', paymentStatus: 'captured', fulfilmentStatus: 'unfulfilled' }, live, 1)).toBeNull()
    expect(staleStatusEdit({ fulfilmentStatus: 'packed' }, live, undefined)).toBeNull()
  })

  it('formHistoryRows reads the raw request: rows, a row count, or nothing', () => {
    expect(formHistoryRows({ statusHistory: [{}, {}] })).toBe(2)
    expect(formHistoryRows({ statusHistory: 3 })).toBe(3)
    expect(formHistoryRows({ fulfilmentStatus: 'packed' })).toBeUndefined()
    expect(formHistoryRows({ statusHistory: 'x' })).toBeUndefined()
    expect(formHistoryRows(null)).toBeUndefined()
  })
})

describe('refundingPrimaryPayment', () => {
  it('names the order\'s own payment while a refund of it is queued, pending or processed', () => {
    for (const status of ['queued', 'pending', 'processed'] as const) {
      expect(refundingPrimaryPayment(order({ refunds: [{ paymentId: 'pay_A', amountPaise: 25000, status }] as Order['refunds'] }))).toBe('pay_A')
    }
  })

  it('ignores failed refunds, refunds of other (duplicate) payments and orders without a payment', () => {
    expect(refundingPrimaryPayment(order({ refunds: [{ paymentId: 'pay_A', amountPaise: 25000, status: 'failed' }] as Order['refunds'] }))).toBeNull()
    expect(refundingPrimaryPayment(order({ refunds: [{ paymentId: 'pay_B', amountPaise: 25000, status: 'queued' }] as Order['refunds'] }))).toBeNull()
    expect(refundingPrimaryPayment(order({ razorpay: { attempts: [] }, refunds: [{ paymentId: 'pay_A', amountPaise: 1, status: 'queued' }] as Order['refunds'] }))).toBeNull()
  })
})

describe('paidMeanwhile (a verified supersede ref to an order that was paid)', () => {
  const check = { cartSig: orderCartSignature(order()), now: NOW, windowMinutes: 30 }

  it('true for this bag\'s online order with money on it, inside the window', () => {
    expect(paidMeanwhile(order(), check)).toBe(true)
    expect(paidMeanwhile(order({ status: 'pending_payment', paymentStatus: 'authorized', razorpay: { attempts: [] } }), check)).toBe(true)
  })

  it('false for another bag, an old order, COD, or an order without money', () => {
    expect(paidMeanwhile(order(), { ...check, cartSig: 'other' })).toBe(false)
    expect(paidMeanwhile(order({ createdAt: at(45) }), check)).toBe(false)
    expect(paidMeanwhile(order({ paymentMethod: 'cod', status: 'cod_pending' }), check)).toBe(false)
    const unpaid = order({ status: 'payment_failed', paymentStatus: 'failed', razorpay: { attempts: [] } })
    expect(moneyArrived(unpaid)).toBe(false)
    expect(paidMeanwhile(unpaid, check)).toBe(false)
  })
})
