/**
 * Environment for the integration project (tests/int). Never reads cms/.env: tests must not be able to
 * touch the dev database. Override the DB with TEST_DATABASE_URI (it must name a *_test database).
 */
export const TEST_DATABASE_URI =
  process.env.TEST_DATABASE_URI ?? 'postgres://wefeasto:wefeasto@127.0.0.1:54329/wefeasto_test'

export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54326'

export const intTestEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URI: TEST_DATABASE_URI,
  DATABASE_POOL_MAX: '20',
  PAYLOAD_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  PAYLOAD_PUBLIC_SERVER_URL: 'http://localhost:3000',
  STOREFRONT_URL: 'http://localhost:5173',
  STOREFRONT_ORIGINS: 'http://localhost:5173,http://localhost:4173',
  PAYMENTS_MODE: 'mock',
  CRON_SECRET: 'test-cron-secret-0123456789',
  SMTP_HOST: process.env.TEST_SMTP_HOST ?? '127.0.0.1',
  SMTP_PORT: process.env.TEST_SMTP_PORT ?? '54325',
  SMTP_USER: '',
  SMTP_PASS: '',
  EMAIL_FROM: 'Wefeasto Test <test@wefeasto.com>',
  RATE_LIMIT_DISABLED: '1',
  PAYLOAD_LOG_LEVEL: process.env.PAYLOAD_LOG_LEVEL ?? 'fatal',
  MAILPIT_URL,
  VERCEL_DEPLOY_HOOK_URL: '',
  BLOB_READ_WRITE_TOKEN: '',
}

/** Refuses anything that does not look like a disposable test database. */
export function assertTestDatabase(uri: string): void {
  const name = new URL(uri).pathname.replace(/^\//, '')
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to reset "${name}": integration tests only run against a *_test database.`)
  }
}
