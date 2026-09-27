import { buildCartLink } from '../commerce/shared/cart-links.js'
import { getEnv } from '../env'

/**
 * Every URL the retention emails and redirects use, in one place (contract: SCRATCH/contracts/retention-backend.md).
 *
 * Email action links (confirm / unsubscribe, also the List-Unsubscribe header) point at the CMS origin
 * (PAYLOAD_PUBLIC_SERVER_URL) so they work without the storefront's /api rewrite; they 303 back to the
 * storefront. Shopping links (cart, offer, recipes) point at the storefront (STOREFRONT_URL).
 */

export const NEWSLETTER_PATH = '/store/newsletter'
export const CONFIRM_PATH = '/store/newsletter/confirm'
export const UNSUBSCRIBE_PATH = '/store/newsletter/unsubscribe'

const api = (path: string, token: string) => `${getEnv().serverUrl}/api${path}?t=${encodeURIComponent(token)}`

export const confirmUrl = (token: string): string => api(CONFIRM_PATH, token)
export const unsubscribeUrl = (token: string): string => api(UNSUBSCRIBE_PATH, token)

/** Where the confirm / unsubscribe endpoints send the browser. The storefront reads these params. */
export type NewsletterOutcome =
  | { subscribed: '1' | 'expired' | 'error' }
  | { unsubscribed: '1' | 'invalid' | 'error' }

export function storefrontNewsletterUrl(outcome: NewsletterOutcome): string {
  const [key, value] = Object.entries(outcome)[0]
  return `${getEnv().storefrontUrl}/?${key}=${value}#newsletter`
}

export const storefrontUrl = (path = '/'): string => `${getEnv().storefrontUrl}${path.startsWith('/') ? path : `/${path}`}`

/** `/cart?offer=CODE`: the cart stores the code and shows the removable offer chip. */
export const offerUrl = (code: string): string => storefrontUrl(`/cart?offer=${encodeURIComponent(code)}`)

export const recipeUrl = (slug: string): string => storefrontUrl(`/recipes/${encodeURIComponent(slug)}`)

/** One-tap refill: `/cart?add=slug:qty,…&src=refill` (lines are validated and clamped by buildCartLink). */
export const refillCartUrl = (items: { slug?: string | null; qty?: number | null }[]): string =>
  storefrontUrl(buildCartLink(items, { src: 'refill' }))

/** Storefront image paths (`/images/…`) become absolute; absolute https URLs pass through; anything else → ''. */
export function absoluteImage(src: unknown): string {
  if (typeof src !== 'string' || !src) return ''
  if (/^https:\/\//i.test(src)) return src
  if (src.startsWith('/') && !src.startsWith('//')) return storefrontUrl(src)
  return ''
}
