#!/usr/bin/env node
/*
 * Razorpay TEST-MODE smoke check.   npm run smoke:razorpay [-- --checkout]   (guide: docs/RAZORPAY-TEST-MODE.md)
 *
 * Talks to the REAL Razorpay API with the keys in cms/.env, through the project's own RazorpayGateway
 * (src/payments/razorpay.ts, loaded with tsx): the same wrapper checkout uses, not a second client.
 *   0. config      key mode (rzp_test_ only by default), PAYMENTS_MODE, the webhook URL Razorpay must reach
 *   1. auth        GET /v1/orders (findOrdersByReceipt with a fresh receipt → no orders)
 *   2. createOrder a ₹1 order with a unique `wf-smoke-…` receipt. Its notes carry no `wf_order`, so if the
 *                  CMS webhook sees its events it treats them as a foreign orphan: logged, never refunded.
 *   3. fetchOrder  amount / currency / status / receipt / notes round-trip
 *   4. payments    fetchOrderPayments → none yet
 *   5. receipt     createOrder again with the same receipt → "recovered" (same order) or "distinct"
 *   6. signature   Checkout HMAC with the real key secret: sign → verify; tampered / other order → rejected
 *   7. webhook     webhook HMAC with the real webhook secret over a Razorpay-style raw body
 *   8. --checkout  a page on 127.0.0.1 opens the REAL checkout.js for that order; pay with success@razorpay
 *                  or a test card; the script polls the order until paid, then runs the verify steps on the
 *                  handler's triple and prints what the storefront would do
 *   9. summary     a table. Exit 0 = passed (warnings allowed), 1 = a check failed, 2 = not configured or
 *                  bad arguments (prints the setup steps), 3 = refused (live keys), 130 = interrupted.
 *
 * Safety: rzp_live_ keys are refused unless --allow-live AND an interactive confirmation (typing
 * LIVE-<last 4 characters of the key id>). Secrets are never printed: every line goes through a redactor
 * that masks the key secret, the webhook secrets and the Basic-auth form of the key pair.
 *
 * The pure parts are exported for tests/unit/razorpay-live-smoke.test.ts; run() takes injectable I/O.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import dotenv from 'dotenv'

const CMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ENV_FILE = path.join(CMS_DIR, '.env')
export const SMOKE_AMOUNT_PAISE = 100
export const DEFAULT_PORT = 5199
export const DEFAULT_WAIT_SECONDS = 600
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, SETUP: 2, REFUSED: 3, INTERRUPTED: 130 })
export const REDACTED = '[redacted]'
/** The mock gateway's public dev defaults (src/payments/config.ts MOCK_DEFAULT_*): never real keys. */
export const MOCK_DEFAULTS = Object.freeze({
  keyId: 'rzp_test_WefeastoMock01',
  keySecret: 'wefeasto-mock-key-secret-dev-only',
  webhookSecret: 'wefeasto-mock-webhook-secret-dev-only',
})
/** Events the dashboard webhook must send (the CMS receiver handles all of them). */
export const WEBHOOK_EVENTS = Object.freeze([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.processed',
  'refund.failed',
  'payment.dispute.created',
])
const MIN_SECRET_LENGTH = 8

export const USAGE = `Usage: npm run smoke:razorpay [-- options]      (from cms/)

  --checkout          also open the REAL Razorpay Checkout (test mode) for the ₹1 order and wait for you to pay
  --port <n>          port of the local checkout page on 127.0.0.1 (default ${DEFAULT_PORT}; 0 = any free port)
  --wait <seconds>    how long --checkout waits for a payment (default ${DEFAULT_WAIT_SECONDS}, 30-3600)
  --no-open           print the checkout page URL instead of opening a browser
  --dotenv <path>     read the keys from this file (default cms/.env; non-empty process variables win)
  --allow-live        permit rzp_live_ keys; you still have to type a confirmation (never in CI)
  -h, --help          show this text

Exit codes: 0 passed (warnings allowed), 1 a check failed, 2 not configured / bad arguments, 3 refused (live keys).`

/* ----------------------------------------------------------------------------------- arguments */

