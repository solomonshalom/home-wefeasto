import type { CollectionConfig } from 'payload'

import { isAdmin, nobody } from '../access'
import { recordSubscriberErasure } from '../retention/erasure'
import { afterSubscriberWrite, guardSubscriberWrite, lockSubscribersBeforeUpdate, serverOwned } from '../retention/subscriberWrites'

/**
 * Newsletter (double opt-in). Written by the retention endpoints with the Local API. Admins can read, delete,
 * edit the source / consent note, correct the email and take someone off the list; the consent state itself
 * (status changes towards the list, the timestamps, token hashes and welcome coupon) is server-owned: see
 * src/retention/subscriberWrites.ts. Token hashes are hidden (sha256 of the emailed token; never stored).
 * Deleting a row is the owner's erasure: it leaves a marker (a hash of the address) so an order's older
 * checkout consent can't put the address back on the list (src/retention/erasure.ts).
 */
export const Subscribers: CollectionConfig = {
  slug: 'subscribers',
  admin: {
    useAsTitle: 'email',
    group: 'Customers',
    defaultColumns: ['email', 'status', 'source', 'confirmedAt', 'createdAt'],
  },
  access: { read: isAdmin, create: nobody, update: isAdmin, delete: isAdmin },
  hooks: {
    beforeOperation: [lockSubscribersBeforeUpdate],
    beforeValidate: [
      ({ data }) => {
        if (data && typeof data.email === 'string') data.email = data.email.trim().toLowerCase()
        return data
      },
    ],
    beforeChange: [guardSubscriberWrite],
    afterChange: [afterSubscriberWrite],
    afterDelete: [recordSubscriberErasure],
  },
  fields: [
    {
      name: 'email',
      type: 'email',
      required: true,
      unique: true,
      index: true,
      admin: {
        description:
          'Correcting it emails a confirmation link to the new address; they are back on the list once they click it. ' +
          'An unsubscribed address stays unsubscribed.',
      },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: ['pending', 'confirmed', 'unsubscribed'].map((value) => ({ label: value, value })),
      admin: {
        description:
          "Only the subscriber can join or confirm (with the link we email them). To take someone off the list, choose 'unsubscribed'.",
      },
    },
    { name: 'source', type: 'text', admin: { description: "How they joined: 'newsletter' (double opt-in) or 'checkout' (consent box)." } },
    { name: 'consentText', type: 'text' },
    // Retention (additive): when the consent in consentText was given. Used to decide which of an
    // unsubscribe and a checkout consent is newer (the newer one wins).
    { name: 'consentAt', type: 'date', access: serverOwned, admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'confirmTokenHash', type: 'text', hidden: true, index: true, access: serverOwned },
    // Retention (additive): the emailed confirm link stops working after this (7 days after sending).
    {
      name: 'confirmTokenExpiresAt',
      type: 'date',
      access: serverOwned,
      admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
    },
    { name: 'confirmedAt', type: 'date', access: serverOwned, admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
    // Always HMAC(email) hashed (guardSubscriberWrite recomputes it), so the link in every email keeps working.
    { name: 'unsubscribeTokenHash', type: 'text', hidden: true, index: true, access: serverOwned },
    { name: 'unsubscribedAt', type: 'date', access: serverOwned, admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'lastConfirmSentAt', type: 'date', access: serverOwned, admin: { readOnly: true } },
    { name: 'welcomeCoupon', type: 'relationship', relationTo: 'coupons', access: serverOwned, admin: { readOnly: true } },
  ],
  timestamps: true,
}
