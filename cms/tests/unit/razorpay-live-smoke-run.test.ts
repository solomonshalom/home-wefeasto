import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import * as env from '@/env'
import * as config from '@/payments/config'
import { MockGateway } from '@/payments/mock'
import * as razorpay from '@/payments/razorpay'
import * as signatures from '@/payments/signatures'
import * as webhookPayload from '@/payments/webhookPayload'

import { EXIT, projectModules, run } from '../../scripts/razorpay-live-smoke.mjs'

/**
 * `run()` end to end without the network: the project's MockGateway stands in for RazorpayGateway (same
 * PaymentGateway interface, real HMACs), every other function is the project's own.
 */

const KEY_ID = 'rzp_test_UnitSmoke0001AB'
const KEY_SECRET = 'unit-key-secret-7f3a9c2e1b5d'
const WH = 'unit-webhook-secret-4d8e0a6f2c'
const WH_OLD = 'unit-webhook-old-secret-9b1c3e'
const SECRETS = [KEY_SECRET, WH, WH_OLD, Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-rzp-smoke-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function envFile(name: string, vars: Record<string, string>): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'))
  return p
}

const good = envFile('good.env', {
  RAZORPAY_KEY_ID: KEY_ID,
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WH,
  RAZORPAY_WEBHOOK_SECRET_OLD: WH_OLD,
  PAYMENTS_MODE: 'razorpay',
  PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.com',
})

function harness(gateway: MockGateway | null, extra: { argv: string[]; interactive?: boolean; prompt?: (q: string) => Promise<string> }) {
  const lines: string[] = []
  let pageUrl: (url: string) => void = () => {}
  const page = new Promise<string>((resolve) => (pageUrl = resolve))
  const loadModules = vi.fn(async () =>
    projectModules({ razorpay, signatures, webhookPayload, config, env }, gateway ? { createGateway: () => gateway } : {}),
  )
  const done = run({
    argv: extra.argv,
    env: {},
    interactive: extra.interactive ?? false,
    prompt: extra.prompt,
    loadModules,
    openUrl: () => {},
    pollMs: 20,
    print: (line: string) => {
      lines.push(line)
      const m = /Checkout page: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/)/.exec(line)
      if (m) pageUrl(m[1])
    },
  })
  const output = () => lines.join('\n')
  const noSecrets = () => {
    for (const s of SECRETS) expect(output()).not.toContain(s)
  }
  return { done, page, output, noSecrets, loadModules }
}

const newMock = () => new MockGateway({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecrets: [WH, WH_OLD], runId: 'SMOKE1' })

describe('run() without keys or with live keys', () => {
  it('no keys → setup instructions, exit 2, nothing loaded', async () => {
    const h = harness(newMock(), { argv: ['--dotenv', envFile('none.env', { PAYMENTS_MODE: 'mock' })] })
    expect(await h.done).toBe(EXIT.SETUP)
    expect(h.output()).toMatch(/not configured[\s\S]*RAZORPAY_KEY_ID is not set[\s\S]*docs\/RAZORPAY-TEST-MODE\.md/)
    expect(h.loadModules).not.toHaveBeenCalled()
  })

  it('live keys → refused (exit 3) without --allow-live, and with a wrong confirmation', async () => {
    const live = envFile('live.env', { RAZORPAY_KEY_ID: 'rzp_live_UnitSmoke0001WX', RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH })
    const plain = harness(newMock(), { argv: ['--dotenv', live] })
    expect(await plain.done).toBe(EXIT.REFUSED)
    const prompt = vi.fn(async () => 'yes')
    const asked = harness(newMock(), { argv: ['--dotenv', live, '--allow-live'], interactive: true, prompt })
    expect(await asked.done).toBe(EXIT.REFUSED)
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('LIVE-01WX'))
    expect(plain.loadModules).not.toHaveBeenCalled()
    expect(asked.loadModules).not.toHaveBeenCalled()
    plain.noSecrets()
    asked.noSecrets()
  })
})

