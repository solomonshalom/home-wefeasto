import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { renderConfirmationEmail } from '@/email/retention/confirmation'
import { renderRefillEmail } from '@/email/retention/refill'
import { formatIstDate, listUnsubscribeHeaders } from '@/email/retention/shared'
import { lastValidDay, renderWelcomeEmail } from '@/email/retention/welcome'
import {
  absoluteImage,
  confirmUrl,
  offerUrl,
  recipeUrl,
  refillCartUrl,
  storefrontNewsletterUrl,
  unsubscribeUrl,
} from '@/retention/links'

const ENV = { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.wefeasto.test/', STOREFRONT_URL: 'https://wefeasto.test/' }
const saved: Record<string, string | undefined> = {}

// Set at load time: some fixtures below are built while the suite is collected (getEnv() reads live).
for (const [k, v] of Object.entries(ENV)) {
  saved[k] = process.env[k]
  process.env[k] = v
}
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))

describe('links', () => {
  it('email action links go to the CMS origin; shopping links to the storefront', () => {
    expect(confirmUrl('abc_-1')).toBe('https://cms.wefeasto.test/api/store/newsletter/confirm?t=abc_-1')
    expect(unsubscribeUrl('xyz')).toBe('https://cms.wefeasto.test/api/store/newsletter/unsubscribe?t=xyz')
    expect(offerUrl('HELLO-7K2Q')).toBe('https://wefeasto.test/cart?offer=HELLO-7K2Q')
    expect(recipeUrl('wf-berry-oats')).toBe('https://wefeasto.test/recipes/wf-berry-oats')
  })

  it('storefront redirect targets carry the outcome and the #newsletter anchor', () => {
    expect(storefrontNewsletterUrl({ subscribed: '1' })).toBe('https://wefeasto.test/?subscribed=1#newsletter')
    expect(storefrontNewsletterUrl({ subscribed: 'expired' })).toBe('https://wefeasto.test/?subscribed=expired#newsletter')
    expect(storefrontNewsletterUrl({ unsubscribed: '1' })).toBe('https://wefeasto.test/?unsubscribed=1#newsletter')
    expect(storefrontNewsletterUrl({ unsubscribed: 'invalid' })).toBe('https://wefeasto.test/?unsubscribed=invalid#newsletter')
  })

  it('refill link = /cart?add=<buildAddParam(items)>&src=refill (clamped, deduped, junk dropped)', () => {
    expect(refillCartUrl([{ slug: 'rolled-oats', qty: 2 }, { slug: 'muesli', qty: 1 }])).toBe(
      'https://wefeasto.test/cart?add=rolled-oats:2,muesli:1&src=refill',
    )
    expect(refillCartUrl([{ slug: 'rolled-oats', qty: 12 }, { slug: 'rolled-oats', qty: 1 }, { slug: 'Bad Slug', qty: 1 }])).toBe(
      'https://wefeasto.test/cart?add=rolled-oats:10&src=refill',
    )
    expect(refillCartUrl([])).toBe('https://wefeasto.test/cart')
  })

  it('absoluteImage: storefront paths become absolute, https passes, anything else is dropped', () => {
    expect(absoluteImage('/images/wefeasto/x.jpg')).toBe('https://wefeasto.test/images/wefeasto/x.jpg')
    expect(absoluteImage('https://cdn.example.com/x.jpg')).toBe('https://cdn.example.com/x.jpg')
    for (const bad of ['//evil.example/x.jpg', 'javascript:alert(1)', 'http://plain.example/x.jpg', '', null, 3]) {
      expect(absoluteImage(bad)).toBe('')
    }
  })
})

describe('confirmation email', () => {
  it('has the confirm button + fallback link and no unsubscribe headers (not on the list yet)', () => {
    const url = confirmUrl('T'.repeat(43))
    const e = renderConfirmationEmail({ confirmUrl: url })
    expect(e.subject).toBe('Confirm your Wefeasto subscription')
    expect(hrefs(e.html).filter((h) => h === url)).toHaveLength(2)
    expect(e.text).toContain(url)
    expect(e.text).toMatch(/7 days/)
    expect(e.headers).toBeUndefined()
  })
})

