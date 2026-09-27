import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)

const nextConfig: NextConfig = {
  // Next 16 writes AGENTS.md / CLAUDE.md into the project on `next dev` when it detects an AI agent.
  agentRules: false,
  // Parallel dev/e2e servers from one checkout each need their own build dir (NEXT_DIST_DIR=.next-e2e …).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  images: {
    localPatterns: [{ pathname: '/api/media/file/**' }],
  },
  // Headless CMS: the storefront is a separate static site. Send visitors of the bare origin to the admin.
  async redirects() {
    return [{ source: '/', destination: '/admin', permanent: false }]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      // Token-bearing API answers (orders/status, the Razorpay callback 303 whose Location carries the guest
      // token, the newsletter confirm/unsubscribe 303s) must not leak their URL in a Referer
      // (checkout-backend §1.5/§1.7). A handler's own Referrer-Policy does not survive `next start`: this
      // table wins. For the same key Next keeps the LAST matching entry, so this must stay after '/:path*'.
      // JSON answers and redirects never need a referrer; /admin keeps strict-origin-when-cross-origin.
      {
        source: '/api/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ]
  },
  typescript: {
    // `next build` type-checks this file's program: the app (src/**, config) without tests/**, so a test
    // file's type error cannot fail a deploy or an e2e stack start. It `extends` tsconfig.json, which makes
    // Next leave both files untouched even for a custom NEXT_DIST_DIR. Tests: `npm run typecheck`.
    tsconfigPath: 'tsconfig.build.json',
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }
    return webpackConfig
  },
  // cms/ lives inside the storefront repo, which has its own lockfile: pin the workspace root here.
  outputFileTracingRoot: path.resolve(dirname),
  turbopack: {
    root: path.resolve(dirname),
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
