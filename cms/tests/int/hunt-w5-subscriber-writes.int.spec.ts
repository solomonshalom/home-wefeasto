import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Coupon, Subscriber } from '@/payload-types'
import { welcomeCouponNote } from '@/retention/codes'
import { confirmSubscription, requestSubscription, unsubscribeByToken, upsertCheckoutConsent } from '@/retention/subscribers'
import { unsubscribeToken, unsubscribeTokenHash } from '@/retention/tokens'
import { ensureWelcomeCoupon } from '@/retention/welcome'

import { createStaff, login } from './helpers/factories'
import { extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet, restPatch } from './helpers/rest'

/**
 * HUNT w5: admin / REST writes to subscribers (src/retention/subscriberWrites.ts).
 *   - a Save of a page loaded before the subscriber unsubscribed used to put them back on the list;
 *   - an admin email correction left the old address's unsubscribe hash (the new address could not unsubscribe);
 *   - an admin 'unsubscribed' left unsubscribedAt empty (an older checkout consent could re-subscribe them).
 */

const CONFIRM_SUBJECT = 'Confirm your Wefeasto subscription'

let payload: Payload
let adminToken: string

beforeAll(async () => {
  payload = await getTestPayload()
  adminToken = (await login('users', (await createStaff(payload, 'admin')).email)).token
})

async function row(id: number): Promise<Subscriber> {
  return (await payload.findByID({ collection: 'subscribers', id, depth: 0, showHiddenFields: true })) as Subscriber
}

async function confirmedSubscriber(tag: string): Promise<Subscriber> {
  const at = new Date(Date.now() - 3_600_000).toISOString()
  return (await payload.create({
    collection: 'subscribers',
    data: { email: uniqueEmail(tag), status: 'confirmed', source: 'newsletter', consentText: 'Newsletter', consentAt: at, confirmedAt: at },
  })) as Subscriber
}

/** What the admin page loads: the REST document (hidden fields excluded). */
async function loadForm(id: number): Promise<Record<string, unknown>> {
  const res = await restGet(`subscribers/${id}`, { token: adminToken, query: 'depth=0' })
  expect(res.status).toBe(200)
  const { id: _id, createdAt: _c, ...form } = res.body as Record<string, unknown>
  return form
}

const save = (id: number, body: Record<string, unknown>) => restPatch(`subscribers/${id}`, { token: adminToken, body, query: 'depth=0' })
const errorCode = (body: unknown) => (body as { errors?: { data?: { code?: string } }[] })?.errors?.[0]?.data?.code

describe('a Save of a page loaded before the subscriber changed', () => {
  it('keeps an unsubscribe that happened after the page was loaded (the unrelated edit is saved)', async () => {
    for (const withUpdatedAt of [true, false]) {
      const sub = await confirmedSubscriber('w5-stale')
      const form = await loadForm(sub.id)
      expect(await unsubscribeByToken(payload, unsubscribeToken(sub.email))).toBe('unsubscribed')
      const unsubscribed = await row(sub.id)

      const body = withUpdatedAt ? form : { ...form, updatedAt: undefined }
      const res = await save(sub.id, { ...body, consentText: 'Newsletter (checked)' })
      expect(res.status, res.text.slice(0, 200)).toBe(200)
      expect(await row(sub.id)).toMatchObject({
        status: 'unsubscribed',
        unsubscribedAt: unsubscribed.unsubscribedAt,
        consentText: 'Newsletter (checked)',
      })
    }
  })

  it('refuses (409) to unsubscribe from a stale page someone who signed up again since; an up-to-date page can', async () => {
    const sub = await confirmedSubscriber('w5-resub')
    const stale = await loadForm(sub.id)
    expect(await unsubscribeByToken(payload, unsubscribeToken(sub.email))).toBe('unsubscribed')
    expect((await requestSubscription(payload, sub.email)).outcome).toBe('resubscribed')

    const refused = await save(sub.id, { ...stale, status: 'unsubscribed' })
    expect(refused.status).toBe(409)
    expect(errorCode(refused.body)).toBe('SUBSCRIBER_CHANGED')
    expect((await row(sub.id)).status).toBe('pending')

    const before = Date.now()
    const ok = await save(sub.id, { ...(await loadForm(sub.id)), status: 'unsubscribed' })
    expect(ok.status, ok.text.slice(0, 200)).toBe(200)
    const after = await row(sub.id)
    expect(after).toMatchObject({ status: 'unsubscribed', confirmTokenHash: null, confirmTokenExpiresAt: null })
    expect(new Date(after.unsubscribedAt!).getTime()).toBeGreaterThanOrEqual(before - 1000)
    // The stamp is what keeps an older checkout consent from re-subscribing them.
    const order = { contact: { email: sub.email }, consent: { marketing: true, at: new Date(before - 60_000).toISOString() }, createdAt: new Date(before - 60_000).toISOString() }
    expect(await upsertCheckoutConsent(payload, order as never)).toBe('unsubscribed-later')
  })
})