const intIn = (raw, name, min, max) => {
  // Values are never echoed: arguments are parsed before the redactor knows the secrets.
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be a whole number`)
  const n = Number(raw)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
}

/**
 * @param {string[]} argv
 * @returns {{ ok: true, opts: { checkout: boolean, allowLive: boolean, open: boolean, port: number, waitSeconds: number, envFile: string | null, help: boolean } } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  const opts = { checkout: false, allowLive: false, open: true, port: DEFAULT_PORT, waitSeconds: DEFAULT_WAIT_SECONDS, envFile: null, help: false }
  const list = Array.isArray(argv) ? [...argv] : []
  try {
    for (let i = 0; i < list.length; i++) {
      let arg = String(list[i])
      let inline
      const eq = arg.indexOf('=')
      if (arg.startsWith('--') && eq > 2) {
        inline = arg.slice(eq + 1)
        arg = arg.slice(0, eq)
      }
      const flag = () => {
        if (inline !== undefined) throw new Error(`${arg} takes no value`)
        return true
      }
      const value = () => {
        if (inline !== undefined) return inline
        const next = list[++i]
        if (next === undefined || String(next).startsWith('-')) throw new Error(`${arg} needs a value`)
        return String(next)
      }
      switch (arg) {
        case '--checkout': opts.checkout = flag(); break
        case '--allow-live': opts.allowLive = flag(); break
        case '--no-open': opts.open = !flag(); break
        case '-h':
        case '--help': opts.help = flag(); break
        case '--port': opts.port = intIn(value(), '--port', 0, 65535); break
        case '--wait': opts.waitSeconds = intIn(value(), '--wait', 30, 3600); break
        case '--dotenv': {  // not --env-file: Node pre-scans argv for that flag
          const v = value().trim()
          if (!v) throw new Error('--dotenv needs a path')
          opts.envFile = v
          break
        }
        default:
          throw new Error(arg.startsWith('-') ? `Unknown option: ${arg}` : 'Unexpected argument (not shown): options start with --')
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, opts }
}

/* ------------------------------------------------------------------------- keys and configuration */

/** 'missing' | 'mock' (the dev default) | 'test' | 'live' | 'invalid' */
export function keyMode(keyId) {
  const k = typeof keyId === 'string' ? keyId.trim() : ''
  if (!k) return 'missing'
  if (k === MOCK_DEFAULTS.keyId) return 'mock'
  if (/^rzp_test_[A-Za-z0-9]{6,}$/.test(k)) return 'test'
  if (/^rzp_live_[A-Za-z0-9]{6,}$/.test(k)) return 'live'
  return 'invalid'
}

/** `rzp_test_…AbCd`: enough to recognise the key, not the whole id. */
export function maskKeyId(keyId) {
  const k = String(keyId ?? '')
  const prefix = /^rzp_(test|live)_/.exec(k)?.[0] ?? ''
  const rest = k.slice(prefix.length)
  return rest.length > 4 ? `${prefix}…${rest.slice(-4)}` : `${prefix}…`
}

const val = (src, key) => (typeof src?.[key] === 'string' ? src[key].trim() : '')

/**
 * The three secrets from an env record (trimmed like src/env.ts) plus what is wrong with them.
 * `missing` / `problems` stop the run (exit 2); `warnings` are shown in step 0.
 */
export function checkConfig(src) {
  const cfg = {
    keyId: val(src, 'RAZORPAY_KEY_ID'),
    keySecret: val(src, 'RAZORPAY_KEY_SECRET'),
    webhookSecret: val(src, 'RAZORPAY_WEBHOOK_SECRET'),
    webhookSecretOld: val(src, 'RAZORPAY_WEBHOOK_SECRET_OLD'),
  }
  const mode = keyMode(cfg.keyId)
  const missing = []
  const problems = []
  const warnings = []
  if (!cfg.keyId) missing.push('RAZORPAY_KEY_ID')
  if (!cfg.keySecret) missing.push('RAZORPAY_KEY_SECRET')
  if (!cfg.webhookSecret) missing.push('RAZORPAY_WEBHOOK_SECRET')
  if (mode === 'mock') problems.push(`RAZORPAY_KEY_ID is the mock gateway's public dev default (${MOCK_DEFAULTS.keyId}), not a Razorpay key.`)
  if (mode === 'invalid') problems.push('RAZORPAY_KEY_ID must look like rzp_test_XXXXXXXXXXXXXX (Dashboard, Test Mode, API Keys).')
  if (cfg.keySecret === MOCK_DEFAULTS.keySecret) problems.push("RAZORPAY_KEY_SECRET is the mock gateway's public dev default.")
  if (cfg.webhookSecret === MOCK_DEFAULTS.webhookSecret) problems.push("RAZORPAY_WEBHOOK_SECRET is the mock gateway's public dev default: choose your own.")
  if (cfg.keySecret && /^rzp_(test|live)_/.test(cfg.keySecret)) problems.push('RAZORPAY_KEY_SECRET looks like a key id (rzp_…): paste the secret shown next to the key id.')
  for (const [name, v] of [['RAZORPAY_KEY_SECRET', cfg.keySecret], ['RAZORPAY_WEBHOOK_SECRET', cfg.webhookSecret], ['RAZORPAY_WEBHOOK_SECRET_OLD', cfg.webhookSecretOld]]) {
    if (v && v.length < MIN_SECRET_LENGTH) problems.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters: that can't be right.`)
  }
  if (cfg.webhookSecret && cfg.webhookSecret === cfg.keySecret) warnings.push('RAZORPAY_WEBHOOK_SECRET equals the key secret: it works, but use a separate random value.')
  else if (cfg.webhookSecret && cfg.webhookSecret.length < 16) warnings.push('RAZORPAY_WEBHOOK_SECRET is short: use 32+ random characters.')
  return { ...cfg, mode, missing, problems, warnings }
}

/**
 * What to do about the key mode: run (test keys), confirm (live + --allow-live + a terminal), or refuse.
 * @returns {{ action: 'run' | 'confirm' | 'refuse', reason?: string }}
 */
export function guardKeyMode({ mode, allowLive, interactive }) {
  if (mode === 'test') return { action: 'run' }
  if (mode !== 'live') return { action: 'refuse', reason: `unusable key (${mode})` }
  if (!allowLive) return { action: 'refuse', reason: 'RAZORPAY_KEY_ID is a LIVE key (rzp_live_). This smoke test is for test mode. Use rzp_test_ keys, or pass --allow-live and confirm interactively.' }
  if (!interactive) return { action: 'refuse', reason: '--allow-live needs an interactive terminal to confirm (refused in CI / piped runs).' }
  return { action: 'confirm' }
}

/** The exact text to type to run with live keys: LIVE-<last 4 characters of the key id>. */
export const liveConfirmPhrase = (keyId) => `LIVE-${String(keyId ?? '').slice(-4)}`
export const isLiveConfirmation = (answer, keyId) => typeof answer === 'string' && answer.trim() === liveConfirmPhrase(keyId)

/* ------------------------------------------------------------------------------------ redaction */

/**
 * A function that masks every secret (raw, URL-encoded, JSON-escaped), the Basic-auth form of the key
 * pair, and any `Basic …` / `Bearer …` credential in a line of output. The key id is public (Checkout
 * ships it to browsers) and is left alone.
 */
export function makeRedactor({ keyId = '', keySecret = '', webhookSecret = '', webhookSecretOld = '' } = {}) {
  const needles = new Set()
  const add = (s) => {
    if (typeof s === 'string' && s.length >= 3) needles.add(s)
  }
  for (const s of [keySecret, webhookSecret, webhookSecretOld]) {
    if (typeof s !== 'string' || !s) continue
    add(s)
    add(encodeURIComponent(s))
    add(JSON.stringify(s).slice(1, -1))
  }
  if (keyId && keySecret) add(Buffer.from(`${keyId}:${keySecret}`).toString('base64'))
  const list = [...needles].sort((a, b) => b.length - a.length)
  return (value) => {
    let out = typeof value === 'string' ? value : String(value)
    for (const n of list) out = out.split(n).join(REDACTED)
    return out.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi, `$1 ${REDACTED}`)
  }
}

/* ------------------------------------------------------------------------------- output helpers */

export const rupees = (paise) => `₹${(Number(paise) / 100).toFixed(2)}`

/** Duck-typed GatewayError (never by class name: production builds rename classes). */
const isGatewayErrorLike = (e) => !!e && typeof e === 'object' && typeof e.kind === 'string' && typeof e.code === 'string' && 'statusCode' in e

