import { createHash, createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { deriveOrderToken, hashToken, newTokenNonce, timingSafeEqualStr, verifyOrderToken } from '@/commerce/orderToken'

const SECRET = 'unit-test-secret-unit-test-secret-000'

describe('deriveOrderToken', () => {
  it('matches the spec formula base64url(HMAC_SHA256(secret, "order:<id>:<nonce>"))', () => {
    const expected = createHmac('sha256', SECRET).update('order:42:bm9uY2U').digest('base64url')
    expect(deriveOrderToken(42, 'bm9uY2U', SECRET)).toBe(expected)
    expect(deriveOrderToken('42', 'bm9uY2U', SECRET)).toBe(expected) // numeric and string ids agree
  })

  it('known vectors (computed independently with openssl dgst -sha256 -hmac … | base64url)', () => {
    expect(deriveOrderToken(10001, 'AAAAAAAAAAAAAAAAAAAAAA', SECRET)).toBe('RtsT1sQieSrb063Kd0qbwazkqrBKJ34yBcDnSdRMlEU')
    expect(deriveOrderToken(1, 'n', 'k')).toBe('d_fsBj3BOkxGBhB7WxuqkBwxRESwkhfpF2BSR_Jk9zA')
  })

  it('is URL-safe, unpadded, 43 chars (256 bits)', () => {
    const t = deriveOrderToken(7, newTokenNonce(), SECRET)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('changes with id, nonce and secret', () => {
    const a = deriveOrderToken(1, 'n1', SECRET)
    expect(deriveOrderToken(2, 'n1', SECRET)).not.toBe(a)
    expect(deriveOrderToken(1, 'n2', SECRET)).not.toBe(a)
    expect(deriveOrderToken(1, 'n1', `${SECRET}x`)).not.toBe(a)
    // No ambiguity between id and nonce boundaries: 1:23 vs 12:3
    expect(deriveOrderToken(1, '23', SECRET)).not.toBe(deriveOrderToken(12, '3', SECRET))
  })

  describe('with PAYLOAD_SECRET from the environment', () => {
    const saved = process.env.PAYLOAD_SECRET
    afterEach(() => {
      process.env.PAYLOAD_SECRET = saved
    })
    it('defaults to PAYLOAD_SECRET', () => {
      process.env.PAYLOAD_SECRET = SECRET
      expect(deriveOrderToken(5, 'n')).toBe(deriveOrderToken(5, 'n', SECRET))
    })
    it('refuses to derive without a secret, id or nonce', () => {
      process.env.PAYLOAD_SECRET = ''
      expect(() => deriveOrderToken(5, 'n')).toThrow(/PAYLOAD_SECRET/)
      expect(() => deriveOrderToken('', 'n', SECRET)).toThrow(/orderId/)
      expect(() => deriveOrderToken(5, '', SECRET)).toThrow(/nonce/)
    })
  })
})

describe('newTokenNonce', () => {
  it('is 16 random bytes in base64url', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const n = newTokenNonce()
      expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(Buffer.from(n, 'base64url')).toHaveLength(16)
      seen.add(n)
    }
    expect(seen.size).toBe(200)
  })
})

describe('hashToken', () => {
  it('is sha256 hex', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('timingSafeEqualStr', () => {
  it('compares strings', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true)
    expect(timingSafeEqualStr('', '')).toBe(true)
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false) // length mismatch does not throw
    expect(timingSafeEqualStr('abcd', 'abc')).toBe(false)
    expect(timingSafeEqualStr('ä', 'a')).toBe(false)
  })
  it('never equates non-strings', () => {
    expect(timingSafeEqualStr(undefined, undefined)).toBe(false)
    expect(timingSafeEqualStr(null, 'x')).toBe(false)
    expect(timingSafeEqualStr(1, 1)).toBe(false)
    expect(timingSafeEqualStr(['a'], 'a')).toBe(false)
  })
})

describe('verifyOrderToken', () => {
  const order = { id: 10001, tokenNonce: 'fixed-nonce-value-0000' }
  const token = deriveOrderToken(order.id, order.tokenNonce, SECRET)
  it('accepts the right token only', () => {
    expect(verifyOrderToken(order, token, SECRET)).toBe(true)
    expect(verifyOrderToken(order, token.toUpperCase(), SECRET)).toBe(false)
    expect(verifyOrderToken(order, token.slice(1), SECRET)).toBe(false)
    expect(verifyOrderToken({ ...order, id: 10002 }, token, SECRET)).toBe(false)
    expect(verifyOrderToken(order, '', SECRET)).toBe(false)
    expect(verifyOrderToken(order, undefined, SECRET)).toBe(false)
    expect(verifyOrderToken({ id: 1, tokenNonce: null }, token, SECRET)).toBe(false)
  })
})
