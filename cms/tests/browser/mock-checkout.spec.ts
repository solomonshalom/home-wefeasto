import { expect, test, type Browser, type Page } from '@playwright/test'

import { getMockGateway } from '../../src/payments/index'
import type { MockGateway } from '../../src/payments/mock'
import { verifyPaymentSignature } from '../../src/payments/signatures'
import { MOCK_DEFAULT_KEY_SECRET } from '../../src/payments/config'
import { startHarness, type Harness } from './harness'

/**
 * The mock checkout.js in a real browser (Chromium), against the real /api/payments/mock/* handlers and
 * MockGateway running in this test process (see harness.ts). Covers the storefront-facing contract:
 * handler / payment.failed / ondismiss semantics, in-modal retry, redirect mode (forced by UA or
 * redirect:true) form POSTs, the __WF_MOCK_RZP__ automation hooks, and accessibility (dialog, focus trap,
 * Esc, focus return).
 */

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1'
const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 Instagram 347.0.0.36.89 Android'
const FACEBOOK_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.94;FBBV/600000000]'
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'

let h: Harness
let mock: MockGateway

test.beforeAll(async () => {
  h = await startHarness()
  const m = getMockGateway()
  if (!m) throw new Error('expected the mock gateway')
  mock = m
})

test.afterAll(async () => {
  await h?.close()
})

let seq = 0
const newOrder = (amountPaise = 47400) =>
  mock.createOrder({ amountPaise, receipt: `WF-BR-${Date.now() % 1e9}-${++seq}`, notes: { wf_order: 'WF-10001' } })

type Auto = NonNullable<Window['__WF_MOCK_RZP__']>

async function openCheckout(
  page: Page,
  orderId: string,
  overrides: Record<string, unknown> = {},
  flags: { noHandler?: boolean; noDismiss?: boolean } = {},
  auto?: Auto,
) {
  await page.goto(`${h.url}/harness.html`)
  await page.evaluate(
    ([o, f, a]) => {
      window.__nextOptions = o
      window.__nextFlags = f
      if (a) window.__WF_MOCK_RZP__ = a
    },
    [{ order_id: orderId, ...overrides }, flags, auto ?? null] as const,
  )
  await page.click('#opener')
}

const log = (page: Page) => page.evaluate(() => window.__log)
const dialog = (page: Page) => page.getByRole('dialog')
const payButton = (page: Page) => page.getByRole('button', { name: /^Pay/ })
const webhooksFor = (orderId: string) => h.webhooks.filter((w) => w.body.includes(orderId)).map((w) => w.event)

async function redirectPage(browser: Browser, userAgent: string) {
  const context = await browser.newContext({ userAgent })
  return { context, page: await context.newPage() }
}

