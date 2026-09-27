import type { Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { emitOrderEvent } from '@/commerce/events'
import type { Order, PayloadJob, Product } from '@/payload-types'
import { refillKey, refillQueueKey, runRefillReminder, scheduleRefillReminder } from '@/retention/refill'
import { registerRetentionHandlers } from '@/retention/register'
import { confirmSubscription, unsubscribeByToken, upsertCheckoutConsent } from '@/retention/subscribers'
import { remindAtFrom } from '@/retention/timing'
import { unsubscribeToken } from '@/retention/tokens'

import { createProduct, createRecipe } from './helpers/catalogFactories'
import { createCustomer, createOrder } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'
import { restGet } from './helpers/rest'

/**
 * S2 refill reminders: scheduling from order events (exactly one job per order and household answer,
 * at 10:00 IST), the job run (payload.jobs.run after moving waitUntil into the past) and every skip rule.
 * Orders are placed signed in (a verified account with the order's email) unless `guest: true`: only then
 * does the ticked box subscribe the address at once; a guest's box only asks the owner to confirm by
 * email, and no reminder goes out until they do (retention/subscribers.ts upsertCheckoutConsent).
 */

const CMS = 'http://localhost:3000'
const SHOP = 'http://localhost:5173'
const CRON = 'test-cron-secret-0123456789'
const MAILPIT = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:54326').replace(/\/+$/, '')
/** A fixed payment time in the future, so no reminder is due until a test moves it. 11:30 IST. */
const PAID_AT = '2031-01-15T06:00:00.000Z'

let payload: Payload
let p14: Product // daysPerPack 14
let p30: Product // daysPerPack 30
let pNone: Product // no daysPerPack and no weights → 14 by default
let recipeSlug: string
let phoneSeq = 0
const uniquePhone = () => `+9196${String(Date.now() % 1e6).padStart(6, '0')}${String((phoneSeq += 1) % 100).padStart(2, '0')}`

beforeAll(async () => {
  payload = await getTestPayload()
  registerRetentionHandlers()
  p14 = (await createProduct(payload, { daysPerPack: 14, name: 'Refill Oats' })) as Product
  p30 = (await createProduct(payload, { daysPerPack: 30, name: 'Refill Muesli' })) as Product
  pNone = (await createProduct(payload, { daysPerPack: null, packGrams: null, servingGrams: null, name: 'Refill Flakes' })) as Product
  expect(pNone.daysPerPack ?? null).toBeNull()
  const recipe = await createRecipe(payload, { title: 'Refill Oat Pancakes', products: [{ product: p14.id, ratingStyle: 'decimal' }] })
  recipeSlug = recipe.slug
})

afterEach(() => {
  vi.restoreAllMocks()
})

type Line = [Product, number]

const accounts = new Map<string, Promise<number>>()
/** The verified customer account for `email` (one per address). */
function accountFor(email: string): Promise<number> {
  if (!accounts.has(email)) accounts.set(email, createCustomer(payload, { email }).then((c) => c.id))
  return accounts.get(email)!
}

async function order(opts: {
  email?: string
  phone?: string
  items?: Line[]
  paidAt?: string | null
  status?: Order['status']
  consent?: boolean
  householdSize?: number | null
  guest?: boolean
}): Promise<Order> {
  const email = opts.email ?? uniqueEmail('refill')
  const items = (opts.items ?? [[p14, 2]]).map(([p, qty]) => ({
    product: p.id,
    slug: p.slug,
    name: p.name,
    unitPaise: p.pricePaise!,
    qty,
    lineTotalPaise: p.pricePaise! * qty,
  }))
  const subtotal = items.reduce((s, i) => s + i.lineTotalPaise, 0)
  const status = opts.status ?? 'paid'
  const cod = status === 'cod_pending' || status === 'cod_confirmed'
  return (await createOrder(payload, {
    contact: { name: 'Asha Rao', email, phone: opts.phone ?? uniquePhone() },
    ...(opts.guest ? {} : { customer: await accountFor(email) }),
    items,
    subtotalPaise: subtotal,
    totalPaise: subtotal,
    status,
    paymentStatus: status === 'paid' ? 'captured' : 'none',
    requestedMethod: cod ? 'cod' : 'upi',
    paymentMethod: cod ? 'cod' : 'online',
    paidAt: opts.paidAt === undefined ? (cod ? null : PAID_AT) : opts.paidAt,
    consent: { marketing: opts.consent ?? true, at: new Date().toISOString(), text: 'Email me recipes and offers.' },
    householdSize: opts.householdSize ?? null,
  })) as Order
}

async function emit(type: 'order.confirmed' | 'order.household_updated', o: Order) {
  const results = await emitOrderEvent(await makeReq(), { type, order: o, source: 'test' })
  for (const r of results.filter((x) => x.name.startsWith('retention:'))) expect(r).toMatchObject({ ok: true })
}

async function jobsFor(orderId: number): Promise<PayloadJob[]> {
  const res = await payload.find({
    collection: 'payload-jobs',
    where: { taskSlug: { equals: 'refillReminder' } },
    limit: 0,
    pagination: false,
    depth: 0,
  })
  return (res.docs as PayloadJob[]).filter((j) => (j.input as { orderId?: number })?.orderId === orderId)
}

async function makeDue(jobs: PayloadJob[]) {
  for (const j of jobs) {
    await payload.db.updateOne({
      collection: 'payload-jobs',
      id: j.id,
      data: { waitUntil: new Date(Date.now() - 60_000).toISOString() },
      returning: false,
    })
  }
}

const runJobs = (jobs: PayloadJob[]) => payload.jobs.run({ where: { id: { in: jobs.map((j) => j.id) } }, limit: 50 })

async function headersOf(id: string): Promise<Record<string, string[]>> {
  return (await (await fetch(`${MAILPIT}/api/v1/message/${encodeURIComponent(id)}/headers`)).json()) as Record<string, string[]>
}

async function logRow(key: string) {
  return (await payload.find({ collection: 'message-log', where: { key: { equals: key } }, depth: 0 })).docs[0] ?? null
}

describe('scheduling (order.confirmed / order.household_updated)', () => {
  it('queues one job at 10:00 IST on the right day; duplicate events (sequential and concurrent) queue nothing more', async () => {
    const o = await order({ items: [[p14, 2]] }) // 2 packs × 14 days / 2 eaters = 14 → +9 days
    await emit('order.confirmed', o)
    let jobs = await jobsFor(o.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      taskSlug: 'refillReminder',
      queue: 'default',
      input: { orderId: o.id, number: o.number, stamp: 'h0', reminder: 1 },
    })
    expect(new Date(jobs[0].waitUntil!).toISOString()).toBe('2031-01-24T04:30:00.000Z')
    expect(await logRow(refillQueueKey(o.number, 'h0'))).toMatchObject({ type: 'refill-scheduled', status: 'sent' })

    await emit('order.confirmed', o)
    await Promise.all(Array.from({ length: 5 }, () => emit('order.confirmed', o)))
    jobs = await jobsFor(o.id)
    expect(jobs).toHaveLength(1)
    expect(await scheduleRefillReminder(payload, o.id)).toMatchObject({ outcome: 'duplicate', stamp: 'h0' })
  })

  it('mixed basket: the earliest run-out wins; a missing daysPerPack counts as 14', async () => {
    // Muesli 1 × 30 = 30, Flakes 2 × 14 (default) = 28 → 28 days for one eater → +19 days.
    const a = await order({ items: [[p30, 1], [pNone, 2]], householdSize: 1 })
    expect((await scheduleRefillReminder(payload, a.id)).remindAt?.toISOString()).toBe('2031-02-03T04:30:00.000Z')
    // Muesli 3 × 30 / 2 = 45, Oats 1 × 14 / 2 = 7 → 7 (the floor) → +3 days.
    const b = await order({ items: [[p30, 3], [p14, 1]] })
    expect((await scheduleRefillReminder(payload, b.id)).remindAt?.toISOString()).toBe('2031-01-18T04:30:00.000Z')
    // 10 × 30 = 300 for one eater → clamped to 45 → +32 days.
    const c = await order({ items: [[p30, 10]], householdSize: 1 })
    expect((await scheduleRefillReminder(payload, c.id)).remindAt?.toISOString()).toBe('2031-02-16T04:30:00.000Z')
  })

  it('COD orders use the placement time; unconfirmed, consent-less and item-less orders are not scheduled', async () => {
    const cod = await order({ status: 'cod_pending', items: [[p14, 2]] })
    await emit('order.confirmed', cod)
    const [job] = await jobsFor(cod.id)
    expect(new Date(job.waitUntil!).toISOString()).toBe(remindAtFrom(new Date(cod.createdAt), 9).toISOString())
    expect(new Date(job.waitUntil!).toISOString().endsWith('T04:30:00.000Z')).toBe(true)

    const pending = await order({ status: 'pending_payment' })
    expect(await scheduleRefillReminder(payload, pending.id)).toEqual({ outcome: 'not-confirmed' })
    const noConsent = await order({ consent: false })
    await emit('order.confirmed', noConsent)
    expect(await jobsFor(noConsent.id)).toHaveLength(0)
    expect(await scheduleRefillReminder(payload, noConsent.id)).toEqual({ outcome: 'no-consent' })
    expect(await scheduleRefillReminder(payload, 987654321)).toEqual({ outcome: 'missing' })
  })

  it('household answer: re-queued with the new size, the stale job exits, exactly one reminder is sent', async () => {
    const email = uniqueEmail('refill-household')
    await deleteMessagesTo(email)
    let o = await order({ email, items: [[p14, 2]] })
    await emit('order.confirmed', o)

    o = (await payload.update({ collection: 'orders', id: o.id, data: { householdSize: 4 } })) as Order
    await emit('order.household_updated', o)
    await emit('order.household_updated', o) // repeated → nothing new
    const jobs = await jobsFor(o.id)
    expect(jobs).toHaveLength(2)
    const stale = jobs.find((j) => (j.input as { stamp: string }).stamp === 'h0')!
    const current = jobs.find((j) => (j.input as { stamp: string }).stamp === 'h4')!
    // 2 × 14 / 4 = 7 → +3 days (earlier than the original +9).
    expect(new Date(stale.waitUntil!).toISOString()).toBe('2031-01-24T04:30:00.000Z')
    expect(new Date(current.waitUntil!).toISOString()).toBe('2031-01-18T04:30:00.000Z')
    expect(await runRefillReminder(payload, stale.input as never)).toBe('skipped:superseded')

    // Not due yet: running the queue does nothing.
    await runJobs(jobs)
    expect(await jobsFor(o.id)).toHaveLength(2)
    expect(await settleAndList(email, 300)).toHaveLength(0)

    await makeDue(jobs)
    await runJobs(jobs)
    expect(await jobsFor(o.id)).toHaveLength(0) // both completed (deleteJobOnComplete)

    const [msg] = await waitForMessages(email)
    expect(await settleAndList(email, 600)).toHaveLength(1)
    const full = await getMessage(msg.ID)
    expect(full.Subject).toBe('Running low on Refill Oats?')
    expect(full.HTML).toContain(o.number)
    const links = extractLinks(full.HTML)
    expect(links).toContain(`${SHOP}/cart?add=${p14.slug}:2&src=refill`)
    expect(links).toContain(`${SHOP}/recipes/${recipeSlug}`)
    const unsubscribe = `${CMS}/api/store/newsletter/unsubscribe?t=${unsubscribeToken(email)}`
    expect(links).toContain(unsubscribe)
    const headers = await headersOf(msg.ID)
    expect(headers['List-Unsubscribe']).toEqual([`<${unsubscribe}>`])
    expect(headers['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click'])
    const row = (await logRow(refillKey(o.number)))!
    expect(row).toMatchObject({ status: 'sent', type: 'refill-reminder', to: email })
    expect(typeof row.order === 'object' ? row.order?.id : row.order).toBe(o.id)

    // At most one reminder per order: later events and runs change nothing.
    expect(await scheduleRefillReminder(payload, o.id)).toEqual({ outcome: 'already-sent' })
    await emit('order.confirmed', o)
    expect(await jobsFor(o.id)).toHaveLength(0)
    expect(await runRefillReminder(payload, current.input as never)).toBe('skipped:already-sent')
    expect(await settleAndList(email, 300)).toHaveLength(1)

    // The email's unsubscribe link works (the consent handler created the subscriber at checkout).
    const res = await restGet('store/newsletter/unsubscribe', { query: `t=${unsubscribeToken(email)}` })
    expect(res.headers.get('location')).toBe(`${SHOP}/?unsubscribed=1#newsletter`)
  })

  it('a household answer on an unconfirmed order queues nothing', async () => {
    const o = await order({ status: 'pending_payment', householdSize: 3 })
    await emit('order.household_updated', o)
    expect(await jobsFor(o.id)).toHaveLength(0)
  })
})

