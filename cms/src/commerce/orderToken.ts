import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { getEnv } from '../env'

/**
 * Guest order access tokens (SPEC §0 "Order identity").
 *
 *   token     = base64url(HMAC_SHA256(PAYLOAD_SECRET, 'order:' + orderId + ':' + tokenNonce))
 *   tokenHash = sha256hex(token)   (stored, indexed; the token itself is never stored)
 *
 * The token is re-derivable from the hidden nonce, so idempotent checkout replays and emails can
 * reproduce it. Lookups must answer unknown order and wrong token with the SAME 404 body.
 */

/** 16 random bytes, base64url (22 chars). Stored hidden on the order as `tokenNonce`. */
export function newTokenNonce(): string {
  return randomBytes(16).toString('base64url')
}

export function deriveOrderToken(orderId: string | number, nonce: string, secret: string = getEnv().payloadSecret): string {
  if (!secret) throw new Error('deriveOrderToken: PAYLOAD_SECRET is not set')
  if (orderId === '' || orderId === null || orderId === undefined) throw new Error('deriveOrderToken: orderId is required')
  if (!nonce) throw new Error('deriveOrderToken: nonce is required')
  return createHmac('sha256', secret).update(`order:${orderId}:${nonce}`).digest('base64url')
}

/** sha256 hex of the token: the value stored in `orders.tokenHash`. */
export function hashToken(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/**
 * Constant-time string comparison. Both sides are hashed first, so different lengths neither throw
 * nor leak the length through timing. Non-strings compare unequal.
 */
export function timingSafeEqualStr(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

/** True when `token` is the valid guest token for this order (needs the hidden `tokenNonce`). */
export function verifyOrderToken(
  order: { id: string | number; tokenNonce?: string | null },
  token: unknown,
  secret?: string,
): boolean {
  if (typeof token !== 'string' || !token || !order?.tokenNonce) return false
  return timingSafeEqualStr(deriveOrderToken(order.id, order.tokenNonce, secret), token)
}