describe('only the address owner puts an address on the list', () => {
  it('an up-to-date page asking for confirmed is refused (400); a REST body that does not say when it was loaded is ignored', async () => {
    const email = uniqueEmail('w5-owner')
    const { subscriberId } = await requestSubscription(payload, email)
    const form = await loadForm(subscriberId!)
    expect(form.status).toBe('pending')

    const refused = await save(subscriberId!, { ...form, status: 'confirmed' })
    expect(refused.status).toBe(400)
    expect(errorCode(refused.body)).toBe('OWNER_CONSENT_ONLY')
    expect((await row(subscriberId!)).status).toBe('pending')

    const ignored = await save(subscriberId!, { status: 'confirmed', source: 'market stall' })
    expect(ignored.status).toBe(200)
    expect(await row(subscriberId!)).toMatchObject({ status: 'pending', source: 'market stall', confirmedAt: null })
  })

  it('server-owned fields keep their stored values', async () => {
    const sub = await confirmedSubscriber('w5-owned')
    const coupon = await ensureWelcomeCoupon(payload, sub)
    const stored = await row(sub.id)
    const bogus = '2020-01-01T00:00:00.000Z'
    const res = await save(sub.id, {
      confirmedAt: bogus,
      consentAt: bogus,
      unsubscribedAt: bogus,
      lastConfirmSentAt: bogus,
      confirmTokenExpiresAt: bogus,
      welcomeCoupon: null,
      unsubscribeTokenHash: 'x'.repeat(43),
      confirmTokenHash: 'y'.repeat(43),
    })
    expect(res.status, res.text.slice(0, 200)).toBe(200)
    const after = await row(sub.id)
    for (const f of ['confirmedAt', 'consentAt', 'unsubscribedAt', 'lastConfirmSentAt', 'confirmTokenExpiresAt', 'confirmTokenHash'] as const) {
      expect(after[f], f).toEqual(stored[f])
    }
    expect(after.welcomeCoupon).toBe(coupon.id)
    expect(after.unsubscribeTokenHash).toBe(unsubscribeTokenHash(sub.email))
  })
})

describe('correcting a subscriber’s email', () => {
  it('the new address confirms by email, its unsubscribe link works and the welcome coupon follows', async () => {
    const sub = await confirmedSubscriber('w5-typo')
    const coupon = await ensureWelcomeCoupon(payload, sub)
    const fixed = uniqueEmail('w5-fixed')

    const res = await save(sub.id, { email: fixed.toUpperCase() })
    expect(res.status, res.text.slice(0, 200)).toBe(200)
    const after = await row(sub.id)
    expect(after).toMatchObject({ email: fixed, status: 'pending', confirmedAt: null, unsubscribeTokenHash: unsubscribeTokenHash(fixed) })
    const moved = (await payload.findByID({ collection: 'coupons', id: coupon.id, depth: 0 })) as Coupon
    expect(moved).toMatchObject({ boundEmail: fixed, note: welcomeCouponNote(fixed) })

    const [msg] = await waitForMessages(fixed, { subject: CONFIRM_SUBJECT })
    const link = extractLinks((await getMessage(msg.ID)).HTML).find((l) => l.includes('/api/store/newsletter/confirm?t='))!
    expect((await confirmSubscription(payload, new URL(link).searchParams.get('t'))).outcome).toBe('confirmed')
    expect(await settleAndList(sub.email, 300)).toHaveLength(0)

    expect(await unsubscribeByToken(payload, unsubscribeToken(sub.email))).toBe('invalid')
    expect(await unsubscribeByToken(payload, unsubscribeToken(fixed))).toBe('unsubscribed')
    expect((await row(sub.id)).status).toBe('unsubscribed')
  })

  it('an unsubscribed address stays unsubscribed (no email); its new unsubscribe link still answers', async () => {
    const sub = await confirmedSubscriber('w5-typo-off')
    expect(await unsubscribeByToken(payload, unsubscribeToken(sub.email))).toBe('unsubscribed')
    const fixed = uniqueEmail('w5-fixed-off')
    expect((await save(sub.id, { ...(await loadForm(sub.id)), email: fixed })).status).toBe(200)
    expect(await row(sub.id)).toMatchObject({ email: fixed, status: 'unsubscribed', unsubscribeTokenHash: unsubscribeTokenHash(fixed) })
    expect(await unsubscribeByToken(payload, unsubscribeToken(fixed))).toBe('already-unsubscribed')
    expect(await settleAndList(fixed, 400)).toHaveLength(0)
  })

  it('correcting to an address that is already on the list is refused (400) and changes nothing', async () => {
    const taken = await confirmedSubscriber('w5-taken')
    const sub = await confirmedSubscriber('w5-dupe')
    const coupon = await ensureWelcomeCoupon(payload, sub)
    const res = await save(sub.id, { email: taken.email })
    expect(res.status, res.text.slice(0, 200)).toBe(400)
    expect(await row(sub.id)).toMatchObject({ email: sub.email, status: 'confirmed', unsubscribeTokenHash: unsubscribeTokenHash(sub.email) })
    expect(((await payload.findByID({ collection: 'coupons', id: coupon.id, depth: 0 })) as Coupon).boundEmail).toBe(sub.email)
    expect(await settleAndList(taken.email, 400)).toHaveLength(0)
  })

  it('a Local API email change keeps the hash in step too', async () => {
    const sub = await confirmedSubscriber('w5-local')
    const fixed = uniqueEmail('w5-local-fixed')
    await payload.update({ collection: 'subscribers', id: sub.id, data: { email: fixed } })
    expect((await row(sub.id)).unsubscribeTokenHash).toBe(unsubscribeTokenHash(fixed))
  })
})

describe('concurrency', () => {
  it('an unsubscribe racing an admin whole-form Save always ends unsubscribed', async () => {
    for (let i = 0; i < 8; i += 1) {
      const sub = await confirmedSubscriber('w5-race')
      const form = await loadForm(sub.id)
      const [saved, outcome] = await Promise.all([
        save(sub.id, { ...form, source: `stall ${i}` }),
        unsubscribeByToken(payload, unsubscribeToken(sub.email)),
      ])
      expect(saved.status).toBe(200)
      expect(outcome).toBe('unsubscribed')
      expect((await row(sub.id)).status, `round ${i}`).toBe('unsubscribed')
    }
  })
})
