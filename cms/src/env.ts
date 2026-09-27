/**
 * Typed environment reader + boot assertions (SPEC §2).
 *
 * `readEnv()` is pure (pass any record to test it) and never throws; `validateEnv()` lists problems;
 * `assertEnv()` throws one EnvError listing every problem. `payload.config.ts` calls `assertEnv()` at import
 * time, so a misconfigured server refuses to boot instead of taking real orders with the wrong keys.
 *
 * During `next build` (NEXT_PHASE=phase-production-build) errors are downgraded to warnings: the build
 * machine does not always carry runtime secrets, and the same checks run again when the server boots.
 */

export type PaymentsMode = 'mock' | 'razorpay'

export type SmtpConfig = {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

export type Env = {
  nodeEnv: string
  isProduction: boolean
  /** APP_ENV, else VERCEL_ENV, else '' (unknown). 'production' means "real customers, real money". */
  appEnv: string
  isBuildPhase: boolean
  databaseUri: string
  databasePoolMax: number
  payloadSecret: string
  /** PAYLOAD_PUBLIC_SERVER_URL without a trailing slash. */
  serverUrl: string
  /** STOREFRONT_URL without a trailing slash; email links point here. */
  storefrontUrl: string
  /** Normalised origins from STOREFRONT_ORIGINS (falls back to the STOREFRONT_URL origin). */
  storefrontOrigins: string[]
  paymentsMode: PaymentsMode | string
  allowMockPayments: boolean
  razorpay: {
    keyId: string
    keySecret: string
    webhookSecret: string
    webhookSecretOld: string
  }
  cronSecret: string
  /** null when SMTP_HOST is empty: email then goes to the console adapter. */
  smtp: SmtpConfig | null
  emailFrom: { name: string; address: string }
  vercelDeployHookUrl: string
  blobReadWriteToken: string
  rateLimitDisabled: boolean
}

export class EnvError extends Error {
  problems: string[]
  constructor(problems: string[]) {
    super(`Invalid Wefeasto CMS environment:\n  - ${problems.join('\n  - ')}`)
    this.name = 'EnvError'
    this.problems = problems
  }
}

type Source = Record<string, string | undefined>

const str = (src: Source, key: string, fallback = ''): string => {
  const v = src[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

const flag = (src: Source, key: string): boolean => /^(1|true|yes|on)$/i.test(str(src, key))

const stripSlash = (url: string) => url.replace(/\/+$/, '')

/** Returns the URL origin, or '' when the value is not an absolute http(s) URL. */
export function toOrigin(value: string): string {
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.origin
  } catch {
    return ''
  }
}

/** Parses `Name <address>` or a bare `address`. */
export function parseEmailFrom(value: string): { name: string; address: string } {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>\s]+)\s*>\s*$/)
  if (m) return { name: m[1].trim() || 'Wefeasto', address: m[2].trim() }
  return { name: 'Wefeasto', address: value.trim() }
}

export function readEnv(source: Source = process.env): Env {
  const nodeEnv = str(source, 'NODE_ENV', 'development')
  const isProduction = nodeEnv === 'production'
  const storefrontUrl = stripSlash(str(source, 'STOREFRONT_URL', 'http://localhost:5173'))
  const rawOrigins = str(source, 'STOREFRONT_ORIGINS')
  const originList = (rawOrigins ? rawOrigins.split(',') : [storefrontUrl])
    .map((o) => o.trim())
    .filter(Boolean)
  const smtpHost = str(source, 'SMTP_HOST')
  const smtpPort = Number.parseInt(str(source, 'SMTP_PORT', '587'), 10) || 587
  const poolMax = Number.parseInt(str(source, 'DATABASE_POOL_MAX', '10'), 10)

  return {
    nodeEnv,
    isProduction,
    appEnv: str(source, 'APP_ENV') || str(source, 'VERCEL_ENV'),
    isBuildPhase: str(source, 'NEXT_PHASE') === 'phase-production-build',
    databaseUri: str(source, 'DATABASE_URI'),
    databasePoolMax: Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10,
    payloadSecret: str(source, 'PAYLOAD_SECRET'),
    serverUrl: stripSlash(str(source, 'PAYLOAD_PUBLIC_SERVER_URL', 'http://localhost:3000')),
    storefrontUrl,
    // Keep invalid entries (as '') so validateEnv can report them.
    storefrontOrigins: originList.map((o) => toOrigin(o) || `invalid:${o}`),
    paymentsMode: str(source, 'PAYMENTS_MODE', 'mock').toLowerCase(),
    allowMockPayments: flag(source, 'ALLOW_MOCK_PAYMENTS'),
    razorpay: {
      keyId: str(source, 'RAZORPAY_KEY_ID'),
      keySecret: str(source, 'RAZORPAY_KEY_SECRET'),
      webhookSecret: str(source, 'RAZORPAY_WEBHOOK_SECRET'),
      webhookSecretOld: str(source, 'RAZORPAY_WEBHOOK_SECRET_OLD'),
    },
    cronSecret: str(source, 'CRON_SECRET'),
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: smtpPort,
          secure: flag(source, 'SMTP_SECURE') || smtpPort === 465,
          user: str(source, 'SMTP_USER'),
          pass: str(source, 'SMTP_PASS'),
        }
      : null,
    emailFrom: parseEmailFrom(str(source, 'EMAIL_FROM', 'Wefeasto <hello@wefeasto.com>')),
    vercelDeployHookUrl: str(source, 'VERCEL_DEPLOY_HOOK_URL'),
    blobReadWriteToken: str(source, 'BLOB_READ_WRITE_TOKEN'),
    rateLimitDisabled: flag(source, 'RATE_LIMIT_DISABLED'),
  }
}

