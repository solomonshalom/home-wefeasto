/*
 * Hunt (payments-security, round 4) — the live shop boots in MOCK payments mode when ALLOW_MOCK_PAYMENTS=1.
 *
 * env.ts treats APP_ENV / VERCEL_ENV = 'production' as "real customers, real money" and refuses a Razorpay
 * TEST key there, even though NODE_ENV=production + rzp_test_ is otherwise fine. The far more dangerous
 * mode gets no such guard: with PAYMENTS_MODE=mock (also the DEFAULT when PAYMENTS_MODE is unset) and
 * ALLOW_MOCK_PAYMENTS=1, the production deployment boots, and then
 *   - POST /api/payments/mock/pay {razorpayOrderId, outcome:'success'} marks ANY order paid, publicly;
 *   - the mock key/webhook secrets are the repo-public defaults (payments/config.ts
 *     MOCK_DEFAULT_KEY_SECRET / MOCK_DEFAULT_WEBHOOK_SECRET), so anyone can also sign a "captured" webhook.
 * ALLOW_MOCK_PAYMENTS is meant for e2e / preview stacks (NODE_ENV=production, APP_ENV/VERCEL_ENV empty or
 * 'preview'); on Vercel it is easy to set it for "All Environments" so previews work, and one forgotten
 * PAYMENTS_MODE on the production environment then ships goods for free with no error at boot.
 *
 * Correct behaviour: like the test-key check, mock payments are refused whenever APP_ENV/VERCEL_ENV is
 * 'production', whatever ALLOW_MOCK_PAYMENTS says (e2e/preview keep working: their APP_ENV is '' / 'preview').
 */
import { describe, expect, it } from 'vitest'

import { readEnv, validateEnv } from '@/env'

const base = {
  DATABASE_URI: 'postgres://u:p@127.0.0.1:54329/wefeasto',
  PAYLOAD_SECRET: 'x'.repeat(40),
  NODE_ENV: 'production',
  PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.wefeasto.com',
  STOREFRONT_URL: 'https://wefeasto.com',
  CRON_SECRET: 'c'.repeat(32),
}
const errorsOf = (src: Record<string, string>) => validateEnv(readEnv(src)).errors

describe('mock payments on the live shop', () => {
  it.each([
    ['VERCEL_ENV=production, PAYMENTS_MODE=mock', { VERCEL_ENV: 'production', PAYMENTS_MODE: 'mock' }],
    ['VERCEL_ENV=production, PAYMENTS_MODE unset (defaults to mock)', { VERCEL_ENV: 'production' }],
    ['APP_ENV=production, PAYMENTS_MODE=mock', { APP_ENV: 'production', PAYMENTS_MODE: 'mock' }],
  ])('%s + ALLOW_MOCK_PAYMENTS=1 is refused at boot', (_label, extra) => {
    const env = { ...base, ALLOW_MOCK_PAYMENTS: '1', ...extra } as Record<string, string>
    expect(readEnv(env).paymentsMode).toBe('mock')
    expect(errorsOf(env)).toEqual(expect.arrayContaining([expect.stringMatching(/mock/i)]))
  })

  it('e2e / preview stacks (APP_ENV empty or preview) may still opt in', () => {
    expect(errorsOf({ ...base, PAYMENTS_MODE: 'mock', ALLOW_MOCK_PAYMENTS: '1' })).toEqual([])
    expect(errorsOf({ ...base, PAYMENTS_MODE: 'mock', ALLOW_MOCK_PAYMENTS: '1', VERCEL_ENV: 'preview' })).toEqual([])
  })
})
