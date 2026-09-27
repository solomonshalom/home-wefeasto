#!/usr/bin/env node
/*
 * Migration drift guard.  npm run check:migrations        (exit 0 = in sync, 1 = drift or failure)
 *
 * Production never pushes the schema: it only gets what src/migrations creates. This fails when the config
 * (collections, globals, fields, indexes) has changes that no committed migration covers:
 *   1. src/migrations/index.ts (the list prodMigrations applies) names exactly the migration files that
 *      `payload migrate` reads;
 *   2. creates a temporary database (wefeasto_mig_check_<id>_test) and applies them with `payload migrate`;
 *   3. boots Payload on it with push off (under tsx) and asks drizzle-kit
 *      a. what a dev push would still change on the migrated database (must be nothing), and
 *      b. what `payload migrate:create` would put in a new migration (latest .json snapshot vs the config;
 *         must be nothing), and checks payload_migrations records every migration;
 *   4. drops the temporary database (CHECK_MIGRATIONS_KEEP_DB=1 keeps it).
 * Env: CHECK_MIGRATIONS_PG_URI = any database on the Postgres server to use (default: the docker compose one).
 * Never reads cms/.env: every variable the config reads is set explicitly.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = path.join(CMS_DIR, 'src/migrations')
const MARK = '@@CHECK_MIGRATIONS@@'

/** Runs under tsx inside the temp DB env: boots Payload (no push) and reports what is not covered. */
async function probe() {
  const { getPayload } = await import('payload')
  const config = (await import(pathToFileURL(path.join(CMS_DIR, 'src/payload.config.ts')).href)).default
  const payload = await getPayload({ config })
  const db = payload.db
  const kit = db.requireDrizzleKit()
  const emit = (part) => new Promise((resolve) => process.stdout.write(`\n${MARK}${JSON.stringify(part)}\n`, resolve))
  const after = await kit.generateDrizzleJson(db.schema)
  const latest = fs.readdirSync(db.migrationDir).filter((f) => f.endsWith('.json')).sort().reverse()[0]
  let before = latest ? JSON.parse(fs.readFileSync(path.join(db.migrationDir, latest), 'utf8')) : db.defaultDrizzleSnapshot
  if (kit.upSnapshot && before.version < after.version) before = kit.upSnapshot(before)
  const snapshot = await kit.generateMigration(before, after)
  const applied = await db.execute({ drizzle: db.drizzle, raw: 'SELECT name, batch FROM payload_migrations ORDER BY name' })
  await emit({ snapshot, latestSnapshot: latest ?? null, applied: applied.rows })
  // The snapshot already shows drift: skip the push dry run (it would ask the same rename questions).
  if (snapshot.length) process.exit(0)
  const pushed = await kit.pushSchema(db.schema, db.drizzle, db.schemaName ? [db.schemaName] : undefined, db.tablesFilter, db.extensions?.postgis ? ['postgis'] : undefined)
  // drizzle-kit 0.31 re-emits `SET DEFAULT <n>` for every numeric column with a default (it compares the
  // introspected '5' with the configured 5), even right after a dev push. Drop those when the live default
  // already equals the literal; any other default change still counts.
  const cols = await db.execute({
    drizzle: db.drizzle,
    raw: `SELECT table_name, column_name, column_default FROM information_schema.columns WHERE table_schema = '${db.schemaName || 'public'}'`,
  })
  const liveDefault = new Map(cols.rows.map((c) => [`${c.table_name}.${c.column_name}`, c.column_default]))
  const norm = (v) => {
    const s = String(v ?? '').trim().replace(/::[\w ."[\]]+$/, '').replace(/^\((.*)\)$/, '$1').replace(/^'(.*)'$/, '$1')
    return s !== '' && Number.isFinite(Number(s)) ? String(Number(s)) : s
  }
  const ignored = []
  const push = pushed.statementsToExecute.filter((stmt) => {
    const m = /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET DEFAULT (.+?);?$/.exec(stmt.trim())
    if (m && liveDefault.has(`${m[1]}.${m[2]}`) && norm(liveDefault.get(`${m[1]}.${m[2]}`)) === norm(m[3])) {
      ignored.push(stmt)
      return false
    }
    return true
  })
  // emit() resolves once the (possibly large) report is flushed: stdout is an async pipe on macOS.
  await emit({ push, ignored: ignored.length, pushWarnings: pushed.warnings })
  process.exit(0)
}

function cmsEnv(dbUri) {
  const env = {
    ...process.env,
    DATABASE_URI: dbUri,
    DATABASE_POOL_MAX: '5',
    PAYLOAD_DB_PUSH: 'false',
    PAYLOAD_SECRET: 'check-migrations-secret-check-migrations-0123456789',
    PAYLOAD_PUBLIC_SERVER_URL: 'http://localhost:3000',
    STOREFRONT_URL: 'http://localhost:5173',
    STOREFRONT_ORIGINS: 'http://localhost:5173',
    PAYMENTS_MODE: 'mock',
    ...Object.fromEntries(
      ['ALLOW_MOCK_PAYMENTS', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_OLD', 'APP_ENV', 'VERCEL_ENV',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'VERCEL_DEPLOY_HOOK_URL', 'BLOB_READ_WRITE_TOKEN', 'MOCK_WEBHOOK_URL'].map((k) => [k, '']),
    ),
    CRON_SECRET: 'check-migrations-cron-secret',
    EMAIL_FROM: 'Wefeasto <check-migrations@wefeasto.test>',
    PAYLOAD_LOG_LEVEL: 'warn',
    NODE_OPTIONS: '--no-deprecation',
  }
  delete env.NODE_ENV // never production: no prodMigrations at boot, no production boot assertions
  return env
}

function run(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: CMS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let prompt = null
    const onData = (d) => {
      out += d
      // drizzle-kit / Payload ask on a TTY (rename or create? data loss?); with stdin closed they wait forever.
      const m = !prompt && /[^\n]*(created or renamed from another|Would you like to proceed|\(y\/N\))[^\n]*/.exec(out)
      if (m) {
        prompt = m[0].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      out += `\n[check-migrations] timed out after ${timeoutMs / 1000}s (an interactive prompt? stdin is closed)`
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out, prompt })
    })
  })
}

