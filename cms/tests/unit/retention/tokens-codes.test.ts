import { createHash, createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { normalizeCouponCode } from '@/commerce/shared/coupons.js'
import {
  codeLengthForAttempt,
  CROCKFORD_ALPHABET,
  crockfordRandom,
  isWelcomeCode,
  WELCOME_CODE_RE,
  welcomeCode,
} from '@/retention/codes'
import {
  CONFIRM_TOKEN_TTL_MS,
  hashToken,
  isTokenShape,
  newConfirmToken,
  unsubscribeToken,
  unsubscribeTokenHash,
} from '@/retention/tokens'

const SECRET = 'unit-test-secret-unit-test-secret-000'

describe('confirm tokens', () => {
  it('are 32 random bytes in base64url (43 URL-safe chars), never repeating', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i += 1) {
      const t = newConfirmToken()
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(t, 'base64url')).toHaveLength(32)
      seen.add(t)
    }
    expect(seen.size).toBe(500)
  })

  it('only the sha256 hex is stored', () => {
    const t = newConfirmToken()
    expect(hashToken(t)).toBe(createHash('sha256').update(t).digest('hex'))
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('expire after 7 days', () => {
    expect(CONFIRM_TOKEN_TTL_MS).toBe(7 * 24 * 3600 * 1000)
  })
})

describe('isTokenShape', () => {
  it.each([
    [newConfirmToken(), true],
    ['A'.repeat(43), true],
    ['a-b_'.repeat(10) + 'abc', true],
    ['A'.repeat(42), false],
    ['A'.repeat(44), false],
    ['A'.repeat(42) + '=', false],
    ['A'.repeat(42) + '+', false],
    ['A'.repeat(42) + '/', false],
    ['', false],
    [null, false],
    [undefined, false],
    [123, false],
    [['A'.repeat(43)], false],
  ])('%s → %s', (value, expected) => {
    expect(isTokenShape(value)).toBe(expected)
  })
})

describe('unsubscribe tokens', () => {
  it('= base64url(HMAC_SHA256(secret, "unsubscribe:" + lowercased email))', () => {
    const expected = createHmac('sha256', SECRET).update('unsubscribe:asha@example.com').digest('base64url')
    expect(unsubscribeToken('asha@example.com', SECRET)).toBe(expected)
    expect(unsubscribeToken('  Asha@Example.COM ', SECRET)).toBe(expected)
    expect(isTokenShape(expected)).toBe(true)
  })

  it('differ per address and per secret; the stored hash is sha256(token)', () => {
    const a = unsubscribeToken('a@example.com', SECRET)
    expect(unsubscribeToken('b@example.com', SECRET)).not.toBe(a)
    expect(unsubscribeToken('a@example.com', `${SECRET}x`)).not.toBe(a)
    expect(unsubscribeTokenHash('a@example.com', SECRET)).toBe(hashToken(a))
  })

  describe('default secret', () => {
    const original = process.env.PAYLOAD_SECRET
    beforeEach(() => {
      process.env.PAYLOAD_SECRET = SECRET
    })
    afterEach(() => {
      if (original === undefined) delete process.env.PAYLOAD_SECRET
      else process.env.PAYLOAD_SECRET = original
    })
    it('uses PAYLOAD_SECRET', () => {
      expect(unsubscribeToken('a@example.com')).toBe(unsubscribeToken('a@example.com', SECRET))
    })
    it('refuses an empty secret or email', () => {
      process.env.PAYLOAD_SECRET = ''
      expect(() => unsubscribeToken('a@example.com')).toThrow(/PAYLOAD_SECRET/)
      expect(() => unsubscribeToken('', SECRET)).toThrow(/email/)
    })
  })
})

describe('welcome codes (HELLO-XXXX, Crockford base32)', () => {
  it('the alphabet is Crockford base32: 32 symbols, no I, L, O or U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32)
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32)
    for (const c of 'ILOU') expect(CROCKFORD_ALPHABET).not.toContain(c)
  })

  it('maps each random byte uniformly onto the alphabet (byte & 31)', () => {
    const bytes = (n: number) => Uint8Array.from([0, 31, 32, 255, 18, 50].slice(0, n))
    expect(crockfordRandom(6, bytes)).toBe('0Z0ZJJ')
    expect(welcomeCode(4, () => Uint8Array.from([1, 10, 20, 30]))).toBe('HELLO-1AMY')
  })

  it('codes are valid coupon codes (collection regex + $shared normalizeCouponCode)', () => {
    for (let i = 0; i < 2000; i += 1) {
      const code = welcomeCode()
      expect(code).toMatch(/^HELLO-[0-9A-HJKMNP-TV-Z]{4}$/)
      expect(isWelcomeCode(code)).toBe(true)
      expect(normalizeCouponCode(code)).toBe(code)
      expect(/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)).toBe(true)
    }
    const long = welcomeCode(6)
    expect(long).toMatch(WELCOME_CODE_RE)
    expect(long).toHaveLength(12)
  })

  it('are spread out (≈1M space: 3000 draws almost never collide)', () => {
    const codes = new Set(Array.from({ length: 3000 }, () => welcomeCode()))
    expect(codes.size).toBeGreaterThan(2980)
  })

  it('rejects lookalikes and junk', () => {
    for (const bad of ['HELLO-ABCI', 'HELLO-L000', 'HELLO-OOOO', 'HELLO-UUUU', 'hello-abcd', 'HELLO-ABC', 'WELCOME10', '', null]) {
      expect(isWelcomeCode(bad)).toBe(false)
    }
  })

  it('retries use 4 characters, then 6', () => {
    expect([0, 1, 5, 6, 9].map(codeLengthForAttempt)).toEqual([4, 4, 4, 6, 6])
  })

  it('refuses a non-positive length', () => {
    expect(() => crockfordRandom(0)).toThrow()
    expect(() => crockfordRandom(2.5)).toThrow()
  })
})