test.describe('popup mode', () => {
  test('success → modal closes, then handler gets a verifiable triple; ondismiss is not called', async ({ page }) => {
    const order = await newOrder(47400)
    await openCheckout(page, order.id)
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true')
    await expect(dialog(page)).toHaveAccessibleName('Wefeasto')
    await expect(dialog(page)).toHaveAccessibleDescription('Order WF-10001')
    await expect(page.getByText('Test mode · mock payment')).toBeVisible()
    await expect(payButton(page)).toHaveText('Pay ₹474')
    await payButton(page).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => log(page)).toHaveLength(1)
    const [entry] = await log(page)
    if (entry.type !== 'handler') throw new Error(`expected handler, got ${entry.type}`)
    expect(entry.modalPresent).toBe(false) // handler runs after the modal is gone
    expect(entry.response.razorpay_order_id).toBe(order.id)
    expect(
      verifyPaymentSignature({ orderId: order.id, paymentId: entry.response.razorpay_payment_id, signature: entry.response.razorpay_signature, keySecret: MOCK_DEFAULT_KEY_SECRET }),
    ).toBe(true)
    expect(await mock.fetchPayment(entry.response.razorpay_payment_id)).toMatchObject({ status: 'captured', method: 'upi', email: 'asha@example.com', contact: '+919876543210' })
    await page.waitForTimeout(300)
    expect((await log(page)).map((e) => e.type)).toEqual(['handler'])
    await expect.poll(() => webhooksFor(order.id)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
  })

  test('fail → payment.failed, modal stays open for retry → success on the same order', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id)
    await page.getByRole('button', { name: 'Fail payment' }).click()
    await expect(page.getByRole('alert')).toContainText('Payment failed')
    await expect(dialog(page)).toBeVisible()
    await expect(payButton(page)).toBeFocused()
    const afterFail = await log(page)
    expect(afterFail).toHaveLength(1)
    expect(afterFail[0]).toMatchObject({
      type: 'payment.failed',
      error: { code: 'BAD_REQUEST_ERROR', reason: 'payment_failed', source: expect.any(String), step: expect.any(String), metadata: { order_id: order.id, payment_id: expect.stringMatching(/^pay_Mock/) } },
    })
    await payButton(page).click()
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['payment.failed', 'handler'])
    const payments = await mock.fetchOrderPayments(order.id)
    expect(payments.map((p) => p.status)).toEqual(['captured', 'failed'])
    expect((await mock.fetchOrder(order.id)).status).toBe('paid')
  })

  test('the chosen method is sent; theme.color styles the pay button with readable text', async ({ page }) => {
    const order = await newOrder(47450)
    await openCheckout(page, order.id, { amount: 47450, theme: { color: '#ff8d5e' }, prefill: { method: 'card', email: 'x@example.com' } })
    await expect(payButton(page)).toHaveText('Pay ₹474.50')
    await expect(payButton(page)).toHaveCSS('background-color', 'rgb(255, 141, 94)')
    await expect(payButton(page)).toHaveCSS('color', 'rgb(0, 0, 0)')
    await expect(page.getByLabel('Pay with')).toHaveValue('card')
    await page.getByLabel('Pay with').selectOption('netbanking')
    await payButton(page).click()
    await expect.poll(async () => (await log(page)).length).toBe(1)
    const [p] = await mock.fetchOrderPayments(order.id)
    expect(p).toMatchObject({ method: 'netbanking', bank: 'HDFC', email: 'x@example.com' })
  })

  test('a double click creates one payment only', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id)
    await payButton(page).dblclick()
    await expect.poll(async () => (await log(page)).length).toBe(1)
    await page.waitForTimeout(300)
    expect(await mock.fetchOrderPayments(order.id)).toHaveLength(1)
  })

  test('Cancel → ondismiss; no payment is created', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
    expect(await mock.fetchOrderPayments(order.id)).toEqual([])
    await expect(page.locator('#opener')).toBeFocused() // focus returns to the opener
  })

  test('modal.confirm_close asks first; "No" returns to payment, "Yes" dismisses', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, { modal: { confirm_close: true } })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Are you sure you want to cancel the payment?')).toBeVisible()
    await expect(page.getByRole('button', { name: 'No, go back' })).toBeFocused()
    await page.getByRole('button', { name: 'No, go back' }).click()
    await expect(payButton(page)).toBeVisible()
    await page.keyboard.press('Escape') // Esc also goes through the confirmation
    await expect(page.getByText('Are you sure you want to cancel the payment?')).toBeVisible()
    await page.keyboard.press('Escape') // …and Esc on the confirmation means "No"
    await expect(payButton(page)).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Yes, cancel' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
  })

  test('focus is trapped in the dialog; Esc dismisses and focus returns to the opener', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id)
    await expect(payButton(page)).toBeFocused()
    const where = () =>
      page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        return `${a?.getAttribute('data-action') ?? a?.tagName.toLowerCase()}:${Boolean(a?.closest('[role="dialog"]'))}`
      })
    const forward: string[] = []
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      forward.push(await where())
    }
    expect(forward).toEqual(['fail:true', 'cancel:true', 'select:true', 'pay:true', 'fail:true', 'cancel:true', 'select:true', 'pay:true'])
    await page.keyboard.press('Shift+Tab')
    expect(await where()).toBe('select:true')
    await page.keyboard.press('Shift+Tab')
    expect(await where()).toBe('cancel:true')
    // focus moved out programmatically is pulled back in
    await page.evaluate(() => (document.getElementById('outside') as HTMLInputElement).focus())
    expect((await where()).endsWith(':true')).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
    await expect(page.locator('#opener')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('')
  })

  test('modal.escape === false ignores Esc; backdrop clicks dismiss only with modal.backdropclose', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, { modal: { escape: false } })
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5) // backdrop, backdropclose defaults to false
    await page.waitForTimeout(200)
    await expect(dialog(page)).toBeVisible()
    expect(await log(page)).toEqual([])

    await openCheckout(page, order.id, { modal: { backdropclose: true } })
    await page.mouse.click(5, 5)
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
  })

  test('retry disabled: a failure closes Checkout, calls ondismiss and alerts like checkout.js', async ({ page }) => {
    const order = await newOrder()
    const alerts: string[] = []
    page.on('dialog', (d) => {
      alerts.push(d.message())
      void d.dismiss()
    })
    await openCheckout(page, order.id, { retry: { enabled: false } })
    await page.getByRole('button', { name: 'Fail payment' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['payment.failed', 'ondismiss'])
    expect(alerts).toEqual(['Payment Failed.\nPayment failed'])
  })

  test('options.timeout auto-dismisses', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, { timeout: 1 })
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page)).toHaveCount(0, { timeout: 3000 })
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
  })

  test('rzp.close() closes without ondismiss', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id)
    await expect(dialog(page)).toBeVisible()
    await page.evaluate(() => window.__rzp?.close())
    await expect(dialog(page)).toHaveCount(0)
    await page.waitForTimeout(300)
    expect(await log(page)).toEqual([])
  })

  test('an unknown order shows the server error in the modal and fires nothing', async ({ page }) => {
    await openCheckout(page, 'order_MockZZZZZZ9999')
    await payButton(page).click()
    await expect(page.getByRole('alert')).toHaveText('The id provided does not exist.')
    await expect(dialog(page)).toBeVisible()
    expect(await log(page)).toEqual([])
  })

  test('an options.amount that differs from the order amount is refused in the modal (order_amount_mismatch)', async ({ page }) => {
    const order = await newOrder(47400)
    await openCheckout(page, order.id, { amount: 100 })
    await payButton(page).click()
    await expect(page.getByRole('alert')).toContainText('does not match the order amount')
    await expect(dialog(page)).toBeVisible()
    expect(await log(page)).toEqual([])
    expect(await mock.fetchOrderPayments(order.id)).toEqual([])
  })

  test('a key that is not the server key opens nothing and fires nothing (like a bogus key)', async ({ page }) => {
    const order = await newOrder()
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })
    await openCheckout(page, order.id, { key: 'rzp_test_SomeOtherKey01' })
    await page.waitForTimeout(500)
    await expect(dialog(page)).toHaveCount(0)
    expect(await log(page)).toEqual([])
    expect(await page.evaluate(() => window.__wfMockRzpInstances?.[0]?.silent)).toBe('key_mismatch')
    expect(warnings.some((w) => w.includes('does not match the server key'))).toBe(true)
  })

  test('new Razorpay() without a key throws "No key passed"; instances record the options', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id)
    expect(await page.evaluate(() => {
      try {
        new window.Razorpay({})
        return 'no error'
      } catch (e) {
        return (e as Error).message
      }
    })).toBe('No key passed')
    const [instance] = (await page.evaluate(() => window.__wfMockRzpInstances)) ?? []
    expect(instance.options).toMatchObject({ key: h.keyId, order_id: order.id, amount: 47400, currency: 'INR', handler: '[fn]', prefill: { contact: '+919876543210' } })
    expect(instance.redirect).toBe(false)
  })

  test('callback_url on a desktop browser does not force redirect mode', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, { callback_url: `${h.url}/callback?no=WF-10001` })
    await payButton(page).click()
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['handler'])
    expect(h.callbacks.filter((c) => c.fields.razorpay_order_id === order.id)).toEqual([])
  })

  test('without a handler, success is form-POSTed to callback_url (Razorpay default handler)', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, { callback_url: `${h.url}/callback?no=WF-10001` }, { noHandler: true })
    await payButton(page).click()
    await page.waitForURL(/\/callback\?no=WF-10001$/)
    const cb = h.callbacks.find((c) => c.fields.razorpay_order_id === order.id)
    expect(Object.keys(cb?.fields ?? {}).sort()).toEqual(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'])
  })
})

