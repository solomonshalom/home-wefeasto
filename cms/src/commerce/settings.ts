import type { Payload, PayloadRequest } from 'payload'

import {
  PUBLIC_SETTINGS_DEFAULTS,
  publicSettings,
  resolveSettings,
  SERVER_SETTINGS_DEFAULTS,
  SERVER_SETTINGS_KEYS,
} from './shared/settings.js'

/**
 * Server-side reader for the `store-settings` global. The canonical keys, defaults and coercion rules
 * live in the shared module (`./shared/settings.js`, also used by the storefront as `$shared`), so
 * the CMS, the snapshot and the UI can never disagree.
 *
 *   const { public: pub, server } = await getStoreSettings(req)
 *   pub     → exactly snapshot.settings (safe to publish)
 *   server  → reservationMinutes, blockedPinPrefixes, codBlockedPinPrefixes, codMaxOpenPerPhone (never publish)
 */

export { PUBLIC_SETTINGS_DEFAULTS, SERVER_SETTINGS_DEFAULTS }

export type PublicStoreSettings = ReturnType<typeof publicSettings>
export type ServerStoreSettings = {
  reservationMinutes: number
  blockedPinPrefixes: string[]
  codBlockedPinPrefixes: string[]
  codMaxOpenPerPhone: number
}
export type StoreSettings = { public: PublicStoreSettings; server: ServerStoreSettings }

export const SERVER_ONLY_SETTINGS_KEYS = [...SERVER_SETTINGS_KEYS] as (keyof ServerStoreSettings)[]

/** Fills gaps with defaults and drops anything malformed. Never throws. */
export function normalizeStoreSettings(raw: unknown): StoreSettings {
  const all = resolveSettings(raw) as unknown as Record<string, unknown>
  const server = Object.fromEntries(SERVER_ONLY_SETTINGS_KEYS.map((k) => [k, all[k]])) as ServerStoreSettings
  return { public: publicSettings(raw), server }
}

/**
 * Reads the global with admin rights (server-only keys included) and normalises it.
 * Pass `req` inside a request/transaction; a bare Payload instance works in scripts and jobs.
 */
export async function getStoreSettings(from: PayloadRequest | Payload): Promise<StoreSettings> {
  const isPayload = typeof (from as Payload).findGlobal === 'function'
  const payload = isPayload ? (from as Payload) : (from as PayloadRequest).payload
  const raw = await payload.findGlobal({
    slug: 'store-settings',
    depth: 0,
    overrideAccess: true,
    ...(isPayload ? {} : { req: from as PayloadRequest }),
  })
  return normalizeStoreSettings(raw)
}
