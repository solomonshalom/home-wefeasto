import type { Order } from '@/payload-types'

import { buildAddParam } from '../../commerce/shared/cart-links.js'
import { formatPaise } from '../../commerce/shared/money.js'
import { firstName } from '../../commerce/shared/validate.js'
import { EMAIL_BRAND, emailButton, escapeHtml, paragraph, renderEmail, renderText, safeHref } from '../layout'

/**
 * Transactional order emails (SPEC §6 markPaid, roadmap M3): confirmation (online, COD, or "your late
 * payment went through"), shipped, and the automatic-refund notice. Pure renderers: the caller supplies
 * the order, its guest token and the public settings; ./send.ts delivers them exactly once.
 */

export type EmailContent = { subject: string; html: string; text: string }

export type OrderEmailContext = {
  storefrontUrl: string
  token: string
  shippingPromiseText?: string
  supportWhatsappE164?: string
}

export function orderUrl(ctx: Pick<OrderEmailContext, 'storefrontUrl' | 'token'>, number: string): string {
  const qs = new URLSearchParams({ no: number, t: ctx.token })
  return `${ctx.storefrontUrl}/order?${qs.toString()}`
}

/** `/cart?add=slug:qty,…&src=email`, or null when nothing survives buildAddParam. */
export function buyAgainUrl(storefrontUrl: string, order: Pick<Order, 'items'>): string | null {
  const add = buildAddParam((order.items ?? []).map((it) => ({ slug: it.slug, qty: it.qty })))
  if (!add) return null
  const qs = new URLSearchParams({ add, src: 'email' })
  return `${storefrontUrl}/cart?${qs.toString()}`
}

