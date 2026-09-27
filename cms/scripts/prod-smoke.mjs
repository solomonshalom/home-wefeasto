#!/usr/bin/env node
/*
 * Production-build smoke guard (cms-hardening §4).  npm run test:prod-smoke [-- --rebuild]
 *
 * Bugs that only exist in the minified `next build` output have happened (Wave 2: `err.name` checks broke
 * because production renames classes). This script runs the error-mapping and unique-violation paths
 * against a REAL production server, over HTTP:
 *
 *   1. (re)uses a production build in cms/.next-prod-smoke (PROD_SMOKE_DIST_DIR; rebuilt when src/, config or
 *      the lockfile change; cms/tsconfig*.json and cms/next-env.d.ts are restored byte-for-byte if Next
 *      rewrites them);
 *   2. resets + seeds a disposable *_test database (PROD_SMOKE_DATABASE_URI, default wefeasto_prodsmoke_test,
 *      created when missing);
 *   3. `next start` (NODE_ENV=production, PAYMENTS_MODE=mock, ALLOW_MOCK_PAYMENTS=1, rate limits ON) on a
 *      free port, with mock webhooks captured by a local sink so they can be redelivered;
 *   4. HTTP probes (see PROBES below) + a grep of the server log for 'INTERNAL' / 'Unhandled';
 *   5. prints a table, stops everything it started, exits 1 on any failure.
 *
 * Needs the docker compose Postgres (127.0.0.1:54329) and Mailpit (SMTP 54325, API 54326).
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const CMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// PROD_SMOKE_DIST_DIR: parallel runs from one checkout need their own build dir (must start with .next-).
const DIST_DIR = process.env.PROD_SMOKE_DIST_DIR || '.next-prod-smoke'
if (!/^\.next-[\w-]+$/.test(DIST_DIR)) throw new Error(`PROD_SMOKE_DIST_DIR must look like .next-<name>, got ${JSON.stringify(DIST_DIR)}`)
const DIST_PATH = path.join(CMS_DIR, DIST_DIR)
const STAMP_FILE = path.join(DIST_PATH, 'wf-prod-smoke.json')
const DB_URI = process.env.PROD_SMOKE_DATABASE_URI || 'postgres://wefeasto:wefeasto@127.0.0.1:54329/wefeasto_prodsmoke_test'
const PORT_PREFERRED = Number(process.env.PROD_SMOKE_PORT || 3600)
const MAILPIT = (process.env.MAILPIT_URL || 'http://127.0.0.1:54326').replace(/\/+$/, '')
const STOREFRONT = 'http://localhost:5173'
const ADMIN = { email: 'prod-smoke-admin@test.wefeasto.dev', password: 'Prod-smoke-admin-0123' }
/** The server's PAYLOAD_SECRET (probes derive newsletter unsubscribe tokens from it). */
const SMOKE_SECRET = 'prod-smoke-secret-prod-smoke-secret-0123456789'
const CRON_SECRET = 'prod-smoke-cron-secret-0123456789abcdef'
const ARGS = new Set(process.argv.slice(2))

const started = Date.now()
const say = (msg) => console.log(`[prod-smoke +${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`)

/* ------------------------------------------------------------------ small utilities */

