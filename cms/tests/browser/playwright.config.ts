import os from 'node:os'
import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests of the mock Razorpay checkout.js (src/payments/mockCheckoutScript.ts).
 *
 *   npx playwright test -c cms/tests/browser/playwright.config.ts          (from the repo root)
 *
 * The specs start their own harness server (tests/browser/harness.ts) that runs the real mock endpoint
 * handlers in-process, so no CMS server is needed. `cms-smoke.spec.ts` additionally drives a running CMS
 * when MOCK_RZP_CMS_URL is set (e.g. http://localhost:3100 started with PAYMENTS_MODE=mock).
 * Uses the repo-root @playwright/test 1.62.0 and its cached chromium.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: process.env.PW_OUTPUT_DIR || path.join(os.tmpdir(), 'wefeasto-cms-browser-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
})
