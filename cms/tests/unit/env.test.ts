import { describe, expect, it } from 'vitest'

import { allowedOrigins, assertEnv, EnvError, parseEmailFrom, readEnv, toOrigin, validateEnv } from '@/env'

const base = {
  DATABASE_URI: 'postgres://u:p@127.0.0.1:54329/wefeasto',
  PAYLOAD_SECRET: 'x'.repeat(40),
}
const errorsOf = (src: Record<string, string>) => validateEnv(readEnv(src)).errors
const warningsOf = (src: Record<string, string>) => validateEnv(readEnv(src)).warnings

describe('readEnv', () => {
  it('applies local defaults', () => {
    const env = readEnv(base)
    expect(env.nodeEnv).toBe('development')
    expect(env.isProduction).toBe(false)
    expect(env.serverUrl).toBe('http://localhost:3000')
    expect(env.storefrontUrl).toBe('http://localhost:5173')
    expect(env.storefrontOrigins).toEqual(['http://localhost:5173'])
    expect(env.paymentsMode).toBe('mock')
    expect(env.smtp).toBeNull()
    expect(env.emailFrom).toEqual({ name: 'Wefeasto', address: 'hello@wefeasto.com' })
    expect(env.databasePoolMax).toBe(10)
    expect(env.rateLimitDisabled).toBe(false)
  })

  it('normalises URLs, origins, SMTP and flags', () => {
    const env = readEnv({
      ...base,
      PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.wefeasto.com/',
      STOREFRONT_URL: 'https://wefeasto.com//',
      STOREFRONT_ORIGINS: ' https://wefeasto.com/ , https://www.wefeasto.com/shop ,,',
      SMTP_HOST: 'smtp.resend.com',
      SMTP_PORT: '465',
      SMTP_USER: 'resend',
      SMTP_PASS: 'secret',
      EMAIL_FROM: '"Wefeasto Orders" <orders@wefeasto.com>',
      PAYMENTS_MODE: ' RAZORPAY ',
      ALLOW_MOCK_PAYMENTS: 'true',
      RATE_LIMIT_DISABLED: '1',
      DATABASE_POOL_MAX: '3',
    })
    expect(env.serverUrl).toBe('https://cms.wefeasto.com')
    expect(env.storefrontUrl).toBe('https://wefeasto.com')
    expect(env.storefrontOrigins).toEqual(['https://wefeasto.com', 'https://www.wefeasto.com'])
    expect(env.smtp).toEqual({ host: 'smtp.resend.com', port: 465, secure: true, user: 'resend', pass: 'secret' })
    expect(env.emailFrom).toEqual({ name: 'Wefeasto Orders', address: 'orders@wefeasto.com' })
    expect(env.paymentsMode).toBe('razorpay')
    expect(env.allowMockPayments).toBe(true)
    expect(env.rateLimitDisabled).toBe(true)
    expect(env.databasePoolMax).toBe(3)
  })

  it('treats blank values as unset and bad numbers as defaults', () => {
    const env = readEnv({ ...base, SMTP_HOST: '   ', SMTP_PORT: 'abc', DATABASE_POOL_MAX: '-1', PAYMENTS_MODE: '' })
    expect(env.smtp).toBeNull()
    expect(env.databasePoolMax).toBe(10)
    expect(env.paymentsMode).toBe('mock')
    expect(readEnv({ ...base, SMTP_HOST: 'h', SMTP_PORT: 'abc' }).smtp?.port).toBe(587)
  })

  it('reads APP_ENV, falling back to VERCEL_ENV', () => {
    expect(readEnv({ ...base, VERCEL_ENV: 'preview' }).appEnv).toBe('preview')
    expect(readEnv({ ...base, VERCEL_ENV: 'preview', APP_ENV: 'production' }).appEnv).toBe('production')
    expect(readEnv({ ...base, NEXT_PHASE: 'phase-production-build' }).isBuildPhase).toBe(true)
  })
})