export function describeError(err) {
  if (isGatewayErrorLike(err)) {
    const http = err.statusCode ? `HTTP ${err.statusCode}` : 'no HTTP response'
    return `${err.kind}/${err.code} (${http}${err.op ? `, ${err.op}` : ''}): ${err.description ?? ''}`.trim()
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/** Advice for the usual first-run failures. */
export function adviceFor(err) {
  if (!isGatewayErrorLike(err)) return ''
  if (err.kind === 'auth') return 'Razorpay rejected the key pair. Copy RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET again from the Dashboard in Test Mode (API Keys; regenerate if the secret is lost). Both must come from the same mode.'
  if (err.kind === 'network' || err.kind === 'timeout') return 'Could not reach api.razorpay.com: check the internet connection, VPN or proxy.'
  if (err.kind === 'rate_limited') return 'Razorpay rate-limited the account: wait a minute and run it again.'
  return ''
}

/** Plain-text table: # | Check | Result | Details. */
export function formatTable(rows) {
  const head = ['#', 'Check', 'Result', 'Details']
  const cells = rows.map((r) => [String(r.n), r.name, r.status, r.detail ?? ''])
  const width = (i) => Math.max(head[i].length, ...cells.map((c) => c[i].length))
  const w = [width(0), width(1), width(2)]
  const line = (c) => `${c[0].padEnd(w[0])}  ${c[1].padEnd(w[1])}  ${c[2].padEnd(w[2])}  ${c[3]}`.trimEnd()
  const rule = `${'-'.repeat(w[0])}  ${'-'.repeat(w[1])}  ${'-'.repeat(w[2])}  ${'-'.repeat(7)}`
  return [line(head), rule, ...cells.map(line)].join('\n')
}

/** 0 when nothing failed; 1 otherwise. */
export const exitCodeFor = (rows) => (rows.some((r) => r.status === 'FAIL') ? EXIT.FAIL : EXIT.OK)

export function setupInstructions({ missing = [], problems = [], envFile = DEFAULT_ENV_FILE } = {}) {
  const why = [
    ...missing.map((m) => `  - ${m} is not set`),
    ...problems.map((p) => `  - ${p}`),
  ]
  return `Razorpay smoke test: not configured${why.length ? `\n${why.join('\n')}` : ''}

This script checks the REAL Razorpay integration in TEST MODE. Put three values in ${envFile}:

  RAZORPAY_KEY_ID=rzp_test_...       Razorpay Dashboard, switch to Test Mode, API Keys, Generate Test Key
  RAZORPAY_KEY_SECRET=...            shown once next to the key id (regenerate the key if you lost it)
  RAZORPAY_WEBHOOK_SECRET=...        a random value YOU choose, e.g. the output of
                                     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
                                     and paste the same value when you add the webhook in the Dashboard

To make the CMS itself use them, also set PAYMENTS_MODE=razorpay and restart it.

Then run:   cd cms && npm run smoke:razorpay                 (API checks, about 10 seconds)
            cd cms && npm run smoke:razorpay -- --checkout   (also pay ₹1 in the real test Checkout)

Full guide: docs/RAZORPAY-TEST-MODE.md in the repo root (../docs/ from cms/)`
}

/* ---------------------------------------------------------------------------------- webhook URL */

const BLOCKED_WEBHOOK_HOSTS = ['ngrok.io', 'loca.lt', 'webhook.site', 'requestbin.com', 'hookbin.com', 'beeceptor.com', 'mockbin.org', 'burpcollaborator.net', 'oast.pro', 'interact.sh', 'canarytokens.com']

/** Why Razorpay could not deliver webhooks to this CMS origin (empty when it looks deliverable). */
export function webhookUrlProblems(serverUrl) {
  let u
  try {
    u = new URL(serverUrl)
  } catch {
    return ['PAYLOAD_PUBLIC_SERVER_URL is not an absolute URL']
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const out = []
  const local =
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (local) out.push(`${host} is a local address: Razorpay cannot reach it`)
  if (/\.(local|internal|corp|onion)$/.test(host) || host === 'localhost.localdomain') out.push(`${host} has a suffix Razorpay refuses`)
  const blocked = BLOCKED_WEBHOOK_HOSTS.find((d) => host === d || host.endsWith(`.${d}`))
  if (blocked) out.push(`${blocked} is on Razorpay's blocked list`)
  if (host.includes('razorpay')) out.push('the domain must not contain "razorpay"')
  if (u.port && u.port !== '80' && u.port !== '443') out.push(`port ${u.port}: Razorpay only delivers to ports 80 and 443`)
  if (u.protocol !== 'https:') out.push('not https (use HTTPS, TLS 1.2+)')
  return out
}

/* ------------------------------------------------------------------ verify (mirror of the CMS) */

const RE = { order: /^order_[A-Za-z0-9]{14,40}$/, pay: /^pay_[A-Za-z0-9]{14,40}$/, sig: /^[0-9a-f]{64}$/ }
const STOREFRONT_PRELUDE = 'The storefront POSTs the triple to /api/store/checkout/verify, then always goes to /order?no=…&t=…, which polls the order status.'

/**
 * The decision POST /api/store/checkout/verify makes for a Checkout triple (src/commerce/checkout/verify.ts
 * + markPaid step 3), without the database: `ourOrderId` is the Razorpay order id stored on our order.
 * Keep in step with verify.ts.
 * @returns {{ http: number, code?: string, outcome: string, ok: boolean, storefront: string }}
 */
export function decideVerify({ ourOrderId, orderAmount, triple, signatureValid, payment, fetchError }) {
  const t = triple && typeof triple === 'object' ? triple : {}
  const r = (http, outcome, ok, then, code) => ({ http, outcome, ok, storefront: `${STOREFRONT_PRELUDE} ${then}`, ...(code ? { code } : {}) })
  if (!RE.order.test(String(t.razorpay_order_id)) || !RE.pay.test(String(t.razorpay_payment_id)) || !RE.sig.test(String(t.razorpay_signature))) {
    return r(400, 'bad_request', false, 'Verify answers 400 VALIDATION (malformed ids or signature); /order keeps polling.', 'VALIDATION')
  }
  if (t.razorpay_order_id !== ourOrderId) {
    return r(404, 'not_found', false, "Verify answers 404: that Razorpay order is not one of this order's attempts.", 'NOT_FOUND')
  }
  if (!signatureValid) {
    return r(400, 'signature_invalid', false, 'Verify answers 400 SIGNATURE_INVALID and changes nothing; /order never shows "failed" for it. A real Checkout signature failing here means RAZORPAY_KEY_SECRET does not belong to RAZORPAY_KEY_ID.', 'SIGNATURE_INVALID')
  }
  if (fetchError || !payment) {
    return r(202, 'pending', false, 'fetchPayment failed, so verify answers 202; /order shows "Confirming your payment…" until the webhook or the reconcile job marks it paid.')
  }
  if (payment.order_id !== ourOrderId) {
    return r(400, 'signature_invalid', false, 'The payment belongs to another Razorpay order: verify answers 400 SIGNATURE_INVALID and logs an ALERT.', 'SIGNATURE_INVALID')
  }
  if (payment.status === 'failed') return r(202, 'pending', false, 'The payment failed: verify records the failure and answers 202; the customer can retry.')
  if (payment.status !== 'authorized' && payment.status !== 'captured') {
    return r(202, 'pending', false, `The payment is "${payment.status}": verify answers 202 and the webhook / reconcile settle it.`)
  }
  if (payment.amount !== orderAmount || String(payment.currency).toUpperCase() !== 'INR') {
    return r(200, 'amount_mismatch', false, `Amount/currency mismatch (${payment.amount} ${payment.currency}, expected ${orderAmount} INR): the order goes to needs_review, is NOT marked paid, and an ALERT is logged.`)
  }
  return r(200, 'paid', true, `Verify answers 200: markPaid(via client) marks the order paid (payment ${payment.status}); /order shows the confirmation at once. The order.paid / payment.captured webhooks that follow are deduplicated as already_paid.`)
}

/* ---------------------------------------------------------------------------------- environment */

/**
 * Values from the env file, overlaid by non-empty process variables (so `RAZORPAY_KEY_ID=… npm run
 * smoke:razorpay` works). A missing default file is fine; a missing explicit --dotenv file is an error.
 */
export function loadEnv(envFile, explicit, processEnv) {
  let fileVars = {}
  if (fs.existsSync(envFile)) fileVars = dotenv.parse(fs.readFileSync(envFile))
  else if (explicit) throw new Error(`--dotenv ${envFile} does not exist`)
  const merged = { ...fileVars }
  for (const [k, v] of Object.entries(processEnv ?? {})) {
    if (typeof v === 'string' && v.trim() !== '') merged[k] = v
  }
  return merged
}

/* ------------------------------------------------------------------------------ project modules */

/** The functions the smoke test needs, from the project's own TypeScript modules. */
export function projectModules(src, overrides = {}) {
  return {
    createGateway: (cfg, logger) =>
      new src.razorpay.RazorpayGateway({
        keyId: cfg.keyId,
        keySecret: cfg.keySecret,
        webhookSecret: cfg.webhookSecret,
        webhookSecretOld: cfg.webhookSecretOld || undefined,
        logger,
      }),
    signPayment: src.signatures.signPayment,
    signWebhook: src.signatures.signWebhook,
    buildWebhookBody: src.webhookPayload.buildWebhookBody,
    serializeWebhookBody: src.webhookPayload.serializeWebhookBody,
    parseWebhookBody: src.webhookPayload.parseWebhookBody,
    readEnv: src.env.readEnv,
    validateEnv: src.env.validateEnv,
    webhookPath: src.config.WEBHOOK_PATH,
    checkoutScript: src.config.RAZORPAY_CHECKOUT_SCRIPT,
    ...overrides,
  }
}

/** Loads src/payments + src/env with tsx (like `npm run seed`), so this script runs with plain node too. */
export async function loadProjectModules() {
  const { tsImport } = await import('tsx/esm/api')
  const load = (p) => tsImport(p, import.meta.url)
  return projectModules({
    razorpay: await load('../src/payments/razorpay.ts'),
    signatures: await load('../src/payments/signatures.ts'),
    webhookPayload: await load('../src/payments/webhookPayload.ts'),
    config: await load('../src/payments/config.ts'),
    env: await load('../src/env.ts'),
  })
}

/* ---------------------------------------------------------------------------------- checkout page */

/** JSON safe inside an inline <script>. */
const inlineJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * The local page: loads the real checkout.js and opens it for our order with the storefront's options
 * (src/lib/checkout/razorpay.js buildRazorpayOptions), or with UPI Collect visible so success@razorpay can
 * be typed. It only ever sees the public key id. Events go back to the script at `eventPath`.
 */
export function checkoutPageHtml({ keyId, orderId, amountPaise, receipt, eventPath, script, live = false }) {
  const cfg = { keyId, orderId, amount: amountPaise, receipt, eventPath, script }
  const badge = live
    ? '<p class="badge live">LIVE MODE: this charges a real card / UPI account. Refund it from the Dashboard afterwards.</p>'
    : '<p class="badge">TEST MODE: no real money moves.</p>'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Razorpay test checkout</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 16px;color:#1f1f1f;background:#fafafa}
code{font:14px ui-monospace,Menlo,monospace;background:#eee;padding:0 .25em;border-radius:3px}
.badge{display:inline-block;padding:.25rem .6rem;border-radius:4px;background:#e6f4ea;color:#14532d;font-weight:600}
.live{background:#fde8e8;color:#8a1111}
button{font:inherit;padding:.6rem 1rem;margin:.25rem .5rem .25rem 0;border:1px solid #333;border-radius:6px;background:#333;color:#fff;cursor:pointer}
button.alt{background:#fff;color:#333}button:disabled{opacity:.5;cursor:wait}
#log{white-space:pre-wrap;font:13px ui-monospace,Menlo,monospace;background:#fff;border:1px solid #ddd;padding:.75rem;min-height:5rem}
li{margin:.25rem 0}
</style></head><body>
<h1>Razorpay test checkout</h1>
${badge}
<p>Order <code>${esc(orderId)}</code>, <strong>${esc(rupees(amountPaise))}</strong>, receipt <code>${esc(receipt)}</code>, key <code>${esc(maskKeyId(keyId))}</code></p>
<p><button id="pay" disabled>Pay (storefront options)</button><button id="pay-upi" class="alt" disabled>Pay with the UPI ID field shown</button></p>
<details open><summary>Test credentials</summary><ul>
<li>UPI ID <code>success@razorpay</code> pays, <code>failure@razorpay</code> fails. Use the second button: the storefront hides UPI Collect (NPCI deprecated it), so the first shows a QR code instead.</li>
<li>Card <code>4100 2800 0000 1007</code> (Visa) or <code>5555 5100 0008 1006</code> (Mastercard): any future expiry, any CVV; on the bank page choose Success.</li>
<li>Failing card <code>4100 2800 0006 0003</code>: choose Failure on the bank page (card_declined). The modal stays open so you can retry on the same order.</li>
<li>Netbanking: any bank, then Success or Failure.</li>
</ul></details>
<h2>Events</h2><div id="log" role="log" aria-live="polite"></div>
<p>Keep the terminal open: the smoke script polls Razorpay and reports the result there.</p>
<script>
(function () {
  var CFG = ${inlineJson(cfg)};
  var logEl = document.getElementById('log');
  var buttons = [document.getElementById('pay'), document.getElementById('pay-upi')];
  function note(t) { logEl.textContent += new Date().toLocaleTimeString() + '  ' + t + '\\n'; }
  function send(type, data) {
    return fetch(CFG.eventPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: type, data: data || null }) })
      .catch(function () { note('Could not reach the smoke script. Is it still running?'); });
  }
  function open(showCollect) {
    var options = {
      key: CFG.keyId, order_id: CFG.orderId, amount: CFG.amount, currency: 'INR',
      name: 'Wefeasto', description: 'Smoke test ' + CFG.receipt,
      prefill: { name: 'Smoke Test', email: 'smoke-test@example.com', contact: '+919999999999' },
      notes: { wf_smoke: '1' }, theme: { color: '#333333' }, retry: { enabled: true }, timeout: 900,
      modal: { confirm_close: true, ondismiss: function () { note('Dismissed (closed without paying).'); send('dismiss'); } },
      handler: function (r) {
        note('Paid: handler got ' + r.razorpay_payment_id + '. Back to the terminal.');
        send('handler', { razorpay_payment_id: r.razorpay_payment_id, razorpay_order_id: r.razorpay_order_id, razorpay_signature: r.razorpay_signature });
      }
    };
    if (!showCollect) options.config = { display: { hide: [{ method: 'upi', flows: ['collect'] }] } };
    var rzp = new window.Razorpay(options);
    rzp.on('payment.failed', function (resp) {
      var e = (resp && resp.error) || {};
      note('payment.failed: ' + (e.reason || e.code || 'unknown') + ' ' + (e.description || ''));
      send('failed', { code: e.code, reason: e.reason, description: e.description, source: e.source, step: e.step, payment_id: e.metadata && e.metadata.payment_id });
    });
    rzp.open();
    note('Checkout opened' + (showCollect ? ' (UPI ID field shown).' : ' (storefront options).'));
    send('opened', { showCollect: !!showCollect });
  }
  buttons[0].onclick = function () { open(false); };
  buttons[1].onclick = function () { open(true); };
  var s = document.createElement('script');
  s.src = CFG.script;
  s.onload = function () { buttons.forEach(function (b) { b.disabled = false; }); note('checkout.js loaded.'); send('loaded'); };
  s.onerror = function () { note('checkout.js failed to load (offline, or blocked by an ad blocker?).'); send('script_error'); };
  document.head.appendChild(s);
})();
</script>
</body></html>`
}

/**
 * Serves the checkout page on 127.0.0.1 under an unguessable path (`/<token>/`) and accepts the page's
 * events at `/<token>/event` (JSON, ≤ 8 KB). Falls back to a free port when the preferred one is taken.
 */
export function startCheckoutServer({ html, port, token, onEvent, host = '127.0.0.1' }) {
  const base = `/${token}/`
  const server = http.createServer((req, res) => {
    const send = (status, body = '', type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
      res.end(body)
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && pathname === base) return send(200, html, 'text/html; charset=utf-8')
    if (req.method !== 'POST' || pathname !== `${base}event`) return send(404, 'not found')
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 8192) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return send(400, 'bad json')
      }
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') return send(400, 'bad event')
      try {
        onEvent(body)
      } catch {
        // a reporting problem must never break the page
      }
      send(204)
    })
  })
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  return new Promise((resolve, reject) => {
    const listen = (p, canFallBack) => {
      server.once('error', (err) => (canFallBack && err?.code === 'EADDRINUSE' ? listen(0, false) : reject(err)))
      server.listen(p, host, () => resolve({ url: `http://${host}:${server.address().port}${base}`, close }))
    }
    listen(port, port !== 0)
  })
}

export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // no browser: the URL is printed anyway
  }
}

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** setTimeout as a promise that ends early when `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/* --------------------------------------------------------------------------------- step helpers */

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const randomAlnum = (n) => [...crypto.randomBytes(n)].map((b) => ALNUM[b % ALNUM.length]).join('')

/** Notes on every smoke order: no `wf_order`, so the CMS webhook never attaches it to a real order. */
export const SMOKE_NOTES = Object.freeze({ wf_smoke: '1', purpose: 'razorpay-live-smoke' })

/** `wf-smoke-[tag-]YYYYMMDDhhmmss-xxxxxx`: unique, ≤ 40 printable ASCII, never a checkout receipt (`WF-10001-a1`). */
export function smokeReceipt(tag = '', now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14)
  const t = /^[a-z]{1,8}$/.test(tag) ? `${tag}-` : ''
  return `wf-smoke-${t}${stamp}-${randomAlnum(6).toLowerCase()}`
}

/** The same signature with its last hex digit changed. */
export const flipHex = (hex) => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`

