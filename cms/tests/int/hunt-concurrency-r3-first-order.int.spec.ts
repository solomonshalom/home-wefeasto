import { sql } from '@payloadcms/db-postgres'
import type { PostgresAdapter } from '@payloadcms/db-postgres'
import type { CollectionBeforeChangeHook, Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { expireOrder } from '@/commerce/checkout/expire'
import { resetGateway } from '@/payments'

import { contactFor, freshMock, makeProduct, orderByNumber, placeOrderVia, reload, settle } from './checkout-helpers'
import { restoreStoreSettings } from './helpers/catalogFactories'
import { getTestPayload } from './helpers/payload'
import { restPost } from './helpers/rest'

/**
 * HUNT-CONC-R3-2 (cms-checkout): a retry of an expired order re-takes its released FIRST-ORDER-ONLY offer
 * without the per-customer serialisation checkout uses, so a parallel checkout of the same customer with
 * ANOTHER first-order offer is granted too: two first-order discounts for one customer.
 *
 * Checkout serialises first-order offers per customer with advisory locks (`first-order:<email>`,
 * `first-order:<phone>`, db.ts lockKeys) and re-counts inside its transaction. retryPayment → retakeReleased →
 * recheckReleasedUse counts the same thing (isFirstOrder) but only under the COUPON row lock, which a checkout
 * using a different first-order code never takes. So the two transactions each count the other as absent.
 *
 * The interleaving is made deterministic by pausing the retry's own order write (a runtime beforeChange hook,
 * i.e. after its first-order re-check and before its commit) until the checkout has passed its re-check, or
 * until the checkout is seen WAITING on a lock the paused retry holds (a serialising fix: then the retry must
 * be let go so it can commit, and the checkout re-counts after it).
 */

let payload: Payload

beforeAll(async () => {
  payload = await getTestPayload()
  await restoreStoreSettings(payload)
})
beforeEach(() => void freshMock())
afterEach(async () => {
  await settle()
  resetGateway()
})
afterAll(async () => {
  await restoreStoreSettings(payload)
})

const code = () => `HR3FO${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const firstOrderCoupon = () =>
  payload.create({
    collection: 'coupons',
    data: { code: code(), type: 'fixed', value: 5000, usedCount: 0, active: true, firstOrderOnly: true } as never,
    overrideAccess: true,
  })

/** Adds a beforeChange hook to orders for the rest of the test; returns the remover. */
/** Some backend is waiting for a lock (e.g. checkout B blocked on a key/row the paused retry holds). */
async function someoneWaitsOnALock(): Promise<boolean> {
  const db = (payload.db as unknown as PostgresAdapter).drizzle
  const res = (await db.execute(sql`SELECT count(*)::int AS "n" FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)) as unknown as { rows?: { n: number }[] }
  return Number(res?.rows?.[0]?.n ?? 0) > 0
}

function addOrderHook(hook: CollectionBeforeChangeHook): () => void {
  const hooks = payload.collections.orders.config.hooks
  hooks.beforeChange = [...(hooks.beforeChange ?? []), hook]
  return () => {
    hooks.beforeChange = (hooks.beforeChange ?? []).filter((h) => h !== hook)
  }
}

describe('first-order-only offers: retry after expiry vs a parallel checkout', () => {
  it('one customer never holds two first-order offers at once', async () => {
    const welcome = await firstOrderCoupon() // e.g. the HELLO-XXXX welcome code
    const first10 = await firstOrderCoupon() // e.g. a store-wide FIRST10 code
    const pa = await makeProduct(payload, { stock: 20 })
    const pb = await makeProduct(payload, { stock: 20 })
    const contact = contactFor('fo-race')

    // Order A used the welcome code, was never paid and expired: its use was given back.
    const a = await placeOrderVia([{ slug: pa.slug as string, qty: 1 }], { couponCode: welcome.code, contact })
    expect(a.res.status, a.res.text).toBe(201)
    const { number, token } = a.res.body.order as { number: string; token: string }
    const aId = (await orderByNumber(payload, number)).id
    await expireOrder(payload, aId, { now: Date.now() + 31 * 60_000 })
    expect((await reload(payload, aId)).status).toBe('expired')

    // Pause the retry's order write (its first-order re-check is done) until checkout B has passed its own.
    let releaseRetry!: () => void
    const retryGate = new Promise<void>((r) => (releaseRetry = r))
    let retryPaused!: () => void
    const retryAtGate = new Promise<void>((r) => (retryPaused = r))
    const remove = addOrderHook(async ({ data, context }) => {
      if (context?.statusNote === 'payment retry') {
        retryPaused()
        await retryGate
      } else if (context?.statusSource === 'checkout' && data?.coupon?.code === first10.code) {
        releaseRetry()
      }
      return data
    })
    try {
      const retrying = restPost('store/checkout/retry', { body: { number, token } })
      await retryAtGate
      // Same customer, another bag, the other first-order code, while the retry is in flight.
      const placing = placeOrderVia([{ slug: pb.slug as string, qty: 2 }], { couponCode: first10.code, contact })
      let bDone = false
      void placing.finally(() => (bDone = true))
      // B blocked on a lock the paused retry holds: let the retry commit so B can go on (and re-count).
      const watcher = (async () => {
        const until = Date.now() + 10_000
        while (!bDone && Date.now() < until) {
          if (await someoneWaitsOnALock()) break
          await new Promise((r) => setTimeout(r, 25))
        }
        releaseRetry()
      })()
      const b = await placing
      releaseRetry() // (in case B was refused before reaching its write)
      await watcher
      const r = await retrying

      const granted = [r.status === 200 ? 'retry kept the welcome code' : null, b.res.status === 201 ? 'checkout B got FIRST10' : null].filter(Boolean)
      expect(granted, `retry → ${r.status} ${r.text.slice(0, 120)} | B → ${b.res.status} ${b.res.text.slice(0, 120)}`).toHaveLength(1)
    } finally {
      remove()
      releaseRetry()
    }

    const held = await payload.find({
      collection: 'coupon-redemptions',
      where: { and: [{ email: { equals: contact.email } }, { status: { in: ['reserved', 'consumed'] } }] },
      overrideAccess: true,
    })
    expect(held.docs.map((d) => d.code).sort()).toHaveLength(1)
  })
})
