import { describe, expect, it } from 'vitest'

import { checkoutRequestHash, IDEMPOTENCY_KEY_RE, stableStringify } from '@/commerce/checkout/checkout'
import { attemptReceipt, refundReceipt } from '@/commerce/checkout/paymentInit'

const base = () => ({
  items: [
    { slug: 'muesli', qty: 1 },
    { slug: 'cornflakes', qty: 2 },
  ],
  contact: { name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777' },
  address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
  method: 'upi',
  expectedTotalPaise: 67400,
  consent: { marketing: false },
  source: 'web',
})

describe('stableStringify', () => {
  it('sorts keys at every level, keeps array order, drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify('x')).toBe('"x"')
  })
})

describe('checkoutRequestHash', () => {
  it('is a sha256 hex digest', () => {
    expect(checkoutRequestHash(base())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores key order, line order, duplicate lines, extra fields, phone/email formatting and state spelling', () => {
    const h = checkoutRequestHash(base())
    const variants = [
      { ...base(), items: [{ qty: 2, slug: 'cornflakes' }, { slug: 'muesli', qty: 1 }] },
      { ...base(), items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }, { slug: 'cornflakes', qty: 1, price: 1 }] },
      { ...base(), contact: { phone: '098452 62777', email: ' Asha@Example.com ', name: 'Asha  Kumar' } },
      { ...base(), address: { ...base().address, state: 'karnataka', pin: '560 001' } },
      { ...base(), total: 1, currency: 'USD' },
    ]
    for (const v of variants) expect(checkoutRequestHash(v)).toBe(h)
  })

  it('ignores the supersede reference (it names what to replace, not what is ordered: SUP-PHONE-1)', () => {
    const h = checkoutRequestHash(base())
    expect(checkoutRequestHash({ ...base(), supersede: { number: 'WF-10001', token: 'x'.repeat(43) } })).toBe(h)
    expect(checkoutRequestHash({ ...base(), supersede: null })).toBe(h)
  })

  it('changes with anything that changes the order', () => {
    const h = checkoutRequestHash(base())
    const changes: Record<string, unknown>[] = [
      { items: [{ slug: 'muesli', qty: 2 }, { slug: 'cornflakes', qty: 2 }] },
      { method: 'cod' },
      { method: 'card' },
      { expectedTotalPaise: 67500 },
      { couponCode: 'WELCOME10' },
      { consent: { marketing: true } },
      { source: 'email' },
      { contact: { ...base().contact, name: 'Ravi Kumar' } },
      { address: { ...base().address, line1: 'Flat 5B, 12 MG Road' } },
    ]
    for (const c of changes) expect(checkoutRequestHash({ ...base(), ...c }), JSON.stringify(c)).not.toBe(h)
  })

  it('coupon codes are compared trimmed and case-insensitively; a blank code equals none', () => {
    expect(checkoutRequestHash({ ...base(), couponCode: ' welcome10 ' })).toBe(checkoutRequestHash({ ...base(), couponCode: 'WELCOME10' }))
    expect(checkoutRequestHash({ ...base(), couponCode: '  ' })).toBe(checkoutRequestHash(base()))
  })

  it('never throws on junk', () => {
    for (const junk of [{}, { items: 'x', contact: 5, address: null, consent: [] }, { items: [{ slug: '__proto__', qty: 1e9 }] }]) {
      expect(checkoutRequestHash(junk as never)).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('IDEMPOTENCY_KEY_RE', () => {
  it('accepts uuid v4 only', () => {
    expect(IDEMPOTENCY_KEY_RE.test(crypto.randomUUID())).toBe(true)
    expect(IDEMPOTENCY_KEY_RE.test('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true)
    for (const bad of ['', 'abc', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '3f2504e0-4f89-41d3-7a0c-0305e82c3301', `${crypto.randomUUID()}x`]) {
      expect(IDEMPOTENCY_KEY_RE.test(bad), bad).toBe(false)
    }
  })
})

describe('receipts', () => {
  it('attempt and refund receipts are short printable ASCII (Razorpay: ≤ 40)', () => {
    expect(attemptReceipt('WF-10001', 1)).toBe('WF-10001-a1')
    expect(attemptReceipt('WF-10001', 10)).toBe('WF-10001-a10')
    expect(refundReceipt('WF-10001', 'dup', 'pay_Mock1234567890ab')).toBe('WF-10001-dup-7890ab')
    for (const r of [attemptReceipt('WF-999999999999', 10), refundReceipt('WF-999999999999', 'oos', 'pay_X'.padEnd(30, 'z'))]) {
      expect(r.length).toBeLessThanOrEqual(40)
      expect(r).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})