/** PASS when every named check holds, else FAIL naming the ones that didn't. */
export function checkResult(checks, passDetail) {
  const failed = checks.filter(([, ok]) => ok !== true).map(([name]) => name)
  return failed.length ? { status: 'FAIL', detail: `failed: ${failed.join(', ')}` } : { status: 'PASS', detail: passDetail }
}

/** What differs between a fresh smoke order and what we asked for (empty = as expected). */
export function orderMismatches(o, { receipt, amount = SMOKE_AMOUNT_PAISE }) {
  const bad = []
  if (!o || typeof o !== 'object') return ['no order returned']
  if (!RE.order.test(String(o.id))) bad.push(`id ${JSON.stringify(o.id)} is not an order_ id`)
  if (o.amount !== amount) bad.push(`amount ${o.amount} ≠ ${amount}`)
  if (o.currency !== 'INR') bad.push(`currency ${o.currency} ≠ INR`)
  if (o.status !== 'created') bad.push(`status ${o.status} ≠ created`)
  if (o.receipt !== receipt) bad.push(`receipt ${o.receipt} ≠ ${receipt}`)
  if (o.amount_paid !== 0) bad.push(`amount_paid ${o.amount_paid} ≠ 0`)
  if (o.attempts !== 0) bad.push(`attempts ${o.attempts} ≠ 0`)
  if (o.notes?.wf_smoke !== SMOKE_NOTES.wf_smoke) bad.push('notes did not round-trip')
  return bad
}

