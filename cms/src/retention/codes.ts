import { randomBytes } from 'node:crypto'

/**
 * Welcome-offer codes: `HELLO-` + Crockford base32 (0-9 A-Z without I, L, O, U, so a code read aloud or
 * typed from a phone can't be confused). 4 characters give ~1M codes; the issuer retries on a unique
 * collision and moves to 6 characters if 4 keep colliding.
 */

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const WELCOME_CODE_PREFIX = 'HELLO-'
export const WELCOME_CODE_LENGTH = 4
export const WELCOME_CODE_RE = /^HELLO-[0-9A-HJKMNP-TV-Z]{4,8}$/

/** `length` random Crockford base32 characters (uniform: 256 is a multiple of 32). */
export function crockfordRandom(length: number, bytes: (n: number) => Uint8Array = randomBytes): string {
  if (!Number.isSafeInteger(length) || length < 1) throw new Error('crockfordRandom: length must be a positive integer')
  const buf = bytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += CROCKFORD_ALPHABET[buf[i] & 31]
  return out
}

export function welcomeCode(length = WELCOME_CODE_LENGTH, bytes?: (n: number) => Uint8Array): string {
  return WELCOME_CODE_PREFIX + crockfordRandom(length, bytes)
}

export function isWelcomeCode(value: unknown): boolean {
  return typeof value === 'string' && WELCOME_CODE_RE.test(value)
}

/** Code length for the n-th attempt (0-based): 4 characters for the first 6 tries, then 6. */
export function codeLengthForAttempt(attempt: number): number {
  return attempt < 6 ? WELCOME_CODE_LENGTH : 6
}

/** The admin note on a subscriber's welcome coupon (rewritten when an admin corrects the address). */
export const welcomeCouponNote = (email: string): string => `Welcome offer for ${email} (newsletter confirmation)`
