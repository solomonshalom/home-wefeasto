/**
 * HUNT data-cms (round 2): the recipe/page HTML gate (`safeHtml`, UNSAFE_HTML_RE in
 * src/endpoints/catalog/rules.ts) still lets a javascript: URL through when a letter of the scheme is
 * written as the numeric character reference of its UPPER-CASE form.
 *
 * The fix for round 1 (#27) builds each letter as `(?:j|&#0*106;?|&#x0*6a;?)` with the `i` flag. The `i`
 * flag makes the literal letter match "J", but the references are the code points of the lower-case
 * letter only: `&#74;` / `&#x4A;` ("J") and `&#65;` ("A") are not matched. URL schemes are
 * case-insensitive, so the browser decodes href="&#74;avascript:alert(1)" to "Javascript:alert(1)" and
 * runs it on click (the storefront renders these fields with {@html} on prerendered pages, no CSP).
 */
import { describe, expect, it } from 'vitest'

import { safeHtml, UNSAFE_HTML_RE } from '@/endpoints/catalog/rules'

const EXECUTABLE = [
  '<a href="&#74;avascript:alert(1)">x</a>', // J decimal
  '<a href="&#x4A;avascript:alert(1)">x</a>', // J hex
  '<a href="jav&#65;script:alert(1)">x</a>', // A decimal
  '<a href="JAV&#x41;SCRIPT:alert(1)">x</a>', // A hex, upper-case scheme
  '<a href="java&#83;cript:alert(1)">x</a>', // S decimal
  '<svg><a><animate attributeName="href" values="&#74;avascript:alert(1)"/><text y="20">x</text></a></svg>',
]

describe('safeHtml rejects javascript: spelled with upper-case character references', () => {
  it.each(EXECUTABLE)('%s', (html) => {
    expect(UNSAFE_HTML_RE.test(html)).toBe(true)
    expect(safeHtml(`<p>Soak overnight.</p>${html}`, {})).not.toBe(true)
  })
})