function run(name, cmd, args, { env, logFile, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const out = fs.openSync(logFile, 'a')
    const child = spawn(cmd, args, { cwd: CMS_DIR, env, stdio: ['ignore', out, out] })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${name}: timed out after ${timeoutMs / 1000}s (log: ${logFile})`))
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      fs.closeSync(out)
      if (code === 0) resolve()
      else reject(new Error(`${name}: exit ${code} (log: ${logFile})\n${tail(logFile, 40)}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function tail(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function freePort(preferred) {
  if (preferred && (await portFree(preferred))) return preferred
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function listFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

/** Hash of everything that shapes the build: src/**, config files, lockfile, the build-time env. */
function buildHash(envSignature) {
  const h = crypto.createHash('sha256')
  const files = [
    ...listFiles(path.join(CMS_DIR, 'src')),
    ...['next.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'].map((f) => path.join(CMS_DIR, f)),
  ].sort()
  for (const f of files) {
    h.update(path.relative(CMS_DIR, f))
    h.update(fs.readFileSync(f))
  }
  h.update(envSignature)
  h.update(process.version)
  return h.digest('hex')
}

/**
 * Next rewrites next-env.d.ts for a custom distDir (and the tsconfig it type-checks, unless that one `extends`
 * another, as tsconfig.build.json does): put them back byte-for-byte.
 */
function guardNextFiles() {
  const files = ['tsconfig.json', 'tsconfig.build.json', 'next-env.d.ts'].map((f) => path.join(CMS_DIR, f))
  const originals = new Map(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]))
  return () => {
    const notes = []
    for (const [file, orig] of originals) {
      const now = fs.existsSync(file) ? fs.readFileSync(file) : null
      if (orig && (!now || !now.equals(orig))) {
        fs.writeFileSync(file, orig)
        notes.push(`restored ${path.basename(file)}`)
      } else if (!orig && now) {
        fs.rmSync(file)
        notes.push(`removed ${path.basename(file)}`)
      }
    }
    return notes
  }
}

function assertDisposable(uri) {
  const name = new URL(uri).pathname.slice(1)
  if (!/_test$/.test(name)) throw new Error(`Refusing to reset "${name}": the prod smoke only uses a *_test database.`)
  return name
}

/** Creates the database when missing, then drops + recreates its public schema. */
async function resetDatabase(uri) {
  const name = assertDisposable(uri)
  const admin = new URL(uri)
  admin.pathname = '/postgres'
  const root = new pg.Client({ connectionString: admin.toString() })
  await root.connect()
  try {
    const exists = await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (!exists.rowCount) await root.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`)
  } finally {
    await root.end()
  }
  const db = new pg.Client({ connectionString: uri })
  await db.connect()
  try {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE')
    await db.query('CREATE SCHEMA public')
    await db.query('GRANT ALL ON SCHEMA public TO public')
  } finally {
    await db.end()
  }
}

/* ------------------------------------------------------------------ build, seed, start */

/** Every variable the CMS reads is set explicitly, so nothing leaks in from cms/.env. */
function smokeEnv({ port, sinkPort, production }) {
  const env = {
    ...process.env,
    DATABASE_URI: DB_URI,
    DATABASE_POOL_MAX: '10',
    PAYLOAD_SECRET: SMOKE_SECRET,
    PAYLOAD_PUBLIC_SERVER_URL: `http://localhost:${port}`,
    STOREFRONT_URL: STOREFRONT,
    STOREFRONT_ORIGINS: STOREFRONT,
    PAYMENTS_MODE: 'mock',
    ALLOW_MOCK_PAYMENTS: '1',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET_OLD: '',
    APP_ENV: '',
    VERCEL_ENV: '',
    CRON_SECRET,
    SMTP_HOST: process.env.PROD_SMOKE_SMTP_HOST || '127.0.0.1',
    SMTP_PORT: process.env.PROD_SMOKE_SMTP_PORT || '54325',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_SECURE: '',
    EMAIL_FROM: 'Wefeasto Smoke <smoke@wefeasto.com>',
    VERCEL_DEPLOY_HOOK_URL: '',
    BLOB_READ_WRITE_TOKEN: '',
    // Production realism: rate limits ON. Every probe sends its own x-real-ip.
    RATE_LIMIT_DISABLED: '0',
    MOCK_WEBHOOK_DELAY_MS: '0',
    MOCK_WEBHOOK_URL: sinkPort ? `http://127.0.0.1:${sinkPort}/hook` : '',
    NEXT_DIST_DIR: DIST_DIR,
    NEXT_TELEMETRY_DISABLED: '1',
    SEED_ADMIN_EMAIL: ADMIN.email,
    SEED_ADMIN_PASSWORD: ADMIN.password,
  }
  delete env.PAYLOAD_DB_PUSH
  delete env.PAYLOAD_LOG_LEVEL
  if (production) env.NODE_ENV = 'production'
  else delete env.NODE_ENV // payload migrate + the seed run outside production (no production boot assertions)
  return env
}

async function ensureBuild({ port, logFile }) {
  const hash = buildHash(JSON.stringify({ DIST_DIR, url: `http://localhost:${port}` }))
  let stamp = null
  try {
    stamp = JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8'))
  } catch {}
  const buildId = fs.existsSync(path.join(DIST_PATH, 'BUILD_ID')) ? fs.readFileSync(path.join(DIST_PATH, 'BUILD_ID'), 'utf8').trim() : null
  if (!ARGS.has('--rebuild') && stamp?.hash === hash && stamp.buildId === buildId && buildId) {
    say(`reusing the production build in cms/${DIST_DIR} (BUILD_ID ${buildId})`)
    return { reused: true, buildId }
  }
  say(`next build → cms/${DIST_DIR} (a few minutes; log: ${logFile})`)
  const restore = guardNextFiles()
  const t0 = Date.now()
  try {
    await run('next build', process.execPath, [path.join(CMS_DIR, 'node_modules/next/dist/bin/next'), 'build'], {
      env: { ...smokeEnv({ port, production: true }), NODE_OPTIONS: '--no-deprecation --max-old-space-size=8000' },
      logFile,
      timeoutMs: 25 * 60_000,
    })
  } finally {
    for (const note of restore()) say(note)
  }
  const id = fs.readFileSync(path.join(DIST_PATH, 'BUILD_ID'), 'utf8').trim()
  fs.writeFileSync(STAMP_FILE, JSON.stringify({ hash, buildId: id, builtAt: new Date().toISOString() }, null, 2))
  say(`built in ${Math.round((Date.now() - t0) / 1000)}s (BUILD_ID ${id})`)
  return { reused: false, buildId: id }
}

async function seed({ port, logFile }) {
  say(`reset + seed ${new URL(DB_URI).pathname.slice(1)} (log: ${logFile})`)
  await resetDatabase(DB_URI)
  // The production schema: src/migrations via `payload migrate`, then the seed without dev push. (A dev-pushed
  // DB would make the production server's prodMigrations wait forever on an interactive prompt.)
  await run('payload migrate', process.execPath, [path.join(CMS_DIR, 'node_modules/payload/bin.js'), 'migrate'], {
    env: { ...smokeEnv({ port, production: false }), NODE_OPTIONS: '--no-deprecation' },
    logFile,
    timeoutMs: 10 * 60_000,
  })
  await run('seed', process.execPath, [path.join(CMS_DIR, 'node_modules/tsx/dist/cli.mjs'), 'src/seed/index.ts', '--stock=100'], {
    env: { ...smokeEnv({ port, production: false }), PAYLOAD_DB_PUSH: 'false', NODE_OPTIONS: '--no-deprecation' },
    logFile,
    timeoutMs: 10 * 60_000,
  })
}

/** Detached `next start`; resolves { child, stop } once the catalog answers 200. */
async function startServer({ port, sinkPort, logFile }) {
  const out = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [path.join(CMS_DIR, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port)], {
    cwd: CMS_DIR,
    env: { ...smokeEnv({ port, sinkPort, production: true }), NODE_OPTIONS: '--no-deprecation' },
    stdio: ['ignore', out, out],
    detached: true,
  })
  let exited = false
  child.on('exit', () => (exited = true))
  const stop = async () => {
    if (exited) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 100))
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    fs.closeSync(out)
  }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (exited) throw new Error(`next start exited early (log: ${logFile})\n${tail(logFile, 40)}`)
    try {
      const res = await fetch(`http://localhost:${port}/api/store/catalog`, { signal: AbortSignal.timeout(5000) })
      if (res.status === 200) return { child, stop }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  await stop()
  throw new Error(`next start did not answer within 180s (log: ${logFile})`)
}

