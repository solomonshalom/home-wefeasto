import type { Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { getTestPayload } from './helpers/payload'

/**
 * HUNT w5 r2: Payload's field sanitizer makes every `virtual: true` field read-only in the admin unless the
 * config says `admin.readOnly: false` (payload/dist/fields/config/sanitize.js). "Adjust stock by (±N)" is
 * virtual, so it rendered disabled and the owner could not restock from the admin at all. Checked on the
 * SANITIZED config (what the admin renders), not the source.
 */

type AnyField = { name?: string; type?: string; virtual?: unknown; admin?: { readOnly?: boolean; hidden?: boolean }; fields?: AnyField[]; tabs?: AnyField[] }

function find(fields: AnyField[] | undefined, name: string): AnyField | undefined {
  for (const f of fields ?? []) {
    if (f.name === name) return f
    const inner = find(f.fields, name) ?? find(f.tabs, name)
    if (inner) return inner
  }
  return undefined
}

let payload: Payload
beforeAll(async () => {
  payload = await getTestPayload()
})

describe('virtual admin fields after Payload sanitizes the config', () => {
  it('"Adjust stock by (±N)" is editable; "Stock (packs)" stays read-only', () => {
    const fields = payload.collections.products.config.fields as AnyField[]
    expect(find(fields, 'stockAdjust')).toMatchObject({ virtual: true, admin: { readOnly: false } })
    expect(find(fields, 'stockOnHand')).toMatchObject({ virtual: true, admin: { readOnly: true } })
  })

  it('every virtual field is either deliberately editable or deliberately read-only', () => {
    const editable = new Set(['products.stockAdjust'])
    for (const slug of Object.keys(payload.collections)) {
      const walk = (fields: AnyField[] | undefined) => {
        for (const f of fields ?? []) {
          if (f.virtual === true && f.name) {
            const key = `${slug}.${f.name}`
            expect(f.admin?.readOnly, key).toBe(!editable.has(key))
          }
          walk(f.fields)
          walk(f.tabs)
        }
      }
      walk(payload.collections[slug as keyof typeof payload.collections].config.fields as AnyField[])
    }
  })
})
