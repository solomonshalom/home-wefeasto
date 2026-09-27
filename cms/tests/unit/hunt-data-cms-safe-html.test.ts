/**
 * HUNT data-cms: the recipe/page HTML gate (`safeHtml`, UNSAFE_HTML_RE in src/endpoints/catalog/rules.ts)
 * lets executable markup through. The storefront renders these fields verbatim with {@html} on the
 * prerendered pages (recipes/[slug], [policy=policy]); the storefront has no CSP, and /api is same-origin,
 * so script there can read a signed-in customer's /api/customers/me and /api/store/orders/mine.
 *
 * cms-catalog.md §1: "Rejected: <script|iframe|…>, on…= handlers, javascript:, data:text/html".
 * Each payload below is an on…= handler or a javascript: URL that a browser executes, and each was
 * accepted by a PUBLISHED save over REST (PATCH /api/recipes/1 → 200) on the production e2e stack.
 */
import { describe, expect, it } from 'vitest'

import { safeHtml, UNSAFE_HTML_RE } from '@/endpoints/catalog/rules'

const EXECUTABLE = [
  // handler after "/" instead of whitespace (the HTML tokenizer treats "/" as an attribute separator)
  '<svg/onload=alert(1)>',
  '<img src=x/onerror=alert(1)>',
  '<img src="x"/onerror="alert(1)">',
  '<details/open/ontoggle=alert(1)>',
  // javascript: URL spelled with character references or a tab/newline (browsers decode / strip them)
  '<a href="jav&#x61;script:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="java&#9;script:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
]

describe('safeHtml rejects executable markup (recipes ingredients/directions/why, pages bodyHtml)', () => {
  it.each(EXECUTABLE)('%s', (html) => {
    expect(safeHtml(`<p>Soak overnight.</p>${html}`, {})).not.toBe(true)
    expect(UNSAFE_HTML_RE.test(html)).toBe(true)
  })

  it('still accepts the committed recipe markup (links, lists, headings, entities)', () => {
    const ok = '<h2>What you&#39;ll need</h2><ul role="list"><li>1 cup <a href="/products/steel-cut-oats">Oats</a></li></ul><p>Stir &amp; serve — onions optional.</p>'
    expect(safeHtml(ok, {})).toBe(true)
  })
})