describe('run() with test keys', () => {
  it('API checks pass; a failed auth skips the API steps and exits 1', async () => {
    const ok = harness(newMock(), { argv: ['--dotenv', good] })
    expect(await ok.done).toBe(EXIT.OK)
    expect(ok.output()).toMatch(/^0 +config +PASS/m)
    expect(ok.output()).toMatch(/^5 +duplicate receipt +PASS +recovered: the same order/m)
    expect(ok.output()).toMatch(/^7 +webhook signature +PASS .*old secret accepted/m)
    expect(ok.output()).toMatch(/^8 +checkout +SKIP/m)
    ok.noSecrets()

    const mock = newMock()
    mock.failNext('findOrdersByReceipt', 'auth')
    const bad = harness(mock, { argv: ['--dotenv', good] })
    expect(await bad.done).toBe(EXIT.FAIL)
    expect(bad.output()).toMatch(/^1 +auth +FAIL .*Razorpay rejected the key pair/m)
    for (const n of [2, 3, 4, 5]) expect(bad.output()).toMatch(new RegExp(`^${n} +\\S.* +SKIP +skipped: the auth check failed`, 'm'))
    expect(bad.output()).toMatch(/^6 +payment signature +PASS/m)
    bad.noSecrets()
  })

  it('--checkout: serves the page, takes the handler triple, and runs the verify decision', async () => {
    const mock = newMock()
    const h = harness(mock, { argv: ['--dotenv', good, '--checkout', '--no-open', '--port', '0', '--wait', '30'] })
    const url = await h.page
    const html = await (await fetch(url)).text()
    expect(html).toContain(KEY_ID)
    expect(html).toContain('https://checkout.razorpay.com/v1/checkout.js')
    for (const s of SECRETS) expect(html).not.toContain(s)
    expect((await fetch(url.replace(/[0-9a-f]{32}\/$/, 'nope/'))).status).toBe(404)

    const orderId = /"orderId":"(order_[A-Za-z0-9]+)"/.exec(html)?.[1] ?? ''
    await fetch(`${url}event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'opened', data: { showCollect: true } }) })
    const failed = await mock.simulatePayment(orderId, { outcome: 'fail', reason: 'card_declined', method: 'card' })
    expect(failed.ok).toBe(false)
    const paid = await mock.simulatePayment(orderId, { outcome: 'success', method: 'upi' })
    if (!paid.ok) throw new Error('mock payment failed')
    const post = await fetch(`${url}event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'handler', data: paid.response }) })
    expect(post.status).toBe(204)

    expect(await h.done).toBe(EXIT.OK)
    const out = h.output()
    expect(out).toContain('page: Checkout opened with the UPI ID field')
    expect(out).toMatch(/order is paid: 2 attempt\(s\), ₹1\.00 paid/)
    expect(out).toMatch(/card_declined/)
    expect(out).toMatch(/verify: HTTP 200 → paid/)
    expect(out).toMatch(/^8 +checkout +PASS +paid by pay_\w+ \(upi, captured\); real Checkout signature verified/m)
    h.noSecrets()
  })

  it('--checkout with a forged handler signature fails the step', async () => {
    const mock = newMock()
    const h = harness(mock, { argv: ['--dotenv', good, '--checkout', '--no-open', '--port', '0', '--wait', '30'] })
    const url = await h.page
    const orderId = /"orderId":"(order_[A-Za-z0-9]+)"/.exec(await (await fetch(url)).text())?.[1] ?? ''
    const paid = await mock.simulatePayment(orderId, { outcome: 'success' })
    if (!paid.ok) throw new Error('mock payment failed')
    const forged = { ...paid.response, razorpay_signature: 'f'.repeat(64) }
    await fetch(`${url}event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'handler', data: forged }) })
    expect(await h.done).toBe(EXIT.FAIL)
    expect(h.output()).toMatch(/verify: HTTP 400 SIGNATURE_INVALID → signature_invalid/)
    expect(h.output()).toMatch(/^8 +checkout +FAIL .*REJECTED/m)
  })
})
