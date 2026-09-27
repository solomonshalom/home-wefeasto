import { type Payload, ValidationError } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { emitOrderEvent } from '@/commerce/events'
import { sendOnce } from '@/email/sendOnce'
import type { Coupon, Order, PayloadJob, Product } from '@/payload-types'
import { refillQueueKey, scheduleRefillReminder } from '@/retention/refill'
import { registerRetentionHandlers } from '@/retention/register'
import { upsertCheckoutConsent } from '@/retention/subscribers'
import { ensureWelcomeCoupon, welcomeKey } from '@/retention/welcome'

import { createProduct, createRecipe } from './helpers/catalogFactories'
import { createOrder } from './helpers/factories'
import { deleteMessagesTo, extractLinks, getMessage, settleAndList, uniqueEmail, waitForMessages } from './helpers/mailpit'
import { getTestPayload, makeReq } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

/**
 * Retention's races under PRODUCTION error shapes. `next build` minifies class names, so the unique-index
 * ValidationError the drizzle adapter throws reaches our code with `name === 'u'` (and, from a second
 * bundled copy of the payload module, not even `instanceof` ValidationError). Dev and the other specs
 * keep the real name, which is how a `err.name === 'ValidationError'` check passed everything and still
 * turned every lost race into a thrown error under `next start`.
 *
 * Each test re-runs one of retention's races with `payload.create` re-throwing ValidationErrors in one of
 * those production shapes, and checks the race still resolves as designed with nothing logged as failed.
 * The races are forced (holdFirstReads) and each test asserts the unique index really was hit, so a pass
 * can't come from requests that happened to run one after another.
 */

const CMS = 'http://localhost:3000'
const SHOP = 'http://localhost:5173'
const CONFIRM_SUBJECT = 'Confirm your Wefeasto subscription'

type Shape = 'minified' | 'foreign'

/** A ValidationError as the production build presents it; any other error unchanged. */
function productionShaped(err: unknown, shape: Shape): unknown {
  if (!(err instanceof ValidationError)) return err
  if (shape === 'minified') {
    Object.defineProperty(err, 'name', { value: 'u', configurable: true, writable: true })
    return err
  }
  // Another module copy's ValidationError: same fields, a different (minified) class.
  return Object.assign(new Error(err.message), { name: 'rA', status: err.status, data: err.data, isPublic: true, isOperational: true })
}

let payload: Payload
let product: Product
let phoneSeq = 0
const uniquePhone = () => `+9195${String(Date.now() % 1e6).padStart(6, '0')}${String((phoneSeq += 1) % 100).padStart(2, '0')}`