/** Reads process.env fresh on every call (tests mutate it). Cheap: a few string ops. */
export function getEnv(): Env {
  return readEnv(process.env)
}

export function validateEnv(env: Env): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  if (!env.payloadSecret) errors.push('PAYLOAD_SECRET is required.')
  else if (env.isProduction && env.payloadSecret.length < 32)
    errors.push('PAYLOAD_SECRET must be at least 32 characters in production.')

  if (!env.databaseUri) errors.push('DATABASE_URI is required (postgres://…).')
  else if (!/^postgres(ql)?:\/\//.test(env.databaseUri))
    errors.push('DATABASE_URI must be a postgres:// connection string.')

  if (!toOrigin(env.serverUrl)) errors.push('PAYLOAD_PUBLIC_SERVER_URL must be an absolute http(s) URL.')
  if (!toOrigin(env.storefrontUrl)) errors.push('STOREFRONT_URL must be an absolute http(s) URL.')
  for (const o of env.storefrontOrigins) {
    if (o.startsWith('invalid:')) errors.push(`STOREFRONT_ORIGINS has an invalid origin: "${o.slice(8)}".`)
  }

  if (env.paymentsMode !== 'mock' && env.paymentsMode !== 'razorpay') {
    errors.push(`PAYMENTS_MODE must be "mock" or "razorpay" (got "${env.paymentsMode}").`)
  }

  if (env.paymentsMode === 'mock' && env.isProduction && !env.allowMockPayments) {
    errors.push('PAYMENTS_MODE=mock is refused when NODE_ENV=production (set ALLOW_MOCK_PAYMENTS=1 for e2e only).')
  }

  // The live shop (real customers, real money) never runs the mock gateway: its public mark-paid endpoint
  // and repo-public secrets would ship goods for free. ALLOW_MOCK_PAYMENTS only opens e2e / preview stacks
  // (APP_ENV/VERCEL_ENV empty or 'preview'). PAYMENTS_MODE defaults to mock, so an unset one lands here too.
  if (env.paymentsMode === 'mock' && env.appEnv.toLowerCase() === 'production') {
    errors.push(
      'PAYMENTS_MODE=mock is refused when APP_ENV/VERCEL_ENV is "production" (ALLOW_MOCK_PAYMENTS only applies to ' +
        'e2e/preview). Set PAYMENTS_MODE=razorpay with live keys.',
    )
  }

  if (env.paymentsMode === 'razorpay') {
    const { keyId, keySecret, webhookSecret } = env.razorpay
    if (!keyId) errors.push('RAZORPAY_KEY_ID is required when PAYMENTS_MODE=razorpay.')
    if (!keySecret) errors.push('RAZORPAY_KEY_SECRET is required when PAYMENTS_MODE=razorpay.')
    if (!webhookSecret) errors.push('RAZORPAY_WEBHOOK_SECRET is required when PAYMENTS_MODE=razorpay.')
    if (keyId) {
      const isLive = keyId.startsWith('rzp_live_')
      const isTest = keyId.startsWith('rzp_test_')
      if (!isLive && !isTest) errors.push('RAZORPAY_KEY_ID must start with rzp_test_ or rzp_live_.')
      if (isLive && !env.isProduction)
        errors.push('A live Razorpay key (rzp_live_) is refused unless NODE_ENV=production.')
      if (isTest && env.appEnv === 'production')
        errors.push('APP_ENV/VERCEL_ENV is "production" but RAZORPAY_KEY_ID is a test key (rzp_test_).')
    }
  }

  if (env.isProduction) {
    if (!env.cronSecret) warnings.push('CRON_SECRET is empty: /api/payload-jobs/run only works for signed-in admins.')
    else if (env.cronSecret.length < 16) warnings.push('CRON_SECRET is shorter than 16 characters.')
    if (!env.smtp) warnings.push('SMTP_HOST is empty: emails are only written to the server log.')
    if (!env.serverUrl.startsWith('https://')) warnings.push('PAYLOAD_PUBLIC_SERVER_URL is not https.')
    if (!env.storefrontUrl.startsWith('https://')) warnings.push('STOREFRONT_URL is not https.')
  }

  return { errors, warnings }
}

/**
 * Throws EnvError when the environment is unusable. In the `next build` phase errors are returned as warnings.
 * Returns the warnings so the caller can log them.
 */
export function assertEnv(env: Env = getEnv()): string[] {
  const { errors, warnings } = validateEnv(env)
  if (errors.length && env.isBuildPhase) return [...errors.map((e) => `[build] ${e}`), ...warnings]
  if (errors.length) throw new EnvError(errors)
  return warnings
}

/** Unique list of origins allowed for CORS + CSRF: every storefront origin plus the CMS itself. */
export function allowedOrigins(env: Env = getEnv()): string[] {
  const list = [...env.storefrontOrigins.filter((o) => !o.startsWith('invalid:')), toOrigin(env.serverUrl)]
  return [...new Set(list.filter(Boolean))]
}
