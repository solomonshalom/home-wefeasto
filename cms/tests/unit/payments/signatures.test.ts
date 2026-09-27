import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import {
  hexDigestEquals,
  isRazorpayOrderId,
  isRazorpayPaymentId,
  isRazorpayRefundId,
  signPayment,
  signWebhook,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '@/payments/signatures'

// The SDK's own (non timing-safe) helpers, used only as an independent oracle for the vectors.
const require = createRequire(import.meta.url)
const { validatePaymentVerification, validateWebhookSignature } = require('razorpay/dist/utils/razorpay-utils') as {
  validatePaymentVerification: (p: { order_id: string; payment_id: string }, sig: string, secret: string) => boolean
  validateWebhookSignature: (body: string, sig: string, secret: string) => boolean
}

/** Vectors computed with `openssl dgst -sha256 -hmac <secret>` (independent of Node's crypto). */
const V = {
  docsPair: {
    orderId: 'order_DESlLckIVRkHWj',
    paymentId: 'pay_DESlfW9H8K9uqM',
    secret: 'rzp_test_secret_EXAMPLE',
    signature: 'a0ff2de8f9ec5efce4bd50db494675b0a2665a347bff1159728a7a960cc158fb',
  },
  sandboxPair: {
    orderId: 'order_ABCDEFGHIJKLMN',
    paymentId: 'pay_ABCDEFGHIJKLMN',
    secret: 'shh',
    signature: '8c760282b916249a854ca77b33fa50dd4921fbdb4ed5e306cdbec68793f7c38b',
  },
  // PHP-style escaped slash: JSON.stringify(JSON.parse(raw)) !== raw
  webhookRaw: '{"event":"order.paid","payload":{"x":"a\\/b"}}',
  webhookSecret: 'wh',
  webhookSignature: '38d542c172215ad2d1e0257dc3846d1da7677a1977e07559196253a840695d56',
  rotationRaw: '{"entity":"event","event":"payment.captured"}',
  rotationCurrent: { secret: 'whsec_current', signature: '4fbad5be6c8cf63bade263e3d0158f23c5327a34686129f5c2dd6acbd6f7d43f' },
  rotationOld: { secret: 'whsec_old', signature: 'c365eea9b03f5cde1ab83f5501d4cee19422f967d91d3f308b55f324c2c18f86' },
}

const flipFirst = (hex: string) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1)

describe('payment (Checkout) signatures', () => {
  it('matches the openssl vectors and the SDK oracle', () => {
    for (const v of [V.docsPair, V.sandboxPair]) {
      expect(signPayment(v.orderId, v.paymentId, v.secret)).toBe(v.signature)
      expect(verifyPaymentSignature({ orderId: v.orderId, paymentId: v.paymentId, signature: v.signature, keySecret: v.secret })).toBe(true)
      expect(validatePaymentVerification({ order_id: v.orderId, payment_id: v.paymentId }, v.signature, v.secret)).toBe(true)
    }
  })

  it('rejects tampering: other order, other payment, other secret, flipped hex digit', () => {
    const v = V.docsPair
    const ok = { orderId: v.orderId, paymentId: v.paymentId, signature: v.signature, keySecret: v.secret }
    expect(verifyPaymentSignature({ ...ok, orderId: 'order_OTHERORDER12345' })).toBe(false)
    expect(verifyPaymentSignature({ ...ok, paymentId: 'pay_OTHERPAYMENT1234' })).toBe(false)
    expect(verifyPaymentSignature({ ...ok, keySecret: 'another-secret' })).toBe(false)
    expect(verifyPaymentSignature({ ...ok, signature: flipFirst(v.signature) })).toBe(false)
    // swapping the pair order must not verify either
    expect(signPayment(v.paymentId, v.orderId, v.secret)).not.toBe(v.signature)
  })

  it('rejects malformed signatures without throwing (length, case, non-hex, non-string)', () => {
    const v = V.docsPair
    const base = { orderId: v.orderId, paymentId: v.paymentId, keySecret: v.secret }
    for (const signature of [
      v.signature.slice(0, 63),
      v.signature + '0',
      v.signature.toUpperCase(),
      v.signature.replace(/.$/, 'g'),
      '',
      ' ' + v.signature.slice(1),
      null,
      undefined,
      123,
      { length: 64 },
      [v.signature],
      Buffer.from(v.signature, 'hex'),
    ]) {
      expect(verifyPaymentSignature({ ...base, signature })).toBe(false)
    }
  })

  it('refuses malformed ids before hashing (no "order|undefined" signatures)', () => {
    const secret = 'shh'
    const sigForUndefined = signPayment('order_ABCDEFGHIJKLMN', 'undefined', secret)
    expect(verifyPaymentSignature({ orderId: 'order_ABCDEFGHIJKLMN', paymentId: undefined, signature: sigForUndefined, keySecret: secret })).toBe(false)
    for (const [orderId, paymentId] of [
      ['order_short', 'pay_ABCDEFGHIJKLMN'],
      ['ORDER_ABCDEFGHIJKLMN', 'pay_ABCDEFGHIJKLMN'],
      ['order_ABCDEFGHIJKLMN', 'pay_ABC-EFGHIJKLMN'],
      ['order_ABCDEFGHIJKLMN|x', 'pay_ABCDEFGHIJKLMN'],
      [123, 'pay_ABCDEFGHIJKLMN'],
    ] as const) {
      const signature = signPayment(String(orderId), String(paymentId), secret)
      expect(verifyPaymentSignature({ orderId, paymentId, signature, keySecret: secret })).toBe(false)
    }
  })

  it('throws when the key secret is missing (configuration error, not bad input)', () => {
    const v = V.sandboxPair
    expect(() => verifyPaymentSignature({ orderId: v.orderId, paymentId: v.paymentId, signature: v.signature, keySecret: '' })).toThrow(/not configured/)
    expect(() => signPayment(v.orderId, v.paymentId, '')).toThrow(/not configured/)
  })
})