beforeAll(async () => {
  payload = await getTestPayload()
  registerRetentionHandlers()
  product = (await createProduct(payload, { daysPerPack: 14, name: 'Prod-shape Oats' })) as Product
  // The welcome email shows two home-featured recipes.
  for (let i = 0; i < 2; i += 1) await createRecipe(payload, { homeFeatured: true, homeAlt: 'A bowl of breakfast' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Error-log entries from retention (sign-up/confirm/welcome background tasks and its order-event handlers). */
function retentionErrors(spy: MockInstance): unknown[] {
  return spy.mock.calls
    .map((c) => c[0] as { msg?: string; handler?: string })
    .filter((o) => o && typeof o === 'object' && (/^newsletter\b/.test(o.msg ?? '') || /^sendOnce\b/.test(o.msg ?? '') || o.handler?.startsWith('retention:')))
}

async function confirmedOrder(email: string): Promise<Order> {
  return (await createOrder(payload, {
    contact: { name: 'Asha Rao', email, phone: uniquePhone() },
    items: [{ product: product.id, slug: product.slug, name: product.name, unitPaise: product.pricePaise!, qty: 2, lineTotalPaise: product.pricePaise! * 2 }],
    subtotalPaise: product.pricePaise! * 2,
    totalPaise: product.pricePaise! * 2,
    status: 'paid',
    paymentStatus: 'captured',
    paidAt: '2031-01-15T06:00:00.000Z',
    consent: { marketing: true, at: new Date().toISOString(), text: 'Email me recipes and offers.' },
  })) as Order
}

async function refillJobs(orderId: number): Promise<PayloadJob[]> {
  const res = await payload.find({ collection: 'payload-jobs', where: { taskSlug: { equals: 'refillReminder' } }, limit: 0, pagination: false, depth: 0 })
  return (res.docs as PayloadJob[]).filter((j) => (j.input as { orderId?: number })?.orderId === orderId)
}

const signup = (email: string) => restPost('store/newsletter', { body: { email } })

type FindArgs = Parameters<Payload['find']>[0]

/**
 * Holds the first `n` matching `payload.find` calls AFTER their read until all `n` have read (or
 * `timeoutMs` passes), so n concurrent callers all see "nothing there yet" and race the insert: the
 * collision is forced rather than left to timing. Returns how many reads were held.
 */
function holdFirstReads(n: number, match: (args: FindArgs) => boolean, timeoutMs = 4000): { held: () => number } {
  const find = payload.find
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const timer = setTimeout(() => release(), timeoutMs)
  vi.spyOn(payload, 'find').mockImplementation((async (args: FindArgs) => {
    const res = await find.call(payload, args)
    if (arrived < n && match(args)) {
      arrived += 1
      if (arrived === n) {
        clearTimeout(timer)
        release()
      }
      await gate
    }
    return res
  }) as unknown as Payload['find'])
  return { held: () => arrived }
}

const findsFor = (collection: string, needle: string) => (args: FindArgs) =>
  args.collection === collection && JSON.stringify(args.where ?? {}).includes(needle)

describe.each<Shape>(['minified', 'foreign'])('production error shape: %s', (shape) => {
  let errorLog: MockInstance
  /** Unique-index hits re-thrown in the production shape, by path. */
  let uniqueHits: Record<string, number>

  beforeEach(() => {
    uniqueHits = {}
    const create = payload.create
    vi.spyOn(payload, 'create').mockImplementation((async (args: Parameters<Payload['create']>[0]) => {
      try {
        return await create.call(payload, args)
      } catch (err) {
        if (err instanceof ValidationError) for (const e of err.data.errors) uniqueHits[e.path] = (uniqueHits[e.path] ?? 0) + 1
        throw productionShaped(err, shape)
      }
    }) as unknown as Payload['create'])
    errorLog = vi.spyOn(payload.logger, 'error')
  })

  it('the simulation is live: a unique hit surfaces in the production shape', async () => {
    const email = uniqueEmail(`pe-sim-${shape}`)
    await payload.create({ collection: 'subscribers', data: { email, status: 'pending', source: 'newsletter' } })
    const err = await payload.create({ collection: 'subscribers', data: { email, status: 'pending', source: 'newsletter' } }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ status: 400, data: { errors: [expect.objectContaining({ path: 'email' })] } })
    expect((err as Error).name).not.toBe('ValidationError')
    expect(err instanceof ValidationError).toBe(shape === 'minified')
  })

  it('concurrent sign-ups for a new address: all 200, one row, one confirmation email, nothing logged', async () => {
    const email = uniqueEmail(`pe-signup-${shape}`)
    await deleteMessagesTo(email)
    const hold = holdFirstReads(4, findsFor('subscribers', email))
    const results = await Promise.all(Array.from({ length: 4 }, () => signup(email)))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(hold.held()).toBe(4)
    expect(uniqueHits.email).toBe(3) // three lost the insert race
    await waitForMessages(email, { subject: CONFIRM_SUBJECT })
    expect(await settleAndList(email, 800)).toHaveLength(1)
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(1)
    expect(retentionErrors(errorLog)).toEqual([])
  })

  it('concurrent confirms: every click lands on ?subscribed=1, one welcome email, one coupon, nothing logged', async () => {
    const email = uniqueEmail(`pe-confirm-${shape}`)
    await deleteMessagesTo(email)
    expect((await signup(email)).status).toBe(200)
    const [msg] = await waitForMessages(email, { subject: CONFIRM_SUBJECT })
    const link = extractLinks((await getMessage(msg.ID)).HTML).find((l) => l.startsWith(`${CMS}/api/store/newsletter/confirm?t=`))!
    expect(link).toBeTruthy()
    const url = new URL(link)
    const hold = holdFirstReads(4, findsFor('message-log', welcomeKey(email)))
    const results = await Promise.all(Array.from({ length: 4 }, () => restGet(url.pathname.replace(/^\/api\//, ''), { query: url.search.slice(1) })))
    for (const r of results) expect(r.headers.get('location')).toBe(`${SHOP}/?subscribed=1#newsletter`)
    expect(hold.held()).toBe(4)
    expect(uniqueHits.key).toBe(3) // three lost sendOnce's claim on welcome:<email>
    await waitForMessages(email, { count: 2 })
    expect(await settleAndList(email, 800)).toHaveLength(2)
    const coupons = (await payload.find({ collection: 'coupons', where: { boundEmail: { equals: email } }, depth: 0 })).docs as Coupon[]
    expect(coupons).toHaveLength(1)
    const log = await payload.find({ collection: 'message-log', where: { key: { equals: welcomeKey(email) } }, depth: 0 })
    expect(log.docs).toHaveLength(1)
    expect(log.docs[0]).toMatchObject({ status: 'sent', attempts: 1 })
    expect(retentionErrors(errorLog)).toEqual([])
  })

  it("a repeated order.confirmed (reconcile re-emit, concurrent too): handlers succeed, one job, outcome 'duplicate'", async () => {
    const o = await confirmedOrder(uniqueEmail(`pe-refill-${shape}`))
    const emit = async () => {
      const results = await emitOrderEvent(await makeReq(), { type: 'order.confirmed', order: o, source: 'test' })
      return results.filter((r) => r.name.startsWith('retention:'))
    }
    const first = await emit()
    expect(first).toHaveLength(2)
    for (const r of first) expect(r).toMatchObject({ ok: true })
    const again = (await Promise.all(Array.from({ length: 4 }, emit))).flat()
    expect(again).toHaveLength(8)
    for (const r of again) expect(r).toMatchObject({ ok: true })
    expect(uniqueHits.key).toBeGreaterThanOrEqual(4) // each re-emit hit the refill-queue claim
    expect(await refillJobs(o.id)).toHaveLength(1)
    expect(await scheduleRefillReminder(payload, o.id)).toMatchObject({ outcome: 'duplicate', stamp: 'h0' })
    const claims = await payload.find({ collection: 'message-log', where: { key: { equals: refillQueueKey(o.number, 'h0') } }, depth: 0 })
    expect(claims.totalDocs).toBe(1)
    expect(retentionErrors(errorLog)).toEqual([])
  })

  it('concurrent checkout-consent upserts for a new (guest) address: one pending row + email, the rest throttled', async () => {
    const email = uniqueEmail(`pe-consent-${shape}`)
    const o = await confirmedOrder(email)
    const hold = holdFirstReads(5, findsFor('subscribers', email))
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => upsertCheckoutConsent(payload, o)))
    expect(hold.held()).toBe(5)
    expect(uniqueHits.email).toBe(4)
    expect(outcomes.filter((x) => x === 'pending')).toHaveLength(1)
    expect(outcomes.filter((x) => x === 'throttled')).toHaveLength(4)
    expect((await payload.find({ collection: 'subscribers', where: { email: { equals: email } } })).totalDocs).toBe(1)
  })

  it('a welcome code collision is retried with a new code (not lost)', async () => {
    const email = uniqueEmail(`pe-collide-${shape}`)
    const stamp = `${Date.now().toString(32).slice(-3)}${shape === 'minified' ? 'M' : 'F'}`.toUpperCase().replace(/[ILOU]/g, 'X')
    const taken = `HELLO-${stamp}`
    await payload.create({ collection: 'coupons', data: { code: taken, type: 'percent', value: 5, usedCount: 0, active: false, note: 'collision fixture' } })
    const sub = await payload.create({ collection: 'subscribers', data: { email, status: 'confirmed', source: 'newsletter' } })
    const fresh = `HELLO-${stamp}Z`
    const tries: string[] = []
    const coupon = await ensureWelcomeCoupon(payload, sub, new Date(), (attempt) => {
      const code = attempt < 2 ? taken : fresh
      tries.push(code)
      return code
    })
    expect(tries).toEqual([taken, taken, fresh])
    expect(uniqueHits.code).toBe(2)
    expect(coupon).toMatchObject({ code: fresh, boundEmail: email })
  })

  it("sendOnce: concurrent sends with one key → one 'sent', the rest 'duplicate'", async () => {
    const to = uniqueEmail(`pe-once-${shape}`)
    await deleteMessagesTo(to)
    const key = `pe-once:${to}`
    const results = await Promise.all(Array.from({ length: 5 }, () => sendOnce({ key, to, subject: 'Once', html: '<p>Once</p>', payload })))
    expect(results.filter((r) => r === 'sent')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4)
    expect(uniqueHits.key).toBe(4)
    await waitForMessages(to)
    expect(await settleAndList(to, 600)).toHaveLength(1)
  })
})
