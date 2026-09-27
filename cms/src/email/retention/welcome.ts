import { formatPaise } from '../../commerce/shared/money.js'
import { paragraph, renderEmail, renderText } from '../layout'
import {
  codeChipHtml,
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

export type WelcomeOffer = {
  code: string
  percent: number
  /** Cap in paise; null/0 = no cap to mention. */
  maxDiscountPaise: number | null
  /** Exclusive end of validity (coupon.endsAt). */
  endsAt: Date | string
  /** STOREFRONT_URL/cart?offer=CODE */
  url: string
}

const WHY = 'You’re getting this because you subscribed to Wefeasto emails.'

/** The last day the code works, as shown to people ('26 Oct 2026', IST); endsAt itself is exclusive. */
export function lastValidDay(endsAt: Date | string): string {
  return formatIstDate(new Date(new Date(endsAt).getTime() - 1))
}

/**
 * Welcome email (M6 + S6), sent once per address on its first newsletter confirmation. With an offer it
 * leads with the personal code and a /cart?offer= button; without one (the address already has an
 * order, so a first-order code could never apply) it leads with the recipes. Two recipes follow, then
 * the one-click unsubscribe line (also in the List-Unsubscribe headers).
 */
export function renderWelcomeEmail({
  offer,
  recipes,
  unsubscribeUrl,
  shopUrl,
}: {
  offer: WelcomeOffer | null
  recipes: EmailRecipe[]
  unsubscribeUrl: string
  shopUrl: string
}): RenderedEmail {
  const offerTerms = offer
    ? `${offer.percent}% off your first order${offer.maxDiscountPaise ? ` (up to ${formatPaise(offer.maxDiscountPaise)})` : ''}. ` +
      `It works once, with this email address, until ${lastValidDay(offer.endsAt)}.`
    : ''
  const subject = offer ? `You're in — here's ${offer.percent}% off your first order` : "You're in — breakfast ideas inside"
  const heading = offer ? 'Welcome! Here’s your breakfast treat' : 'Welcome to Wefeasto'
  const intro = 'You’re subscribed. Expect easy breakfast recipes, new flavours and the occasional treat — never spam.'
  const cta = offer ? { href: offer.url, label: 'Use my welcome offer' } : { href: shopUrl, label: 'Browse the shop' }

  const blocks: string[] = [paragraph(intro)]
  if (offer) {
    blocks.push(paragraph('Your personal code:'), codeChipHtml(offer.code), paragraph(offerTerms))
    blocks.push(paragraph('The button adds it to your bag automatically — no typing needed.'))
  }
  blocks.push(ctaBlockHtml(cta.href, cta.label))
  if (recipes.length) blocks.push(subheadingHtml(recipes.length > 1 ? 'Two to try this week' : 'One to try this week'), ...recipes.map(recipeCardHtml))
  blocks.push(unsubscribeFooterHtml(unsubscribeUrl, WHY))

  const html = renderEmail({
    heading,
    preheader: offer ? `Your code ${offer.code}: ${offer.percent}% off your first order.` : 'Easy breakfast recipes, straight to your inbox.',
    bodyHtml: blocks.join('\n'),
  })

  const paragraphs = [intro]
  if (offer) paragraphs.push(`Your personal code: ${offer.code}`, offerTerms)
  paragraphs.push(`${cta.label}: ${cta.href}`)
  if (recipes.length) paragraphs.push('To try this week:', ...recipes.map(recipeText))
  const text = renderText({ heading, paragraphs, footerNote: unsubscribeFooterText(unsubscribeUrl, WHY) })

  return { subject, html, text, headers: listUnsubscribeHeaders(unsubscribeUrl) }
}