/** Captures the mock gateway's signed webhooks (MOCK_WEBHOOK_URL) so probes can redeliver them verbatim. */
function startWebhookSink() {
  const deliveries = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      deliveries.push({ headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, deliveries, close: () => new Promise((r) => server.close(r)) }))
  })
}

/* ------------------------------------------------------------------ HTTP + Mailpit helpers */

class ProbeError extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new ProbeError(msg)
}

let ipSeq = 0
/** A client IP per probe step: rate limits are ON, and each probe must get its own buckets. */
const nextIp = () => `10.99.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

function apiClient(base) {
  return async function api(method, p, { body, raw, contentType, headers = {}, ip, cookie, token, origin } = {}) {
    const h = new Headers(headers)
    h.set('x-real-ip', ip ?? nextIp())
    let payload
    if (raw !== undefined) {
      payload = raw
      if (contentType) h.set('content-type', contentType)
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      h.set('content-type', 'application/json')
    }
    if (cookie) h.set('cookie', cookie)
    if (token) h.set('authorization', `JWT ${token}`)
    const o = origin === undefined ? (cookie ? STOREFRONT : null) : origin
    if (o) h.set('origin', o)
    const res = await fetch(`${base}/api/${p.replace(/^\/+/, '')}`, {
      method,
      headers: h,
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    const setCookie = res.headers.getSetCookie?.() ?? []
    const jwt = setCookie.map((c) => /^payload-token=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? null
    return { status: res.status, headers: res.headers, text, json, setCookie, jwt }
  }
}

const uniqueEmail = (tag) => `${tag}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}@test.wefeasto.dev`

async function mailTo(address, subject) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`)
  if (!res.ok) throw new Error(`Mailpit search → ${res.status}`)
  const list = (await res.json()).messages ?? []
  return list.filter((m) => !subject || m.Subject.includes(subject))
}

