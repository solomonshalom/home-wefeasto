import type { CollectionConfig } from 'payload'

import { isAdmin, nobody } from '../access'

/**
 * One row per order that used a coupon (unique `order`). Reserved at checkout, consumed when the order
 * is paid, released when it expires/cancels. Per-customer limits count consumed + reserved rows by email.
 */
export const CouponRedemptions: CollectionConfig = {
  slug: 'coupon-redemptions',
  admin: {
    useAsTitle: 'code',
    group: 'Shop',
    defaultColumns: ['code', 'order', 'email', 'status', 'discountPaise', 'createdAt'],
  },
  access: { read: isAdmin, create: nobody, update: nobody, delete: nobody },
  fields: [
    { name: 'coupon', type: 'relationship', relationTo: 'coupons', required: true, index: true },
    { name: 'code', type: 'text', required: true, index: true },
    { name: 'order', type: 'relationship', relationTo: 'orders', required: true, unique: true, index: true },
    { name: 'email', type: 'email', required: true, index: true },
    { name: 'customer', type: 'relationship', relationTo: 'customers', index: true },
    { name: 'discountPaise', type: 'number', required: true, min: 0 },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'reserved',
      index: true,
      options: ['reserved', 'consumed', 'released'].map((value) => ({ label: value, value })),
    },
    { name: 'consumedAt', type: 'date' },
    { name: 'releasedAt', type: 'date' },
  ],
  timestamps: true,
}
