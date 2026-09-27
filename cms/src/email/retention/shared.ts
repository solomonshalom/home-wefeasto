import { EMAIL_BRAND, emailButton, escapeHtml, safeHref } from '../layout'

/**
 * Building blocks for the marketing emails (welcome, refill). Everything interpolated is escaped;
 * hrefs go through safeHref (http/https/mailto only).
 */

export type EmailRecipe = {
  title: string
  url: string
  /** Absolute image URL, or '' for none. */
  image?: string
  alt?: string
  description?: string
}

export type RenderedEmail = { subject: string; html: string; text: string; headers?: Record<string, string> }

/** RFC 2369 + RFC 8058 one-click unsubscribe headers. */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

const small = `margin:0 0 8px;font-size:13px;line-height:1.5;color:${EMAIL_BRAND.muted};`

/** Small print with the unsubscribe link, placed at the end of the card. */
export function unsubscribeFooterHtml(unsubscribeUrl: string, why: string): string {
  return `<p style="${small}margin-top:24px;">${escapeHtml(why)} <a href="${escapeHtml(safeHref(unsubscribeUrl))}" style="color:${EMAIL_BRAND.ink};">Unsubscribe</a> — one click, no questions.</p>`
}

export function unsubscribeFooterText(unsubscribeUrl: string, why: string): string {
  return `${why} Unsubscribe (one click): ${unsubscribeUrl}`
}

/** A recipe as a compact card: optional image, linked title, one-line blurb. */
export function recipeCardHtml(r: EmailRecipe): string {
  const href = escapeHtml(safeHref(r.url))
  const img = r.image
    ? `<a href="${href}"><img src="${escapeHtml(safeHref(r.image))}" alt="${escapeHtml(r.alt ?? r.title)}" width="496" style="display:block;width:100%;max-width:496px;height:auto;border:0;border-radius:14px;margin:0 0 10px;"></a>`
    : ''
  const blurb = r.description
    ? `<p style="margin:4px 0 0;font-size:14px;line-height:1.5;color:${EMAIL_BRAND.muted};">${escapeHtml(r.description)}</p>`
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;"><tr><td>
${img}<a href="${href}" style="font-size:17px;font-weight:700;line-height:1.35;color:${EMAIL_BRAND.ink};text-decoration:none;">${escapeHtml(r.title)}</a>${blurb}
</td></tr></table>`
}

export function recipeText(r: EmailRecipe): string {
  return `${r.title}: ${r.url}`
}

/**
 * Button + copy-paste fallback, for bodies that need content AFTER the call to action (renderEmail's
 * own `cta` always goes last).
 */
export function ctaBlockHtml(href: string, label: string): string {
  return `${emailButton(href, label)}<p style="${small}margin-top:-12px;">If the button doesn't work, copy this link into your browser:<br><a href="${escapeHtml(safeHref(href))}" style="color:${EMAIL_BRAND.ink};word-break:break-all;">${escapeHtml(href)}</a></p>`
}

/** A code shown as a big, copyable chip. */
export function codeChipHtml(code: string): string {
  return `<p style="margin:0 0 16px;"><span style="display:inline-block;padding:10px 18px;border:2px dashed ${EMAIL_BRAND.accent};border-radius:12px;font-size:22px;font-weight:800;letter-spacing:2px;color:${EMAIL_BRAND.ink};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(code)}</span></p>`
}

export function subheadingHtml(text: string): string {
  return `<h2 style="margin:24px 0 12px;font-size:18px;line-height:1.3;color:${EMAIL_BRAND.ink};">${escapeHtml(text)}</h2>`
}

/** '26 Oct 2026' in Asia/Kolkata (emails are read in India). */
export function formatIstDate(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at)
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d)
}
