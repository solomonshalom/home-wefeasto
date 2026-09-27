import type { Payload } from 'payload'

import type { Coupon } from '@/payload-types'

import { loadServerCatalog } from '../../endpoints/catalog/data'
import type { ServerCatalogItem } from '../../endpoints/catalog/serialize'
import { getStoreSettings, type StoreSettings } from '../settings'
import { normalizeCouponCode } from '../shared/coupons.js'
import { quote, type Quote } from '../shared/pricing.js'
import { customerUsageCount, findCoupon, isFirstOrder, reservedCount, withReservations } from './coupons'

/**
 * Server-side pricing: $shared quote() over the DB catalog (published products with exact stock), the
 * store settings (public + server: blocked PINs, COD caps) and the coupon record with its live usage.
 *
 * For POST /store/quote only the EMAIL_MISMATCH check runs (when an email is given); first-order and
 * per-customer checks stay deferred so the quote endpoint can't be used to probe whether an address has
 * ordered before. Checkout passes the full identity (all three checks run, deferredChecks === []).
 *
 * With an identity the result also carries `publicQuote`: the same pricing over the same reads WITHOUT the
 * identity-derived inputs (isFirstOrder, customerUsageCount), i.e. exactly what POST /store/quote answers
 * for this request. Checkout compares the client's expected total against it and refuses on it first, so
 * a checkout that can't be placed anyway never reveals whether an email/phone has ordered before.
 */

export type Identity = { email: string; phone: string; excludeOrderIds?: (number | string)[] }

export type ServerQuote = {
  quote: Quote
  /** The identity-free quote (=== quote when no identity was given). */
  publicQuote: Quote
  catalog: ServerCatalogItem[]
  settings: StoreSettings
  coupon: Coupon | null
  couponCode: string | null
}

export type ServerQuoteInput = {
  items: unknown
  couponCode?: unknown
  method?: unknown
  email?: string | null
  pin?: string | null
  identity?: Identity
  /**
   * Orders about to be superseded, whose coupon reservations don't count against the offer's limits. For the
   * quote endpoint, which has no phone and so no Identity (merged with identity.excludeOrderIds).
   */
  excludeOrderIds?: (number | string)[]
  /** Extra units per slug that are about to be released (supersede) and may be counted as available. */
  extraStock?: Map<string, number>
  now?: number
}

/**
 * Counts units that an earlier, about-to-be-cancelled order holds as available again (supersede).
 * `inStock` is recomputed from the "Available for sale" checkbox, which the catalog row does not carry.
 */
async function withExtraStock(payload: Payload, catalog: ServerCatalogItem[], extra: Map<string, number>): Promise<ServerCatalogItem[]> {
  const slugs = [...extra.keys()]
  const res = await payload.find({
    collection: 'products',
    where: { slug: { in: slugs } },
    select: { slug: true, inStock: true },
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  const sellable = new Map(res.docs.map((d) => [String((d as { slug?: string }).slug), (d as { inStock?: boolean | null }).inStock !== false]))
  return catalog.map((p) => {
    const add = extra.get(p.slug) ?? 0
    if (add <= 0) return p
    const stock = p.stock + add
    return { ...p, stock, inStock: sellable.get(p.slug) === true && stock > 0 }
  })
}

/**
 * The settings $shared quote() prices with on the server: public + server-only. A cap of 0 open COD orders
 * per phone (codMaxOpenPerPhone, 0..1000) means no COD order is ever allowed, so COD is reported as
 * DISABLED up front ("isn't available right now — please pay online") instead of the pill being offered
 * and the checkout then answering TOO_MANY_OPEN ("you already have COD orders on the way") to a customer
 * who has none. placeOrder refuses on this quote's answer before it counts anything.
 */
export function quoteSettings(settings: StoreSettings): StoreSettings['public'] & StoreSettings['server'] {
  const merged = { ...settings.public, ...settings.server }
  return codCapAllowsAny(settings.server.codMaxOpenPerPhone) ? merged : { ...merged, codEnabled: false }
}

/** False when the open-COD cap is below 1 (no COD order could ever be placed). */
export const codCapAllowsAny = (cap: number): boolean => Number.isFinite(cap) && cap >= 1

export async function serverQuote(payload: Payload, input: ServerQuoteInput): Promise<ServerQuote> {
  const now = input.now ?? Date.now()
  const rawCode = typeof input.couponCode === 'string' ? input.couponCode : ''
  const couponCode = rawCode.trim() ? normalizeCouponCode(rawCode) : null
  const [settings, catalogRaw, couponDoc] = await Promise.all([
    getStoreSettings(payload),
    loadServerCatalog(payload),
    couponCode ? findCoupon(payload, couponCode) : Promise.resolve(null),
  ])
  const catalog = input.extraStock?.size ? await withExtraStock(payload, catalogRaw, input.extraStock) : catalogRaw

  let coupon: Record<string, unknown> | null = null
  const context: Record<string, unknown> = { now, couponCode: rawCode.trim() ? rawCode : undefined }
  if (input.pin) context.pin = input.pin
  if (input.email) context.email = input.email
  if (input.identity) context.email = input.identity.email
  // Identity-derived coupon inputs (history of this email/phone): only the full quote sees them.
  const identityContext: Record<string, unknown> = {}
  if (couponDoc) {
    const exclude = [...new Set([...(input.excludeOrderIds ?? []), ...(input.identity?.excludeOrderIds ?? [])])]
    coupon = withReservations(couponDoc, await reservedCount(payload, couponDoc.id, exclude))
    if (input.identity) {
      identityContext.isFirstOrder = await isFirstOrder(payload, input.identity.email, input.identity.phone, exclude)
      identityContext.customerUsageCount = await customerUsageCount(payload, couponDoc.id, input.identity.email, exclude)
    }
  }
  const price = (ctx: Record<string, unknown>) =>
    hideStockDepth(quote({ items: input.items, catalog, settings: quoteSettings(settings), coupon, method: input.method, context: ctx }), catalog)
  const publicQuote = price(context)
  const q = input.identity ? price({ ...context, ...identityContext }) : publicQuote
  return { quote: q, publicQuote, catalog, settings, coupon: couponDoc, couponCode }
}

/**
 * Exact stock is never shown to shoppers (the live catalog only says "only N left" at or below the low-stock
 * threshold). An OUT_OF_STOCK issue carries `available`, so a request for 999 packs would reveal the whole
 * count. When the stock covers the per-order maximum anyway, such a line is really over the limit: report it
 * as QTY_LIMIT {max} instead. `available` is therefore only ever below maxPerOrder.
 */
export function hideStockDepth(q: Quote, catalog: ServerCatalogItem[]): Quote {
  if (!q.issues.some((i) => i.code === 'OUT_OF_STOCK')) return q
  const bySlug = new Map(catalog.map((p) => [p.slug, p]))
  const issues = q.issues.map((i) => {
    const p = i.code === 'OUT_OF_STOCK' ? bySlug.get(i.slug) : undefined
    const max = p?.maxPerOrder ?? 10
    if (!p || !p.inStock || p.stock < max) return i
    return { slug: i.slug, name: i.name, code: 'QTY_LIMIT' as const, requestedQty: i.requestedQty, max, suggestedQty: max }
  })
  return { ...q, issues }
}
