import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { evaluateCoupon as evaluateSharedCoupon } from '@/commerce/shared/coupons.js'
import { resetRateLimits } from '@/lib/rateLimit'
import type { Coupon, Subscriber } from '@/payload-types'
import { WELCOME_CODE_RE } from '@/retention/codes'
import { hashToken, unsubscribeToken, unsubscribeTokenHash } from '@/retention/tokens'
import { ensureWelcomeCoupon } from '@/retention/welcome'

import { createRecipe } from './helpers/catalogFactories'
import { createOrder } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

/**
 * M6 newsletter (double opt-in) + S6 welcome offer, end to end through the REST handlers and Mailpit.
 * Env (tests/int/env.ts): PAYLOAD_PUBLIC_SERVER_URL=http://localhost:3000, STOREFRONT_URL=http://localhost:5173.
 */

const CMS = 'http://localhost:3000'
const SHOP = 'http://localhost:5173'
const MAILPIT = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:54326').replace(/\/+$/, '')
const CONFIRM_SUBJECT = 'Confirm your Wefeasto subscription'
const HOUR = 3600_000

let payload: Payload

/** The DB row as checkout passes it (Payload types say `boolean | null`; the shared JSDoc says `boolean`). */
const evaluateCoupon = (coupon: Coupon, ctx: Parameters<typeof evaluateSharedCoupon>[1]) =>
  evaluateSharedCoupon(coupon as unknown as Parameters<typeof evaluateSharedCoupon>[0], ctx)

