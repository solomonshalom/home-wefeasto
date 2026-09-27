import { describe, expect, it } from 'vitest'

import { MOCK_DEFAULT_KEY_ID, MOCK_DEFAULT_KEY_SECRET, MOCK_DEFAULT_WEBHOOK_SECRET } from '@/payments/config'

import {
  checkConfig,
  decideVerify,
  DEFAULT_PORT,
  DEFAULT_WAIT_SECONDS,
  formatTable,
  guardKeyMode,
  isLiveConfirmation,
  keyMode,
  liveConfirmPhrase,
  makeRedactor,
  maskKeyId,
  MOCK_DEFAULTS,
  orderMismatches,
  parseArgs,
  REDACTED,
  smokeReceipt,
  SMOKE_NOTES,
  WEBHOOK_EVENTS,
  webhookUrlProblems,
} from '../../scripts/razorpay-live-smoke.mjs'

/** Pure parts of `npm run smoke:razorpay` (cms/scripts/razorpay-live-smoke.mjs). */

describe('parseArgs', () => {
  it('defaults: API checks only, test keys only, open a browser, default port and wait', () => {
    expect(parseArgs([])).toEqual({
      ok: true,
      opts: { checkout: false, allowLive: false, open: true, port: DEFAULT_PORT, waitSeconds: DEFAULT_WAIT_SECONDS, envFile: null, help: false },
    })
  })

  it('reads every option, in both --flag value and --flag=value forms', () => {
    const r = parseArgs(['--checkout', '--allow-live', '--no-open', '--port', '0', '--wait=120', '--dotenv', 'x.env'])
    expect(r).toEqual({ ok: true, opts: { checkout: true, allowLive: true, open: false, port: 0, waitSeconds: 120, envFile: 'x.env', help: false } })
    expect(parseArgs(['-h'])).toMatchObject({ ok: true, opts: { help: true } })
    expect(parseArgs(['--help'])).toMatchObject({ ok: true, opts: { help: true } })
  })

  it.each([
    [['--bogus'], /Unknown option: --bogus/],
    [['--env-file', 'x'], /Unknown option: --env-file/],
    [['--port', '70000'], /--port must be between 0 and 65535/],
    [['--port', 'abc'], /--port must be a whole number/],
    [['--port', '-1'], /--port needs a value/],
    [['--wait', '5'], /--wait must be between 30 and 3600/],
    [['--wait=1.5'], /--wait must be a whole number/],
    [['--checkout=1'], /--checkout takes no value/],
    [['--dotenv'], /--dotenv needs a value/],
    [['--dotenv='], /--dotenv needs a path/],
    [['--port', '--checkout'], /--port needs a value/],
    [['rzp_secret_pasted_here'], /^Unexpected argument \(not shown\)/],
  ])('refuses %j', (argv, message) => {
    const r = parseArgs(argv)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toMatch(message)
    // Never echoes a value (it could be a pasted secret).
    for (const a of argv) if (!a.startsWith('-') && a.length > 3) expect(r.ok ? '' : r.error).not.toContain(a)
  })
})