describe('run-time skip rules', () => {
  const input = (o: Order, stamp = 'h0') => ({ orderId: o.id, number: o.number, stamp, reminder: 1 })

  /** What the order.confirmed consent handler does at checkout (the job itself never records consent). */
  const recordConsent = async (o: Order) => expect(await upsertCheckoutConsent(payload, o)).toMatch(/^(created|unchanged)$/)

  async function expectSkip(o: Order, result: string, stamp = 'h0') {
    await deleteMessagesTo(o.contact.email)
    expect(await runRefillReminder(payload, input(o, stamp))).toBe(result)
    expect(await settleAndList(o.contact.email, 250)).toHaveLength(0)
  }

  it('no marketing consent', async () => {
    await expectSkip(await order({ consent: false }), 'skipped:no-consent')
  })

  it('the subscriber unsubscribed', async () => {
    const o = await order({})
    await emit('order.confirmed', o)
    expect(await unsubscribeByToken(payload, unsubscribeToken(o.contact.email))).toBe('unsubscribed')
    await expectSkip(o, 'skipped:unsubscribed')
  })

  it('a newer confirmed order for the same email or phone', async () => {
    const email = uniqueEmail('refill-again')
    const first = await order({ email })
    await recordConsent(first)
    await order({ email, status: 'paid' })
    await expectSkip(first, 'skipped:reordered')

    const phone = uniquePhone()
    const byPhone = await order({ phone })
    await recordConsent(byPhone)
    await order({ phone, status: 'cod_pending' }) // different email, same phone
    await expectSkip(byPhone, 'skipped:reordered')
  })

  it('a newer order that never went through does not count', async () => {
    const email = uniqueEmail('refill-abandoned')
    await deleteMessagesTo(email)
    const first = await order({ email })
    await recordConsent(first)
    await order({ email, status: 'pending_payment' })
    await order({ email, status: 'payment_failed' })
    await order({ email, status: 'expired' })
    expect(await runRefillReminder(payload, input(first))).toBe('sent')
    await waitForMessages(email)
  })

  it('refunded, cancelled and returned (RTO) orders', async () => {
    const refunded = await order({})
    await payload.update({ collection: 'orders', id: refunded.id, data: { status: 'refunded', paymentStatus: 'refunded' } })
    await expectSkip(refunded, 'skipped:inactive')

    const cancelled = await order({ status: 'cod_pending' })
    await payload.update({ collection: 'orders', id: cancelled.id, data: { status: 'cancelled' } })
    await expectSkip(cancelled, 'skipped:inactive')

    const rto = await order({ status: 'cod_confirmed' })
    await payload.update({ collection: 'orders', id: rto.id, data: { fulfilmentStatus: 'rto' } })
    await expectSkip(rto, 'skipped:inactive')
  })

  it('already sent (message-log refill:<no>:1); a FAILED earlier attempt is retried', async () => {
    const sent = await order({})
    await recordConsent(sent)
    await payload.create({ collection: 'message-log', data: { key: refillKey(sent.number), status: 'sent', to: sent.contact.email } })
    await expectSkip(sent, 'skipped:already-sent')

    const failed = await order({})
    await recordConsent(failed)
    await payload.create({ collection: 'message-log', data: { key: refillKey(failed.number), status: 'failed', to: failed.contact.email } })
    expect(await runRefillReminder(payload, input(failed))).toBe('sent')
    await waitForMessages(failed.contact.email)
  })

  it('superseded stamp and missing order', async () => {
    await expectSkip(await order({ householdSize: 3 }), 'skipped:superseded', 'h0')
    expect(await runRefillReminder(payload, { orderId: 987654321, stamp: 'h0' })).toBe('skipped:missing')
  })

  it('no subscriber row (consent never recorded): skipped, and the job records no consent itself', async () => {
    const o = await order({})
    const email = o.contact.email
    await deleteMessagesTo(email)
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(0)
    await expectSkip(o, 'skipped:unconfirmed')
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(0)
  })

  it('a guest’s ticked box: no reminder until the owner confirms by email, then it goes out', async () => {
    const o = await order({ guest: true })
    const email = o.contact.email
    await deleteMessagesTo(email)
    await emit('order.confirmed', o)
    const [confirm] = await waitForMessages(email, { subject: 'Confirm your Wefeasto subscription' })
    expect(await runRefillReminder(payload, input(o))).toBe('skipped:unconfirmed')
    expect((await settleAndList(email, 300)).map((m) => m.Subject)).toEqual(['Confirm your Wefeasto subscription'])

    const link = extractLinks((await getMessage(confirm.ID)).HTML).find((l) => l.includes('/api/store/newsletter/confirm?t='))!
    expect((await confirmSubscription(payload, new URL(link).searchParams.get('t'))).outcome).toBe('confirmed')
    expect(await runRefillReminder(payload, input(o))).toBe('sent')
    await waitForMessages(email, { subject: 'Running low' })
  })

  it('a guest order with no subscriber row: skipped, no row created and no confirmation email', async () => {
    const o = await order({ guest: true })
    const email = o.contact.email
    await expectSkip(o, 'skipped:unconfirmed')
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(0)
  })

  it('the owner deleted the subscriber (erasure): the queued reminder neither re-creates nor emails them', async () => {
    const o = await order({})
    const email = o.contact.email
    await deleteMessagesTo(email)
    await emit('order.confirmed', o)
    const sub = (await payload.find({ collection: 'subscribers', where: { email: { equals: email } }, depth: 0 })).docs[0]
    expect(sub).toMatchObject({ status: 'confirmed', source: 'checkout' })
    const jobs = await jobsFor(o.id)
    expect(jobs).toHaveLength(1)

    await payload.delete({ collection: 'subscribers', id: sub.id })
    await makeDue(jobs)
    await runJobs(jobs)
    expect(await jobsFor(o.id)).toHaveLength(0)
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(0)
    expect(await logRow(refillKey(o.number))).toBeNull()
    expect(await settleAndList(email, 400)).toHaveLength(0)
  })
})

