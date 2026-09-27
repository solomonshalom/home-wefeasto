import type { CollectionConfig } from 'payload'

import { isAdmin, nobody } from '../access'

/**
 * Exactly-once guard for outgoing messages. `key` is unique (e.g. `confirm:WF-10001`, `refill:WF-10001:1`):
 * `src/email/sendOnce.ts` inserts the row BEFORE sending, so duplicate webhooks / job retries lose the race.
 */
export const MESSAGE_STATUSES = ['pending', 'sent', 'failed'] as const

export const MessageLog: CollectionConfig = {
  slug: 'message-log',
  admin: {
    useAsTitle: 'key',
    group: 'Settings',
    defaultColumns: ['key', 'type', 'to', 'status', 'sentAt'],
  },
  access: { read: isAdmin, create: nobody, update: nobody, delete: nobody },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true, index: true },
    { name: 'type', type: 'text', index: true },
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true },
    { name: 'to', type: 'text' },
    { name: 'subject', type: 'text' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: MESSAGE_STATUSES.map((value) => ({ label: value, value })),
    },
    { name: 'attempts', type: 'number', defaultValue: 0 },
    { name: 'sentAt', type: 'date' },
    { name: 'error', type: 'text' },
  ],
  timestamps: true,
}
