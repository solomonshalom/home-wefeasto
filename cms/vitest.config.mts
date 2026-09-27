import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

import { intTestEnv } from './tests/int/env'

/**
 * Two projects:
 *   unit  tests/unit/**   pure functions, no DB/network, parallel.
 *   int   tests/int/**    Payload REST handlers + Local API against Postgres `wefeasto_test` (reset by
 *                        globalSetup), Mailpit for email. Files run one after another in ONE worker with
 *                        isolate:false, so getPayload() (schema push included) happens once per run.
 *
 *   npm run test:unit | npm run test:int | npm test
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.{test,spec}.{ts,mts,js,mjs}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'int',
          environment: 'node',
          include: ['tests/int/**/*.int.spec.ts'],
          globalSetup: ['tests/int/globalSetup.ts'],
          env: intTestEnv,
          fileParallelism: false,
          isolate: false,
          testTimeout: 30_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
})
