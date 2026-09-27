import { afterEach, describe, expect, it } from 'vitest'

import { resetPasswordHtml, resetPasswordUrl, verifyEmailHtml, verifyEmailUrl } from '@/email/customerAuth'
import { EMAIL_BRAND, emailButton, escapeHtml, paragraph, renderEmail, renderText, safeHref } from '@/email/layout'

describe('escapeHtml / safeHref', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
  it('only allows http(s) and mailto links', () => {
    expect(safeHref('https://wefeasto.com/order?no=1&t=2')).toBe('https://wefeasto.com/order?no=1&t=2')
    expect(safeHref('mailto:hello@wefeasto.com')).toBe('mailto:hello@wefeasto.com')
    expect(safeHref('javascript:alert(1)')).toBe('#')
    expect(safeHref(' data:text/html,x')).toBe('#')
    expect(safeHref('/relative')).toBe('#')
  })
})

describe('renderEmail', () => {
  const html = renderEmail({
    heading: 'Order WF-10001 <confirmed>',
    preheader: 'Arrives in 3–7 days',
    bodyHtml: paragraph('Hi <Asha>'),
    cta: { href: 'https://wefeasto.com/order?no=WF-10001&t=abc', label: 'View order' },
    footerNote: 'Questions? Reply to this email.',
  })

  it('is a complete branded HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Wefeasto')
    expect(html).toContain(EMAIL_BRAND.background) // #f9f4ef
    expect(html).toContain(EMAIL_BRAND.ink) // #333333
    expect(html).toContain(EMAIL_BRAND.accent) // #ff8d5e
    expect(html).not.toMatch(/<style|<script/i)
  })

  it('escapes every caller-provided string', () => {
    expect(html).toContain('Order WF-10001 &lt;confirmed&gt;')
    expect(html).toContain('Hi &lt;Asha&gt;')
    expect(html).not.toContain('<confirmed>')
    expect(html).toContain('href="https://wefeasto.com/order?no=WF-10001&amp;t=abc"')
  })

  it('renders the CTA, a copy-paste fallback link, preheader and footer', () => {
    expect(html).toContain('View order')
    expect(html.match(/https:\/\/wefeasto\.com\/order\?no=WF-10001&amp;t=abc/g)!.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('Arrives in 3–7 days')
    expect(html).toContain('Questions? Reply to this email.')
  })

  it('omits optional parts', () => {
    const bare = renderEmail({ heading: 'Hello' })
    expect(bare).not.toContain('display:none')
    expect(bare).not.toContain("If the button doesn't work")
  })

  it('neutralises dangerous CTA links', () => {
    expect(emailButton('javascript:alert(1)', 'x')).toContain('href="#"')
  })
})

describe('renderText', () => {
  it('produces a plain-text alternative', () => {
    const text = renderText({
      heading: 'Order confirmed',
      paragraphs: ['Thanks!', 'See you soon.'],
      cta: { href: 'https://x.dev/o', label: 'View order' },
      footerNote: 'Reply for help.',
    })
    expect(text).toBe('Order confirmed\n\nThanks!\n\nSee you soon.\n\nView order: https://x.dev/o\n\nReply for help.\n\n— Wefeasto')
  })
})

describe('customer auth emails', () => {
  const saved = process.env.STOREFRONT_URL
  afterEach(() => {
    process.env.STOREFRONT_URL = saved
  })

  it('link to the storefront with the token URL-encoded', () => {
    process.env.STOREFRONT_URL = 'https://wefeasto.com/'
    expect(verifyEmailUrl('abc/+=')).toBe('https://wefeasto.com/login?verify=abc%2F%2B%3D')
    expect(resetPasswordUrl('t0k')).toBe('https://wefeasto.com/reset-password?token=t0k')
    const v = verifyEmailHtml({ token: 'tok123', user: { name: 'Asha Rao', email: 'a@b.dev' } })
    expect(v).toContain('href="https://wefeasto.com/login?verify=tok123"')
    expect(v).toContain('Hi Asha,')
    expect(v).not.toContain('/admin')
    const r = resetPasswordHtml({ token: 'tok456', user: { name: '<b>x</b>' } })
    expect(r).toContain('href="https://wefeasto.com/reset-password?token=tok456"')
    expect(r).toContain('Hi &lt;b&gt;x&lt;/b&gt;,')
    expect(resetPasswordHtml({ token: 'z' })).toContain('Hi there,')
  })
})