/* ------------------------------------------------------------------------------------------ run */

/**
 * The whole smoke test. Never throws; returns the exit code. Every argument is injectable for tests:
 * `loadModules` (defaults to the project's TS modules through tsx), `print`, `prompt`, `openUrl`, `pollMs`.
 */
export async function run(io = {}) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    print = (line) => process.stdout.write(`${line}\n`),
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt = askLine,
    loadModules = loadProjectModules,
    openUrl = openInBrowser,
    pollMs = 3000,
    signal,
  } = io
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    print(`${parsed.error}\n\n${USAGE}`)
    return EXIT.SETUP
  }
  const opts = parsed.opts
  if (opts.help) {
    print(USAGE)
    return EXIT.OK
  }
  const envFile = opts.envFile ? path.resolve(opts.envFile) : DEFAULT_ENV_FILE
  let merged
  try {
    merged = loadEnv(envFile, Boolean(opts.envFile), env)
  } catch (err) {
    print(describeError(err))
    return EXIT.SETUP
  }
  const cfg = checkConfig(merged)
  const redact = makeRedactor(cfg)
  const out = (line = '') => print(redact(line))
  try {
    if (cfg.missing.length || cfg.problems.length) {
      out(setupInstructions({ missing: cfg.missing, problems: cfg.problems, envFile }))
      return EXIT.SETUP
    }
    const guard = guardKeyMode({ mode: cfg.mode, allowLive: opts.allowLive, interactive })
    if (guard.action === 'refuse') {
      out(`Refused: ${guard.reason}`)
      return EXIT.REFUSED
    }
    if (guard.action === 'confirm') {
      out(`LIVE keys (${maskKeyId(cfg.keyId)}): this creates two unpaid ${rupees(SMOKE_AMOUNT_PAISE)} LIVE orders${opts.checkout ? ' and, with --checkout, lets you make a REAL payment that you must refund from the Dashboard' : ''}.`)
      const answer = await prompt(`Type ${liveConfirmPhrase(cfg.keyId)} to continue, anything else to stop: `)
      if (!isLiveConfirmation(answer, cfg.keyId)) {
        out('Refused: the confirmation did not match.')
        return EXIT.REFUSED
      }
    }
    const mods = await loadModules()
    // Keep the event loop alive while requests are in flight (the gateway's timers are unref'd).
    const keepAlive = setInterval(() => {}, 60_000)
    try {
      return await runSteps({ cfg, opts, mods, merged, out, openUrl, pollMs, signal })
    } finally {
      clearInterval(keepAlive)
    }
  } catch (err) {
    out(`Unexpected error: ${describeError(err)}`)
    return EXIT.FAIL
  }
}

