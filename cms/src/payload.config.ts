import { postgresAdapter, type PostgresAdapter } from '@payloadcms/db-postgres'
import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { vercelBlobStorage } from '@payloadcms/storage-vercel-blob'
import path from 'path'
import { buildConfig, type Config, type DatabaseAdapterObj } from 'payload'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { hardenInternalCollections } from './access/hardenInternals'
import { CROSS_SITE_AUTH_ERROR } from './auth/crossSite'
import { LAST_ADMIN_ERROR } from './auth/lastAdmin'
import { serializeSessionLogins } from './auth/loginSessions'
import { collections } from './collections'
import { COUPON_IN_USE_ERROR } from './collections/Coupons'
import { MEDIA_IN_USE_ERROR, MEDIA_MAX_UPLOAD_BYTES } from './collections/Media'
import { Users } from './collections/Users'
import { ensureCounter, ORDER_COUNTER, ORDER_COUNTER_START } from './commerce/orderNumber'
import { consoleEmailAdapter } from './email/consoleAdapter'
import { assertUniqueEndpoints, endpoints } from './endpoints'
import { allowedOrigins, assertEnv, getEnv } from './env'
import { StoreSettings } from './globals/StoreSettings'
import { jobs } from './jobs'
import { quietExpectedRefusals } from './lib/logging'
import { guardRestInput } from './lib/restGuards'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Boot assertions (SPEC §2): refuse to start with unsafe payment/secret configuration.
const env = getEnv()
const envWarnings = assertEnv(env)
assertUniqueEndpoints(endpoints)

const origins = allowedOrigins(env)

const email = env.smtp
  ? nodemailerAdapter({
      defaultFromAddress: env.emailFrom.address,
      defaultFromName: env.emailFrom.name,
      // Verifying opens an SMTP connection at import time (also during `next build`): errors surface on send.
      skipVerify: true,
      transportOptions: {
        host: env.smtp.host,
        port: env.smtp.port,
        secure: env.smtp.secure,
        ...(env.smtp.user ? { auth: { user: env.smtp.user, pass: env.smtp.pass } } : {}),
      },
    })
  : consoleEmailAdapter({ fromName: env.emailFrom.name, fromAddress: env.emailFrom.address })

/**
 * Dev push never touches a database that migrations manage (production/staging, or one made with `payload migrate`):
 * a push there (e.g. `npm run seed` or `npm run dev` pointed at it) leaves Payload's `dev` marker (batch -1) in
 * payload_migrations, and from then on `payload migrate` and a production server's prodMigrations wait forever on an
 * interactive "you've run Payload in dev mode" prompt. So when push is on, a dev/test connection first looks for
 * applied migrations (batch >= 1) and skips the push if there are any (schema changes there go through a migration).
 */
async function hasAppliedMigrations(adapter: PostgresAdapter): Promise<boolean> {
  const client = new adapter.pg.Client(adapter.poolOptions)
  try {
    await client.connect()
    const table = `"${adapter.schemaName || 'public'}"."payload_migrations"`
    const res = await client.query(`SELECT 1 FROM ${table} WHERE batch >= 1 LIMIT 1`)
    return (res.rowCount ?? 0) > 0
  } catch {
    return false // a fresh database has no payload_migrations yet; connection errors surface in connect() itself
  } finally {
    await client.end().catch(() => {})
  }
}

function noDevPushOnMigratedDb(factory: DatabaseAdapterObj<PostgresAdapter>): DatabaseAdapterObj<PostgresAdapter> {
  return {
    ...factory,
    init: (args) => {
      const adapter = factory.init(args)
      const connect = adapter.connect
      if (!connect) return adapter
      adapter.connect = async function (this: PostgresAdapter, options) {
        if (this.push !== false && process.env.NODE_ENV !== 'production' && process.env.PAYLOAD_MIGRATING !== 'true') {
          if (await hasAppliedMigrations(this)) {
            this.push = false
            this.payload.logger.warn('db: this database is managed by migrations (payload_migrations has applied rows), so the dev schema push is skipped. Change its schema with `npm run migrate:create` + `npm run migrate`.')
          }
        }
        return connect.call(this, options)
      }
      return adapter
    },
  }
}