test.describe('redirect mode', () => {
  for (const [label, ua] of [
    ['iPhone Safari', IPHONE_SAFARI],
    ['Chrome on iOS (CriOS)', CHROME_IOS],
    ['Instagram in-app (Android)', INSTAGRAM_ANDROID],
    ['Facebook in-app (FBAN)', FACEBOOK_IOS],
    ['Android WebView (; wv))', ANDROID_WEBVIEW],
  ] as const) {
    test(`${label}: success form-POSTs exactly the three fields to callback_url`, async ({ browser }) => {
      const { context, page } = await redirectPage(browser, ua)
      try {
        const order = await newOrder()
        await openCheckout(page, order.id, { callback_url: `${h.url}/callback?no=WF-10001&t=tok123` })
        await expect(dialog(page)).toBeVisible()
        await expect(page.getByText('Redirect mode: the result is posted to the callback URL.')).toBeVisible()
        await payButton(page).click()
        await page.waitForURL(/\/callback\?no=WF-10001&t=tok123$/)
        await expect(page.locator('#callback')).toBeVisible()
        const cb = h.callbacks.find((c) => c.fields.razorpay_order_id === order.id)
        if (!cb) throw new Error('no callback recorded')
        expect(cb.contentType).toBe('application/x-www-form-urlencoded')
        expect(cb.query).toEqual({ no: 'WF-10001', t: 'tok123' })
        expect(Object.keys(cb.fields).sort()).toEqual(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'])
        expect(
          verifyPaymentSignature({ orderId: order.id, paymentId: cb.fields.razorpay_payment_id, signature: cb.fields.razorpay_signature, keySecret: MOCK_DEFAULT_KEY_SECRET }),
        ).toBe(true)
      } finally {
        await context.close()
      }
    })
  }

  test('failure form-POSTs error[...] fields with error[metadata] as a JSON string', async ({ browser }) => {
    const { context, page } = await redirectPage(browser, IPHONE_SAFARI)
    try {
      const order = await newOrder()
      await openCheckout(page, order.id, { callback_url: `${h.url}/callback?no=WF-10002&t=tok` })
      await page.getByRole('button', { name: 'Fail payment' }).click()
      await page.waitForURL(/\/callback\?no=WF-10002&t=tok$/)
      const cb = h.callbacks.find((c) => c.fields['error[metadata]']?.includes(order.id))
      if (!cb) throw new Error('no callback recorded')
      expect(Object.keys(cb.fields).sort()).toEqual(['error[code]', 'error[description]', 'error[metadata]', 'error[reason]', 'error[source]', 'error[step]'])
      expect(cb.fields['error[code]']).toBe('BAD_REQUEST_ERROR')
      expect(cb.fields['error[reason]']).toBe('payment_failed')
      const metadata = JSON.parse(cb.fields['error[metadata]'])
      expect(metadata).toEqual({ order_id: order.id, payment_id: expect.stringMatching(/^pay_Mock/) })
      expect((await mock.fetchPayment(metadata.payment_id)).status).toBe('failed')
    } finally {
      await context.close()
    }
  })

  test('redirect: true forces redirect mode on desktop too; Cancel still just dismisses', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, { callback_url: `${h.url}/callback?no=WF-10003`, redirect: true })
    expect(await page.evaluate(() => window.__wfMockRzpInstances?.[0]?.redirect)).toBe(true)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
    await page.click('#opener')
    await payButton(page).click()
    await page.waitForURL(/\/callback\?no=WF-10003$/)
    expect(h.callbacks.some((c) => c.fields.razorpay_order_id === order.id)).toBe(true)
  })

  test('forced-redirect UAs without callback_url stay in popup mode (handler)', async ({ browser }) => {
    const { context, page } = await redirectPage(browser, IPHONE_SAFARI)
    try {
      const order = await newOrder()
      await openCheckout(page, order.id)
      await payButton(page).click()
      await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['handler'])
    } finally {
      await context.close()
    }
  })

  test('plain Android Chrome is not forced into redirect mode', async ({ browser }) => {
    const { context, page } = await redirectPage(browser, ANDROID_CHROME)
    try {
      const order = await newOrder()
      await openCheckout(page, order.id, { callback_url: `${h.url}/callback` })
      expect(await page.evaluate(() => window.__wfMockRzpInstances?.[0]?.redirect)).toBe(false)
    } finally {
      await context.close()
    }
  })
})