describe('validateEnv', () => {
  it('accepts the dev defaults', () => {
    expect(errorsOf(base)).toEqual([])
  })

  it('requires PAYLOAD_SECRET and DATABASE_URI', () => {
    expect(errorsOf({})).toEqual(
      expect.arrayContaining([expect.stringMatching(/PAYLOAD_SECRET/), expect.stringMatching(/DATABASE_URI/)]),
    )
    expect(errorsOf({ ...base, DATABASE_URI: 'mysql://x' })).toEqual([expect.stringMatching(/postgres/)])
  })

  it('requires a 32+ character PAYLOAD_SECRET in production only', () => {
    const prod = { ...base, NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: '1' }
    expect(errorsOf({ ...prod, PAYLOAD_SECRET: 'x'.repeat(31) })).toEqual([expect.stringMatching(/at least 32/)])
    expect(errorsOf({ ...prod, PAYLOAD_SECRET: 'x'.repeat(32) })).toEqual([])
    expect(errorsOf({ ...base, PAYLOAD_SECRET: 'short' })).toEqual([])
  })

  it('refuses mock payments in production unless ALLOW_MOCK_PAYMENTS=1', () => {
    const prod = { ...base, NODE_ENV: 'production' }
    expect(errorsOf(prod)).toEqual([expect.stringMatching(/PAYMENTS_MODE=mock is refused/)])
    expect(errorsOf({ ...prod, PAYMENTS_MODE: 'mock', ALLOW_MOCK_PAYMENTS: '1' })).toEqual([])
    expect(errorsOf({ ...prod, PAYMENTS_MODE: 'mock', ALLOW_MOCK_PAYMENTS: '0' })).toHaveLength(1)
  })

  it('refuses mock payments on the live shop (APP_ENV/VERCEL_ENV=production) whatever ALLOW_MOCK_PAYMENTS says', () => {
    const live = { ...base, NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: '1' }
    const liveMock = /APP_ENV\/VERCEL_ENV is "production"/
    expect(errorsOf({ ...live, APP_ENV: 'production' })).toEqual([expect.stringMatching(liveMock)])
    expect(errorsOf({ ...live, VERCEL_ENV: 'production', PAYMENTS_MODE: 'MOCK' })).toEqual([expect.stringMatching(liveMock)])
    // Without the opt-in both refusals are reported.
    expect(errorsOf({ ...base, NODE_ENV: 'production', APP_ENV: 'production' })).toHaveLength(2)
    // APP_ENV wins over VERCEL_ENV: an explicit non-production APP_ENV (e.g. staging) may opt in.
    expect(errorsOf({ ...live, APP_ENV: 'staging', VERCEL_ENV: 'production' })).toEqual([])
    expect(errorsOf({ ...live, VERCEL_ENV: 'preview' })).toEqual([])
    // Real payments on the live shop are unaffected.
    expect(
      errorsOf({
        ...live,
        APP_ENV: 'production',
        PAYMENTS_MODE: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_live_abc',
        RAZORPAY_KEY_SECRET: 'ks',
        RAZORPAY_WEBHOOK_SECRET: 'ws',
      }),
    ).toEqual([])
  })

  it('rejects unknown payment modes', () => {
    expect(errorsOf({ ...base, PAYMENTS_MODE: 'stripe' })).toEqual([expect.stringMatching(/"mock" or "razorpay"/)])
  })

  it('requires all three Razorpay secrets in razorpay mode', () => {
    const errs = errorsOf({ ...base, PAYMENTS_MODE: 'razorpay' })
    expect(errs).toHaveLength(3)
    expect(errs.join(' ')).toMatch(/RAZORPAY_KEY_ID.*RAZORPAY_KEY_SECRET.*RAZORPAY_WEBHOOK_SECRET/)
  })

  const rzp = (keyId: string, extra: Record<string, string> = {}) => ({
    ...base,
    PAYMENTS_MODE: 'razorpay',
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: 'ks',
    RAZORPAY_WEBHOOK_SECRET: 'ws',
    ...extra,
  })

  it('checks the key prefix against the environment', () => {
    expect(errorsOf(rzp('rzp_test_abc'))).toEqual([])
    expect(errorsOf(rzp('key_abc'))).toEqual([expect.stringMatching(/must start with rzp_test_ or rzp_live_/)])
    expect(errorsOf(rzp('rzp_live_abc'))).toEqual([expect.stringMatching(/live Razorpay key .* refused/)])
    expect(errorsOf(rzp('rzp_live_abc', { NODE_ENV: 'production' }))).toEqual([])
    expect(errorsOf(rzp('rzp_test_abc', { NODE_ENV: 'production' }))).toEqual([]) // e.g. staging with next start
    expect(errorsOf(rzp('rzp_test_abc', { NODE_ENV: 'production', APP_ENV: 'production' }))).toEqual([
      expect.stringMatching(/test key/),
    ])
    expect(errorsOf(rzp('rzp_test_abc', { NODE_ENV: 'production', VERCEL_ENV: 'production' }))).toHaveLength(1)
    expect(errorsOf(rzp('rzp_test_abc', { NODE_ENV: 'production', VERCEL_ENV: 'preview' }))).toEqual([])
  })

  it('flags invalid URLs and origins', () => {
    expect(errorsOf({ ...base, STOREFRONT_ORIGINS: 'http://ok.dev,not a url' })).toEqual([
      expect.stringMatching(/invalid origin: "not a url"/),
    ])
    // STOREFRONT_ORIGINS falls back to STOREFRONT_URL, so both are reported.
    expect(errorsOf({ ...base, STOREFRONT_URL: 'ftp://x' })).toEqual([
      expect.stringMatching(/STOREFRONT_URL must be/),
      expect.stringMatching(/invalid origin: "ftp:\/\/x"/),
    ])
    expect(errorsOf({ ...base, PAYLOAD_PUBLIC_SERVER_URL: '/relative' })).toEqual([expect.stringMatching(/PAYLOAD_PUBLIC_SERVER_URL/)])
  })

  it('warns (not errors) about weak production settings', () => {
    const w = warningsOf({ ...base, NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: '1' })
    expect(w.join('\n')).toMatch(/CRON_SECRET is empty/)
    expect(w.join('\n')).toMatch(/SMTP_HOST is empty/)
    expect(w.join('\n')).toMatch(/not https/)
    expect(warningsOf({ ...base, NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: '1', CRON_SECRET: 'short' }).join()).toMatch(
      /shorter than 16/,
    )
    expect(warningsOf(base)).toEqual([])
  })
})

