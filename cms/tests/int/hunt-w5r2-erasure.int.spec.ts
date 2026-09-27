import { initTransaction, killTransaction, type Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { emitOrderEvent } from '@/commerce/events'
import type { Order, Subscriber } from '@/payload-types'
import { ERASURE_TYPE, erasureKey, lastErasedAt, recordErasure } from '@/retention/erasure'
import { registerRetentionHandlers } from '@/retention/register'
import { confirmSubscription, requestSubscription, upsertCheckoutConsent } from '@/retention/subscribers'

import { createCustomer, createOrder, createStaff, login } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'
import { restDelete } from './helpers/rest'

/**
 * HUNT w5 r2: a subscriber the owner deleted (DPDP erasure) came back — confirmed, for a verified account's
 * order — when an old order of theirs was confirmed again (an admin resolving a review → paid, reconcile
 * re-emitting order.confirmed). Every delete now leaves an erasure marker (src/retention/erasure.ts), and
 * consent given before it never puts the address back.
 */

let payload: Payload
let adminToken: string
let phoneSeq = 0
const phone = () => `+9196${String(Date.now() % 1e6).padStart(6, '0')}${String((phoneSeq += 1) % 100).padStart(2, '0')}`

beforeAll(async () => {
  payload = await getTestPayload()
  registerRetentionHandlers()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
})

const subscriberFor = async (email: string) =>
  ((await payload.find({ collection: 'subscribers', where: { email: { equals: email } }, depth: 0 })).docs[0] as Subscriber | undefined) ?? null

async function orderFor(email: string, { customer, at = new Date(Date.now() - 60_000) }: { customer?: number; at?: Date } = {}) {
  return (await createOrder(payload, {
    contact: { name: 'Asha Rao', email, phone: phone() },
    status: 'paid',
    paymentStatus: 'captured',
    paidAt: new Date().toISOString(),
    consent: { marketing: true, at: at.toISOString(), text: 'Send me recipes and offers.' },
    ...(customer ? { customer } : {}),
  })) as Order
}

const emitConfirmed = async (order: Order) =>
  emitOrderEvent(await makeReq(), { type: 'order.confirmed', order, previousStatus: 'needs_review', source: 'test' })

async function eraseViaAdmin(email: string) {
  const sub = (await subscriberFor(email))!
  const res = await restDelete(`subscribers/${sub.id}`, { token: adminToken })
  expect(res.status, res.text.slice(0, 200)).toBe(200)
  expect(await subscriberFor(email)).toBeNull()
}

describe('an erased subscriber stays erased', () => {
  it("re-confirming a verified account's old order does not re-create them (no row, no email)", async () => {
    const email = uniqueEmail('w5r2-erase-acct')
    const customer = await createCustomer(payload, { email })
    const order = await orderFor(email, { customer: customer.id })
    await emitConfirmed(order)
    expect((await subscriberFor(email))?.status).toBe('confirmed')

    await eraseViaAdmin(email)
    const marker = (await payload.find({ collection: 'message-log', where: { key: { equals: erasureKey(email) } }, depth: 0 })).docs[0]
    expect(marker).toMatchObject({ type: ERASURE_TYPE, status: 'sent' })
    expect(marker.to ?? null).toBeNull()
    expect(JSON.stringify(marker)).not.toContain(email)

    await deleteMessagesTo(email)
    await Promise.all([emitConfirmed(order), emitConfirmed(order)])
    expect(await upsertCheckoutConsent(payload, order)).toBe('erased')
    expect(await subscriberFor(email)).toBeNull()
    expect(await settleAndList(email, 400)).toHaveLength(0)
  })

  it('a guest order placed before the erasure and confirmed after it sends no confirmation email', async () => {
    const email = uniqueEmail('w5r2-erase-guest')
    const early = await orderFor(email)
    await emitConfirmed(await orderFor(email, { at: new Date(Date.now() - 120_000) }))
    expect((await subscriberFor(email))?.status).toBe('pending')
    await eraseViaAdmin(email)
    await deleteMessagesTo(email)
    await emitConfirmed(early)
    expect(await subscriberFor(email)).toBeNull()
    expect(await settleAndList(email, 400)).toHaveLength(0)
  })

  it('consent given after the erasure works as usual; an older order never confirms a new sign-up', async () => {
    const email = uniqueEmail('w5r2-erase-again')
    const customer = await createCustomer(payload, { email })
    const old = await orderFor(email, { customer: customer.id })
    await emitConfirmed(old)
    await eraseViaAdmin(email)

    // They sign up again with the newsletter form: pending until they click; the old order doesn't confirm it.
    await deleteMessagesTo(email)
    expect((await requestSubscription(payload, email)).outcome).toBe('created')
    expect(await upsertCheckoutConsent(payload, old)).toBe('erased')
    expect((await subscriberFor(email))?.status).toBe('pending')

    // A new order with the box ticked (consent after the erasure) is their choice now.
    const fresh = await orderFor(email, { customer: customer.id, at: new Date(Date.now() + 1_000) })
    expect(await upsertCheckoutConsent(payload, fresh)).toBe('confirmed')
    expect((await subscriberFor(email))?.status).toBe('confirmed')
  })

  it('the newsletter confirmation link still works after an erasure (the owner\'s own click)', async () => {
    const email = uniqueEmail('w5r2-erase-click')
    await requestSubscription(payload, email)
    await eraseViaAdmin(email)
    await deleteMessagesTo(email)
    expect((await requestSubscription(payload, email)).outcome).toBe('created')
    const [msg] = await waitForMessages(email, { subject: 'Confirm your Wefeasto subscription' })
    const link = extractLinks((await getMessage(msg.ID)).HTML).find((l) => l.includes('/api/store/newsletter/confirm?t='))!
    expect((await confirmSubscription(payload, new URL(link).searchParams.get('t')!)).outcome).toBe('confirmed')
  })
})

describe('the erasure marker', () => {
  it('commits with the delete: a delete that rolls back leaves no marker', async () => {
    const email = uniqueEmail('w5r2-erase-rollback')
    await requestSubscription(payload, email)
    const sub = (await subscriberFor(email))!
    const req = await makeReq()
    await initTransaction(req)
    await payload.delete({ collection: 'subscribers', id: sub.id, req })
    await killTransaction(req)
    expect(await subscriberFor(email)).not.toBeNull()
    expect(await lastErasedAt(payload, email)).toBeNull()
  })

  it('bulk deletes mark every address; the marker only moves forward', async () => {
    const emails = [uniqueEmail('w5r2-bulk-a'), uniqueEmail('w5r2-bulk-b')]
    for (const e of emails) await requestSubscription(payload, e)
    await payload.delete({ collection: 'subscribers', where: { email: { in: emails } } })
    for (const e of emails) expect(await lastErasedAt(payload, e)).not.toBeNull()

    const at = (await lastErasedAt(payload, emails[0]))!
    await recordErasure(await makeReq(), emails[0], new Date(at.getTime() - 86_400_000))
    expect((await lastErasedAt(payload, emails[0]))!.getTime()).toBe(at.getTime())
    const later = new Date(at.getTime() + 5_000)
    await recordErasure(await makeReq(), emails[0].toUpperCase(), later)
    expect((await lastErasedAt(payload, emails[0]))!.getTime()).toBe(later.getTime())
  })
})
