import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_DRAFTS_FILE,
  DEFAULT_SNAPSHOT_FILE,
  isProductionEnv,
  parseSeedArgs,
  seedAdminEmail,
  SNAPSHOT_VALIDATOR_FILE,
  summary,
  USAGE,
} from '@/seed/args'
import { DEV_STOCK, defaultSeedStock } from '@/seed/seedCatalog'

/** `npm run seed` argument parsing and output (cms-catalog). */

describe('parseSeedArgs', () => {
  it('defaults: committed snapshot and policy drafts, create admin, no reset, stock decided later', () => {
    expect(parseSeedArgs([])).toEqual({
      reset: false,
      file: DEFAULT_SNAPSHOT_FILE,
      drafts: DEFAULT_DRAFTS_FILE,
      draftsExplicit: false,
      admin: true,
      help: false,
    })
    expect(fs.existsSync(DEFAULT_SNAPSHOT_FILE)).toBe(true)
    expect(fs.existsSync(DEFAULT_DRAFTS_FILE)).toBe(true)
    expect(fs.existsSync(SNAPSHOT_VALIDATOR_FILE)).toBe(true)
    expect(DEFAULT_SNAPSHOT_FILE.endsWith(path.join('src', 'lib', 'data', 'cms-snapshot.json'))).toBe(true)
    expect(DEFAULT_DRAFTS_FILE.endsWith(path.join('src', 'lib', 'data', 'policy-drafts.server.json'))).toBe(true)
  })

  it('policy drafts: another file, or none', () => {
    expect(parseSeedArgs(['--drafts=d.json'], '/tmp/x')).toMatchObject({ drafts: path.resolve('/tmp/x', 'd.json'), draftsExplicit: true })
    expect(parseSeedArgs(['--no-drafts'])).toMatchObject({ drafts: null, draftsExplicit: false })
    // The last one wins.
    expect(parseSeedArgs(['--no-drafts', '--drafts=/abs/d.json']).drafts).toBe('/abs/d.json')
  })

  it('flags', () => {
    expect(parseSeedArgs(['--reset', '--no-admin', '--stock=25'])).toMatchObject({ reset: true, admin: false, stock: 25 })
    expect(parseSeedArgs(['--stock=0']).stock).toBe(0)
    expect(parseSeedArgs(['--help']).help).toBe(true)
    expect(parseSeedArgs(['-h']).help).toBe(true)
    expect(parseSeedArgs(['--file=snap.json'], '/tmp/x').file).toBe(path.resolve('/tmp/x', 'snap.json'))
    expect(parseSeedArgs(['--file=/abs/snap.json']).file).toBe('/abs/snap.json')
  })

  it.each([['--stock=-1'], ['--stock=1.5'], ['--stock=abc'], ['--stock='], ['--stock=1e3'], ['--file='], ['--drafts='], ['--drafts'], ['--force'], ['reset']])(
    'rejects %s',
    (arg) => expect(() => parseSeedArgs([arg])).toThrow(/stock|Unknown option/),
  )
})

describe('environment', () => {
  it('production is NODE_ENV, APP_ENV or VERCEL_ENV = production', () => {
    expect(isProductionEnv({})).toBe(false)
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false)
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ APP_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ VERCEL_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ VERCEL_ENV: 'preview' })).toBe(false)
  })

  it('admin email: SEED_ADMIN_EMAIL, else the dev default; production needs it explicitly', () => {
    expect(seedAdminEmail({})).toBe(DEFAULT_ADMIN_EMAIL)
    expect(seedAdminEmail({ SEED_ADMIN_EMAIL: ' owner@wefeasto.com ' })).toBe('owner@wefeasto.com')
    expect(seedAdminEmail({ NODE_ENV: 'production' })).toBe('')
    expect(seedAdminEmail({ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@wefeasto.com' })).toBe('owner@wefeasto.com')
  })

  it('stock for new products: 100 in dev, 0 in production', () => {
    expect(DEV_STOCK).toBe(100)
    expect(defaultSeedStock({})).toBe(100)
    expect(defaultSeedStock({ NODE_ENV: 'production' })).toBe(0)
  })
})

describe('output', () => {
  it('summarises the report', () => {
    const none = { created: 0, updated: 0, unchanged: 0 }
    const text = summary({
      reset: false,
      products: { created: 0, updated: 1, unchanged: 5 },
      recipes: { created: 0, updated: 0, unchanged: 12 },
      pages: { created: 1, updated: 0, unchanged: 0 },
      drafts: { created: 2, kept: 1 },
      settings: 'unchanged',
      changed: true,
    })
    expect(text).toContain('products  0 created, 1 updated, 5 unchanged')
    expect(text).toContain('pages     1 created, 0 updated, 0 unchanged')
    expect(text).toContain('drafts    2 created, 1 kept')
    expect(text).not.toContain('nothing changed')
    const base = { reset: false, products: none, recipes: none, pages: none, drafts: { created: 0, kept: 3 }, settings: 'unchanged' as const }
    expect(summary({ ...base, changed: false })).toMatch(/nothing changed/)
    expect(summary({ ...base, reset: true, settings: 'updated', changed: true })).toMatch(/after --reset/)
    expect(USAGE).toMatch(/--reset/)
    expect(USAGE).toMatch(/--no-drafts/)
    expect(USAGE).toMatch(/SEED_ADMIN_EMAIL/)
  })
})