describe('welcome email', () => {
  const unsub = unsubscribeUrl('U'.repeat(43))
  const recipes = [
    { title: 'Berry <Overnight> Oats', url: recipeUrl('wf-a'), image: absoluteImage('/images/a.jpg'), alt: 'A bowl "of" oats', description: 'Creamy & quick.' },
    { title: 'Muesli Parfait', url: recipeUrl('wf-b'), image: '', description: undefined },
  ]
  const offer = { code: 'HELLO-7K2Q', percent: 10, maxDiscountPaise: 7500, endsAt: '2026-10-26T10:00:00.000Z', url: offerUrl('HELLO-7K2Q') }

  it('leads with the code, links /cart?offer=, shows two recipes and the unsubscribe link', () => {
    const e = renderWelcomeEmail({ offer, recipes, unsubscribeUrl: unsub, shopUrl: 'https://wefeasto.test/shop' })
    expect(e.subject).toBe("You're in — here's 10% off your first order")
    expect(e.html).toContain('HELLO-7K2Q')
    expect(e.html).toContain('10% off your first order (up to ₹75)')
    expect(e.html).toContain('until 26 Oct 2026')
    const links = hrefs(e.html)
    expect(links).toContain('https://wefeasto.test/cart?offer=HELLO-7K2Q')
    expect(links).toContain('https://wefeasto.test/recipes/wf-a')
    expect(links).toContain('https://wefeasto.test/recipes/wf-b')
    expect(links).toContain(unsub)
    // The offer comes before the recipes, and the unsubscribe line is last.
    expect(e.html.indexOf('HELLO-7K2Q')).toBeLessThan(e.html.indexOf('wf-a'))
    expect(e.html.lastIndexOf(unsub)).toBeGreaterThan(e.html.indexOf('wf-b'))
    expect(e.headers).toEqual({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    expect(e.text).toContain('HELLO-7K2Q')
    expect(e.text).toContain('https://wefeasto.test/cart?offer=HELLO-7K2Q')
    expect(e.text).toContain(unsub)
  })

  it('escapes recipe content', () => {
    const e = renderWelcomeEmail({ offer, recipes, unsubscribeUrl: unsub, shopUrl: 'https://wefeasto.test/shop' })
    expect(e.html).toContain('Berry &lt;Overnight&gt; Oats')
    expect(e.html).toContain('alt="A bowl &quot;of&quot; oats"')
    expect(e.html).toContain('Creamy &amp; quick.')
    expect(e.html).not.toContain('<Overnight>')
  })

  it('without an offer: recipes and a shop link, no code', () => {
    const e = renderWelcomeEmail({ offer: null, recipes, unsubscribeUrl: unsub, shopUrl: 'https://wefeasto.test/shop' })
    expect(e.subject).toBe("You're in — breakfast ideas inside")
    expect(e.html).not.toContain('HELLO-')
    expect(hrefs(e.html)).toContain('https://wefeasto.test/shop')
    expect(e.headers?.['List-Unsubscribe']).toBe(`<${unsub}>`)
  })

  it('no cap → no "up to" wording', () => {
    const e = renderWelcomeEmail({ offer: { ...offer, maxDiscountPaise: null }, recipes: [], unsubscribeUrl: unsub, shopUrl: '' })
    expect(e.html).toContain('10% off your first order.')
    expect(e.html).not.toContain('up to')
  })

  it('lastValidDay: endsAt is exclusive and shown in IST', () => {
    expect(lastValidDay('2026-10-26T10:00:00.000Z')).toBe('26 Oct 2026')
    // 18:30Z = midnight IST on the 27th → the last valid IST day is the 26th.
    expect(lastValidDay('2026-10-26T18:30:00.000Z')).toBe('26 Oct 2026')
    expect(lastValidDay('2026-10-26T18:30:00.001Z')).toBe('27 Oct 2026')
    // 19:00Z on the 26th is already the 27th in IST (ICU spells September "Sep" or "Sept").
    expect(formatIstDate('2026-09-26T19:00:00.000Z')).toMatch(/^27 Sept? 2026$/)
  })
})

describe('refill email', () => {
  const unsub = unsubscribeUrl('U'.repeat(43))
  const base = {
    firstName: 'Asha',
    orderNumber: 'WF-10042',
    items: [
      { name: 'Rolled Oats', qty: 2 },
      { name: 'Muesli', qty: 1 },
    ],
    runsOutAt: '2026-10-10T04:30:00.000Z',
    refillUrl: refillCartUrl([{ slug: 'rolled-oats', qty: 2 }, { slug: 'muesli', qty: 1 }]),
    recipe: { title: 'Oat Pancakes', url: recipeUrl('wf-oat-pancakes'), image: '', description: 'Fluffy.' },
    unsubscribeUrl: unsub,
  }

  it('one-tap refill link, one recipe, unsubscribe link + headers', () => {
    const e = renderRefillEmail(base)
    expect(e.subject).toBe('Running low on breakfast?')
    expect(e.html).toContain('Breakfast running low, Asha?')
    expect(e.html).toContain('WF-10042 (Rolled Oats × 2, Muesli)')
    expect(e.html).toContain('10 Oct 2026')
    const links = hrefs(e.html)
    expect(links).toContain('https://wefeasto.test/cart?add=rolled-oats:2,muesli:1&src=refill')
    expect(links).toContain('https://wefeasto.test/recipes/wf-oat-pancakes')
    expect(links).toContain(unsub)
    expect(e.headers).toEqual(listUnsubscribeHeaders(unsub))
    expect(e.text).toContain('https://wefeasto.test/cart?add=rolled-oats:2,muesli:1&src=refill')
    expect(e.text).toContain(unsub)
  })

  it('single product subject, no name, no recipe', () => {
    const e = renderRefillEmail({ ...base, firstName: '', items: [{ name: 'Cornflakes', qty: 1 }], recipe: null })
    expect(e.subject).toBe('Running low on Cornflakes?')
    expect(e.html).toContain('Breakfast running low?')
    expect(e.html).not.toContain('wf-oat-pancakes')
  })
})