test.describe('window.__WF_MOCK_RZP__ automation', () => {
  test("auto 'success' pays without clicks", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'success', delayMs: 50 })
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['handler'])
    expect((await mock.fetchOrder(order.id)).status).toBe('paid')
  })

  test("auto 'fail' fails once, then the customer closes the modal", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'fail', delayMs: 50, reason: 'insufficient_funds' })
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['payment.failed', 'ondismiss'])
    const [failed] = await log(page)
    expect(failed).toMatchObject({ error: { reason: 'insufficient_funds' } })
    await expect(dialog(page)).toHaveCount(0)
    expect((await mock.fetchOrder(order.id)).status).toBe('attempted')
    await expect.poll(() => webhooksFor(order.id)).toEqual(['payment.failed'])
  })

  test("auto 'fail_then_success' retries in the modal on the same order", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'fail_then_success', delayMs: 50 })
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['payment.failed', 'handler'])
    expect((await mock.fetchOrderPayments(order.id)).map((p) => p.status)).toEqual(['captured', 'failed'])
  })

  test("auto 'dismiss' dismisses without paying", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'dismiss', delayMs: 50 })
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['ondismiss'])
    expect(await mock.fetchOrderPayments(order.id)).toEqual([])
  })

  test("auto 'lost': paid server-side with webhooks, but no handler and no ondismiss", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'lost', delayMs: 50 })
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await mock.fetchOrder(order.id)).status).toBe('paid')
    await expect.poll(() => webhooksFor(order.id)).toEqual(['payment.authorized', 'payment.captured', 'order.paid'])
    await page.waitForTimeout(400)
    expect(await log(page)).toEqual([])
  })

  test("auto 'silent': nothing renders and nothing fires", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'silent' })
    await page.waitForTimeout(600)
    await expect(dialog(page)).toHaveCount(0)
    expect(await log(page)).toEqual([])
    expect((await mock.fetchOrder(order.id)).attempts).toBe(0)
    expect(await page.evaluate(() => window.__wfMockRzpInstances?.[0]?.silent)).toBe('auto')
  })

  test("auto 'late': fails now (then dismiss), the bank authorises it later", async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'late', delayMs: 50 })
    await expect.poll(async () => (await log(page)).map((e) => e.type)).toEqual(['payment.failed', 'ondismiss'])
    const [failed] = await log(page)
    expect(failed).toMatchObject({ error: { reason: 'payment_timed_out' } })
    await expect.poll(async () => (await mock.fetchOrder(order.id)).status, { timeout: 5000 }).toBe('paid')
    await expect.poll(() => webhooksFor(order.id)).toEqual(['payment.failed', 'payment.authorized', 'payment.captured', 'order.paid'])
  })

  test("auto 'success' / 'fail' in redirect mode end in the callback POST", async ({ browser }) => {
    const { context, page } = await redirectPage(browser, INSTAGRAM_ANDROID)
    try {
      const ok = await newOrder()
      await openCheckout(page, ok.id, { callback_url: `${h.url}/callback?no=WF-20001` }, {}, { auto: 'success', delayMs: 50 })
      await page.waitForURL(/\/callback\?no=WF-20001$/)
      expect(h.callbacks.some((c) => c.fields.razorpay_order_id === ok.id)).toBe(true)

      const bad = await newOrder()
      await openCheckout(page, bad.id, { callback_url: `${h.url}/callback?no=WF-20002` }, {}, { auto: 'fail', delayMs: 50 })
      await page.waitForURL(/\/callback\?no=WF-20002$/)
      expect(h.callbacks.some((c) => c.fields['error[metadata]']?.includes(bad.id))).toBe(true)
    } finally {
      await context.close()
    }
  })

  test('webhook: false suppresses the webhooks of automated payments', async ({ page }) => {
    const order = await newOrder()
    await openCheckout(page, order.id, {}, {}, { auto: 'success', delayMs: 50, webhook: false })
    await expect.poll(async () => (await log(page)).length).toBe(1)
    await page.waitForTimeout(300)
    expect(webhooksFor(order.id)).toEqual([])
  })
})