async function runSteps(ctx) {
  const { cfg, opts, mods, merged, out, signal } = ctx
  const rows = []
  const logger = {
    warn: (o) => out(`      gateway: ${o?.msg ?? 'warning'} (${[o?.op, o?.kind, o?.code].filter(Boolean).join(' ')})`),
    error: (o) => out(`      gateway: ${o?.msg ?? 'error'}`),
  }
  const gw = mods.createGateway(cfg, logger)
  const state = { authOk: false, order: null }
  const step = async (n, name, fn, skip) => {
    let row
    out(`[${n}] ${name}`)
    if (skip) row = { n, name, status: 'SKIP', detail: skip }
    else {
      try {
        row = { n, name, ...(await fn()) }
      } catch (err) {
        const desc = describeError(err)
        const advice = adviceFor(err)
        row = { n, name, status: 'FAIL', detail: advice ? `${desc}${/[.!?]$/.test(desc) ? '' : '.'} ${advice}` : desc }
      }
    }
    rows.push(row)
    out(`    ${row.status}  ${row.detail}`)
  }

  out(`Razorpay smoke test (${cfg.mode.toUpperCase()} mode, key ${maskKeyId(cfg.keyId)})`)

  await step(0, 'config', async () => {
    const warnings = [...cfg.warnings]
    const pm = String(merged.PAYMENTS_MODE ?? '').trim().toLowerCase() || 'mock'
    if (pm !== 'razorpay') warnings.push(`PAYMENTS_MODE=${pm}: the CMS still uses the mock gateway. Set PAYMENTS_MODE=razorpay and restart it to use these keys at checkout.`)
    const env = mods.readEnv({ ...merged, PAYMENTS_MODE: 'razorpay' })
    for (const e of mods.validateEnv(env).errors.filter((m) => /RAZORPAY|rzp_/.test(m))) warnings.push(`The CMS would refuse to boot: ${e}`)
    const hook = `${env.serverUrl}${mods.webhookPath}`
    const hookProblems = webhookUrlProblems(env.serverUrl)
    if (hookProblems.length) warnings.push(`Razorpay cannot deliver webhooks to ${hook} (${hookProblems.join('; ')}). Fine for these API checks; for webhooks use a deployed preview or a tunnel (docs/RAZORPAY-TEST-MODE.md).`)
    for (const w of warnings) out(`    ! ${w}`)
    const detail = `${cfg.mode} key ${maskKeyId(cfg.keyId)}, PAYMENTS_MODE=${pm}, webhook URL ${hook}${cfg.webhookSecretOld ? ', old webhook secret set' : ''}`
    return { status: warnings.length ? 'WARN' : 'PASS', detail: warnings.length ? `${detail} (${warnings.length} warning(s) above)` : detail }
  })

  await step(1, 'auth', async () => {
    const t0 = Date.now()
    const found = await gw.findOrdersByReceipt(smokeReceipt('auth'))
    state.authOk = true
    const ms = Date.now() - t0
    if (found.length) return { status: 'WARN', detail: `keys accepted (${ms} ms), but ${found.length} order(s) already use a brand-new receipt?` }
    return { status: 'PASS', detail: `keys accepted: GET /v1/orders answered in ${ms} ms` }
  })
  const noApi = state.authOk ? undefined : 'skipped: the auth check failed'

  const receipt = smokeReceipt()
  await step(2, 'createOrder', async () => {
    const o = await gw.createOrder({ amountPaise: SMOKE_AMOUNT_PAISE, receipt, notes: { ...SMOKE_NOTES } })
    state.order = o
    const bad = orderMismatches(o, { receipt })
    return bad.length ? { status: 'FAIL', detail: `${o.id}: ${bad.join('; ')}` } : { status: 'PASS', detail: `${o.id} for ${rupees(o.amount)}, receipt ${receipt}` }
  }, noApi)
  const noOrder = noApi ?? (state.order ? undefined : 'skipped: no order was created')

  await step(3, 'fetchOrder', async () => {
    const o = await gw.fetchOrder(state.order.id)
    const bad = orderMismatches(o, { receipt })
    if (o.id !== state.order.id) bad.unshift(`id ${o.id} ≠ ${state.order.id}`)
    return bad.length ? { status: 'FAIL', detail: bad.join('; ') } : { status: 'PASS', detail: `${o.id}: ${rupees(o.amount)} INR, status created, receipt and notes round-trip` }
  }, noOrder)

  await step(4, 'fetchOrderPayments', async () => {
    const list = await gw.fetchOrderPayments(state.order.id)
    return list.length ? { status: 'FAIL', detail: `a brand-new order already has ${list.length} payment(s)` } : { status: 'PASS', detail: 'no payments yet (the reconcile primitive works)' }
  }, noOrder)

  await step(5, 'duplicate receipt', () => duplicateReceiptStep(gw, state.order, receipt, signal), noOrder)
  await step(6, 'payment signature', async () => paymentSignatureStep(gw, mods, cfg, state.order))
  await step(7, 'webhook signature', async () => webhookSignatureStep(gw, mods, cfg, state.order, receipt))
  await step(8, 'checkout', () => checkoutStep(ctx, gw, state.order), opts.checkout ? noOrder : 'run with --checkout to pay ₹1 in the real test Checkout')

  const interrupted = Boolean(signal?.aborted)
  const code = interrupted ? EXIT.INTERRUPTED : exitCodeFor(rows)
  const count = (s) => rows.filter((r) => r.status === s).length
  out('')
  out(formatTable(rows))
  out('')
  out(`[9] RESULT: ${interrupted ? 'INTERRUPTED' : code === EXIT.OK ? 'PASS' : 'FAIL'} (${count('PASS')} passed, ${count('WARN')} warning(s), ${count('FAIL')} failed, ${count('SKIP')} skipped)`)
  if (state.order) out(`Test orders stay in the Dashboard (Transactions, Orders; receipt ${receipt}). Unpaid test orders are harmless.`)
  out('Next: the manual checklist in docs/RAZORPAY-TEST-MODE.md (storefront payments, redirect mode, webhooks, refunds).')
  return code
}

