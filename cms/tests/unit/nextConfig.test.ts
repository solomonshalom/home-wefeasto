/**
 * cms/next.config.ts + cms/tsconfig.build.json (PI-ORD-1, e2e-2).
 *
 *  - Referrer-Policy: a route handler's own header does not survive `next start` (the next.config table wins),
 *    so every /api/** answer must get `no-referrer` from the table itself, while pages keep
 *    strict-origin-when-cross-origin. Matching uses Next's own route compiler; for one key the LAST matching
 *    entry wins (Next docs, "headers": "the last header key will override the first").
 *  - `next build` type-checks tsconfig.build.json's program: the app without tests/**.
 *    (The real server is covered by `npm run test:prod-smoke`, probe "security headers".)
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import nextConfig from '../../next.config'

const require = createRequire(import.meta.url)
const { buildCustomRoute } = require('next/dist/lib/build-custom-route') as {
  buildCustomRoute: (type: 'header', route: { source: string; headers: { key: string; value: string }[] }) => { regex: string }
}

const CMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

type HeaderRoute = { source: string; headers: { key: string; value: string }[] }

async function effectiveHeaders(pathname: string): Promise<Record<string, string>> {
  const routes = ((await nextConfig.headers?.()) ?? []) as HeaderRoute[]
  const out: Record<string, string> = {}
  for (const route of routes) {
    if (!new RegExp(buildCustomRoute('header', route).regex).test(pathname)) continue
    for (const h of route.headers) out[h.key.toLowerCase()] = h.value
  }
  // withPayload adds its own entries (color-scheme client hints …): only the security headers matter here.
  const pick = ['x-content-type-options', 'referrer-policy', 'x-frame-options']
  return Object.fromEntries(pick.filter((k) => k in out).map((k) => [k, out[k]]))
}

describe('next.config headers()', () => {
  it.each([
    '/api/store/orders/status',
    '/api/payments/razorpay/callback',
    '/api/store/newsletter/confirm',
    '/api/store/newsletter/unsubscribe',
    '/api/store/catalog',
    '/api/customers/me',
    '/api',
  ])('%s → Referrer-Policy: no-referrer (plus the global security headers)', async (p) => {
    expect(await effectiveHeaders(p)).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'SAMEORIGIN',
    })
  })

  it.each(['/', '/admin', '/admin/collections/orders', '/apiary', '/_next/static/chunks/x.js'])(
    '%s keeps strict-origin-when-cross-origin',
    async (p) => {
      expect(await effectiveHeaders(p)).toEqual({
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-frame-options': 'SAMEORIGIN',
      })
    },
  )
})

describe('build type-check program (tsconfig.build.json)', () => {
  function program(file: string) {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(CMS_DIR, file), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      },
    })
    if (!parsed) throw new Error(`cannot parse ${file}`)
    return { ...parsed, files: parsed.fileNames.map((f) => path.relative(CMS_DIR, f)) }
  }

  it('next build uses tsconfig.build.json', () => {
    expect(nextConfig.typescript?.tsconfigPath).toBe('tsconfig.build.json')
  })

  it('extends tsconfig.json (so Next never rewrites either file) and leaves tests/** out', () => {
    const build = program('tsconfig.build.json')
    const full = program('tsconfig.json')
    expect(build.errors).toEqual([])
    expect(build.raw.extends).toBe('./tsconfig.json')
    expect(build.files.filter((f) => f.startsWith('tests/'))).toEqual([])
    expect(build.files).not.toContain('vitest.config.mts')
    // same compiler options (paths, strict, jsx …) and every non-test file of the full program
    expect(build.options).toEqual({ ...full.options, configFilePath: build.options.configFilePath })
    const nonTest = full.files.filter((f) => !f.startsWith('tests/') && f !== 'vitest.config.mts')
    expect(build.files.sort()).toEqual(nonTest.sort())
    expect(build.files).toContain('src/payload.config.ts')
  })

  it('tsconfig.json (npm run typecheck) still covers the tests', () => {
    const full = program('tsconfig.json')
    expect(full.files.some((f) => f.startsWith('tests/unit/'))).toBe(true)
    expect(full.files.some((f) => f.startsWith('tests/int/'))).toBe(true)
  })
})