describe('assertEnv', () => {
  it('throws one EnvError listing every problem', () => {
    try {
      assertEnv(readEnv({ NODE_ENV: 'production' }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError)
      expect((err as EnvError).problems.length).toBeGreaterThanOrEqual(3)
      expect((err as Error).message).toMatch(/PAYLOAD_SECRET[\s\S]*DATABASE_URI[\s\S]*mock/)
    }
  })

  it('downgrades errors to warnings during `next build`', () => {
    const warnings = assertEnv(readEnv({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }))
    expect(warnings.some((w) => w.startsWith('[build]'))).toBe(true)
  })

  it('returns warnings when valid', () => {
    expect(assertEnv(readEnv(base))).toEqual([])
  })
})

describe('helpers', () => {
  it('toOrigin', () => {
    expect(toOrigin('https://a.b/c?d')).toBe('https://a.b')
    expect(toOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
    expect(toOrigin('javascript:alert(1)')).toBe('')
    expect(toOrigin('nope')).toBe('')
  })

  it('parseEmailFrom', () => {
    expect(parseEmailFrom('Wefeasto <hello@wefeasto.com>')).toEqual({ name: 'Wefeasto', address: 'hello@wefeasto.com' })
    expect(parseEmailFrom('"Wefeasto Team"<team@x.com>')).toEqual({ name: 'Wefeasto Team', address: 'team@x.com' })
    expect(parseEmailFrom('solo@x.com')).toEqual({ name: 'Wefeasto', address: 'solo@x.com' })
    expect(parseEmailFrom('<only@x.com>')).toEqual({ name: 'Wefeasto', address: 'only@x.com' })
  })

  it('allowedOrigins = storefront origins + the CMS, de-duplicated, invalid ones dropped', () => {
    const env = readEnv({
      ...base,
      STOREFRONT_ORIGINS: 'http://localhost:5173,http://localhost:3000,bad',
      PAYLOAD_PUBLIC_SERVER_URL: 'http://localhost:3000',
    })
    expect(allowedOrigins(env)).toEqual(['http://localhost:5173', 'http://localhost:3000'])
  })
})
