import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { emitOrderEvent, orderEventHandlerNames } from '@/commerce/events'
import type { Order, Subscriber } from '@/payload-types'
import { registerRetentionHandlers, RETENTION_HANDLER_NAMES } from '@/retention/register'
import { confirmSubscription, requestSubscription, unsubscribeByToken, upsertCheckoutConsent } from '@/retention/subscribers'
import { unsubscribeToken, unsubscribeTokenHash } from '@/retention/tokens'

import { createCustomer, createOrder } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'

/**
 * Checkout consent → newsletter (M6). Consent must come from the address owner (DPDP, double opt-in):
 *   - an order placed signed in, by a verified account with the same email, subscribes it at once
 *     (confirmed, source 'checkout', no email);
 *   - any other order (a guest, a free COD order) only ASKS the owner: new → pending + confirmation email,
 *     unsubscribed → stays unsubscribed + a link that re-subscribes only when clicked.
 * Driven through the real event bus (emitOrderEvent), orders created through the Local API.
 */

const CONFIRM_SUBJECT = 'Confirm your Wefeasto subscription'
let payload: Payload
let phoneSeq = 0
const uniquePhone = () => `+9197${String(Date.now() % 1e6).padStart(6, '0')}${String((phoneSeq += 1) % 100).padStart(2, '0')}`

beforeAll(async () => {
  payload = await getTestPayload()
  registerRetentionHandlers() // idempotent; guards against another spec having cleared the registry
})

async function subscriberFor(email: string): Promise<Subscriber | null> {
  const res = await payload.find({ collection: 'subscribers', where: { email: { equals: email } }, showHiddenFields: true, depth: 0 })
  expect(res.docs.length).toBeLessThanOrEqual(1)
  return (res.docs[0] as Subscriber) ?? null
}

type OrderOpts = { marketing?: boolean; at?: Date; text?: string; customer?: number; status?: string }
async function confirmedOrder(email: string, { marketing = true, at = new Date(), text = 'Send me recipes and offers.', customer, status = 'paid' }: OrderOpts = {}) {
  return (await createOrder(payload, {
    contact: { name: 'Asha Rao', email, phone: uniquePhone() },
    status,
    ...(status === 'paid' ? { paymentStatus: 'captured', paidAt: new Date().toISOString() } : { paymentMethod: 'cod', requestedMethod: 'cod' }),
    consent: { marketing, at: at.toISOString(), text },
    ...(customer ? { customer } : {}),
  })) as Order
}

/** A signed-in order: a verified customer account with this email. */
async function accountOrder(email: string, opts: OrderOpts = {}) {
  const customer = await createCustomer(payload, { email })
  return confirmedOrder(email, { ...opts, customer: customer.id })
}

async function emitConfirmed(order: Order) {
  const results = await emitOrderEvent(await makeReq(), { type: 'order.confirmed', order, previousStatus: 'pending_payment', source: 'test' })
  const mine = results.filter((r) => r.name.startsWith('retention:'))
  expect(mine.map((r) => r.name).sort()).toEqual([RETENTION_HANDLER_NAMES.consent, RETENTION_HANDLER_NAMES.refill].sort())
  for (const r of mine) expect(r).toMatchObject({ ok: true })
}

async function confirmTokenFrom(email: string, count = 1): Promise<string> {
  const msgs = await waitForMessages(email, { subject: CONFIRM_SUBJECT, count })
  const link = extractLinks((await getMessage(msgs[0].ID)).HTML).find((l) => l.includes('/api/store/newsletter/confirm?t='))
  expect(link).toBeTruthy()
  return new URL(link!).searchParams.get('t')!
}

