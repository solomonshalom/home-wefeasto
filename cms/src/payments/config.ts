import { getEnv, type Env } from '../env'

/**
 * Payment settings derived from the environment (SPEC §2). In `mock` mode the Razorpay variables are
 * optional: when unset, the dev defaults below are used. They sign mock Checkout responses and mock
 * webhooks with REAL HMACs, so the verification code paths are exactly the ones production runs.
 *
 * The defaults are public on purpose (they are in the repo). They are safe because mock mode is refused
 * when NODE_ENV=production unless ALLOW_MOCK_PAYMENTS=1 (env.ts), and no real money flows through it.
 */
export const MOCK_DEFAULT_KEY_ID = 'rzp_test_WefeastoMock01'
export const MOCK_DEFAULT_KEY_SECRET = 'wefeasto-mock-key-secret-dev-only'
export const MOCK_DEFAULT_WEBHOOK_SECRET = 'wefeasto-mock-webhook-secret-dev-only'

export const RAZORPAY_CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js'
/** Relative: the storefront loads it through its same-origin /api proxy. */
export const MOCK_CHECKOUT_SCRIPT = '/api/payments/mock/checkout.js'
export const WEBHOOK_PATH = '/api/payments/razorpay/webhook'

/** Default delay before the mock delivers webhooks for a simulated payment (MOCK_WEBHOOK_DELAY_MS). */
export const DEFAULT_MOCK_WEBHOOK_DELAY_MS = 1500
/** Default delay before a mock 'late' payment gets authorised (MOCK_LATE_AUTH_DELAY_MS). */
export const DEFAULT_MOCK_LATE_AUTH_DELAY_MS = 10_000

export interface PaymentConfig {
  mode: 'mock' | 'razorpay'
  keyId: string
  keySecret: string
  /** Current secret first, then RAZORPAY_WEBHOOK_SECRET_OLD when set. */
  webhookSecrets: string[]
  /** Where webhooks are delivered: `${PAYLOAD_PUBLIC_SERVER_URL}/api/payments/razorpay/webhook`. */
  webhookUrl: string
  mockWebhookDelayMs: number
  mockLateAuthDelayMs: number
}

const intFrom = (raw: string | undefined, fallback: number, max = 3_600_000): number => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback
}

export function resolvePaymentConfig(env: Env = getEnv(), source: Record<string, string | undefined> = process.env): PaymentConfig {
  const mode = env.paymentsMode === 'razorpay' ? 'razorpay' : 'mock'
  const { keyId, keySecret, webhookSecret, webhookSecretOld } = env.razorpay
  const isMock = mode === 'mock'
  const secrets = [webhookSecret || (isMock ? MOCK_DEFAULT_WEBHOOK_SECRET : ''), webhookSecretOld].filter(Boolean)
  return {
    mode,
    keyId: keyId || (isMock ? MOCK_DEFAULT_KEY_ID : ''),
    keySecret: keySecret || (isMock ? MOCK_DEFAULT_KEY_SECRET : ''),
    webhookSecrets: secrets,
    webhookUrl: `${env.serverUrl}${WEBHOOK_PATH}`,
    mockWebhookDelayMs: intFrom(source.MOCK_WEBHOOK_DELAY_MS, DEFAULT_MOCK_WEBHOOK_DELAY_MS),
    mockLateAuthDelayMs: intFrom(source.MOCK_LATE_AUTH_DELAY_MS, DEFAULT_MOCK_LATE_AUTH_DELAY_MS),
  }
}
