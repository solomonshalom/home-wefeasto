import { expect, test } from '@playwright/test'

import { startHarness, type Harness } from './harness'

/**
 * Smoke test against a RUNNING CMS (Next + Payload), e.g.
 *
 *   PAYMENTS_MODE=mock NEXT_DIST_DIR=.next-gateway npx next dev -p 3100   (in cms/)
 *   MOCK_RZP_CMS_URL=http://localhost:3100 npx playwright test -c cms/tests/browser/playwright.config.ts cms-smoke
 *
 * The harness proxies /api/* to the CMS the way the storefront's Vite/Vercel proxy does, so the script
 * and /mock/pay are served by the real Next route. Orders cannot be created from here (that is
 * /api/store/checkout's job), so this checks wiring: headers, the script, the endpoint's error paths.
 */

const CMS = process.env.MOCK_RZP_CMS_URL

test.describe('mock checkout against a running CMS', () => {
  test.skip(!CMS, 'set MOCK_RZP_CMS_URL to run')

  let h: Harness
  let keyId = ''

  test.beforeAll(async () => {
    const res = await fetch(`${CMS}/api/payments/mock/checkout.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const src = await res.text()
    keyId = /"keyId":"([^"]+)"/.exec(src)?.[1] ?? ''
    expect(keyId).toMatch(/^rzp_test_/)
    h = await startHarness({ cmsUrl: CMS, keyId })
  })

  test.afterAll(async () => {
    await h?.close()
  })

  test('the script served by the CMS defines the mock Razorpay and talks to /mock/pay through the proxy', async ({ page }) => {
    await page.goto(`${h.url}/harness.html`)
    expect(await page.evaluate(() => typeof window.Razorpay === 'function' && (window.Razorpay as unknown as { __wfMock?: boolean }).__wfMock)).toBe(true)
    await page.evaluate(() => {
      window.__nextOptions = { order_id: 'order_MockZZZZZZ9999' }
    })
    await page.click('#opener')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: /^Pay/ }).click()
    await expect(page.getByRole('alert')).toHaveText('The id provided does not exist.')
    expect(await page.evaluate(() => window.__log)).toEqual([])
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => window.__log.map((e) => e.type))).toEqual(['ondismiss'])
  })

  test('/mock/pay validates input on the real server', async () => {
    const res = await fetch(`${CMS}/api/payments/mock/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ razorpayOrderId: 'nope', outcome: 'maybe' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION', message: 'Some details need fixing.', details: { fields: { razorpayOrderId: 'invalid', outcome: 'invalid' } } },
    })
  })
})