describe('key mode guard', () => {
  it('classifies key ids', () => {
    expect(keyMode('')).toBe('missing')
    expect(keyMode('   ')).toBe('missing')
    expect(keyMode(undefined)).toBe('missing')
    expect(keyMode('rzp_test_AbCdEf1234WXYZ')).toBe('test')
    expect(keyMode(' rzp_test_AbCdEf1234WXYZ ')).toBe('test')
    expect(keyMode('rzp_live_AbCdEf1234WXYZ')).toBe('live')
    expect(keyMode(MOCK_DEFAULTS.keyId)).toBe('mock')
    expect(keyMode('rzp_test_')).toBe('invalid')
    expect(keyMode('rzp_TEST_AbCdEf1234')).toBe('invalid')
    expect(keyMode('AbCdEf1234WXYZ')).toBe('invalid')
  })

  it('runs test keys, refuses live keys by default, and needs a terminal to confirm live keys', () => {
    expect(guardKeyMode({ mode: 'test', allowLive: false, interactive: false })).toEqual({ action: 'run' })
    expect(guardKeyMode({ mode: 'live', allowLive: false, interactive: true })).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/LIVE key/) })
    expect(guardKeyMode({ mode: 'live', allowLive: true, interactive: false })).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/interactive/) })
    expect(guardKeyMode({ mode: 'live', allowLive: true, interactive: true })).toEqual({ action: 'confirm' })
    for (const mode of ['missing', 'mock', 'invalid']) expect(guardKeyMode({ mode, allowLive: true, interactive: true }).action).toBe('refuse')
  })

  it('confirms live mode only with the exact phrase', () => {
    const key = 'rzp_live_AbCdEf1234WXYZ'
    expect(liveConfirmPhrase(key)).toBe('LIVE-WXYZ')
    expect(isLiveConfirmation('LIVE-WXYZ', key)).toBe(true)
    expect(isLiveConfirmation('  LIVE-WXYZ\n', key)).toBe(true)
    for (const a of ['', 'y', 'yes', 'LIVE', 'live-wxyz', 'LIVE-WXY', undefined]) expect(isLiveConfirmation(a, key)).toBe(false)
  })

  it('masks key ids to the mode and the last 4 characters', () => {
    expect(maskKeyId('rzp_test_AbCdEf1234WXYZ')).toBe('rzp_test_…WXYZ')
    expect(maskKeyId('rzp_live_AbCdEf1234WXYZ')).toBe('rzp_live_…WXYZ')
    expect(maskKeyId('rzp_test_AB')).toBe('rzp_test_…')
  })
})

