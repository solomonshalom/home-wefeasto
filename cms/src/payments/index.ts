import crypto from 'node:crypto'

import { getEnv, type Env } from '../env'
import { resolvePaymentConfig } from './config'
import { MockGateway } from './mock'
import { RazorpayGateway } from './razorpay'
import type { PaymentGateway } from './types'

/**
 * The process-wide payment gateway (SPEC §0): PAYMENTS_MODE=mock → MockGateway (shared in-memory state),
 * PAYMENTS_MODE=razorpay → RazorpayGateway (razorpay@2.9.8). Always call getGateway() at use time, never
 * cache it in module scope: tests swap it with setGatewayForTests(), and a change of PAYMENTS_MODE or of
 * the Razorpay keys (tests set process.env) builds a fresh gateway on the next call.
 *
 * Kept on globalThis so every module instance (Next dev HMR, route bundles) sees the same gateway.
 */

type Slot = { gateway?: PaymentGateway; fingerprint?: string; override?: PaymentGateway }

const SLOT_KEY = Symbol.for('wefeasto.paymentGateway')

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>
  let s = g[SLOT_KEY]
  if (!s) {
    s = {}
    g[SLOT_KEY] = s
  }
  return s
}

function fingerprint(env: Env): string {
  const cfg = resolvePaymentConfig(env)
  const secrets = crypto.createHash('sha256').update([cfg.keySecret, ...cfg.webhookSecrets].join('\n')).digest('hex')
  return [cfg.mode, cfg.keyId, secrets, cfg.webhookUrl, cfg.mockWebhookDelayMs].join('|')
}

/** Builds a gateway for `env` (no caching). Throws for an unknown PAYMENTS_MODE or missing razorpay keys. */
export function createGateway(env: Env = getEnv()): PaymentGateway {
  if (env.paymentsMode !== 'mock' && env.paymentsMode !== 'razorpay') {
    throw new Error(`PAYMENTS_MODE must be "mock" or "razorpay" (got "${env.paymentsMode}")`)
  }
  const cfg = resolvePaymentConfig(env)
  if (cfg.mode === 'razorpay') {
    return new RazorpayGateway({
      keyId: cfg.keyId,
      keySecret: cfg.keySecret,
      webhookSecret: cfg.webhookSecrets[0] ?? '',
      webhookSecretOld: cfg.webhookSecrets[1],
    })
  }
  return new MockGateway({
    keyId: cfg.keyId,
    keySecret: cfg.keySecret,
    webhookSecrets: cfg.webhookSecrets,
    webhookUrl: cfg.webhookUrl,
    shared: true,
    autoWebhooks: true,
    webhookDelayMs: cfg.mockWebhookDelayMs,
  })
}

/** The gateway for the current environment (or the test override). */
export function getGateway(): PaymentGateway {
  const s = slot()
  if (s.override) return s.override
  const env = getEnv()
  const fp = fingerprint(env)
  if (!s.gateway || s.fingerprint !== fp) {
    s.gateway = createGateway(env)
    s.fingerprint = fp
  }
  return s.gateway
}

/** The MockGateway when payments run in mock mode (PAYMENTS_MODE=mock and the gateway is a mock), else null. */
export function getMockGateway(): MockGateway | null {
  if (getEnv().paymentsMode !== 'mock') return null
  const g = getGateway()
  return g instanceof MockGateway ? g : null
}

/** Tests: make getGateway() return `gateway` until resetGateway(). */
export function setGatewayForTests(gateway: PaymentGateway): void {
  slot().override = gateway
}

/** Tests: drop the override and the cached gateway (the mock's shared state is kept: use mock.reset()). */
export function resetGateway(): void {
  const s = slot()
  s.override = undefined
  s.gateway = undefined
  s.fingerprint = undefined
}

export { MockGateway } from './mock'
export { RazorpayGateway } from './razorpay'
export * from './types'
export {
  isRazorpayOrderId,
  isRazorpayPaymentId,
  isRazorpayRefundId,
  signPayment,
  signWebhook,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from './signatures'
export { buildWebhookBody, parseWebhookBody, serializeWebhookBody, type ParsedWebhook } from './webhookPayload'
export { resolvePaymentConfig, MOCK_DEFAULT_KEY_ID, MOCK_DEFAULT_KEY_SECRET, MOCK_DEFAULT_WEBHOOK_SECRET } from './config'
