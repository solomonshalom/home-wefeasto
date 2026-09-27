import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migrations } from '@/migrations'

import { TEST_DATABASE_URI } from './env'
import { getTestPayload } from './helpers/payload'

/**
 * Production never pushes: its schema is exactly what src/migrations builds (README "Migrations"). The rest of
 * the int suite runs on a dev-pushed database for speed; this file applies the committed migrations to an EMPTY
 * scratch database next to it (<test db>_mig_test, e.g. wefeasto_mig_test) with the real `payload migrate`, and
 * checks the result against the pushed schema of this run. (owner: migrations; drift guard: npm run check:migrations)
 */
const CMS_DIR = path.resolve(__dirname, '../..')
const withDb = (name: string) => {
  const u = new URL(TEST_DATABASE_URI)
  u.pathname = `/${name}`
  return u.href
}
const TEST_DB = new URL(TEST_DATABASE_URI).pathname.slice(1)
const MIG_DB = TEST_DB.replace(/_test$/, '_mig_test')
const MIG_URI = withDb(MIG_DB)
const FIX_HINT = 'the config and src/migrations disagree: run `npm run migrate:create -- <name>` in cms/ and `npm run check:migrations`'

function payloadMigrate(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(CMS_DIR, 'node_modules/payload/bin.js'), 'migrate'],
      {
        cwd: CMS_DIR,
        env: { ...process.env, DATABASE_URI: MIG_URI, PAYLOAD_DB_PUSH: 'false', PAYLOAD_LOG_LEVEL: 'info', NODE_OPTIONS: '--no-deprecation' },
        timeout: 240_000,
      },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    )
  })
}

async function query<T = Record<string, unknown>>(uri: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: uri })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows as T[]
  } finally {
    await c.end()
  }
}

async function recreateMigDb(drop = false): Promise<void> {
  if (!/_mig_test$/.test(MIG_DB)) throw new Error(`refusing to touch ${MIG_DB}`)
  await query(withDb('postgres'), `DROP DATABASE IF EXISTS "${MIG_DB}" WITH (FORCE)`)
  if (!drop) await query(withDb('postgres'), `CREATE DATABASE "${MIG_DB}"`)
}

/** Columns, indexes and constraints of the public schema, one sorted line each (payload_migrations rows are data). */
async function schemaOf(uri: string): Promise<string[]> {
  const cols = await query<{ l: string }>(
    uri,
    `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || udt_name || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-') AS l
       FROM information_schema.columns WHERE table_schema = 'public'`,
  )
  const idx = await query<{ l: string }>(uri, `SELECT 'index ' || indexdef AS l FROM pg_indexes WHERE schemaname = 'public'`)
  const cons = await query<{ l: string }>(
    uri,
    `SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS l
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
  )
  const enums = await query<{ l: string }>(
    uri,
    `SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS l
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' GROUP BY t.typname`,
  )
  return [...cols, ...idx, ...cons, ...enums].map((r) => r.l).sort()
}