async function waitForMail(address, { subject, count = 1, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await mailTo(address, subject)
    if (last.length >= count) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new ProbeError(`expected ${count} email(s) "${subject}" to ${address}, saw ${last.length}`)
}

async function mailLinks(id) {
  const res = await fetch(`${MAILPIT}/api/v1/message/${encodeURIComponent(id)}`)
  const html = (await res.json()).HTML ?? ''
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
}

async function verifyTokensFor(address, count) {
  const msgs = await waitForMail(address, { subject: 'Confirm your Wefeasto account', count })
  const tokens = []
  for (const m of msgs) {
    const link = (await mailLinks(m.ID)).find((l) => l.startsWith(`${STOREFRONT}/login?verify=`))
    check(link, `verify email to ${address} has no ${STOREFRONT}/login?verify= link`)
    tokens.push(new URL(link).searchParams.get('verify'))
  }
  return tokens // newest first
}

/** Payload REST field errors: errors[0].data.errors[{path,message}]. */
const payloadFieldPaths = (r) => (r.json?.errors?.[0]?.data?.errors ?? []).map((e) => e.path)
const sorted = (xs) => [...xs].sort((a, b) => a - b)

/* ------------------------------------------------------------------ probes */

const ADDRESS = { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' }
let phoneSeq = 0
const phone = () => `+9198${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq % 100).padStart(2, '0')}`

async function orderBody(api, ctx, { qty = 1, method = 'upi', couponCode } = {}) {
  const items = [{ slug: ctx.slug, qty }]
  const q = await api('POST', 'store/quote', { body: { items, method, ...(couponCode ? { couponCode } : {}) } })
  check(q.status === 200, `quote → ${q.status} ${q.text.slice(0, 200)}`)
  if (couponCode) check(q.json?.quote?.discountPaise > 0, `quote with ${couponCode} has no discount: ${q.text.slice(0, 200)}`)
  return {
    items,
    ...(couponCode ? { couponCode } : {}),
    contact: { name: 'Smoke Tester', email: uniqueEmail('buyer'), phone: phone() },
    address: ADDRESS,
    method,
    expectedTotalPaise: q.json.quote.totalPaise,
    consent: { marketing: false },
    source: 'web',
  }
}

const PROBES = [
  {
    name: 'catalog answers (warm-up)',
    async fn(api, ctx) {
      const r = await api('GET', 'store/catalog')
      check(r.status === 200 && r.json?.products?.length > 0, `catalog → ${r.status}`)
      ctx.slug = r.json.products.find((p) => p.inStock)?.slug
      check(ctx.slug, 'no product in stock')
      return `${r.json.products.length} products; using ${ctx.slug}`
    },
  },
  {
    name: 'webhook: one signed event redelivered ×3 → 200,200,200',
    async fn(api, ctx) {
      const ip = nextIp()
      const co = await api('POST', 'store/checkout', { body: await orderBody(api, ctx), headers: { 'Idempotency-Key': crypto.randomUUID() }, ip })
      check(co.status === 201, `checkout → ${co.status} ${co.text.slice(0, 200)}`)
      const { number, token } = co.json.order
      const rzp = co.json.payment.razorpayOrderId
      const pay = await api('POST', 'payments/mock/pay', { body: { razorpayOrderId: rzp, outcome: 'success', webhook: true }, ip })
      check(pay.status === 200 && pay.json?.ok, `mock/pay → ${pay.status} ${pay.text.slice(0, 200)}`)
      const find = (event) => ctx.sink.deliveries.find((d) => d.body.includes(`"event":"${event}"`) && d.body.includes(rzp))
      const deadline = Date.now() + 15_000
      while (!(find('payment.captured') && find('order.paid')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      const captured = find('payment.captured')
      check(captured, `no payment.captured webhook for ${rzp} reached the sink (MOCK_WEBHOOK_URL)`)
      const deliver = (d) =>
        api('POST', 'payments/razorpay/webhook', {
          raw: d.body,
          contentType: 'application/json',
          headers: { 'x-razorpay-signature': d.headers['x-razorpay-signature'], 'x-razorpay-event-id': d.headers['x-razorpay-event-id'] },
        })
      const seq = []
      for (let i = 0; i < 3; i++) seq.push(await deliver(captured))
      const statuses = seq.map((r) => r.status)
      const outcomes = seq.map((r) => r.json?.outcome)
      check(statuses.join() === '200,200,200', `sequential redelivery → ${statuses} ${seq.map((r) => r.text.slice(0, 120)).join(' | ')}`)
      check(outcomes[0] === 'paid' && outcomes[1] === 'duplicate' && outcomes[2] === 'duplicate', `outcomes ${outcomes}`)
      const orderPaid = find('order.paid')
      const par = orderPaid ? await Promise.all([1, 2, 3].map(() => deliver(orderPaid))) : []
      check(par.every((r) => r.status === 200), `parallel order.paid ×3 → ${par.map((r) => r.status)}`)
      const bad = await api('POST', 'payments/razorpay/webhook', { raw: captured.body, contentType: 'application/json', headers: { 'x-razorpay-signature': 'f'.repeat(64), 'x-razorpay-event-id': 'evt_forged' } })
      check(bad.status === 400, `forged signature → ${bad.status}`)
      const st = await api('GET', `store/orders/status?no=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`)
      check(st.status === 200 && st.json?.status === 'paid', `order status → ${st.status} ${st.json?.status}`)
      return `${number}: ${outcomes.join('/')}; order.paid ×3 parallel ${par.map((r) => r.json?.outcome).join('/') || 'n/a'}; forged → 400`
    },
  },
  {
    name: 'checkout: same Idempotency-Key ×5 concurrent → one 201 + four 200',
    async fn(api, ctx) {
      const ip = nextIp()
      const body = await orderBody(api, ctx)
      const key = crypto.randomUUID()
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', 'store/checkout', { body, headers: { 'Idempotency-Key': key }, ip })))
      const statuses = sorted(rs.map((r) => r.status))
      check(statuses.join() === '200,200,200,200,201', `statuses ${statuses} ${rs.filter((r) => r.status >= 300).map((r) => r.text.slice(0, 160)).join(' | ')}`)
      const numbers = new Set(rs.map((r) => r.json?.order?.number))
      check(numbers.size === 1, `orders ${[...numbers]}`)
      const mismatch = await api('POST', 'store/checkout', { body: { ...body, contact: { ...body.contact, name: 'Someone Else' } }, headers: { 'Idempotency-Key': key }, ip })
      check(mismatch.status === 409 && mismatch.json?.error?.code === 'IDEMPOTENCY_MISMATCH', `same key, other body → ${mismatch.status} ${mismatch.json?.error?.code}`)
      return `${[...numbers][0]}: ${statuses.join(',')}; other body → 409 IDEMPOTENCY_MISMATCH`
    },
  },
  {
    name: 'newsletter: double-submit race → all 200 {ok:true}',
    async fn(api) {
      const email = uniqueEmail('news')
      const a = await Promise.all([1, 2].map(() => api('POST', 'store/newsletter', { body: { email } })))
      const b = await Promise.all([1, 2, 3].map(() => api('POST', 'store/newsletter', { body: { email } })))
      const all = [...a, ...b]
      check(all.every((r) => r.status === 200 && r.json?.ok === true), `statuses ${all.map((r) => r.status)} ${all.map((r) => r.text.slice(0, 100)).join(' | ')}`)
      await new Promise((r) => setTimeout(r, 1500))
      const mails = await mailTo(email)
      return `2 + 3 concurrent → ${all.map((r) => r.status).join(',')}; ${mails.length} email(s) to the address`
    },
  },
]

PROBES.push({
  // PI-ORD-1: a handler's own Referrer-Policy is replaced by the next.config.ts headers() table under
  // `next start`, so token-bearing answers get no-referrer only if that table says so for /api/**.
  name: 'security headers: /api/** no-referrer (status, callback 303, newsletter 303); /admin strict-origin',
  async fn(api, ctx) {
    const ip = nextIp()
    const co = await api('POST', 'store/checkout', { body: await orderBody(api, ctx), headers: { 'Idempotency-Key': crypto.randomUUID() }, ip })
    check(co.status === 201, `checkout → ${co.status} ${co.text.slice(0, 200)}`)
    const { number, token } = co.json.order
    const q = `no=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`
    const seen = {
      'status 200': await api('GET', `store/orders/status?${q}`),
      'status 404': await api('GET', `store/orders/status?no=WF-99999999&t=${encodeURIComponent(token)}`),
      'callback 303': await api('POST', `payments/razorpay/callback?${q}`, {
        raw: 'error%5Bcode%5D=BAD_REQUEST_ERROR&error%5Breason%5D=payment_cancelled',
        contentType: 'application/x-www-form-urlencoded',
      }),
      'newsletter confirm 303': await api('GET', 'store/newsletter/confirm?t=bogus-token'),
      'catalog 200': await api('GET', 'store/catalog'),
    }
    const want = { 'status 200': 200, 'status 404': 404, 'callback 303': 303, 'newsletter confirm 303': 303, 'catalog 200': 200 }
    const got = Object.fromEntries(Object.entries(seen).map(([k, r]) => [k, `${r.status} ${r.headers.get('referrer-policy')} ${r.headers.get('x-content-type-options')}`]))
    for (const [k, status] of Object.entries(want)) check(got[k] === `${status} no-referrer nosniff`, `${k}: ${got[k]} (want ${status} no-referrer nosniff) — all: ${JSON.stringify(got)}`)
    check((seen['callback 303'].headers.get('location') ?? '').includes(`t=${token}`), `callback Location ${seen['callback 303'].headers.get('location')} lacks the token`)
    const admin = await fetch(`${ctx.base}/admin`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    check(admin.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', `/admin → ${admin.status} Referrer-Policy ${admin.headers.get('referrer-policy')}`)
    return `${Object.entries(got).map(([k, v]) => `${k}: ${v.split(' ')[1]}`).join('; ')}; /admin ${admin.status}: strict-origin-when-cross-origin`
  },
})

PROBES.push(
  {
    name: 'signup: duplicate email → 400 (not 500), also concurrently',
    async fn(api) {
      const email = uniqueEmail('dupe')
      const first = await api('POST', 'customers', { body: { email, password: 'Smoke-passw0rd' } })
      check(first.status === 201, `signup → ${first.status} ${first.text.slice(0, 160)}`)
      const again = await api('POST', 'customers', { body: { email, password: 'Smoke-passw0rd' } })
      check(again.status === 400 && payloadFieldPaths(again).includes('email'), `duplicate → ${again.status} ${again.text.slice(0, 200)}`)
      const racer = uniqueEmail('race')
      const rs = await Promise.all([1, 2, 3].map(() => api('POST', 'customers', { body: { email: racer, password: 'Smoke-passw0rd' } })))
      const statuses = sorted(rs.map((r) => r.status))
      check(statuses.join() === '201,400,400', `3 concurrent signups → ${statuses} ${rs.map((r) => r.text.slice(0, 100)).join(' | ')}`)
      check(!again.text.match(/hash|salt|_verificationToken/), 'duplicate response leaks auth fields')
      // Evidence the build is minified: Payload's ValidationError arrives under a mangled class name.
      const errName = again.json?.errors?.[0]?.name
      return `sequential 201→400 (path email, error name "${errName}"${errName === 'ValidationError' ? ' — NOT minified?' : ', minified'}); concurrent ×3 → ${statuses.join(',')}`
    },
  },
  {
    name: 'withErrors error mapping (custom endpoints)',
    async fn(api, ctx) {
      const cases = [
        ['malformed JSON', await api('POST', 'store/quote', { raw: '{nope', contentType: 'application/json' }), 400, 'INVALID_JSON'],
        ['wrong content type', await api('POST', 'store/quote', { raw: 'x', contentType: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
        ['empty bag', await api('POST', 'store/checkout', { body: { items: [] }, headers: { 'Idempotency-Key': crypto.randomUUID() } }), 400, 'EMPTY_CART'],
        ['bad qty in quote', await api('POST', 'store/quote', { body: { items: [{ slug: ctx.slug, qty: -1 }] } }), 400, 'BAD_QTY'],
        [
          'invalid contact',
          await api('POST', 'store/checkout', {
            body: { ...(await orderBody(api, ctx)), contact: { name: '', email: 'nope', phone: '12' } },
            headers: { 'Idempotency-Key': crypto.randomUUID() },
          }),
          400,
          'VALIDATION',
        ],
        ['no Idempotency-Key', await api('POST', 'store/checkout', { body: await orderBody(api, ctx) }), 400, 'IDEMPOTENCY_KEY_REQUIRED'],
        ['unknown order', await api('GET', 'store/orders/status?no=WF-1&t=nope'), 404, 'NOT_FOUND'],
        ['resend: bad email', await api('POST', 'store/account/resend-verification', { body: { email: 'nope' } }), 400, 'VALIDATION'],
      ]
      const bad = cases.filter(([, r, status, code]) => r.status !== status || r.json?.error?.code !== code || typeof r.json?.error?.message !== 'string' || /stack|at \w+ \(/.test(r.text))
      check(!bad.length, bad.map(([n, r, s, c]) => `${n}: want ${s} ${c}, got ${r.status} ${r.text.slice(0, 160)}`).join(' | '))
      return cases.map(([n, r]) => `${n} ${r.status}`).join('; ')
    },
  },
  {
    name: 'resend-verification + verify + login without JWT in JSON',
    async fn(api, ctx) {
      const email = uniqueEmail('resend')
      const password = 'Smoke-passw0rd'
      const su = await api('POST', 'customers', { body: { email, password, name: 'Smoke Tester' } })
      check(su.status === 201, `signup → ${su.status}`)
      const [first] = await verifyTokensFor(email, 1)
      const r = await api('POST', 'store/account/resend-verification', { body: { email: email.toUpperCase() } })
      check(r.status === 200 && r.text === '{"ok":true}', `resend → ${r.status} ${r.text}`)
      const tokens = await verifyTokensFor(email, 2)
      const fresh = tokens.find((t) => t !== first)
      check(fresh, 'no fresh token in the second email')
      const old = await api('POST', `customers/verify/${first}`)
      check(old.status === 403, `old token → ${old.status}`)
      const ok = await api('POST', `customers/verify/${fresh}`)
      check(ok.status === 200, `new token → ${ok.status} ${ok.text.slice(0, 120)}`)
      const ghost = await api('POST', 'store/account/resend-verification', { body: { email: uniqueEmail('ghost') } })
      const verified = await api('POST', 'store/account/resend-verification', { body: { email } })
      check(ghost.text === r.text && verified.text === r.text && ghost.status === 200 && verified.status === 200, 'unknown/verified answers differ')
      const login = await api('POST', 'customers/login', { body: { email, password }, origin: STOREFRONT })
      check(login.status === 200, `login → ${login.status} ${login.text.slice(0, 160)}`)
      check(login.json?.token === undefined && login.jwt && !login.text.includes(login.jwt), 'login JSON exposes the JWT (removeTokenFromResponses)')
      const cookie = login.setCookie.find((c) => c.startsWith('payload-token='))
      check(/HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie), `cookie flags: ${cookie}`)
      const me = await api('GET', 'customers/me', { cookie: `payload-token=${login.jwt}` })
      check(me.status === 200 && me.json?.user?.email === email && me.json?.token === undefined, `me → ${me.status} ${me.text.slice(0, 120)}`)
      ctx.customer = { id: me.json.user.id, email, password, jwt: login.jwt }
      const ip = nextIp()
      const flood = []
      for (let i = 0; i < 6; i++) flood.push(await api('POST', 'store/account/resend-verification', { body: { email: uniqueEmail('flood') }, ip }))
      const last = flood[5]
      check(flood.slice(0, 5).every((x) => x.status === 200) && last.status === 429 && last.json?.error?.code === 'RATE_LIMITED' && Number(last.headers.get('retry-after')) > 0, `6 from one IP → ${flood.map((x) => x.status)}`)
      return 'resend 200 → fresh token (old 403, new 200); login: no token in JSON, HttpOnly+Secure cookie; 6th/min → 429'
    },
  },
  {
    name: 'password policy 8–128 (signup, change, reset)',
    async fn(api, ctx) {
      const short = await api('POST', 'customers', { body: { email: uniqueEmail('pw'), password: 'short77' } })
      check(short.status === 400 && payloadFieldPaths(short).includes('password'), `7 chars → ${short.status} ${short.text.slice(0, 160)}`)
      const long = await api('POST', 'customers', { body: { email: uniqueEmail('pw'), password: 'x'.repeat(129) } })
      check(long.status === 400 && payloadFieldPaths(long).includes('password'), `129 chars → ${long.status}`)
      const c = ctx.customer
      check(c, 'needs the customer from the resend probe')
      const change = await api('PATCH', `customers/${c.id}`, { body: { password: 'short' }, token: c.jwt })
      check(change.status === 400 && payloadFieldPaths(change).includes('password'), `PATCH short password → ${change.status} ${change.text.slice(0, 160)}`)
      const phoneErr = await api('PATCH', `customers/${c.id}`, { body: { phone: '12345' }, token: c.jwt })
      check(phoneErr.status === 400 && payloadFieldPaths(phoneErr).includes('phone'), `PATCH bad phone → ${phoneErr.status}`)
      const reset = await api('POST', 'customers/reset-password', { body: { token: 'not-a-token', password: 'short' } })
      check(reset.status === 400 && payloadFieldPaths(reset).includes('password'), `reset short → ${reset.status} ${reset.text.slice(0, 160)}`)
      const still = await api('POST', 'customers/login', { body: { email: c.email, password: c.password } })
      check(still.status === 200, 'old password stopped working')
      return 'signup 7/129 → 400 password; PATCH short → 400 password; bad phone → 400 phone; reset short → 400'
    },
  },
  {
    name: 'auth rate limit (Payload APIError 429 under minification)',
    async fn(api) {
      const ip = nextIp()
      const rs = []
      for (let i = 0; i < 11; i++) rs.push(await api('POST', 'customers/login', { body: { email: uniqueEmail('nobody'), password: 'wrong-password' }, ip }))
      const last = rs[10]
      check(rs.slice(0, 10).every((r) => r.status === 401), `first 10 → ${rs.slice(0, 10).map((r) => r.status)}`)
      check(last.status === 429 && last.json?.errors?.[0]?.data?.code === 'RATE_LIMITED' && Number(last.headers.get('retry-after')) > 0, `11th → ${last.status} ${last.text.slice(0, 200)}`)
      const forgot = []
      const victim = uniqueEmail('victim')
      for (let i = 0; i < 4; i++) forgot.push(await api('POST', 'customers/forgot-password', { body: { email: victim } }))
      check(forgot.map((r) => r.status).join() === '200,200,200,429', `forgot ×4 same email → ${forgot.map((r) => r.status)}`)
      return `login 10×401 then 429 (Retry-After ${last.headers.get('retry-after')}s); forgot-password per email → ${forgot.map((r) => r.status).join(',')}`
    },
  },
  {
    name: 'admin stock: absolute write refused, ±N applied',
    async fn(api, ctx) {
      const login = await api('POST', 'users/login', { body: ADMIN })
      check(login.status === 200 && login.json?.token, `admin login → ${login.status}`)
      const token = login.json.token
      const list = await api('GET', `products?where[slug][equals]=${ctx.slug}&depth=0&limit=1`, { token })
      const doc = list.json?.docs?.[0]
      check(doc && typeof doc.stock === 'number', `product read → ${list.status}`)
      const abs = await api('PATCH', `products/${doc.id}?depth=0`, { body: { stock: doc.stock + 500 }, token })
      check(abs.status === 400 && payloadFieldPaths(abs).includes('stock'), `absolute stock → ${abs.status} ${abs.text.slice(0, 160)}`)
      const down = await api('PATCH', `products/${doc.id}?depth=0`, { body: { stockAdjust: -1 }, token })
      check(down.status === 200 && down.json?.doc?.stock === doc.stock - 1 && down.json?.doc?.stockAdjust === null, `adjust -1 → ${down.status} ${down.text.slice(0, 160)}`)
      const tooMany = await api('PATCH', `products/${doc.id}?depth=0`, { body: { stockAdjust: -(doc.stock + 10) }, token })
      check(tooMany.status === 400 && payloadFieldPaths(tooMany).includes('stockAdjust'), `below 0 → ${tooMany.status}`)
      const up = await api('PATCH', `products/${doc.id}?depth=0`, { body: { stockAdjust: 1 }, token })
      check(up.status === 200 && up.json?.doc?.stock === doc.stock, `adjust +1 → ${up.status}`)
      // The admin edit page renders the read-only stock and the ±N field (production RSC build).
      const page = await fetch(`${ctx.base}/admin/collections/products/${doc.id}`, {
        headers: { cookie: `payload-token=${login.jwt}`, 'sec-fetch-site': 'same-origin', 'x-real-ip': nextIp() },
      })
      const html = await page.text()
      check(page.status === 200 && html.includes('Adjust stock by') && html.includes('Stock (packs)'), `admin edit page → ${page.status}, fields ${html.includes('Adjust stock by') ? '' : 'missing'}`)
      // What the admin form submits (multipart _payload): a stale stockOnHand, blank stockAdjust, no stock.
      const form = new FormData()
      form.set('_payload', JSON.stringify({ name: doc.name, pricePaise: doc.pricePaise, stockOnHand: doc.stock + 7, stockAdjust: null }))
      const saved = await fetch(`${ctx.base}/api/products/${doc.id}?depth=0`, { method: 'PATCH', body: form, headers: { authorization: `JWT ${token}`, 'x-real-ip': nextIp() } })
      const savedJson = await saved.json().catch(() => null)
      check(saved.status === 200 && savedJson?.doc?.stock === doc.stock, `admin-form save → ${saved.status} stock ${savedJson?.doc?.stock}`)
      return `stock ${doc.stock}: absolute → 400; -1 → ${doc.stock - 1}; below 0 → 400; +1 → ${doc.stock}; admin page shows both fields; form save keeps ${doc.stock}`
    },
  },
)

PROBES.push({
  // CPN-DEL-1: the Coupons beforeDelete guard throws a public APIError 409, matched by status (never by the
  // class name the minified build mangles). Before it, the FK's ON DELETE SET NULL hit the NOT NULL
  // coupon_redemptions.coupon_id and the admin saw a 500 "Something went wrong.".
  name: 'coupons: delete redeemed → 409 (not 500); unused → 200; bulk → 400 naming it; retire → 200',
  async fn(api, ctx) {
    const login = await api('POST', 'users/login', { body: ADMIN })
    check(login.status === 200 && login.json?.token, `admin login → ${login.status}`)
    const token = login.json.token
    const mk = async (tag) => {
      const code = `SMOKE-${tag}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase()
      const r = await api('POST', 'coupons?depth=0', { body: { code, type: 'percent', value: 10 }, token })
      check(r.status === 201 && r.json?.doc?.id, `create coupon ${code} → ${r.status} ${r.text.slice(0, 160)}`)
      return r.json.doc
    }
    const used = await mk('USED')
    const co = await api('POST', 'store/checkout', {
      body: await orderBody(api, ctx, { couponCode: used.code }),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    check(co.status === 201 && co.json?.order?.number, `checkout with ${used.code} → ${co.status} ${co.text.slice(0, 200)}`)

    const del = await api('DELETE', `coupons/${used.id}`, { token })
    const err = del.json?.errors?.[0]
    check(
      del.status === 409 && err?.data?.code === 'COUPON_IN_USE' && err?.data?.orders === 1 && /can't be deleted/.test(err?.message ?? ''),
      `redeemed delete → ${del.status} ${del.text.slice(0, 240)}`,
    )
    const still = await api('GET', `coupons/${used.id}?depth=0`, { token })
    check(still.status === 200 && still.json?.active === true, `after refusal → ${still.status} active=${still.json?.active}`)

    const free = await mk('FREE')
    const delFree = await api('DELETE', `coupons/${free.id}`, { token })
    check(delFree.status === 200, `unused delete → ${delFree.status} ${delFree.text.slice(0, 160)}`)

    const other = await mk('BULK')
    const bulk = await api('DELETE', `coupons?where[id][in]=${used.id},${other.id}&depth=0`, { token })
    const bErr = bulk.json?.errors ?? []
    check(
      bulk.status === 400 && bErr.length === 1 && bErr[0].id === used.id && bErr[0].message === err.message &&
        bulk.json?.docs?.length === 1 && bulk.json.docs[0].id === other.id,
      `bulk delete → ${bulk.status} ${bulk.text.slice(0, 240)}`,
    )

    const retire = await api('PATCH', `coupons/${used.id}?depth=0`, { body: { active: false }, token })
    check(retire.status === 200 && retire.json?.doc?.active === false, `retire → ${retire.status}`)
    // An expected refusal: logged at info via loggingLevels (keyed by the literal name the minifier keeps).
    check(err?.name === 'CouponInUseError', `error name ${JSON.stringify(err?.name)} (loggingLevels key would miss)`)
    const refusals = fs.readFileSync(ctx.serverLog, 'utf8').split('\n').filter((l) => l.includes("can't be deleted"))
    check(refusals.length > 0 && !refusals.some((l) => /ERROR|"level":50/.test(l)), `refusal log lines: ${refusals.slice(0, 3).join(' | ') || 'none'}`)
    return `${co.json.order.number} used ${used.code}: DELETE → 409 COUPON_IN_USE (${err?.name}, logged at info); unused → 200; bulk → 400 (1 of 2 refused); retire → 200`
  },
})

PROBES.push({
  // HUNT w5 (src/retention/subscriberWrites.ts): an admin Save never puts an address back on the list, and its
  // refusals are public APIErrors (400/409, matched by status + data.code) logged at info, not 500s.
  name: 'subscribers: stale Save keeps an unsubscribe; fresh confirm → 400; stale unsubscribe → 409',
  async fn(api, ctx) {
    const login = await api('POST', 'users/login', { body: ADMIN })
    check(login.status === 200 && login.json?.token, `admin login → ${login.status}`)
    const token = login.json.token
    const email = uniqueEmail('subform')
    // Sign-ups are processed after the response (no membership oracle): poll for the outcome.
    const poll = async (read, ok) => {
      let value
      for (const until = Date.now() + 10_000; Date.now() < until; await new Promise((r) => setTimeout(r, 150))) {
        value = await read()
        if (ok(value)) break
      }
      return value
    }
    const signUp = await api('POST', 'store/newsletter', { body: { email } })
    check(signUp.status === 200, `sign-up → ${signUp.status}`)
    const read = await poll(
      () => api('GET', `subscribers?where[email][equals]=${encodeURIComponent(email)}&depth=0`, { token }),
      (r) => r.json?.docs?.length === 1,
    )
    const { id, createdAt: _c, ...form } = read.json?.docs?.[0] ?? {}
    check(id && form.status === 'pending', `subscriber read → ${read.status} ${read.text.slice(0, 160)}`)
    const statusNow = async () => (await api('GET', `subscribers/${id}?depth=0`, { token })).json?.status

    const confirm = await api('PATCH', `subscribers/${id}?depth=0`, { body: { ...form, status: 'confirmed' }, token })
    check(confirm.status === 400 && confirm.json?.errors?.[0]?.data?.code === 'OWNER_CONSENT_ONLY', `fresh confirm → ${confirm.status} ${confirm.text.slice(0, 200)}`)

    const t = crypto.createHmac('sha256', SMOKE_SECRET).update(`unsubscribe:${email}`).digest('base64url')
    const unsub = await api('GET', `store/newsletter/unsubscribe?t=${t}`)
    check(unsub.status === 303 && /unsubscribed=1/.test(unsub.headers.get('location') ?? ''), `unsubscribe link → ${unsub.status} ${unsub.headers.get('location')}`)
    const stale = await api('PATCH', `subscribers/${id}?depth=0`, { body: { ...form, source: 'smoke stall' }, token })
    check(stale.status === 200 && (await statusNow()) === 'unsubscribed', `stale Save → ${stale.status}, status ${await statusNow()}`)

    const again = await api('POST', 'store/newsletter', { body: { email } })
    const resubscribed = await poll(statusNow, (st) => st === 'pending')
    check(again.status === 200 && resubscribed === 'pending', `re-subscribe → ${again.status}, status ${resubscribed}`)
    const staleUnsub = await api('PATCH', `subscribers/${id}?depth=0`, { body: { ...form, status: 'unsubscribed' }, token })
    check(
      staleUnsub.status === 409 && staleUnsub.json?.errors?.[0]?.data?.code === 'SUBSCRIBER_CHANGED' && (await statusNow()) === 'pending',
      `stale unsubscribe → ${staleUnsub.status} ${staleUnsub.text.slice(0, 200)}`,
    )
    const refusals = fs.readFileSync(ctx.serverLog, 'utf8').split('\n').filter((l) => /Only the subscriber can join|changed after you opened/.test(l))
    check(refusals.length >= 2 && !refusals.some((l) => /ERROR|"level":50/.test(l)), `refusal log lines: ${refusals.slice(0, 3).join(' | ') || 'none'}`)
    return 'fresh confirm → 400 OWNER_CONSENT_ONLY; unsubscribe link → 303; stale Save → 200 still unsubscribed; re-subscribed → stale unsubscribe 409 SUBSCRIBER_CHANGED; logged at info'
  },
})

/* ------------------------------------------------------------------ main */

function printTable(rows) {
  const w = Math.max(...rows.map((r) => r.name.length), 10)
  const line = `+-${'-'.repeat(w)}-+------+--------+`
  console.log(`\n${line}\n| ${'probe'.padEnd(w)} | pass | ms     |\n${line}`)
  for (const r of rows) console.log(`| ${r.name.padEnd(w)} | ${r.ok ? ' ok ' : 'FAIL'} | ${String(r.ms).padStart(6)} |`)
  console.log(line)
  for (const r of rows) console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.name}\n        ${r.detail}`)
}

async function main() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wefeasto-prod-smoke-'))
  const logs = { build: path.join(logDir, 'build.log'), seed: path.join(logDir, 'seed.log'), server: path.join(logDir, 'server.log') }
  const port = await freePort(PORT_PREFERRED)
  say(`logs in ${logDir}; CMS port ${port}; database ${new URL(DB_URI).pathname.slice(1)}`)

  const build = await ensureBuild({ port, logFile: logs.build })
  await seed({ port, logFile: logs.seed })
  const sink = await startWebhookSink()
  let server = null
  const rows = []
  try {
    say(`next start on :${port} (webhook sink :${sink.port})`)
    server = await startServer({ port, sinkPort: sink.port, logFile: logs.server })
    const api = apiClient(`http://localhost:${port}`)
    const ctx = { sink, base: `http://localhost:${port}`, serverLog: logs.server }
    for (const probe of PROBES) {
      const t0 = Date.now()
      try {
        const detail = await probe.fn(api, ctx)
        rows.push({ name: probe.name, ok: true, ms: Date.now() - t0, detail })
      } catch (err) {
        rows.push({ name: probe.name, ok: false, ms: Date.now() - t0, detail: err instanceof ProbeError ? err.message : String(err?.stack || err) })
      }
    }
    await new Promise((r) => setTimeout(r, 1000)) // let after-response work (emails) finish logging
    const serverLog = fs.readFileSync(logs.server, 'utf8')
    const hits = serverLog.split('\n').filter((l) => /INTERNAL|Unhandled/.test(l))
    rows.push({
      name: "server log has no 'INTERNAL' / 'Unhandled'",
      ok: hits.length === 0,
      ms: 0,
      detail: hits.length ? hits.slice(0, 10).join('\n        ') : `${serverLog.split('\n').length} log lines scanned`,
    })
  } finally {
    if (server) await server.stop()
    await sink.close()
    say('server stopped')
  }

  printTable(rows)
  const failed = rows.filter((r) => !r.ok).length
  console.log(`\nbuild ${build.reused ? 'reused' : 'fresh'} (BUILD_ID ${build.buildId}); ${rows.length - failed}/${rows.length} passed; logs: ${logDir}`)
  return failed ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[prod-smoke] FAILED before the probes finished: ${err?.stack || err}`)
    process.exit(1)
  },
)
