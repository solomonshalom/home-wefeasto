import type { CollectionConfig } from 'payload'

import { isAdmin, nobody } from '../access'

/**
 * Razorpay webhook log + dedupe table. One row per `x-razorpay-event-id` (unique): insert first,
 * a unique violation means "already seen". Written only by server code; admins can read.
 * `payload` holds the parsed event (contains customer PII: keep a retention policy).
 */
export const PaymentEvents: CollectionConfig = {
  slug: 'payment-events',
  admin: {
    useAsTitle: 'eventId',
    group: 'Payments',
    defaultColumns: ['eventId', 'event', 'entityId', 'outcome', 'receivedAt'],
  },
  access: { read: isAdmin, create: nobody, update: nobody, delete: nobody },
  fields: [
    { name: 'eventId', type: 'text', required: true, unique: true, index: true },
    { name: 'event', type: 'text', required: true, index: true },
    { name: 'entityId', type: 'text', index: true, admin: { description: 'Payment/order/refund id the event is about.' } },
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true },
    { name: 'receivedAt', type: 'date', required: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'processedAt', type: 'date', admin: { date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'outcome', type: 'text', index: true },
    { name: 'rawSha256', type: 'text' },
    { name: 'payload', type: 'json' },
  ],
  timestamps: true,
}
