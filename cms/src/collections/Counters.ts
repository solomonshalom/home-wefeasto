import type { CollectionConfig } from 'payload'

import { isAdmin, nobody } from '../access'

/**
 * Named monotonic counters (`orders` → WF-10001…). Incremented only with an atomic
 * `UPDATE … SET value = value + 1 … RETURNING` inside the caller's transaction (src/commerce/orderNumber.ts).
 */
export const Counters: CollectionConfig = {
  slug: 'counters',
  admin: { useAsTitle: 'name', group: 'Settings', defaultColumns: ['name', 'value', 'updatedAt'] },
  access: { read: isAdmin, create: nobody, update: nobody, delete: nobody },
  fields: [
    { name: 'name', type: 'text', required: true, unique: true, index: true },
    { name: 'value', type: 'number', required: true, defaultValue: 0 },
  ],
  timestamps: true,
}
