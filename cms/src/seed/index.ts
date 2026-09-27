/**
 * `npm run seed` — import the storefront catalog snapshot into Payload (idempotent), plus a dev admin.
 * Options and environment: see USAGE in ./args.ts (`npm run seed -- --help`).
 *
 * Reads cms/.env (plain tsx does not). The target database is DATABASE_URI.
 */
import 'dotenv/config'

import fs from 'fs'
import path from 'path'
import { getPayload } from 'payload'
import { pathToFileURL } from 'url'

import { isProductionEnv, parseSeedArgs, seedAdminEmail, SNAPSHOT_VALIDATOR_FILE, summary, USAGE } from './args'
import { defaultSeedStock, type PolicyDrafts, seedAdmin, SeedError, seedCatalog } from './seedCatalog'

type Validate = (s: unknown) => { ok: boolean; errors: string[] }
type Validators = { validateSnapshot?: Validate; validatePolicyDrafts?: Validate }

/** The storefront's own validators (pure ESM), so the seed refuses exactly what the sync would refuse. */
async function loadValidators(): Promise<Validators> {
  if (!fs.existsSync(SNAPSHOT_VALIDATOR_FILE)) return {}
  return (await import(pathToFileURL(SNAPSHOT_VALIDATOR_FILE).href)) as Validators
}

/** The policy drafts to seed: undefined for --no-drafts, or when the default file is absent (warned). */
function loadDrafts(file: string | null, explicit: boolean): PolicyDrafts | undefined {
  if (!file) return undefined
  if (!fs.existsSync(file)) {
    if (explicit) throw new SeedError(`--drafts: ${file} not found`)
    console.warn(`seed: ${file} not found; no policy drafts created`)
    return undefined
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PolicyDrafts
}

async function main() {
  const args = parseSeedArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.reset && isProductionEnv() && process.env.SEED_ALLOW_RESET !== '1') {
    throw new SeedError('--reset deletes the whole catalog; refused in production (set SEED_ALLOW_RESET=1 to force).')
  }
  const snapshot = JSON.parse(fs.readFileSync(args.file, 'utf8'))
  const policyDrafts = loadDrafts(args.drafts, args.draftsExplicit)
  const { validateSnapshot: validate, validatePolicyDrafts: validateDrafts } = await loadValidators()
  if (!validate) console.warn(`seed: ${SNAPSHOT_VALIDATOR_FILE} not found; the snapshot is not validated`)
  if (policyDrafts && !validateDrafts) console.warn('seed: validatePolicyDrafts not found; the policy drafts are not validated')
  const stock = args.stock ?? defaultSeedStock()
  const db = (() => {
    try {
      return new URL(process.env.DATABASE_URI ?? '').pathname.slice(1)
    } catch {
      return '?'
    }
  })()

  // Imported here, not at the top: loading the config validates the environment (payment mode, secrets, …),
  // so the option checks and the production refusal above are reported first, whatever the environment.
  const { default: config } = await import('../payload.config')
  const payload = await getPayload({ config })
  try {
    console.log(`seed: ${path.relative(process.cwd(), args.file)} → database "${db}" (new products get stock ${stock})`)
    const report = await seedCatalog(payload, snapshot, {
      reset: args.reset,
      stock,
      validate,
      policyDrafts,
      validateDrafts,
      log: (m) => console.log(`  ${m}`),
    })
    console.log(summary(report))

    if (args.admin) {
      const email = seedAdminEmail()
      if (!email) {
        console.log('seed: admin skipped (set SEED_ADMIN_EMAIL to create one in production)')
      } else {
        const admin = await seedAdmin(payload, { email, password: process.env.SEED_ADMIN_PASSWORD || undefined })
        if (!admin.created) console.log(`seed: admin ${admin.email} already exists (unchanged)`)
        else if (admin.generated) {
          console.log(`seed: created admin ${admin.email}`)
          console.log(`seed: generated password (shown once — store it now): ${admin.password}`)
        } else console.log(`seed: created admin ${admin.email} with SEED_ADMIN_PASSWORD`)
      }
    }
  } finally {
    await payload.destroy()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof SeedError ? `seed: ${err.message}` : err)
    process.exit(1)
  },
)