const indent = (text) => text.trim().split('\n').map((l) => `    ${l}`).join('\n')

async function main() {
  const problems = []
  let ignored = 0
  // 1. registry vs files
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /\.(ts|js)$/.test(f) && !/^index\.(ts|js)$/.test(f)).map((f) => f.replace(/\.(ts|js)$/, '')).sort()
  const indexText = fs.readFileSync(path.join(MIGRATIONS_DIR, 'index.ts'), 'utf8')
  const listed = [...indexText.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).sort()
  if (JSON.stringify(files) !== JSON.stringify(listed)) {
    problems.push(`src/migrations/index.ts lists [${listed.join(', ')}] but the directory has [${files.join(', ')}]: prodMigrations and \`payload migrate\` would apply different sets. Regenerate the index (npm run migrate:create rewrites it) or fix it by hand.`)
  }
  if (!files.length) problems.push('src/migrations has no migrations: production would start without a schema.')

  const { default: pg } = await import('pg')
  const adminUri = process.env.CHECK_MIGRATIONS_PG_URI || 'postgres://wefeasto:wefeasto@127.0.0.1:54329/postgres'
  const dbName = `wefeasto_mig_check_${process.pid}_${Date.now().toString(36)}_test`
  const dbUrl = new URL(adminUri)
  dbUrl.pathname = `/${dbName}`
  const admin = new pg.Client({ connectionString: adminUri, connectionTimeoutMillis: 10_000 })
  try {
    await admin.connect()
  } catch (err) {
    console.error(`check-migrations: cannot reach Postgres at ${new URL(adminUri).host} (${err.message}). Start it (docker compose up -d) or set CHECK_MIGRATIONS_PG_URI.`)
    return 1
  }
  const t0 = Date.now()
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`)
    console.log(`check-migrations: temp database ${dbName}; applying ${files.length} migration(s) with payload migrate …`)
    const env = cmsEnv(dbUrl.href)
    // 2. apply
    const mig = await run([path.join(CMS_DIR, 'node_modules/payload/bin.js'), 'migrate'], { ...env, PAYLOAD_LOG_LEVEL: 'info' }, 5 * 60_000)
    if (mig.code !== 0) {
      problems.push(`\`payload migrate\` failed on an empty database (exit ${mig.code}):\n${indent(mig.out)}`)
    } else {
      // 3. probe
      const pr = await run([path.join(CMS_DIR, 'node_modules/tsx/dist/cli.mjs'), fileURLToPath(import.meta.url), '--probe'], env, 5 * 60_000)
      const parts = pr.out.split('\n').filter((l) => l.startsWith(MARK)).map((l) => JSON.parse(l.slice(MARK.length)))
      if (pr.prompt) {
        problems.push(`drizzle-kit stopped at an interactive question, so the config changed in a way no migration covers (a renamed field or table asks this):\n    ${pr.prompt}\n  Run \`npm run migrate:create -- <name>\` in a terminal and answer it there (rename keeps the data).${parts[0]?.snapshot?.length ? `\n  New migration would contain:\n${indent(parts[0].snapshot.join('\n'))}` : ''}`)
      } else if (pr.code !== 0 || !parts.length) {
        problems.push(`could not inspect the migrated schema (exit ${pr.code}):\n${indent(pr.out)}`)
      } else {
        const r = Object.assign({ push: [], pushWarnings: [], ignored: 0 }, ...parts)
        ignored = r.ignored
        if (r.push.length) {
          problems.push(`the migrated database differs from the config: a dev push would still run ${r.push.length} statement(s):\n${indent(r.push.join('\n'))}${r.pushWarnings.length ? `\n  drizzle-kit warnings:\n${indent(r.pushWarnings.join('\n'))}` : ''}`)
        }
        if (r.snapshot.length) {
          problems.push(`\`payload migrate:create\` would generate a new migration (${r.latestSnapshot ?? 'no snapshot'} → config), ${r.snapshot.length} statement(s):\n${indent(r.snapshot.join('\n'))}`)
        }
        const appliedNames = r.applied.map((a) => a.name).sort()
        if (JSON.stringify(appliedNames) !== JSON.stringify(files)) problems.push(`payload_migrations records [${appliedNames.join(', ')}], expected [${files.join(', ')}]`)
      }
    }
  } finally {
    if (process.env.CHECK_MIGRATIONS_KEEP_DB === '1') console.log(`check-migrations: kept ${dbUrl.href}`)
    else await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch((err) => console.error(`check-migrations: could not drop ${dbName}: ${err.message}`))
    await admin.end().catch(() => {})
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (problems.length) {
    console.error(`\ncheck-migrations: FAIL (${secs}s) — src/migrations and the config are out of sync.\n`)
    for (const p of problems) console.error(`  - ${p}\n`)
    console.error('Fix: after changing collections/globals/fields, create a migration against the committed ones:\n  cd cms && npm run migrate:create -- <short_name>\nanswer its "created or renamed?" questions in a terminal (rename keeps the data), review the generated SQL, commit src/migrations/* (the .ts, the .json and index.ts), and run npm run check:migrations again. See README "Migrations".')
    return 1
  }
  console.log(`check-migrations: OK (${secs}s) — ${files.length} migration(s) [${files.join(', ')}] build exactly the configured schema (${ignored} no-op numeric SET DEFAULT statement(s) from drizzle-kit ignored).`)
  return 0
}

if (process.argv.includes('--probe')) await probe()
else process.exit(await main())
