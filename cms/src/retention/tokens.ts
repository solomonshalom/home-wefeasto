import { createHmac, randomBytes } from 'node:crypto'

import { hashToken } from '../commerce/orderToken'
import { getEnv } from '../env'

/**
 * Newsletter link tokens. Only sha256(token) is ever stored (`subscribers.confirmTokenHash`,
 * `subscribers.unsubscribeTokenHash`); the tokens themselves live only in the emails.
 *
 *   confirm      32 random bytes, base64url (43 chars). Rotated every time a confirmation email is sent,
 *                valid for 7 days (`subscribers.confirmTokenExpiresAt`).
 *   unsubscribe  base64url(HMAC_SHA256(PAYLOAD_SECRET, 'unsubscribe:' + email)) (43 chars). Deterministic,
 *                so every marketing email (welcome, refill, …) can carry a working one-click link without
 *                storing the token, and old links keep working after a re-subscription.
 */

export const CONFIRM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Both token kinds are 32 bytes in base64url: exactly 43 URL-safe characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export { hashToken }

export function isTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

export function newConfirmToken(): string {
  return randomBytes(32).toString('base64url')
}

export function unsubscribeToken(email: string, secret: string = getEnv().payloadSecret): string {
  if (!secret) throw new Error('unsubscribeToken: PAYLOAD_SECRET is not set')
  if (!email) throw new Error('unsubscribeToken: email is required')
  return createHmac('sha256', secret).update(`unsubscribe:${email.trim().toLowerCase()}`).digest('base64url')
}

export function unsubscribeTokenHash(email: string, secret?: string): string {
  return hashToken(unsubscribeToken(email, secret))
}