/* ------------------------------------------------------------------------------------ steps 5-7 */

async function duplicateReceiptStep(gw, first, receipt, signal) {
  const again = () => gw.createOrder({ amountPaise: SMOKE_AMOUNT_PAISE, receipt, notes: { ...SMOKE_NOTES } })
  let second
  let note = ''
  try {
    second = await again()
  } catch (err) {
    if (err?.code !== 'DUPLICATE_UNRESOLVED') throw err
    // Razorpay said "duplicate" before orders.all({receipt}) listed the order: give its index a moment.
    await sleep(3000, signal)
    try {
      second = await again()
      note = ' Razorpay said "duplicate" before orders.all listed the order; a retry 3 s later recovered it.'
    } catch (err2) {
      if (err2?.code !== 'DUPLICATE_UNRESOLVED') throw err2
      return { status: 'WARN', detail: 'Razorpay refused the duplicate receipt, but orders.all({receipt}) still did not list the existing order after 3 s: a retried checkout createOrder would answer 503 PAYMENTS_UNAVAILABLE until it does.' }
    }
  }
  const listed = await gw.findOrdersByReceipt(receipt)
  if (second.id === first.id) {
    return { status: 'PASS', detail: `recovered: the same order ${first.id} came back (Razorpay treats the receipt as an idempotency key; ${listed.length} order(s) with this receipt).${note}` }
  }
  return { status: 'PASS', detail: `distinct: Razorpay created a second order ${second.id} for the same receipt (${listed.length} order(s) listed); receipts are not enforced on this account. Harmless: a retried createOrder can leave one unpaid order that no customer sees.` }
}

function paymentSignatureStep(gw, mods, cfg, order) {
  const orderId = order?.id ?? `order_${randomAlnum(14)}`
  const paymentId = `pay_${randomAlnum(14)}`
  const signature = mods.signPayment(orderId, paymentId, cfg.keySecret)
  const verify = (i) => gw.verifyPaymentSignature(i)
  return checkResult(
    [
      ['a signed triple verifies', verify({ orderId, paymentId, signature }) === true],
      ['a tampered signature is rejected', verify({ orderId, paymentId, signature: flipHex(signature) }) === false],
      ['another order id is rejected', verify({ orderId: `order_${randomAlnum(14)}`, paymentId, signature }) === false],
      ['an uppercase signature is rejected', verify({ orderId, paymentId, signature: signature.toUpperCase() }) === false],
    ],
    'HMAC-SHA256(order_id|payment_id) with the real key secret: sign → verify; tampered, other-order and uppercase forgeries rejected (the real Checkout signature is checked by --checkout)',
  )
}

function webhookSignatureStep(gw, mods, cfg, order, receipt) {
  const now = Math.floor(Date.now() / 1000)
  const orderId = order?.id ?? `order_${randomAlnum(14)}`
  const payment = {
    id: `pay_${randomAlnum(14)}`, entity: 'payment', amount: SMOKE_AMOUNT_PAISE, currency: 'INR', status: 'captured',
    order_id: orderId, invoice_id: null, international: false, method: 'upi', amount_refunded: 0, refund_status: null,
    captured: true, description: 'Smoke test / ₹1', card_id: null, bank: null, wallet: null, vpa: 'success@razorpay',
    email: 'smoke-test@example.com', contact: '+919999999999', notes: { ...SMOKE_NOTES }, fee: 2, tax: 0,
    error_code: null, error_description: null, error_source: null, error_step: null, error_reason: null, created_at: now,
  }
  const rzpOrder = {
    id: orderId, entity: 'order', amount: SMOKE_AMOUNT_PAISE, currency: 'INR', receipt, offer_id: null,
    notes: { ...SMOKE_NOTES }, created_at: order?.created_at ?? now,
    status: 'paid', amount_paid: SMOKE_AMOUNT_PAISE, amount_due: 0, attempts: 1,
  }
  // Razorpay's PHP-style bytes: `/` → `\/`, `₹` → `₹`. Re-serialising them changes the bytes.
  const raw = mods.serializeWebhookBody(mods.buildWebhookBody('order.paid', { payment, order: rzpOrder }, { accountId: 'acc_WefeastoSmoke1', createdAt: now }))
  const sig = mods.signWebhook(raw, cfg.webhookSecret)
  const verify = (body, s) => gw.verifyWebhookSignature(body, s) === true
  const reserialised = JSON.stringify(JSON.parse(raw))
  const parsed = mods.parseWebhookBody(raw)
  const checks = [
    ['the raw body verifies', verify(raw, sig)],
    ['the raw bytes verify', verify(Buffer.from(raw, 'utf8'), sig)],
    ['a tampered body is rejected', !verify(raw.replace(`"amount":${SMOKE_AMOUNT_PAISE}`, `"amount":${SMOKE_AMOUNT_PAISE + 1}`), sig)],
    ['re-serialised JSON is rejected', reserialised !== raw && !verify(reserialised, sig)],
    ['a missing signature is rejected', !verify(raw, null)],
    ['it parses as order.paid', parsed?.event === 'order.paid' && parsed?.payment?.id === payment.id && parsed?.order?.id === orderId],
  ]
  if (cfg.webhookSecret !== cfg.keySecret) checks.push(['a body signed with the API key secret is rejected', !verify(raw, mods.signWebhook(raw, cfg.keySecret))])
  if (cfg.webhookSecretOld) checks.push(['the old secret is still accepted (rotation)', verify(raw, mods.signWebhook(raw, cfg.webhookSecretOld))])
  return checkResult(checks, `HMAC-SHA256 of the raw body with the webhook secret: ${checks.length} checks (tampered, re-serialised, unsigned${cfg.webhookSecret !== cfg.keySecret ? ', key-secret-signed' : ''} rejected${cfg.webhookSecretOld ? '; old secret accepted' : ''})`)
}

/* ------------------------------------------------------------------------------ step 8: checkout */

const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '')