const config = buildConfig({
  serverURL: env.serverUrl,
  // Credentialed CORS + CSRF allowlist: storefront origin(s) and the CMS itself. Cookie auth from any
  // other Origin is ignored (use `Authorization: JWT <token>` for server-to-server calls).
  cors: origins,
  csrf: origins,
  // Expected refusals (an admin deleting a coupon orders have used or an image a product shows → 409, the
  // last admin deleting their account → 409, a cross-site sign-in → 403) log at info, not error + stack.
  // Keyed by an explicit error name that survives minification (see Coupons.ts CouponInUseError). The type
  // only lists Payload's own error names; its logError looks up any err.name, so the cast is safe.
  // Payload's own refusals (Forbidden, ValidationError, …) are keyed by class names that `next build`
  // minifies, so onInit also downgrades every 4xx APIError by shape (src/lib/logging.ts).
  loggingLevels: {
    [COUPON_IN_USE_ERROR]: 'info',
    [CROSS_SITE_AUTH_ERROR]: 'info',
    [MEDIA_IN_USE_ERROR]: 'info',
    [LAST_ADMIN_ERROR]: 'info',
  } as Record<string, 'info'> as Config['loggingLevels'],
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
    meta: { titleSuffix: ' — Wefeasto CMS' },
  },
  collections,
  globals: [StoreSettings],
  endpoints,
  jobs,
  editor: lexicalEditor(),
  email,
  secret: env.payloadSecret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  graphQL: { disable: true },
  telemetry: false,
  // Cap on ?depth for every caller (Payload's default is 10). Products and recipes are public and link to
  // each other, so each level multiplies the response; the storefront reads /api/store/* (depth 0/1) and the
  // admin never asks for more than 1. The cyclic relations also carry their own maxDepth: 1.
  maxDepth: 2,
  // PAYLOAD_LOG_LEVEL (e.g. warn/fatal) quiets the per-request error log; the integration tests default to fatal.
  ...(process.env.PAYLOAD_LOG_LEVEL
    ? { logger: { options: { level: process.env.PAYLOAD_LOG_LEVEL as 'fatal' | 'error' | 'warn' | 'info' | 'debug' } } }
    : {}),
  // Below Vercel's 4.5 MB function request body (see MEDIA_MAX_UPLOAD_BYTES).
  upload: { limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES } },
  db: noDevPushOnMigratedDb(postgresAdapter({
    pool: {
      connectionString: env.databaseUri,
      max: env.databasePoolMax,
      // Fail fast instead of hanging forever when the pool is exhausted.
      connectionTimeoutMillis: 30_000,
    },
    // Dev/test: schema push (PAYLOAD_DB_PUSH=false turns it off, e.g. for a seed on top of `payload migrate`;
    // noDevPushOnMigratedDb also skips it on a migration-managed DB). Production: never push; the schema comes
    // only from src/migrations (README "Migrations"). Payload also skips push when NODE_ENV=production or while
    // the CLI migrates; this states it explicitly. A pushed DB makes `payload migrate`/prodMigrations prompt.
    push: process.env.PAYLOAD_DB_PUSH !== 'false' && process.env.NODE_ENV !== 'production',
    migrationDir: path.resolve(dirname, 'migrations'),
    // Applied on the first connection of a production server (NODE_ENV=production); already-applied ones are
    // skipped. Deploys should still run `payload migrate` before `next build` (npm run build:deploy).
    prodMigrations: migrations,
  })),
  sharp,
  plugins: [
    vercelBlobStorage({
      enabled: Boolean(env.blobReadWriteToken),
      collections: { media: true },
      token: env.blobReadWriteToken,
    }),
  ],
  onInit: async (payload) => {
    quietExpectedRefusals(payload)
    for (const w of envWarnings) payload.logger.warn(`env: ${w}`)
    // Make sure the order counter exists before the first checkout (idempotent).
    try {
      await ensureCounter(payload, ORDER_COUNTER, ORDER_COUNTER_START)
    } catch (err) {
      // Production without migrations has no tables yet; checkout will retry the insert itself.
      payload.logger.warn({ err, msg: 'onInit: could not ensure the orders counter' })
    }
  },
})

// Post-processing of the sanitised config: staff-only internals + version history, serialised logins, and
// malformed REST input refused with a 4xx before Payload reaches the database (src/lib/restGuards.ts).
export default config.then((c) => guardRestInput(serializeSessionLogins(hardenInternalCollections(c))))