/** wa.me link for the support number (digits only), or null when none is configured. */
export function whatsappUrl(e164: string | undefined, text: string): string | null {
  const digits = (e164 ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

const cell = (html: string, align: 'left' | 'right' = 'left', extra = '') =>
  `<td style="padding:6px 0;font-size:15px;line-height:1.45;color:${EMAIL_BRAND.ink};text-align:${align};${extra}">${html}</td>`

/** Items + totals table (inline styles only). */
export function receiptHtml(order: Order): string {
  const rows = (order.items ?? [])
    .map((it) => `<tr>${cell(`${escapeHtml(it.name)} × ${it.qty}`)}${cell(escapeHtml(formatPaise(it.lineTotalPaise)), 'right')}</tr>`)
    .join('')
  const line = (label: string, value: string, bold = false) =>
    `<tr>${cell(escapeHtml(label), 'left', bold ? 'font-weight:700;' : `color:${EMAIL_BRAND.muted};`)}${cell(
      escapeHtml(value),
      'right',
      bold ? 'font-weight:700;' : '',
    )}</tr>`
  const totals = [
    line('Subtotal', formatPaise(order.subtotalPaise)),
    order.discountPaise > 0
      ? line(order.coupon?.code ? `Discount (${order.coupon.code})` : 'Discount', `−${formatPaise(order.discountPaise)}`)
      : '',
    line('Delivery', order.deliveryPaise > 0 ? formatPaise(order.deliveryPaise) : 'Free'),
    order.codFeePaise > 0 ? line('Cash on delivery fee', formatPaise(order.codFeePaise)) : '',
    line('Total', formatPaise(order.totalPaise), true),
  ].join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">
${rows}<tr><td colspan="2" style="border-top:1px solid #eadfd6;padding:0;height:8px;"></td></tr>${totals}</table>`
}

export function receiptText(order: Order): string[] {
  const lines = (order.items ?? []).map((it) => `${it.name} × ${it.qty} — ${formatPaise(it.lineTotalPaise)}`)
  lines.push(`Subtotal: ${formatPaise(order.subtotalPaise)}`)
  if (order.discountPaise > 0) lines.push(`Discount${order.coupon?.code ? ` (${order.coupon.code})` : ''}: −${formatPaise(order.discountPaise)}`)
  lines.push(`Delivery: ${order.deliveryPaise > 0 ? formatPaise(order.deliveryPaise) : 'Free'}`)
  if (order.codFeePaise > 0) lines.push(`Cash on delivery fee: ${formatPaise(order.codFeePaise)}`)
  lines.push(`Total: ${formatPaise(order.totalPaise)}`)
  return lines
}

const addressLine = (order: Order) => {
  const a = order.shippingAddress
  return a ? `${a.line1}, ${a.city}, ${a.state} ${a.pin}` : ''
}

const smallLink = (href: string, label: string) =>
  `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;"><a href="${escapeHtml(safeHref(href))}" style="color:${EMAIL_BRAND.ink};font-weight:700;">${escapeHtml(label)}</a></p>`

function supportBits(ctx: OrderEmailContext, number: string): { html: string; text: string | null } {
  const wa = whatsappUrl(ctx.supportWhatsappE164, `Hi Wefeasto, I have a question about order ${number}.`)
  if (!wa) return { html: '', text: null }
  return {
    html: `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${EMAIL_BRAND.muted};">Questions? <a href="${escapeHtml(
      wa,
    )}" style="color:${EMAIL_BRAND.ink};">Message us on WhatsApp</a> and quote ${escapeHtml(number)}.</p>`,
    text: `Questions? WhatsApp us: ${wa}`,
  }
}

export type ConfirmationVariant = 'online' | 'cod' | 'late'

export function confirmationVariant(order: Order, opts: { late?: boolean } = {}): ConfirmationVariant {
  if (order.paymentMethod === 'cod') return 'cod'
  return opts.late ? 'late' : 'online'
}

/** "Order WF-10001 confirmed" (online), "… placed — pay on delivery" (COD) or the late-payment variant. */
export function renderOrderConfirmation(order: Order, ctx: OrderEmailContext, variant: ConfirmationVariant): EmailContent {
  const name = firstName(order.contact?.name ?? '') || 'there'
  const n = order.number
  const total = formatPaise(order.totalPaise)
  const subject =
    variant === 'cod'
      ? `Order ${n} placed — pay on delivery`
      : variant === 'late'
        ? `Good news — your payment for ${n} went through`
        : `Order ${n} confirmed — thank you!`
  const heading =
    variant === 'cod' ? `Thanks, ${name} — your order is placed` : variant === 'late' ? `Your payment went through, ${name}` : `Thanks, ${name} — order confirmed`
  const intro =
    variant === 'cod'
      ? `We've got order ${n}. Please keep ${total} ready (cash or UPI) when it arrives.`
      : variant === 'late'
        ? `Your bank confirmed the payment for order ${n} after the payment window had closed. It's confirmed now and we're packing it — no need to order again.`
        : `We've received your payment of ${total} for order ${n}.`
  const promise = ctx.shippingPromiseText?.trim()
  const view = orderUrl(ctx, n)
  const again = buyAgainUrl(ctx.storefrontUrl, order)
  const support = supportBits(ctx, n)

  const bodyHtml = [
    paragraph(intro),
    receiptHtml(order),
    promise ? paragraph(promise) : '',
    paragraph(`Delivering to: ${addressLine(order)}`),
    emailButton(view, 'View your order'),
    again ? smallLink(again, 'Buy these again') : '',
    support.html,
  ].join('')
  const html = renderEmail({
    heading,
    bodyHtml,
    preheader: variant === 'cod' ? `Pay ${total} on delivery.` : `Order ${n} · ${total}`,
    footerNote: 'You are receiving this because you placed an order with Wefeasto.',
  })
  const text = renderText({
    heading,
    paragraphs: [
      intro,
      receiptText(order).join('\n'),
      ...(promise ? [promise] : []),
      `Delivering to: ${addressLine(order)}`,
      ...(again ? [`Buy these again: ${again}`] : []),
      ...(support.text ? [support.text] : []),
    ],
    cta: { href: view, label: 'View your order' },
  })
  return { subject, html, text }
}

export function renderOrderShipped(order: Order, ctx: OrderEmailContext): EmailContent {
  const name = firstName(order.contact?.name ?? '') || 'there'
  const n = order.number
  const subject = `Your order ${n} is on its way`
  const heading = `It's on its way, ${name}!`
  const intro = `Order ${n} has left our kitchen and is heading to ${order.shippingAddress?.city ?? 'you'}.`
  const cod = order.paymentMethod === 'cod' ? `Please keep ${formatPaise(order.totalPaise)} ready (cash or UPI) for the delivery partner.` : ''
  const promise = ctx.shippingPromiseText?.trim()
  const view = orderUrl(ctx, n)
  const again = buyAgainUrl(ctx.storefrontUrl, order)
  const support = supportBits(ctx, n)
  // checkout-backend.md §5 / roadmap M3: receipt, shipping promise, delivery address, View your order,
  // Buy these again and WhatsApp help, like the confirmation (PI-ORD-2).
  const bodyHtml = [
    paragraph(intro),
    cod ? paragraph(cod) : '',
    receiptHtml(order),
    promise ? paragraph(promise) : '',
    paragraph(`Delivering to: ${addressLine(order)}`),
    emailButton(view, 'View your order'),
    again ? smallLink(again, 'Buy these again') : '',
    support.html,
  ].join('')
  const html = renderEmail({
    heading,
    bodyHtml,
    preheader: `Order ${n} has shipped.`,
    footerNote: 'You are receiving this because you placed an order with Wefeasto.',
  })
  const text = renderText({
    heading,
    paragraphs: [
      intro,
      ...(cod ? [cod] : []),
      receiptText(order).join('\n'),
      ...(promise ? [promise] : []),
      `Delivering to: ${addressLine(order)}`,
      ...(again ? [`Buy these again: ${again}`] : []),
      ...(support.text ? [support.text] : []),
    ],
    cta: { href: view, label: 'View your order' },
  })
  return { subject, html, text }
}

export type RefundReasonKind = 'duplicate_payment' | 'out_of_stock' | 'order_cancelled' | string

export function refundReasonCopy(kind: RefundReasonKind, number: string): string {
  switch (kind) {
    case 'duplicate_payment':
      return `Order ${number} was paid twice, so we've refunded the extra payment. Your order is still confirmed.`
    case 'out_of_stock':
      return `Your payment for order ${number} reached us after the payment window closed, and by then the items had sold out. We're sorry — we've refunded the full amount.`
    case 'order_cancelled':
      return `A payment for order ${number} arrived after the order was cancelled (for example, because you placed it again as cash on delivery). We've refunded it in full.`
    default:
      return `We've refunded a payment for order ${number}.`
  }
}

export function renderRefundNotice(
  order: Order,
  ctx: OrderEmailContext,
  refund: { amountPaise: number; reason: RefundReasonKind },
): EmailContent {
  const name = firstName(order.contact?.name ?? '') || 'there'
  const n = order.number
  const amount = formatPaise(refund.amountPaise)
  const subject = `We've refunded ${amount} for order ${n}`
  const heading = `Refund on its way, ${name}`
  const why = refundReasonCopy(refund.reason, n)
  const when = `The ${amount} goes back to the account or card you paid with, usually within 5–7 working days (UPI is often faster).`
  const view = orderUrl(ctx, n)
  const support = supportBits(ctx, n)
  const html = renderEmail({
    heading,
    bodyHtml: [paragraph(why), paragraph(when), emailButton(view, 'View your order'), support.html].join(''),
    preheader: `${amount} refunded for ${n}.`,
    footerNote: 'You are receiving this because you placed an order with Wefeasto.',
  })
  const text = renderText({
    heading,
    paragraphs: [why, when, ...(support.text ? [support.text] : [])],
    cta: { href: view, label: 'View your order' },
  })
  return { subject, html, text }
}