describe('jobs runner', () => {
  it('an SMTP failure makes the job fail and retry; exactly one email in the end', async () => {
    const o = await order({})
    const email = o.contact.email
    await deleteMessagesTo(email)
    await emit('order.confirmed', o)
    const jobs = await jobsFor(o.id)
    expect(jobs).toHaveLength(1)
    await makeDue(jobs)

    vi.spyOn(payload, 'sendEmail').mockRejectedValueOnce(new Error('SMTP 421 try later'))
    await runJobs(jobs)
    const [retrying] = await jobsFor(o.id)
    expect(retrying).toBeTruthy()
    expect(retrying.completedAt ?? null).toBeNull()
    expect(retrying.totalTried).toBe(1)
    expect((await logRow(refillKey(o.number)))!.status).toBe('failed')
    expect(await settleAndList(email, 300)).toHaveLength(0)

    await makeDue([retrying])
    await runJobs([retrying])
    expect(await jobsFor(o.id)).toHaveLength(0)
    await waitForMessages(email)
    expect(await settleAndList(email, 500)).toHaveLength(1)
    expect((await logRow(refillKey(o.number)))!.status).toBe('sent')
  })

  it('GET /api/payload-jobs/run: 401 without the cron secret; with it, a due reminder goes out', async () => {
    const o = await order({})
    const email = o.contact.email
    await deleteMessagesTo(email)
    await emit('order.confirmed', o)
    const jobs = await jobsFor(o.id)
    await makeDue(jobs)

    expect((await restGet('payload-jobs/run')).status).toBe(401)
    expect((await restGet('payload-jobs/run', { headers: { Authorization: 'Bearer wrong-secret' } })).status).toBe(401)
    expect(await settleAndList(email, 300)).toHaveLength(0)
    expect(await jobsFor(o.id)).toHaveLength(1)

    const res = await restGet('payload-jobs/run', { headers: { Authorization: `Bearer ${CRON}` }, query: 'limit=50' })
    expect(res.status).toBe(200)
    await waitForMessages(email)
    expect(await jobsFor(o.id)).toHaveLength(0)
  })
})
