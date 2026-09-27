import { paragraph, renderEmail, renderText } from '../layout'
import {
  ctaBlockHtml,
  type EmailRecipe,
  formatIstDate,
  listUnsubscribeHeaders,
  recipeCardHtml,
  recipeText,
  type RenderedEmail,
  subheadingHtml,
  unsubscribeFooterHtml,
  unsubscribeFooterText,
} from './shared'

const WHY = 'You’re getting this because you asked for Wefeasto emails when you ordered.'

export type RefillEmailArgs = {
  firstName: string
  orderNumber: string
  items: { name: string; qty: number }[]
  /** When the earliest product is expected to run out. */
  runsOutAt: Date | string
  /** STOREFRONT_URL/cart?add=…&src=refill */
  refillUrl: string
  recipe: EmailRecipe | null
  unsubscribeUrl: string
}

const itemList = (items: { name: string; qty: number }[]): string =>
  items.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(', ')

/**
 * Refill reminder (S2): one per order, a few days before the earliest product in it runs out. One-tap
 * "refill my bag" link (same items, today's prices), one recipe using something they bought, and the
 * one-click unsubscribe (also in the List-Unsubscribe headers).
 */
export function renderRefillEmail(a: RefillEmailArgs): RenderedEmail {
  const lead = a.items[0]?.name ?? 'breakfast'
  const subject = a.items.length === 1 ? `Running low on ${lead}?` : 'Running low on breakfast?'
  const heading = a.firstName ? `Breakfast running low, ${a.firstName}?` : 'Breakfast running low?'
  const lines = [
    `Your order ${a.orderNumber} (${itemList(a.items)}) should last until about ${formatIstDate(a.runsOutAt)}.`,
    'Restock in one tap: we’ll fill your bag with the same items at today’s prices. You can change anything before you pay.',
  ]
  const cta = { href: a.refillUrl, label: 'Refill my bag' }

  const blocks = [...lines.map(paragraph), ctaBlockHtml(cta.href, cta.label)]
  if (a.recipe) blocks.push(subheadingHtml(`Something new to make with your ${lead}`), recipeCardHtml(a.recipe))
  blocks.push(unsubscribeFooterHtml(a.unsubscribeUrl, WHY))

  const html = renderEmail({
    heading,
    preheader: `Same breakfast, one tap: refill order ${a.orderNumber}.`,
    bodyHtml: blocks.join('\n'),
  })
  const paragraphs = [...lines, `${cta.label}: ${cta.href}`]
  if (a.recipe) paragraphs.push(`Something new to make: ${recipeText(a.recipe)}`)
  const text = renderText({ heading, paragraphs, footerNote: unsubscribeFooterText(a.unsubscribeUrl, WHY) })
  return { subject, html, text, headers: listUnsubscribeHeaders(a.unsubscribeUrl) }
}
