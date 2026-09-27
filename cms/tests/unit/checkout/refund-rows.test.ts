import { describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import { partlyRefundedPrimary, refundingPrimaryPayment } from '@/commerce/checkout/adminEdits'
import { matchRefundRows, type RefundUpdate, withdrawnRefundState } from '@/commerce/checkout/refunds'
import { holdsUnshippedStock } from '@/commerce/checkout/stock'

/** Hunt wave 5 round 2 (cms-checkout): refund rows, hold release by a human, restock of unshipped refunds. */

type Rows = NonNullable<Order['refunds']>

const dupQueued = { paymentId: 'pay_LATE', amountPaise: 25000, receipt: 'WF-10001-dup-LATE01', reason: 'duplicate_payment', status: 'queued' }
const rzpOwn: RefundUpdate = { refundId: 'rfnd_RZP', paymentId: 'pay_LATE', amountPaise: 25000, status: 'processed', receipt: null }

describe('matchRefundRows', () => {
  it('a receipt-less refund Razorpay made itself settles our queued full refund of that payment (not a new row)', () => {
    expect(matchRefundRows([dupQueued] as Rows, rzpOwn)).toEqual({ byId: -1, ours: 0 })
    expect(matchRefundRows([dupQueued] as Rows, { ...rzpOwn, status: 'pending' })).toEqual({ byId: -1, ours: 0 })
  })

  it('never ties to ours: a failed refund, a smaller (partial) one, another payment\'s, or an external row', () => {
    expect(matchRefundRows([dupQueued] as Rows, { ...rzpOwn, status: 'failed' }).ours).toBe(-1)
    expect(matchRefundRows([dupQueued] as Rows, { ...rzpOwn, amountPaise: 5000 }).ours).toBe(-1)
    expect(matchRefundRows([dupQueued] as Rows, { ...rzpOwn, paymentId: 'pay_OTHER' }).ours).toBe(-1)
    expect(matchRefundRows([{ ...dupQueued, reason: 'external' }] as Rows, rzpOwn).ours).toBe(-1)
    expect(matchRefundRows([{ ...dupQueued, status: 'failed' }] as Rows, rzpOwn).ours).toBe(-1)
  })

  it('with a receipt, only the row with that receipt is ours', () => {
    expect(matchRefundRows([dupQueued] as Rows, { ...rzpOwn, receipt: 'WF-10001-dup-LATE01' }).ours).toBe(0)
    expect(matchRefundRows([dupQueued] as Rows, { ...rzpOwn, receipt: 'WF-10001-r1' }).ours).toBe(-1)
  })

  it('finds both rows when the refund was filed separately before it was tied to ours (they get merged)', () => {
    const separate = { refundId: 'rfnd_RZP', paymentId: 'pay_LATE', amountPaise: 25000, reason: 'external', status: 'processed' }
    expect(matchRefundRows([dupQueued, separate] as Rows, { ...rzpOwn, receipt: dupQueued.receipt })).toEqual({ byId: 1, ours: 0 })
    // A redelivered receipt-less webhook of that refund finds them too.
    expect(matchRefundRows([dupQueued, separate] as Rows, rzpOwn)).toEqual({ byId: 1, ours: 0 })
    // Once settled, the refund is found by id only.
    expect(matchRefundRows([{ ...dupQueued, refundId: 'rfnd_RZP', status: 'processed' }] as Rows, rzpOwn)).toEqual({ byId: 0, ours: -1 })
  })
})

const order = (refunds: unknown[], totalPaise = 25000) =>
  ({ totalPaise, razorpay: { attempts: [], paymentId: 'pay_A' }, refunds }) as unknown as Order

describe('releasing a hold: refundingPrimaryPayment / partlyRefundedPrimary', () => {
  it('a partial Dashboard refund doesn\'t block "partially_refunded", but "paid" would hide it', () => {
    const o = order([{ refundId: 'rfnd_1', paymentId: 'pay_A', amountPaise: 5000, reason: 'external', status: 'processed' }])
    expect(refundingPrimaryPayment(o)).toBeNull()
    expect(partlyRefundedPrimary(o)).toBe('pay_A')
    const pending = order([{ refundId: 'rfnd_1', paymentId: 'pay_A', amountPaise: 5000, reason: 'late note', status: 'pending' }])
    expect(refundingPrimaryPayment(pending)).toBeNull()
    expect(partlyRefundedPrimary(pending)).toBe('pay_A')
  })

  it('automatic refunds of the order\'s payment, or refunds covering the whole order, still block', () => {
    for (const reason of ['duplicate_payment', 'out_of_stock', 'order_cancelled']) {
      expect(refundingPrimaryPayment(order([{ paymentId: 'pay_A', amountPaise: 25000, reason, status: 'queued' }]))).toBe('pay_A')
    }
    const two = order([
      { refundId: 'rfnd_1', paymentId: 'pay_A', amountPaise: 15000, reason: 'external', status: 'processed' },
      { refundId: 'rfnd_2', paymentId: 'pay_A', amountPaise: 10000, reason: 'external', status: 'pending' },
    ])
    expect(refundingPrimaryPayment(two)).toBe('pay_A')
  })

  it('failed refunds and refunds of other payments count for neither', () => {
    const o = order([
      { refundId: 'rfnd_1', paymentId: 'pay_A', amountPaise: 5000, reason: 'external', status: 'failed' },
      { refundId: 'rfnd_2', paymentId: 'pay_B', amountPaise: 25000, reason: 'duplicate_payment', status: 'processed' },
    ])
    expect(refundingPrimaryPayment(o)).toBeNull()
    expect(partlyRefundedPrimary(o)).toBeNull()
  })
})

describe('holdsUnshippedStock', () => {
  it('true while unfulfilled/packed with stock reserved or committed', () => {
    for (const fulfilmentStatus of ['unfulfilled', 'packed']) {
      for (const stockState of ['reserved', 'committed']) expect(holdsUnshippedStock({ fulfilmentStatus, stockState })).toBe(true)
      expect(holdsUnshippedStock({ fulfilmentStatus, stockState: 'released' })).toBe(false)
    }
    for (const fulfilmentStatus of ['shipped', 'delivered', 'rto', 'returned']) {
      expect(holdsUnshippedStock({ fulfilmentStatus, stockState: 'committed' })).toBe(false)
    }
  })
})

describe('withdrawnRefundState (verify pass 2: a refund counted while pending failed, nothing refunded)', () => {
  const cap = { capturedAt: '2026-09-27T10:00:00.000Z' }
  it('partly refunded → paid, payment back to captured (authorized if never captured)', () => {
    expect(withdrawnRefundState({ status: 'partially_refunded', paymentStatus: 'partially_refunded', razorpay: cap })).toEqual({ status: 'paid', paymentStatus: 'captured' })
    expect(withdrawnRefundState({ status: 'partially_refunded', paymentStatus: 'partially_refunded', razorpay: { capturedAt: null } })).toEqual({ status: 'paid', paymentStatus: 'authorized' })
    expect(withdrawnRefundState({ status: 'partially_refunded', paymentStatus: 'captured', razorpay: cap })).toEqual({ status: 'paid' })
  })
  it('a hold stays (payment status corrected under it); other statuses keep theirs', () => {
    expect(withdrawnRefundState({ status: 'needs_review', paymentStatus: 'partially_refunded', razorpay: cap })).toEqual({ paymentStatus: 'captured' })
    expect(withdrawnRefundState({ status: 'paid', paymentStatus: 'partially_refunded', razorpay: cap })).toEqual({ paymentStatus: 'captured' })
    expect(withdrawnRefundState({ status: 'paid', paymentStatus: 'captured', razorpay: cap })).toEqual({})
    expect(withdrawnRefundState({ status: 'cancelled', paymentStatus: 'captured', razorpay: cap })).toEqual({})
  })
  it('refunded is terminal: nothing changes', () => {
    expect(withdrawnRefundState({ status: 'refunded', paymentStatus: 'refunded', razorpay: cap })).toEqual({})
    expect(withdrawnRefundState({ status: 'refunded', paymentStatus: 'partially_refunded', razorpay: cap })).toEqual({})
  })
})