describe('order.confirmed → checkout consent', () => {
  it('registers its handlers when the config loads', () => {
    expect(orderEventHandlerNames('order.confirmed')).toEqual(expect.arrayContaining([RETENTION_HANDLER_NAMES.consent, RETENTION_HANDLER_NAMES.refill]))
    expect(orderEventHandlerNames('order.household_updated')).toContain(RETENTION_HANDLER_NAMES.household)
  })

  it('guest order: a PENDING subscriber (source checkout) + one confirmation email; the click confirms it', async () => {
    const email = uniqueEmail('co-guest')
    await deleteMessagesTo(email)
    const order = await confirmedOrder(email.toUpperCase(), { text: 'Yes, email me breakfast recipes and offers.' })
    await emitConfirmed(order)
    const sub = (await subscriberFor(email))!
    expect(sub).toMatchObject({ email, status: 'pending', source: 'checkout', consentText: 'Yes, email me breakfast recipes and offers.' })
    expect(sub.unsubscribeTokenHash).toBe(unsubscribeTokenHash(email))

    // Repeated events inside the cooldown send nothing more.
    await Promise.all(Array.from({ length: 4 }, () => emitConfirmed(order)))
    expect(await settleAndList(email, 500)).toHaveLength(1)
    expect((await subscriberFor(email))!.status).toBe('pending')

    expect((await confirmSubscription(payload, await confirmTokenFrom(email))).outcome).toBe('confirmed')
    expect((await subscriberFor(email))!.status).toBe('confirmed')
  })

  it('a free COD order cannot override an unsubscribe: it stays unsubscribed until the OWNER clicks the link', async () => {
    const email = uniqueEmail('co-cod-unsub')
    await requestSubscription(payload, email)
    expect(await unsubscribeByToken(payload, unsubscribeToken(email))).toBe('unsubscribed')
    await deleteMessagesTo(email)
    const unsubscribedAt = (await subscriberFor(email))!.unsubscribedAt!

    const order = await confirmedOrder(email, { status: 'cod_pending', at: new Date(Date.parse(unsubscribedAt) + 5_000) })
    // Within 10 minutes of the sign-up's confirmation email: nothing is sent at all.
    await emitConfirmed(order)
    expect((await subscriberFor(email))!.status).toBe('unsubscribed')
    expect(await settleAndList(email, 300)).toHaveLength(0)

    // Later (the sign-up was long ago): one re-confirmation email; the row STAYS unsubscribed.
    const sub = (await subscriberFor(email))!
    await payload.db.updateOne({ collection: 'subscribers', id: sub.id, data: { lastConfirmSentAt: new Date(Date.now() - 3_600_000).toISOString() } })
    expect(await upsertCheckoutConsent(payload, order)).toBe('reconfirm-sent')
    expect(await upsertCheckoutConsent(payload, order)).toBe('throttled')
    expect((await subscriberFor(email))!.status).toBe('unsubscribed')

    // Only the owner's click (the link went to their inbox) brings them back.
    const token = await confirmTokenFrom(email)
    expect((await subscriberFor(email))!.status).toBe('unsubscribed')
    expect((await confirmSubscription(payload, token)).outcome).toBe('confirmed')
    expect((await subscriberFor(email))!.status).toBe('confirmed')
  })

  it('no consent → nothing', async () => {
    const email = uniqueEmail('co-none')
    await emitConfirmed(await confirmedOrder(email, { marketing: false }))
    expect(await subscriberFor(email)).toBeNull()
  })

  it('signed-in verified account, same email: confirmed at once, no email; repeated events change nothing', async () => {
    const email = uniqueEmail('co-account')
    await deleteMessagesTo(email)
    const at = new Date(Date.now() - 60_000)
    const order = await accountOrder(email, { at, text: 'Send offers.' })
    await emitConfirmed(order)
    const sub = (await subscriberFor(email))!
    expect(sub).toMatchObject({ email, status: 'confirmed', source: 'checkout', consentText: 'Send offers.', consentAt: at.toISOString() })
    expect(sub.confirmTokenHash ?? null).toBeNull()
    await Promise.all(Array.from({ length: 3 }, () => emitConfirmed(order)))
    expect((await subscriberFor(email))!.updatedAt).toBe(sub.updatedAt)
    expect(await settleAndList(email, 500)).toHaveLength(0)
  })

  it('an account order with ANOTHER email proves nothing about that email', async () => {
    const email = uniqueEmail('co-other')
    const customer = await createCustomer(payload, { email: uniqueEmail('co-owner') })
    const order = await confirmedOrder(email, { customer: customer.id })
    expect(await upsertCheckoutConsent(payload, order)).toBe('pending')
  })

  it('an account order confirms a pending sign-up; an unsubscribe older than its consent is overridden by the owner', async () => {
    const pending = uniqueEmail('co-acc-pending')
    await requestSubscription(payload, pending)
    await emitConfirmed(await accountOrder(pending))
    expect((await subscriberFor(pending))!.status).toBe('confirmed')

    const resub = uniqueEmail('co-acc-resub')
    await requestSubscription(payload, resub)
    expect(await unsubscribeByToken(payload, unsubscribeToken(resub))).toBe('unsubscribed')
    const at = new Date(Date.parse((await subscriberFor(resub))!.unsubscribedAt!) + 5_000)
    await emitConfirmed(await accountOrder(resub, { at, text: 'Changed my mind.' }))
    expect(await subscriberFor(resub)).toMatchObject({ status: 'confirmed', source: 'checkout', consentText: 'Changed my mind.', consentAt: at.toISOString() })
  })

  it('unsubscribed AFTER the order’s consent (a late or repeated event) → stays unsubscribed, no email', async () => {
    const email = uniqueEmail('co-late')
    const order = await accountOrder(email, { at: new Date(Date.now() - 3_600_000) })
    await emitConfirmed(order)
    expect((await subscriberFor(email))!.status).toBe('confirmed')
    expect(await unsubscribeByToken(payload, unsubscribeToken(email))).toBe('unsubscribed')
    await deleteMessagesTo(email)
    await emitConfirmed(order) // e.g. the reconcile job re-emits after a crash
    expect((await subscriberFor(email))!.status).toBe('unsubscribed')
    expect(await upsertCheckoutConsent(payload, order)).toBe('unsubscribed-later')
    expect(await settleAndList(email, 300)).toHaveLength(0)
  })

  it('outcomes (direct): an existing confirmed subscriber is left alone; fallbacks for consent.at/text', async () => {
    const email = uniqueEmail('co-direct')
    const existing = await payload.create({
      collection: 'subscribers',
      data: { email, status: 'confirmed', source: 'newsletter', consentText: 'newsletter', confirmedAt: new Date().toISOString() },
    })
    const order = await confirmedOrder(email)
    expect(await upsertCheckoutConsent(payload, order)).toBe('unchanged')
    expect(await subscriberFor(email)).toMatchObject({ id: existing.id, status: 'confirmed', source: 'newsletter' })
    expect(await upsertCheckoutConsent(payload, { ...order, consent: { marketing: false } })).toBe('no-consent')
    expect(await upsertCheckoutConsent(payload, { ...order, contact: { ...order.contact, email: 'not-an-email' } })).toBe('invalid-email')

    const email2 = uniqueEmail('co-fallback')
    const bare = await accountOrder(email2)
    expect(await upsertCheckoutConsent(payload, { ...bare, consent: { marketing: true } })).toBe('created')
    expect(await subscriberFor(email2)).toMatchObject({ consentAt: bare.createdAt, consentText: 'Ticked the marketing email box at checkout.' })
  })

  it('concurrent first events for a new address create exactly one row and send one email', async () => {
    const email = uniqueEmail('co-race')
    await deleteMessagesTo(email)
    const order = await confirmedOrder(email)
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => upsertCheckoutConsent(payload, order)))
    expect(outcomes.filter((o) => o === 'pending')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'throttled')).toHaveLength(5)
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(1)
    expect(await settleAndList(email, 500)).toHaveLength(1)
  })
})