describe('webhook signatures', () => {
  it('matches the openssl vector over the raw bytes (string and Buffer) and the SDK oracle', () => {
    expect(signWebhook(V.webhookRaw, V.webhookSecret)).toBe(V.webhookSignature)
    expect(verifyWebhookSignature(V.webhookRaw, V.webhookSignature, V.webhookSecret)).toBe(true)
    expect(verifyWebhookSignature(Buffer.from(V.webhookRaw), V.webhookSignature, V.webhookSecret)).toBe(true)
    expect(verifyWebhookSignature(new TextEncoder().encode(V.webhookRaw), V.webhookSignature, V.webhookSecret)).toBe(true)
    expect(validateWebhookSignature(V.webhookRaw, V.webhookSignature, V.webhookSecret)).toBe(true)
  })

  it('fails for a re-serialised body and refuses parsed objects', () => {
    const reserialised = JSON.stringify(JSON.parse(V.webhookRaw))
    expect(reserialised).not.toBe(V.webhookRaw)
    expect(verifyWebhookSignature(reserialised, V.webhookSignature, V.webhookSecret)).toBe(false)
    expect(verifyWebhookSignature(JSON.parse(V.webhookRaw), V.webhookSignature, V.webhookSecret)).toBe(false)
    expect(verifyWebhookSignature(null, V.webhookSignature, V.webhookSecret)).toBe(false)
    expect(verifyWebhookSignature(V.webhookRaw + '\n', V.webhookSignature, V.webhookSecret)).toBe(false)
  })

  it('rejects tampered, truncated, uppercase or missing signature headers without throwing', () => {
    for (const sig of [flipFirst(V.webhookSignature), V.webhookSignature.slice(1), V.webhookSignature.toUpperCase(), '', null, undefined, 42]) {
      expect(verifyWebhookSignature(V.webhookRaw, sig, V.webhookSecret)).toBe(false)
    }
  })

  it('accepts the current or the old secret during a rotation, nothing else', () => {
    const secrets = [V.rotationCurrent.secret, V.rotationOld.secret]
    expect(signWebhook(V.rotationRaw, V.rotationCurrent.secret)).toBe(V.rotationCurrent.signature)
    expect(signWebhook(V.rotationRaw, V.rotationOld.secret)).toBe(V.rotationOld.signature)
    expect(verifyWebhookSignature(V.rotationRaw, V.rotationCurrent.signature, secrets)).toBe(true)
    expect(verifyWebhookSignature(V.rotationRaw, V.rotationOld.signature, secrets)).toBe(true)
    // without the old secret configured, an old-secret signature fails
    expect(verifyWebhookSignature(V.rotationRaw, V.rotationOld.signature, [V.rotationCurrent.secret, '', undefined])).toBe(false)
    expect(verifyWebhookSignature(V.rotationRaw, signWebhook(V.rotationRaw, 'whsec_other'), secrets)).toBe(false)
  })

  it('throws when no webhook secret is configured', () => {
    expect(() => verifyWebhookSignature(V.rotationRaw, V.rotationCurrent.signature, [])).toThrow(/not configured/)
    expect(() => verifyWebhookSignature(V.rotationRaw, V.rotationCurrent.signature, ['', null])).toThrow(/not configured/)
    expect(() => signWebhook(V.rotationRaw, '')).toThrow(/not configured/)
  })
})

describe('helpers', () => {
  it('hexDigestEquals compares lowercase 64-hex digests only', () => {
    const d = V.webhookSignature
    expect(hexDigestEquals(d, d)).toBe(true)
    expect(hexDigestEquals(d, flipFirst(d))).toBe(false)
    expect(hexDigestEquals(d, d.toUpperCase())).toBe(false)
    expect(hexDigestEquals('nothex', d)).toBe(false)
  })

  it('id patterns follow Razorpay (prefix + ≥14 alphanumerics, bounded)', () => {
    expect(isRazorpayOrderId('order_DESlLckIVRkHWj')).toBe(true)
    expect(isRazorpayOrderId('order_MockK3J9Z20001')).toBe(true)
    expect(isRazorpayOrderId('order_DESlLckIVRkHW')).toBe(false)
    expect(isRazorpayOrderId('order_' + 'a'.repeat(41))).toBe(false)
    expect(isRazorpayOrderId('pay_DESlfW9H8K9uqM')).toBe(false)
    expect(isRazorpayPaymentId('pay_DESlfW9H8K9uqM')).toBe(true)
    expect(isRazorpayPaymentId('pay_DESlfW9H8K9uq/')).toBe(false)
    expect(isRazorpayRefundId('rfnd_FP8QHiV938haTz')).toBe(true)
    expect(isRazorpayRefundId(undefined)).toBe(false)
  })
})
