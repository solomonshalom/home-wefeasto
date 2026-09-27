import { APIError } from 'payload'
import { describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import { formRevision, nextRevision, staleFormEdit } from '@/commerce/checkout/adminEdits'
import { bulkUpdateAllOrNothing } from '@/lib/bulkAllOrNothing'

/**
 * Wave 5 (cms-checkout): a whole-form admin Save loaded before a server write that changes no status (a
 * failed refund, a second chargeback, an amount mismatch) must not erase the reviewReason alert or release
 * the hold; a bulk edit where one order is refused must save nothing.
 */

const history = [
  { at: '2026-09-26T10:00:00.000Z', field: 'status', to: 'pending_payment', source: 'checkout' },
  { at: '2026-09-26T10:05:00.000Z', field: 'status', from: 'pending_payment', to: 'paid', source: 'webhook' },
]
const live = (o: Partial<Order> = {}) =>
  ({ status: 'paid', paymentStatus: 'captured', fulfilmentStatus: 'unfulfilled', reviewReason: null, revision: 3, statusHistory: history, ...o }) as Order

const ALERT = '[2026-09-26 10:10Z] Refund rfnd_1 of payment pay_1 FAILED at Razorpay — pay the customer back manually.'

describe('nextRevision (what makes an open admin form stale)', () => {
  it('starts at 0 and stays put when nothing an admin must see changed', () => {
    expect(nextRevision({ revision: 9 }, undefined)).toBe(0)
    expect(nextRevision({ status: 'paid', fulfilmentStatus: 'unfulfilled', reviewReason: '' }, live())).toBe(3)
    expect(nextRevision({ razorpay: { payments: [] }, refunds: [] }, live())).toBe(3)
    expect(nextRevision({}, live({ revision: null }))).toBe(0)
  })

  it('bumps on a status, payment, fulfilment, review-note or chargeback change', () => {
    expect(nextRevision({ status: 'needs_review' }, live())).toBe(4)
    expect(nextRevision({ paymentStatus: 'refunded' }, live())).toBe(4)
    expect(nextRevision({ fulfilmentStatus: 'packed' }, live())).toBe(4)
    expect(nextRevision({ reviewReason: ALERT }, live())).toBe(4)
    expect(nextRevision({ dispute: { disputeId: 'disp_2', status: 'open' } }, live({ dispute: { disputeId: 'disp_1', status: 'open' } }))).toBe(4)
    expect(nextRevision({ dispute: { disputeId: 'disp_1', status: 'open', at: 'later' } }, live({ dispute: { disputeId: 'disp_1', status: 'open' } }))).toBe(3)
  })
})

describe('staleFormEdit', () => {
  it('refuses a form loaded before a refund failed: packing it would erase the alert', () => {
    const now = live({ reviewReason: ALERT, revision: 4 })
    const r = staleFormEdit({ status: 'paid', fulfilmentStatus: 'packed', reviewReason: null }, now, { rows: 2, revision: 3 })
    expect(r?.field).toBe('fulfilmentStatus')
    expect(r?.message).toMatch(/changed while you had it open \(new notes were added to Review Reason\)/)
    // Even a Save that changes nothing else would erase it.
    expect(staleFormEdit({ status: 'paid', fulfilmentStatus: 'unfulfilled', reviewReason: '' }, now, { rows: 2, revision: 3 })?.field).toBe('reviewReason')
  })

  it('refuses resolving a hold from a form loaded before a second chargeback (no status change)', () => {
    const now = live({ status: 'needs_review', reviewReason: 'd1\nd2', revision: 6 })
    expect(staleFormEdit({ status: 'paid', reviewReason: 'd1' }, now, { rows: 2, revision: 5 })?.field).toBe('status')
  })

  it('lets through an up-to-date form, a stale form equal to the live order, and plain REST calls', () => {
    const now = live({ reviewReason: ALERT, revision: 4 })
    expect(staleFormEdit({ fulfilmentStatus: 'packed', reviewReason: ALERT }, now, { rows: 2, revision: 4 })).toBeNull()
    expect(staleFormEdit({ status: 'paid', fulfilmentStatus: 'unfulfilled', reviewReason: ALERT }, now, { rows: 2, revision: 3 })).toBeNull()
    expect(staleFormEdit({ fulfilmentStatus: 'packed', reviewReason: null }, now, {})).toBeNull()
    // null and '' are the same empty note.
    expect(staleFormEdit({ status: 'paid', reviewReason: '' }, live({ revision: 4 }), { revision: 3 })).toBeNull()
  })

  it('a form without a revision is judged by its history rows, on the status fields only', () => {
    const now = live({ status: 'needs_review', reviewReason: 'x' })
    const r = staleFormEdit({ status: 'paid', reviewReason: 'note' }, now, { rows: 1 })
    expect(r).toEqual({ field: 'status', message: expect.stringContaining('(it is now "needs_review")') })
    expect(staleFormEdit({ status: 'needs_review', reviewReason: 'note' }, now, { rows: 1 })).toBeNull()
  })

  it('formRevision reads the raw request', () => {
    expect(formRevision({ revision: 4 })).toBe(4)
    expect(formRevision({ revision: '4' })).toBe(4)
    for (const bad of [{ revision: -1 }, { revision: 1.5 }, { revision: 'x' }, { revision: null }, {}, null]) expect(formRevision(bad)).toBeUndefined()
  })
})

describe('bulkUpdateAllOrNothing', () => {
  const req = { context: {} } as never
  const hook = bulkUpdateAllOrNothing({
    plural: 'orders',
    refusal: (_req, id) => (id === 2 ? { label: 'WF-10002', errors: [{ path: 'status', message: 'rolled-oats is out of stock.' }] } : undefined),
  })
  const run = (operation: string, result: unknown) => (hook as (a: unknown) => Promise<unknown>)({ operation, req, result, args: {}, collection: {} })

  it('passes a clean bulk edit and single-document saves through', async () => {
    const ok = { docs: [{ id: 1 }], errors: [] }
    expect(await run('update', ok)).toBe(ok)
    expect(await run('updateByID', { id: 1 })).toEqual({ id: 1 })
  })

  it('throws (rolling the shared transaction back) when any document failed, and says why', async () => {
    const err = (await run('update', {
      docs: [{ id: 1 }],
      errors: [
        { id: 2, message: 'The following field is invalid: status', isPublic: true },
        { id: 3, message: 'relation "x" does not exist', isPublic: false },
      ],
    }).catch((e: unknown) => e)) as APIError
    expect(err).toBeInstanceOf(APIError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Nothing was saved: 2 of 3 orders could not be updated. WF-10002: rolled-oats is out of stock. | #3: Something went wrong.')
    expect(err.data).toEqual({ errors: [{ path: 'status', message: 'rolled-oats is out of stock.' }] })
  })
})