beforeAll(async () => {
  payload = await getTestPayload()
  // Two published, home-featured recipes so the welcome email always has recipes to show.
  for (let i = 0; i < 2; i += 1) {
    await createRecipe(payload, { homeFeatured: true, homeAlt: 'A bowl of breakfast' })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function subscriberFor(email: string): Promise<Subscriber | null> {
  const res = await payload.find({ collection: 'subscribers', where: { email: { equals: email } }, showHiddenFields: true, depth: 0 })
  expect(res.docs.length).toBeLessThanOrEqual(1)
  return (res.docs[0] as Subscriber) ?? null
}

async function couponsFor(email: string): Promise<Coupon[]> {
  return (await payload.find({ collection: 'coupons', where: { boundEmail: { equals: email } }, depth: 0 })).docs as Coupon[]
}

async function headersOf(id: string): Promise<Record<string, string[]>> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${encodeURIComponent(id)}/headers`)
  return (await res.json()) as Record<string, string[]>
}

const signup = (body: unknown, headers: Record<string, string> = {}) => restPost('store/newsletter', { body, headers })

async function confirmLinkFrom(to: string, count = 1): Promise<string> {
  const msgs = await waitForMessages(to, { subject: CONFIRM_SUBJECT, count })
  const full = await getMessage(msgs[0].ID) // newest first
  const link = extractLinks(full.HTML).find((l) => l.startsWith(`${CMS}/api/store/newsletter/confirm?t=`))
  expect(link).toBeTruthy()
  return link!
}

/** Follows a link from an email through the REST handlers (GET or POST). */
async function follow(link: string, method: 'GET' | 'POST' = 'GET', opts: Parameters<typeof restPost>[1] = {}) {
  const url = new URL(link)
  const path = url.pathname.replace(/^\/api\//, '')
  const query = url.search.slice(1)
  return method === 'GET' ? restGet(path, { ...opts, query }) : restPost(path, { ...opts, query })
}

const tokenOf = (link: string) => new URL(link).searchParams.get('t')!

async function subscribeAndConfirm(email: string) {
  await deleteMessagesTo(email)
  expect((await signup({ email })).status).toBe(200)
  const link = await confirmLinkFrom(email)
  const res = await follow(link)
  expect(res.status).toBe(303)
  return link
}

describe('POST /api/store/newsletter → confirm → welcome offer', () => {
  it('happy path: pending + one confirmation email → confirm → welcome email with a personal HELLO code', async () => {
    const email = uniqueEmail('nl-happy')
    await deleteMessagesTo(email)

    const res = await signup({ email: `  ${email.toUpperCase()} `, website: '' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers.get('cache-control')).toBe('no-store')

    const pending = await subscriberFor(email)
    expect(pending).toMatchObject({ email, status: 'pending', source: 'newsletter' })
    expect(pending!.consentText).toMatch(/double opt-in/)
    expect(pending!.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(pending!.unsubscribeTokenHash).toBe(unsubscribeTokenHash(email))
    const ttl = Date.parse(pending!.confirmTokenExpiresAt!) - Date.parse(pending!.lastConfirmSentAt!)
    expect(ttl).toBe(7 * 24 * HOUR)

    // Exactly one confirmation email; its link is the CMS confirm endpoint; only the hash is stored.
    const link = await confirmLinkFrom(email)
    expect(hashToken(tokenOf(link))).toBe(pending!.confirmTokenHash)
    const [confirmMsg] = await waitForMessages(email)
    expect((await headersOf(confirmMsg.ID))['List-Unsubscribe']).toBeUndefined()
    expect(await settleAndList(email, 400)).toHaveLength(1)

    const confirmed = await follow(link)
    expect(confirmed.status).toBe(303)
    expect(confirmed.headers.get('location')).toBe(`${SHOP}/?subscribed=1#newsletter`)
    expect(confirmed.headers.get('cache-control')).toBe('no-store')

    const sub = await subscriberFor(email)
    expect(sub).toMatchObject({ status: 'confirmed' })
    expect(sub!.confirmedAt).toBeTruthy()
    expect(sub!.consentAt).toBe(sub!.confirmedAt)

    // The coupon: unique HELLO-XXXX, 10% capped at ₹75, single use, first order, bound, 30 days.
    const [coupon] = await couponsFor(email)
    expect(sub!.welcomeCoupon).toBe(coupon.id)
    expect(coupon.code).toMatch(WELCOME_CODE_RE)
    expect(coupon.code).toMatch(/^HELLO-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(coupon).toMatchObject({
      type: 'percent',
      value: 10,
      maxDiscountPaise: 7500,
      usageLimit: 1,
      usedCount: 0,
      perCustomerLimit: 1,
      firstOrderOnly: true,
      boundEmail: email,
      active: true,
    })
    expect(Date.parse(coupon.endsAt!) - Date.parse(coupon.startsAt!)).toBe(30 * 24 * HOUR)
    expect(Math.abs(Date.parse(coupon.startsAt!) - Date.parse(sub!.confirmedAt!))).toBeLessThan(5000)

    // The welcome email: code, /cart?offer= link, two recipes, one-click unsubscribe (+ headers).
    const [welcome] = await waitForMessages(email, { subject: '10% off your first order' })
    const full = await getMessage(welcome.ID)
    expect(full.HTML).toContain(coupon.code)
    expect(full.Text).toContain(coupon.code)
    const links = extractLinks(full.HTML)
    expect(links).toContain(`${SHOP}/cart?offer=${coupon.code}`)
    const recipeLinks = [...new Set(links.filter((l) => l.startsWith(`${SHOP}/recipes/wf-`)))]
    expect(recipeLinks).toHaveLength(2)
    const slugs = recipeLinks.map((l) => l.slice(`${SHOP}/recipes/`.length))
    const published = await payload.find({ collection: 'recipes', where: { and: [{ slug: { in: slugs } }, { _status: { equals: 'published' } }] } })
    expect(published.totalDocs).toBe(2)
    const unsubscribe = `${CMS}/api/store/newsletter/unsubscribe?t=${unsubscribeToken(email)}`
    expect(links).toContain(unsubscribe)
    const headers = await headersOf(welcome.ID)
    expect(headers['List-Unsubscribe']).toEqual([`<${unsubscribe}>`])
    expect(headers['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click'])
    expect(await settleAndList(email, 400)).toHaveLength(2)

    // $shared evaluateCoupon (what checkout runs): valid for this email's first order, not for others.
    const now = Date.now()
    const ok = evaluateCoupon(coupon, { subtotalPaise: 42500, now, email: email.toUpperCase(), isFirstOrder: true, customerUsageCount: 0 })
    expect(ok).toMatchObject({ discountPaise: 4200, error: null, deferredChecks: [] })
    expect(evaluateCoupon(coupon, { subtotalPaise: 125000, now, email, isFirstOrder: true, customerUsageCount: 0 }).discountPaise).toBe(7500)
    const other = evaluateCoupon(coupon, { subtotalPaise: 42500, now, email: uniqueEmail('someone-else'), isFirstOrder: true, customerUsageCount: 0 })
    expect(other.error).toEqual({ code: 'COUPON_INVALID', reason: 'EMAIL_MISMATCH' })
    expect(evaluateCoupon(coupon, { subtotalPaise: 42500, now, email, isFirstOrder: false, customerUsageCount: 0 }).error?.reason).toBe('FIRST_ORDER_ONLY')
    expect(evaluateCoupon(coupon, { subtotalPaise: 42500, now, email, isFirstOrder: true, customerUsageCount: 1 }).error?.reason).toBe('PER_CUSTOMER_LIMIT')
    expect(evaluateCoupon({ ...coupon, usedCount: 1 }, { subtotalPaise: 42500, now, email, isFirstOrder: true, customerUsageCount: 0 }).error?.reason).toBe('USAGE_LIMIT')
    expect(evaluateCoupon(coupon, { subtotalPaise: 42500, now: coupon.endsAt!, email, isFirstOrder: true, customerUsageCount: 0 }).error?.reason).toBe('EXPIRED')

    // Confirming again is idempotent: same redirect, no second welcome, still one coupon.
    const again = await follow(link)
    expect(again.status).toBe(303)
    expect(again.headers.get('location')).toBe(`${SHOP}/?subscribed=1#newsletter`)
    expect(await settleAndList(email, 500)).toHaveLength(2)
    expect(await couponsFor(email)).toHaveLength(1)

    // A new sign-up from a confirmed address: 200, nothing sent, nothing changed.
    expect((await signup({ email })).body).toEqual({ ok: true })
    expect(await settleAndList(email, 400)).toHaveLength(2)
    expect((await subscriberFor(email))!.status).toBe('confirmed')
  })

  it('one row per lower-cased address; a repeat within 10 minutes sends nothing; after the cooldown a NEW link replaces the old one', async () => {
    const email = uniqueEmail('nl-dupe')
    await deleteMessagesTo(email)
    expect((await signup({ email })).status).toBe(200)
    expect((await signup({ email: email.toUpperCase() })).status).toBe(200)
    expect((await signup({ email: `\t${email}\n` })).status).toBe(200)
    const first = await confirmLinkFrom(email)
    expect(await settleAndList(email, 500)).toHaveLength(1)
    const rows = await payload.find({ collection: 'subscribers', where: { email: { like: email.split('@')[0] } } })
    expect(rows.totalDocs).toBe(1)

    // Age the last send past the cooldown: the next sign-up rotates the token and emails a new link.
    const sub = (await subscriberFor(email))!
    await payload.db.updateOne({
      collection: 'subscribers',
      id: sub.id,
      data: { lastConfirmSentAt: new Date(Date.now() - 11 * 60_000).toISOString() },
      returning: false,
    })
    expect((await signup({ email })).status).toBe(200)
    await waitForMessages(email, { count: 2 })
    const second = await confirmLinkFrom(email, 2)
    expect(second).not.toBe(first)

    // The replaced link no longer works; the new one does.
    expect((await follow(first)).headers.get('location')).toBe(`${SHOP}/?subscribed=expired#newsletter`)
    expect((await subscriberFor(email))!.status).toBe('pending')
    expect((await follow(second)).headers.get('location')).toBe(`${SHOP}/?subscribed=1#newsletter`)
    expect((await subscriberFor(email))!.status).toBe('confirmed')
  })

  it('concurrent sign-ups for a new address: one row, one email', async () => {
    const email = uniqueEmail('nl-race')
    await deleteMessagesTo(email)
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => signup({ email: i % 2 ? email.toUpperCase() : email })))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    await waitForMessages(email)
    expect(await settleAndList(email, 800)).toHaveLength(1)
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(1)
  })

  it('concurrent confirms: one welcome email, one coupon', async () => {
    const email = uniqueEmail('nl-confirm-race')
    await deleteMessagesTo(email)
    await signup({ email })
    const link = await confirmLinkFrom(email)
    const results = await Promise.all(Array.from({ length: 5 }, () => follow(link)))
    for (const r of results) expect(r.headers.get('location')).toBe(`${SHOP}/?subscribed=1#newsletter`)
    await waitForMessages(email, { count: 2 })
    expect(await settleAndList(email, 800)).toHaveLength(2)
    expect(await couponsFor(email)).toHaveLength(1)
  })

  it('an expired link (7 days) redirects to ?subscribed=expired and leaves the address pending; junk tokens too', async () => {
    const email = uniqueEmail('nl-expired')
    await deleteMessagesTo(email)
    await signup({ email })
    const link = await confirmLinkFrom(email)
    const sub = (await subscriberFor(email))!
    await payload.db.updateOne({
      collection: 'subscribers',
      id: sub.id,
      data: { confirmTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
      returning: false,
    })
    const res = await follow(link)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${SHOP}/?subscribed=expired#newsletter`)
    expect((await subscriberFor(email))!.status).toBe('pending')
    expect(await couponsFor(email)).toHaveLength(0)

    for (const query of ['t=' + 'A'.repeat(43), 't=short', 't=', '']) {
      const r = await restGet('store/newsletter/confirm', { query })
      expect(r.status).toBe(303)
      expect(r.headers.get('location')).toBe(`${SHOP}/?subscribed=expired#newsletter`)
    }
  })

  it('unsubscribe by GET (303 ?unsubscribed=1), idempotent; old confirm links cannot re-subscribe; re-subscribing needs a new confirmation but gets no second welcome', async () => {
    const email = uniqueEmail('nl-unsub')
    const confirmLink = await subscribeAndConfirm(email)
    const [welcome] = await waitForMessages(email, { subject: '10% off' })
    const unsubscribeLink = extractLinks((await getMessage(welcome.ID)).HTML).find((l) => l.includes('/unsubscribe?t='))!
    const [couponBefore] = await couponsFor(email)

    const res = await follow(unsubscribeLink)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${SHOP}/?unsubscribed=1#newsletter`)
    let sub = (await subscriberFor(email))!
    expect(sub.status).toBe('unsubscribed')
    expect(sub.unsubscribedAt).toBeTruthy()
    expect(sub.confirmTokenHash ?? null).toBeNull()

    // Idempotent.
    expect((await follow(unsubscribeLink)).headers.get('location')).toBe(`${SHOP}/?unsubscribed=1#newsletter`)
    // The old confirm link must not re-subscribe them.
    expect((await follow(confirmLink)).headers.get('location')).toBe(`${SHOP}/?subscribed=expired#newsletter`)
    expect((await subscriberFor(email))!.status).toBe('unsubscribed')
    // Unknown / malformed unsubscribe tokens.
    expect((await restGet('store/newsletter/unsubscribe', { query: `t=${'B'.repeat(43)}` })).headers.get('location')).toBe(
      `${SHOP}/?unsubscribed=invalid#newsletter`,
    )
    expect((await restGet('store/newsletter/unsubscribe', { query: 't=nope' })).headers.get('location')).toBe(`${SHOP}/?unsubscribed=invalid#newsletter`)

    // Re-subscribe: straight back to pending with a fresh link (no cooldown after an unsubscribe).
    await deleteMessagesTo(email)
    expect((await signup({ email })).status).toBe(200)
    sub = (await subscriberFor(email))!
    expect(sub.status).toBe('pending')
    const newLink = await confirmLinkFrom(email)
    expect(newLink).not.toBe(confirmLink)
    expect((await follow(newLink)).headers.get('location')).toBe(`${SHOP}/?subscribed=1#newsletter`)
    sub = (await subscriberFor(email))!
    expect(sub.status).toBe('confirmed')
    // One welcome per address, ever; the same coupon stays linked.
    expect(await settleAndList(email, 600)).toHaveLength(1)
    expect(sub.welcomeCoupon).toBe(couponBefore.id)
    expect(await couponsFor(email)).toHaveLength(1)
  })

  it('RFC 8058 one-click POST on the List-Unsubscribe URL', async () => {
    const email = uniqueEmail('nl-oneclick')
    await subscribeAndConfirm(email)
    const [welcome] = await waitForMessages(email, { subject: '10% off' })
    const header = (await headersOf(welcome.ID))['List-Unsubscribe'][0]
    const url = header.replace(/^<|>$/g, '')
    const res = await follow(url, 'POST', { rawBody: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect((await subscriberFor(email))!.status).toBe('unsubscribed')
    // Repeat → still 200.
    expect((await follow(url, 'POST', { rawBody: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' })).status).toBe(200)
    // Unknown token → 404; no token → 400.
    const unknown = await restPost('store/newsletter/unsubscribe', { query: `t=${'C'.repeat(43)}`, rawBody: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('NOT_FOUND')
    const missing = await restPost('store/newsletter/unsubscribe', { rawBody: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' })
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('VALIDATION')
  })

  it('honeypot: silent 200, no row, no email', async () => {
    const email = uniqueEmail('nl-bot')
    await deleteMessagesTo(email)
    for (const website of ['http://spam.example', ' x ', 1, true]) {
      const res = await signup({ email, website })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    }
    // A bot with a garbage email is not told it's garbage either.
    expect((await signup({ email: 'not-an-email', website: 'x' })).status).toBe(200)
    expect(await subscriberFor(email)).toBeNull()
    expect(await settleAndList(email, 500)).toHaveLength(0)
  })

  it('malformed input: 400 VALIDATION / INVALID_JSON, 415 for non-JSON', async () => {
    for (const email of ['', 'nope', 'a@b', 'a b@example.com', 'x@example.com'.padStart(300, 'x'), 42, null, undefined]) {
      const res = await signup({ email })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION', details: { fields: { email: 'INVALID' } } })
    }
    expect((await signup([uniqueEmail()])).status).toBe(400)
    const badJson = await restPost('store/newsletter', { rawBody: '{"email":', contentType: 'application/json' })
    expect(badJson.status).toBe(400)
    expect(badJson.body.error.code).toBe('INVALID_JSON')
    const form = await restPost('store/newsletter', { rawBody: 'email=a%40example.com', contentType: 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(415)
  })

  it('no membership oracle: new, pending, confirmed and unsubscribed addresses get the same answer', async () => {
    const confirmed = uniqueEmail('nl-oracle-c')
    await subscribeAndConfirm(confirmed)
    const pending = uniqueEmail('nl-oracle-p')
    await signup({ email: pending })
    const answers = await Promise.all([uniqueEmail('nl-oracle-new'), pending, confirmed].map((email) => signup({ email })))
    for (const a of answers) {
      expect(a.status).toBe(200)
      expect(a.text).toBe('{"ok":true}')
    }
  })

  it('an address that already ordered gets the welcome email without a (useless) first-order code', async () => {
    const email = uniqueEmail('nl-customer')
    await createOrder(payload, {
      contact: { name: 'Asha Rao', email, phone: '+919812345670' },
      status: 'paid',
      paymentStatus: 'captured',
      paidAt: new Date().toISOString(),
    })
    await subscribeAndConfirm(email)
    const [welcome] = await waitForMessages(email, { subject: 'breakfast ideas' })
    const full = await getMessage(welcome.ID)
    expect(full.HTML).not.toMatch(/HELLO-/)
    expect(extractLinks(full.HTML)).toContain(`${SHOP}/shop`)
    expect(await couponsFor(email)).toHaveLength(0)
    expect((await headersOf(welcome.ID))['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click'])
  })

  it('an SMTP failure on the confirmation email lifts the cooldown so the next try sends at once', async () => {
    const email = uniqueEmail('nl-smtp')
    await deleteMessagesTo(email)
    vi.spyOn(payload, 'sendEmail').mockRejectedValueOnce(new Error('SMTP 421 try later'))
    expect((await signup({ email })).status).toBe(200) // still ok: no oracle, no error leak
    expect((await subscriberFor(email))!.lastConfirmSentAt ?? null).toBeNull()
    expect(await settleAndList(email, 300)).toHaveLength(0)
    expect((await signup({ email })).status).toBe(200)
    await confirmLinkFrom(email)
    expect(await settleAndList(email, 400)).toHaveLength(1)
  })

  it('welcome code collisions are retried with a new code', async () => {
    const email = uniqueEmail('nl-collide')
    const taken = `HELLO-${Date.now().toString(32).slice(-4).toUpperCase().replace(/[ILOU]/g, 'X')}`
    await payload.create({
      collection: 'coupons',
      data: { code: taken, type: 'percent', value: 5, usedCount: 0, active: false, note: 'collision fixture' },
    })
    const sub = await payload.create({ collection: 'subscribers', data: { email, status: 'confirmed', source: 'newsletter' } })
    const fresh = `HELLO-${Date.now().toString(32).slice(-6).toUpperCase().replace(/[ILOU]/g, 'Y')}`
    const tries: string[] = []
    const coupon = await ensureWelcomeCoupon(payload, sub, new Date(), (attempt) => {
      const code = attempt < 2 ? taken : fresh
      tries.push(code)
      return code
    })
    expect(tries).toEqual([taken, taken, fresh])
    expect(coupon.code).toBe(fresh)
    expect(coupon.boundEmail).toBe(email)
    // Idempotent: a second call returns the linked coupon.
    const linked = await payload.findByID({ collection: 'subscribers', id: sub.id, depth: 0 })
    expect((await ensureWelcomeCoupon(payload, linked)).id).toBe(coupon.id)
  })

  describe('rate limits', () => {
    const saved = process.env.RATE_LIMIT_DISABLED
    afterEach(() => {
      process.env.RATE_LIMIT_DISABLED = saved
      resetRateLimits()
    })

    it('5 sign-ups per minute per IP, then 429 RATE_LIMITED with Retry-After', async () => {
      process.env.RATE_LIMIT_DISABLED = '0'
      resetRateLimits()
      const ip = { 'x-real-ip': '203.0.113.77' }
      const statuses: number[] = []
      for (let i = 0; i < 5; i += 1) statuses.push((await signup({ email: uniqueEmail('nl-rl'), website: 'bot' }, ip)).status)
      expect(statuses).toEqual([200, 200, 200, 200, 200])
      const limited = await signup({ email: uniqueEmail('nl-rl') }, ip)
      expect(limited.status).toBe(429)
      expect(limited.body.error.code).toBe('RATE_LIMITED')
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      // Another client is unaffected.
      expect((await signup({ email: uniqueEmail('nl-rl'), website: 'bot' }, { 'x-real-ip': '203.0.113.78' })).status).toBe(200)
    })

    it('at most one confirmation email per address per 10 minutes, even across IPs', async () => {
      process.env.RATE_LIMIT_DISABLED = '0'
      resetRateLimits()
      const email = uniqueEmail('nl-rl-addr')
      await deleteMessagesTo(email)
      for (let i = 0; i < 4; i += 1) {
        expect((await signup({ email }, { 'x-real-ip': `198.51.100.${i + 1}` })).status).toBe(200)
      }
      await waitForMessages(email)
      expect(await settleAndList(email, 600)).toHaveLength(1)
    })
  })
})
