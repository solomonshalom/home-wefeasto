/**
 * Branded transactional email shell. Table layout + inline styles only (Gmail/Outlook strip <style>),
 * system font stack, 560px max width. Colours are the storefront palette literals.
 *
 *   const html = renderEmail({ heading: 'Order WF-10001 confirmed', bodyHtml: paragraph('Thanks!'),
 *                              cta: { href, label: 'View your order' } })
 *   const text = renderText({ heading: 'Order WF-10001 confirmed', paragraphs: ['Thanks!'], cta: { href, label } })
 */

export const EMAIL_BRAND = {
  ink: '#333333',
  muted: '#6b6560',
  background: '#f9f4ef',
  card: '#ffffff',
  accent: '#ff8d5e',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text for HTML element content and double/single-quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** Only http(s) and mailto links survive; anything else (javascript:, data:) becomes '#'. */
export function safeHref(href: string): string {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : '#'
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${EMAIL_BRAND.ink};">${escapeHtml(text)}</p>`
}

export function emailButton(href: string, label: string): string {
  const url = escapeHtml(safeHref(href))
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>
<td style="border-radius:999px;background:${EMAIL_BRAND.accent};">
<a href="${url}" style="display:inline-block;padding:14px 28px;font-family:${EMAIL_BRAND.font};font-size:16px;font-weight:700;color:${EMAIL_BRAND.ink};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
</td></tr></table>`
}

export type RenderEmailArgs = {
  /** Main heading (escaped). */
  heading: string
  /** Trusted HTML for the body: build it with paragraph()/emailButton() or escape values yourself. */
  bodyHtml?: string
  /** Optional call to action rendered after the body. */
  cta?: { href: string; label: string }
  /** Hidden inbox preview text (escaped). */
  preheader?: string
  /** Small print under the card (escaped). */
  footerNote?: string
}

export function renderEmail({ heading, bodyHtml = '', cta, preheader, footerNote }: RenderEmailArgs): string {
  const b = EMAIL_BRAND
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>`
    : ''
  const button = cta ? emailButton(cta.href, cta.label) : ''
  const linkFallback = cta
    ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${b.muted};">If the button doesn't work, copy this link into your browser:<br><a href="${escapeHtml(safeHref(cta.href))}" style="color:${b.ink};word-break:break-all;">${escapeHtml(cta.href)}</a></p>`
    : ''
  const note = footerNote ? `${escapeHtml(footerNote)}<br>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:${b.background};">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${b.background};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${b.font};">
<tr><td style="padding:0 8px 20px;font-size:28px;font-weight:800;letter-spacing:-0.5px;color:${b.ink};">Wefeasto<span style="color:${b.accent};">.</span></td></tr>
<tr><td style="background:${b.card};border-radius:20px;padding:32px 28px;border-top:6px solid ${b.accent};">
<h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;color:${b.ink};">${escapeHtml(heading)}</h1>
${bodyHtml}${button}${linkFallback}
</td></tr>
<tr><td style="padding:20px 8px;font-size:12px;line-height:1.5;color:${b.muted};">${note}Wefeasto · Wholesome breakfast, made in India.</td></tr>
</table></td></tr></table></body></html>`
}

export type RenderTextArgs = {
  heading: string
  paragraphs?: string[]
  cta?: { href: string; label: string }
  footerNote?: string
}

/** Plain-text alternative for multipart emails. */
export function renderText({ heading, paragraphs = [], cta, footerNote }: RenderTextArgs): string {
  const parts = [heading, '', ...paragraphs.flatMap((p) => [p, ''])]
  if (cta) parts.push(`${cta.label}: ${cta.href}`, '')
  if (footerNote) parts.push(footerNote, '')
  parts.push('— Wefeasto')
  return parts.join('\n')
}