describe('migrations: src/migrations on an empty database (payload migrate)', () => {
  let first: { code: number; out: string }

  beforeAll(async () => {
    await getTestPayload() // the suite's dev-pushed schema, for the parity check
    await recreateMigDb()
    first = await payloadMigrate()
  })

  afterAll(async () => {
    await recreateMigDb(true)
  })

  it('the registry (index.ts, used by prodMigrations) lists exactly the files `payload migrate` reads', () => {
    const files = fs
      .readdirSync(path.join(CMS_DIR, 'src/migrations'))
      .filter((f) => /\.(ts|js)$/.test(f) && !/^index\.(ts|js)$/.test(f))
      .map((f) => f.replace(/\.(ts|js)$/, ''))
      .sort()
    expect(files.length).toBeGreaterThan(0)
    expect(migrations.map((m) => m.name).sort()).toEqual(files)
    for (const m of migrations) {
      expect(typeof m.up).toBe('function')
      expect(typeof m.down).toBe('function')
    }
  })

  it('applies every migration non-interactively and records them in payload_migrations (no dev marker)', async () => {
    expect(first.code, first.out).toBe(0)
    for (const m of migrations) expect(first.out).toContain(`Migrated:  ${m.name}`)
    const rows = await query<{ name: string; batch: string }>(MIG_URI, 'SELECT name, batch FROM payload_migrations ORDER BY name')
    expect(rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name).sort())
    expect(rows.every((r) => Number(r.batch) >= 1)).toBe(true) // batch -1 = dev push; prodMigrations would prompt
  })

  it('creates the key tables, columns and unique indexes', async () => {
    const cols = await query<{ t: string; c: string }>(
      MIG_URI,
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`,
    )
    const has = new Set(cols.map((r) => `${r.t}.${r.c}`))
    const expected: Record<string, string[]> = {
      products: ['slug', 'name', 'price_paise', 'stock', 'low_stock_threshold', 'max_per_order', 'cod_allowed', '_status'],
      _products_v: ['parent_id', 'version_slug', 'version_stock'],
      orders: ['number', 'status', 'payment_status', 'fulfilment_status', 'token_hash', 'idempotency_key', 'total_paise', 'stock_state', 'reserved_until', 'razorpay_payment_id', 'consent_marketing'],
      orders_items: ['_parent_id', 'unit_paise', 'line_total_paise'],
      customers: ['email', 'hash', 'salt', '_verified', 'login_attempts', 'lock_until', 'marketing_opt_in'],
      users: ['email', 'hash', 'login_attempts'],
      coupons: ['code', 'type', 'value', 'used_count', 'usage_limit', 'first_order_only'],
      coupon_redemptions: ['coupon_id', 'order_id', 'status'],
      payment_events: ['event_id', 'event', 'order_id', 'raw_sha256'],
      message_log: ['key', 'type', 'status', 'attempts'],
      subscribers: ['email', 'status', 'confirm_token_hash', 'unsubscribe_token_hash'],
      counters: ['name', 'value'],
      store_settings: ['free_delivery_threshold_paise', 'cod_enabled', 'reservation_minutes', 'cod_max_open_per_phone'],
      recipes: ['slug', '_status'],
      pages: ['slug', '_status'],
      media: ['filename', 'alt'],
      payload_jobs: ['task_slug', 'queue', 'wait_until', 'processing'],
      payload_migrations: ['name', 'batch'],
    }
    const missing = Object.entries(expected).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`)).filter((k) => !has.has(k))
    expect(missing, FIX_HINT).toEqual([])
    const unique = (await query<{ i: string }>(MIG_URI, `SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'`)).map((r) => r.i)
    for (const i of ['orders_number_idx', 'orders_idempotency_key_idx', 'orders_token_hash_idx', 'payment_events_event_id_idx', 'message_log_key_idx', 'coupons_code_idx', 'coupon_redemptions_order_idx', 'counters_name_idx', 'products_slug_idx', 'customers_email_idx', 'subscribers_email_idx']) {
      expect(unique, `unique index ${i}`).toContain(i)
    }
  })

  it('matches the dev-pushed schema of this run column for column, index for index', async () => {
    const [migrated, pushed] = await Promise.all([schemaOf(MIG_URI), schemaOf(TEST_DATABASE_URI)])
    const onlyPushed = pushed.filter((l) => !migrated.includes(l))
    const onlyMigrated = migrated.filter((l) => !pushed.includes(l))
    expect({ onlyPushed, onlyMigrated }, FIX_HINT).toEqual({ onlyPushed: [], onlyMigrated: [] })
  })

  it('`npm run seed` with the default env on the migrated database does not dev-push (no `dev` marker)', async () => {
    // Without the guard in payload.config.ts (noDevPushOnMigratedDb) this push leaves batch -1 behind and every
    // later `payload migrate` / production boot (prodMigrations) waits on an interactive prompt.
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URI: MIG_URI, PAYLOAD_LOG_LEVEL: 'warn', NODE_OPTIONS: '--no-deprecation' }
    delete env.PAYLOAD_DB_PUSH
    const res = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile(process.execPath, [path.join(CMS_DIR, 'node_modules/tsx/dist/cli.mjs'), 'src/seed/index.ts', '--stock=0'], { cwd: CMS_DIR, env, timeout: 240_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
      ),
    )
    expect(res.code, res.out).toBe(0)
    expect(res.out).toContain('dev schema push is skipped')
    const dev = await query(MIG_URI, 'SELECT name FROM payload_migrations WHERE batch = -1')
    expect(dev).toEqual([])
    expect((await query<{ n: string }>(MIG_URI, 'SELECT count(*)::text AS n FROM products'))[0].n).not.toBe('0')
  }, 240_000)

  it('a second `payload migrate` is a no-op', async () => {
    const again = await payloadMigrate()
    expect(again.code, again.out).toBe(0)
    expect(again.out).not.toContain('Migrating:')
    const rows = await query(MIG_URI, 'SELECT name FROM payload_migrations')
    expect(rows).toHaveLength(migrations.length)
  }, 240_000)
})
