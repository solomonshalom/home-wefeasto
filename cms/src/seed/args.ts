import path from 'path'
import { fileURLToPath } from 'url'

import { SeedError, type SeedReport } from './seedCatalog'

/** CLI parsing and output for `npm run seed` (kept apart from index.ts so tests can import it without Payload). */

const dirname = path.dirname(fileURLToPath(import.meta.url))
/** REPO/src/lib/data — the storefront's committed snapshot, the policy drafts and their validator. */
export const STOREFRONT_DATA_DIR = path.resolve(dirname, '../../../src/lib/data')
export const DEFAULT_SNAPSHOT_FILE = path.join(STOREFRONT_DATA_DIR, 'cms-snapshot.json')
/** Unpublished policy pages (shipping, refunds, grievances) the seed creates for the owner to review. */
export const DEFAULT_DRAFTS_FILE = path.join(STOREFRONT_DATA_DIR, 'policy-drafts.server.json')
export const SNAPSHOT_VALIDATOR_FILE = path.join(STOREFRONT_DATA_DIR, 'snapshot-schema.js')
export const DEFAULT_ADMIN_EMAIL = 'admin@wefeasto.local'

export const USAGE = `npm run seed [-- options]

Imports the storefront catalog snapshot into Payload (idempotent upsert by slug), creates the policy-page
drafts that don't exist yet (off the storefront until reviewed), and creates a dev admin.

  --reset            delete every product, recipe and page first (refused in production unless SEED_ALLOW_RESET=1)
  --stock=N          stock for products the seed CREATES (default 100; 0 in production). Never resets existing stock.
  --file=path.json   another snapshot file (default ../src/lib/data/cms-snapshot.json)
  --drafts=path.json another policy drafts file (default ../src/lib/data/policy-drafts.server.json).
                     Only missing pages are created; an existing page is never overwritten.
  --no-drafts        skip the policy drafts
  --no-admin         skip the admin user
  --help             this text

Admin: SEED_ADMIN_EMAIL (default ${DEFAULT_ADMIN_EMAIL}; required in production), SEED_ADMIN_PASSWORD
(default: generated and printed once). An existing user is never modified. Database: DATABASE_URI (cms/.env).`

export type SeedArgs = {
  reset: boolean
  stock?: number
  file: string
  /** Policy drafts file, or null for --no-drafts. */
  drafts: string | null
  /** --drafts= was given (a missing file is then an error, not a warning). */
  draftsExplicit: boolean
  admin: boolean
  help: boolean
}

export function parseSeedArgs(argv: string[], cwd = process.cwd()): SeedArgs {
  const out: SeedArgs = { reset: false, file: DEFAULT_SNAPSHOT_FILE, drafts: DEFAULT_DRAFTS_FILE, draftsExplicit: false, admin: true, help: false }
  for (const arg of argv) {
    if (arg === '--reset') out.reset = true
    else if (arg === '--no-admin') out.admin = false
    else if (arg === '--no-drafts') out.drafts = null
    else if (arg.startsWith('--drafts=') && arg.length > '--drafts='.length) {
      out.drafts = path.resolve(cwd, arg.slice('--drafts='.length))
      out.draftsExplicit = true
    }
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--stock=')) {
      const raw = arg.slice('--stock='.length)
      if (!/^\d{1,9}$/.test(raw)) throw new SeedError(`--stock needs a whole number ≥ 0, got "${raw}"`)
      out.stock = Number(raw)
    } else if (arg.startsWith('--file=') && arg.length > '--file='.length) out.file = path.resolve(cwd, arg.slice('--file='.length))
    else throw new SeedError(`Unknown option "${arg}" (try --help)`)
  }
  return out
}

export const isProductionEnv = (env: Record<string, string | undefined> = process.env) =>
  env.NODE_ENV === 'production' || env.APP_ENV === 'production' || env.VERCEL_ENV === 'production'

/** The admin email to seed: SEED_ADMIN_EMAIL, else the dev default outside production, else none. */
export const seedAdminEmail = (env: Record<string, string | undefined> = process.env): string =>
  env.SEED_ADMIN_EMAIL?.trim() || (isProductionEnv(env) ? '' : DEFAULT_ADMIN_EMAIL)

export function summary(r: SeedReport): string {
  const line = (name: string, c: { created: number; updated: number; unchanged: number }) =>
    `  ${name.padEnd(9)} ${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged`
  return [
    `seed: done${r.reset ? ' (after --reset)' : ''}${r.changed ? '' : ' — nothing changed'}`,
    line('products', r.products),
    line('recipes', r.recipes),
    line('pages', r.pages),
    `  drafts    ${r.drafts.created} created, ${r.drafts.kept} kept (policy pages to review; never overwritten)`,
    `  settings  ${r.settings}`,
  ].join('\n')
}