describe('checkConfig', () => {
  const good = { RAZORPAY_KEY_ID: 'rzp_test_AbCdEf1234WXYZ', RAZORPAY_KEY_SECRET: 'kS3cr3tValue0123456789ab', RAZORPAY_WEBHOOK_SECRET: 'whS3cr3t-0123456789abcdef-xyz' }

  it('lists every missing secret', () => {
    expect(checkConfig({}).missing).toEqual(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'])
    expect(checkConfig({ ...good, RAZORPAY_WEBHOOK_SECRET: '  ' }).missing).toEqual(['RAZORPAY_WEBHOOK_SECRET'])
  })

  it('accepts a complete test configuration (values trimmed like src/env.ts)', () => {
    const c = checkConfig({ ...good, RAZORPAY_KEY_ID: ` ${good.RAZORPAY_KEY_ID}\t` })
    expect(c).toMatchObject({ mode: 'test', keyId: good.RAZORPAY_KEY_ID, missing: [], problems: [], warnings: [] })
  })

  it("refuses the mock gateway's public dev defaults (kept in step with src/payments/config.ts)", () => {
    expect(MOCK_DEFAULTS).toEqual({ keyId: MOCK_DEFAULT_KEY_ID, keySecret: MOCK_DEFAULT_KEY_SECRET, webhookSecret: MOCK_DEFAULT_WEBHOOK_SECRET })
    const c = checkConfig({ RAZORPAY_KEY_ID: MOCK_DEFAULT_KEY_ID, RAZORPAY_KEY_SECRET: MOCK_DEFAULT_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: MOCK_DEFAULT_WEBHOOK_SECRET })
    expect(c.mode).toBe('mock')
    expect(c.problems).toHaveLength(3)
  })

  it('catches the usual copy-paste mistakes', () => {
    expect(checkConfig({ ...good, RAZORPAY_KEY_ID: 'AbCdEf1234WXYZ' }).problems.join()).toMatch(/must look like rzp_test_/)
    expect(checkConfig({ ...good, RAZORPAY_KEY_SECRET: good.RAZORPAY_KEY_ID }).problems.join()).toMatch(/looks like a key id/)
    expect(checkConfig({ ...good, RAZORPAY_WEBHOOK_SECRET: 'abc' }).problems.join()).toMatch(/shorter than 8/)
    expect(checkConfig({ ...good, RAZORPAY_WEBHOOK_SECRET: good.RAZORPAY_KEY_SECRET }).warnings.join()).toMatch(/equals the key secret/)
    expect(checkConfig({ ...good, RAZORPAY_WEBHOOK_SECRET: 'short-secret' }).warnings.join()).toMatch(/is short/)
  })
})

describe('makeRedactor', () => {
  const cfg = { keyId: 'rzp_test_AbCdEf1234WXYZ', keySecret: 'kS3cr3t/Value+01"23', webhookSecret: 'whS3cr3t-0123456789', webhookSecretOld: 'whOld-secret-98765' }
  const redact = makeRedactor(cfg)

  it('masks every secret, raw, URL-encoded and JSON-escaped', () => {
    const line = `a ${cfg.keySecret} b ${encodeURIComponent(cfg.keySecret)} c ${JSON.stringify({ s: cfg.keySecret })} d ${cfg.webhookSecret} e ${cfg.webhookSecretOld}`
    const out = redact(line)
    for (const s of [cfg.keySecret, encodeURIComponent(cfg.keySecret), JSON.stringify(cfg.keySecret).slice(1, -1), cfg.webhookSecret, cfg.webhookSecretOld]) {
      expect(out).not.toContain(s)
    }
    expect(out.split(REDACTED)).toHaveLength(6)
  })

  it('masks the Basic-auth form of the key pair and any Basic/Bearer credential', () => {
    const basic = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')
    expect(redact(`token ${basic} end`)).toBe(`token ${REDACTED} end`)
    expect(redact('authorization: Basic cnpwX3Rlc3RfeHh4Onl5eXk=')).toBe(`authorization: Basic ${REDACTED}`)
    expect(redact('Authorization: Bearer abc.def-ghi_jkl')).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  it('leaves the public key id and ordinary text alone; works on non-strings', () => {
    expect(redact(`key ${cfg.keyId}, order order_AbCdEf1234WXYZ`)).toBe(`key ${cfg.keyId}, order order_AbCdEf1234WXYZ`)
    expect(redact(42 as unknown as string)).toBe('42')
    expect(makeRedactor()('nothing configured')).toBe('nothing configured')
  })

  it('masks the longer secret first when one secret contains another', () => {
    const r = makeRedactor({ keySecret: 'abcdefgh', webhookSecret: 'abcdefgh-longer' })
    expect(r('x abcdefgh-longer y')).toBe(`x ${REDACTED} y`)
  })
})

describe('decideVerify (mirror of POST /api/store/checkout/verify)', () => {
  const ourOrderId = 'order_AbCdEf1234WXYZ'
  const triple = { razorpay_order_id: ourOrderId, razorpay_payment_id: 'pay_AbCdEf1234WXYZ', razorpay_signature: 'a'.repeat(64) }
  const payment = { order_id: ourOrderId, status: 'captured', amount: 100, currency: 'INR' }
  const base = { ourOrderId, orderAmount: 100, triple, signatureValid: true, payment, fetchError: null }

  it('a verified, captured, right-amount payment → 200 paid', () => {
    expect(decideVerify(base)).toMatchObject({ http: 200, outcome: 'paid', ok: true, storefront: expect.stringMatching(/\/order\?no=.*confirmation/) })
    expect(decideVerify({ ...base, payment: { ...payment, status: 'authorized' } })).toMatchObject({ http: 200, outcome: 'paid' })
  })

  it.each([
    ['malformed ids', { triple: { ...triple, razorpay_payment_id: 'pay_x' } }, 400, 'bad_request', 'VALIDATION'],
    ['an uppercase signature', { triple: { ...triple, razorpay_signature: 'A'.repeat(64) } }, 400, 'bad_request', 'VALIDATION'],
    ["someone else's Razorpay order", { triple: { ...triple, razorpay_order_id: 'order_ZZZZZZZZZZZZZZ' } }, 404, 'not_found', 'NOT_FOUND'],
    ['a bad signature', { signatureValid: false }, 400, 'signature_invalid', 'SIGNATURE_INVALID'],
    ['a payment of another order', { payment: { ...payment, order_id: 'order_ZZZZZZZZZZZZZZ' } }, 400, 'signature_invalid', 'SIGNATURE_INVALID'],
    ['fetchPayment failing', { payment: null, fetchError: new Error('timeout') }, 202, 'pending', undefined],
    ['a failed payment', { payment: { ...payment, status: 'failed' } }, 202, 'pending', undefined],
    ['a created payment', { payment: { ...payment, status: 'created' } }, 202, 'pending', undefined],
    ['a wrong amount', { payment: { ...payment, amount: 101 } }, 200, 'amount_mismatch', undefined],
    ['a wrong currency', { payment: { ...payment, currency: 'USD' } }, 200, 'amount_mismatch', undefined],
  ])('%s', (_label, change, http, outcome, code) => {
    const d = decideVerify({ ...base, ...change })
    expect(d).toMatchObject({ http, outcome, ok: false })
    expect(d.code).toBe(code)
    expect(d.storefront).toMatch(/^The storefront POSTs the triple/)
  })
})

describe('helpers', () => {
  it('smoke receipts are unique, ≤ 40 printable ASCII, and never look like checkout receipts', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const r = smokeReceipt(i % 2 ? 'auth' : '')
      expect(r).toMatch(/^wf-smoke-(auth-)?\d{14}-[a-z0-9]{6}$/)
      expect(r.length).toBeLessThanOrEqual(40)
      expect(r).not.toMatch(/^WF-/)
      seen.add(r)
    }
    expect(seen.size).toBe(50)
    expect(smokeReceipt('Not A Tag!', new Date('2026-09-27T01:02:03Z'))).toMatch(/^wf-smoke-20260927010203-/)
    expect(SMOKE_NOTES).not.toHaveProperty('wf_order')
  })

  it('webhook URL problems: local dev is unreachable, a public https origin is fine', () => {
    expect(webhookUrlProblems('http://localhost:3000')).toHaveLength(3)
    expect(webhookUrlProblems('https://cms.wefeasto.com')).toEqual([])
    expect(webhookUrlProblems('https://wefeasto-cms-git-main.vercel.app')).toEqual([])
    expect(webhookUrlProblems('https://abc.trycloudflare.com')).toEqual([])
    expect(webhookUrlProblems('https://abc.ngrok.io').join()).toMatch(/blocked list/)
    expect(webhookUrlProblems('https://192.168.1.20').join()).toMatch(/local address/)
    expect(webhookUrlProblems('https://[::1]').join()).toMatch(/local address/)
    expect(webhookUrlProblems('https://shop.corp').join()).toMatch(/suffix/)
    expect(webhookUrlProblems('https://my-razorpay-hooks.example.com').join()).toMatch(/must not contain "razorpay"/)
    expect(webhookUrlProblems('https://cms.example.com:8443').join()).toMatch(/ports 80 and 443/)
    expect(webhookUrlProblems('not a url')).toEqual(['PAYLOAD_PUBLIC_SERVER_URL is not an absolute URL'])
  })

  it('the webhook events the guide tells the owner to subscribe to', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      ['order.paid', 'payment.authorized', 'payment.captured', 'payment.dispute.created', 'payment.failed', 'refund.failed', 'refund.processed'].sort(),
    )
  })

  it('orderMismatches lists every difference from a fresh ₹1 smoke order', () => {
    const o = { id: 'order_AbCdEf1234WXYZ', amount: 100, currency: 'INR', status: 'created', receipt: 'r1', amount_paid: 0, attempts: 0, notes: { ...SMOKE_NOTES } }
    expect(orderMismatches(o, { receipt: 'r1' })).toEqual([])
    expect(orderMismatches({ ...o, amount: 200, status: 'paid', notes: {} }, { receipt: 'r2' })).toHaveLength(4)
    expect(orderMismatches(null, { receipt: 'r1' })).toEqual(['no order returned'])
  })

  it('formatTable aligns the columns', () => {
    const t = formatTable([
      { n: 0, name: 'config', status: 'PASS', detail: 'ok' },
      { n: 1, name: 'createOrder', status: 'FAIL', detail: 'boom' },
    ]).split('\n')
    expect(t[0]).toMatch(/^#\s+Check\s+Result\s+Details$/)
    expect(t[2]).toBe('0  config       PASS    ok')
    expect(t[3]).toBe('1  createOrder  FAIL    boom')
  })
})