async function checkoutStep(ctx, gw, order) {
  const { cfg, opts, mods, out, openUrl, pollMs, signal } = ctx
  const token = crypto.randomBytes(16).toString('hex')
  let triple = null
  let lastFailure = null
  const onEvent = (e) => {
    const d = e.data && typeof e.data === 'object' ? e.data : {}
    if (e.type === 'loaded') out('    page: checkout.js loaded')
    else if (e.type === 'script_error') out('    page: checkout.js failed to load (offline, or an ad blocker?)')
    else if (e.type === 'opened') out(`    page: Checkout opened${d.showCollect ? ' with the UPI ID field' : ' with the storefront options'}`)
    else if (e.type === 'dismiss') out('    page: Checkout closed without a payment')
    else if (e.type === 'failed') {
      lastFailure = { reason: text(d.reason, 64) || text(d.code, 64) || 'unknown', paymentId: text(d.payment_id, 64) }
      out(`    page: payment.failed ${lastFailure.reason} ${lastFailure.paymentId} ${text(d.description)}`.trimEnd())
    } else if (e.type === 'handler') {
      triple = { razorpay_payment_id: text(d.razorpay_payment_id, 64), razorpay_order_id: text(d.razorpay_order_id, 64), razorpay_signature: text(d.razorpay_signature, 64) }
      out(`    page: handler got ${triple.razorpay_payment_id} (signature ${triple.razorpay_signature.slice(0, 12)}…)`)
    }
  }
  const html = checkoutPageHtml({ keyId: cfg.keyId, orderId: order.id, amountPaise: order.amount, receipt: order.receipt, eventPath: `/${token}/event`, script: mods.checkoutScript, live: cfg.mode === 'live' })
  const server = await startCheckoutServer({ html, port: opts.port, token, onEvent })
  try {
    out(`    Checkout page: ${server.url}`)
    out(`    Pay ${rupees(order.amount)} there: success@razorpay (second button) or card 4100 2800 0000 1007. Waiting up to ${opts.waitSeconds} s; Ctrl-C stops.`)
    if (opts.open) openUrl(server.url)

    const deadline = Date.now() + opts.waitSeconds * 1000
    let seen = `${order.status}/${order.attempts}`
    let paid = null
    while (!signal?.aborted && Date.now() < deadline) {
      await sleep(pollMs, signal)
      if (signal?.aborted) break
      let o
      try {
        o = await gw.fetchOrder(order.id)
      } catch (err) {
        out(`    fetchOrder failed (${describeError(err)}); still waiting`)
        continue
      }
      if (`${o.status}/${o.attempts}` !== seen) {
        seen = `${o.status}/${o.attempts}`
        out(`    order is ${o.status}: ${o.attempts} attempt(s), ${rupees(o.amount_paid)} paid`)
      }
      if (o.status === 'paid') {
        paid = o
        break
      }
    }
    if (!paid) {
      const why = signal?.aborted ? 'interrupted before a payment' : `no successful payment within ${opts.waitSeconds} s`
      return { status: 'FAIL', detail: `${why} (order ${seen.split('/')[0]}${lastFailure ? `; last failure: ${lastFailure.reason}` : ''})` }
    }

    // Checkout calls the handler ~200 ms after its success screen: give the page a moment to report it.
    const tripleBy = Date.now() + 15_000
    while (!triple && !signal?.aborted && Date.now() < tripleBy) await sleep(Math.min(pollMs, 500), signal)

    const payments = await gw.fetchOrderPayments(order.id)
    for (const p of payments) out(`    ${p.id}  ${String(p.status).padEnd(10)} ${String(p.method ?? '').padEnd(10)} ${rupees(p.amount)}${p.error_reason ? `  ${p.error_reason}` : ''}`)
    let money = payments.find((p) => p.status === 'captured') ?? payments.find((p) => p.status === 'authorized')
    if (!money) return { status: 'FAIL', detail: 'Razorpay says the order is paid but lists no authorized/captured payment' }
    const warnings = []
    if (money.status === 'authorized') {
      // Auto-capture normally follows within seconds.
      const capBy = Date.now() + 30_000
      while (money.status === 'authorized' && !signal?.aborted && Date.now() < capBy) {
        await sleep(Math.min(pollMs, 3000), signal)
        money = await gw.fetchPayment(money.id).catch(() => money)
      }
      if (money.status === 'authorized') warnings.push('still authorized after 30 s: turn on automatic capture (Dashboard, Account & Settings, Payment capture)')
    }
    if (payments.filter((p) => ['captured', 'authorized', 'refunded'].includes(p.status)).length > 1) warnings.push('more than one payment took money on this order')

    if (!triple) {
      return { status: 'WARN', detail: `paid by ${money.id} (${money.method}, ${money.status}), but the page never reported the handler triple (tab closed?). The storefront would show "Confirming your payment…" until the webhook or the reconcile job marks it paid.` }
    }
    const sameOrder = triple.razorpay_order_id === order.id
    const signatureValid = sameOrder && gw.verifyPaymentSignature({ orderId: order.id, paymentId: triple.razorpay_payment_id, signature: triple.razorpay_signature }) === true
    let payment = null
    let fetchError = null
    if (signatureValid) {
      try {
        payment = await gw.fetchPayment(triple.razorpay_payment_id)
      } catch (err) {
        fetchError = err
        out(`    fetchPayment failed: ${describeError(err)}`)
      }
    }
    const d = decideVerify({ ourOrderId: order.id, orderAmount: order.amount, triple, signatureValid, payment, fetchError })
    out(`    verify: HTTP ${d.http}${d.code ? ` ${d.code}` : ''} → ${d.outcome}`)
    out(`    storefront: ${d.storefront}`)
    out(`    webhooks: Razorpay now sends order.paid / payment.captured for ${order.id} to your test-mode webhook URL, if one is set. It is not a CMS order, so the CMS answers 200 and only logs it (orphan); the Dashboard's webhook log should show 200.`)
    const status = !d.ok ? (d.outcome === 'pending' ? 'WARN' : 'FAIL') : warnings.length ? 'WARN' : 'PASS'
    const how = `${payment?.method ?? money.method}, ${payment?.status ?? money.status}`
    return { status, detail: `paid by ${triple.razorpay_payment_id} (${how}); real Checkout signature ${signatureValid ? 'verified with RAZORPAY_KEY_SECRET' : 'REJECTED'}; verify → ${d.http} ${d.outcome}${warnings.length ? `; ${warnings.join('; ')}` : ''}` }
  } finally {
    await server.close()
  }
}

/* ----------------------------------------------------------------------------------------- main */

async function main() {
  const controller = new AbortController()
  let interrupts = 0
  process.on('SIGINT', () => {
    interrupts += 1
    if (interrupts > 1) process.exit(EXIT.INTERRUPTED)
    process.stdout.write('\nInterrupted: finishing up (Ctrl-C again to quit at once)\n')
    controller.abort()
  })
  const code = await run({ signal: controller.signal })
  process.exit(code)
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}
const isEntry = Boolean(process.argv[1]) && realpath(path.resolve(process.argv[1])) === realpath(fileURLToPath(import.meta.url))
if (isEntry) {
  main().catch(() => {
    // run() never throws; this only guards against a broken runtime. No details: they could hold config.
    process.stderr.write('razorpay-live-smoke: unexpected failure\n')
    process.exit(EXIT.FAIL)
  })
}
