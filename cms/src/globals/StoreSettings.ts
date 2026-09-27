import type { Field, FieldAccess, FieldHook, GlobalConfig } from 'payload'

import { anyone, isAdmin, isAdminField } from '../access'
import { PUBLIC_SETTINGS_DEFAULTS as P, SERVER_SETTINGS_DEFAULTS as S } from '../commerce/settings'
import {
  E164_RE,
  EMAIL_RE,
  FSSAI_RE,
  GSTIN_RE,
  integerIn,
  isBlank,
  matches,
  optional,
  PATH_OR_URL_RE,
  type Check,
  wholeRupees,
} from '../endpoints/catalog/rules'
import { deployHookGlobalAfterChange } from '../hooks/deployHook'

/**
 * Owner-editable store settings (SPEC §3/§4). Public keys mirror `snapshot.settings` exactly; the
 * "Server only" tab is hidden from everyone but admins by field-level read access, so
 * GET /api/globals/store-settings is safe to call anonymously. Server code should read settings through
 * `getStoreSettings()` in src/commerce/settings.ts (normalised, defaults filled in).
 *
 * Validation matches the storefront snapshot validator (src/lib/data/snapshot-schema.js) and the ranges
 * `resolveSettings()` accepts, so a saved value can neither block the storefront sync nor be silently
 * replaced by its default. Saving a change to a public value triggers a storefront rebuild.
 */

const adminOnlyField: { read: FieldAccess; update: FieldAccess } = { read: isAdminField, update: isAdminField }

/** Cleared text is stored as '' (not null), so publicSettings() never falls back to the default text. */
const emptyNotNull: FieldHook = ({ value }) => (value === null || value === undefined ? '' : value)
/** Identifiers: surrounding spaces never matter; internal spaces are dropped where the format has none. */
const trimmed: FieldHook = ({ value }) => (typeof value === 'string' ? value.trim() : value)
const compact: FieldHook = ({ value }) => (typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value)
const upper: FieldHook = ({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)

/**
 * A money setting in paise. Amounts the storefront shows or charges (fees, thresholds, limits) must be whole
 * rupees (wholeRupees): the shop displays whole rupees, so ₹49.40 would show as ₹49 but be charged ₹49.40.
 * `rupees: false` only for internal tuning numbers that are never shown or charged.
 */
const paise = (name: string, defaultValue: number, description: string, { min = 0, rupees = true } = {}): Field => ({
  name,
  type: 'number',
  required: true,
  min,
  defaultValue,
  admin: { description: `${description} (paise${rupees ? ', whole rupees: ₹49 is 4900' : ': ₹1 = 100'})` },
  validate: rupees
    ? wholeRupees(min)
    : (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= min ? true : `Whole paise ≥ ${min}.`),
})

type TextOpts = { validate?: Check; normalise?: FieldHook; description?: string; textarea?: boolean; maxLength?: number }

const text = (name: string, defaultValue: string, o: TextOpts = {}): Field =>
  ({
    name,
    type: o.textarea ? 'textarea' : 'text',
    defaultValue,
    ...(o.maxLength ? { maxLength: o.maxLength } : {}),
    ...(o.validate ? { validate: o.validate } : {}),
    hooks: { beforeValidate: o.normalise ? [o.normalise] : [], beforeChange: [emptyNotNull] },
    ...(o.description ? { admin: { description: o.description } } : {}),
  }) as Field

const pinPrefixList = (name: string, description: string): Field => ({
  name,
  type: 'text',
  hasMany: true,
  defaultValue: [],
  access: adminOnlyField,
  admin: { description },
  validate: (value: unknown) =>
    value == null || (Array.isArray(value) && value.every((v) => /^\d{1,6}$/.test(String(v))))
      ? true
      : 'Each prefix is 1–6 digits.',
})

/** '' or a site path (/shop, not //host) or an https:// link. */
const checkHref = optional(matches(PATH_OR_URL_RE, 'Use a site path like /shop or a full https:// link.'))
const checkAnnouncementText: Check = (value, args) => {
  if (typeof value === 'string' && value.length > 140) return 'Keep the announcement to 140 characters.'
  return args?.siblingData?.enabled === true && isBlank(value) ? 'Add the announcement text (or switch the bar off).' : true
}

export const StoreSettings: GlobalConfig = {
  slug: 'store-settings',
  label: 'Store settings',
  admin: { group: 'Settings', description: 'Changes to delivery, announcement and legal details rebuild the storefront.' },
  access: { read: anyone, update: isAdmin },
  hooks: { afterChange: [deployHookGlobalAfterChange] },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Delivery & payment',
          fields: [
            paise('freeDeliveryThresholdPaise', P.freeDeliveryThresholdPaise, 'Free delivery at or above this pre-discount subtotal'),
            paise('deliveryFeePaise', P.deliveryFeePaise, 'Delivery fee below the threshold'),
            { name: 'codEnabled', type: 'checkbox', defaultValue: P.codEnabled, label: 'Cash on delivery enabled' },
            paise('codMaxPaise', P.codMaxPaise, 'Largest order total allowed on COD'),
            paise('codFeePaise', P.codFeePaise, 'Extra fee for COD orders'),
            paise('codMinSubtotalPaise', P.codMinSubtotalPaise, 'Smallest subtotal allowed on COD'),
            paise('maxOrderPaise', P.maxOrderPaise, 'Largest order total accepted at all', { min: 100 }),
            paise('topUpDiscoveryBiasPaise', P.topUpDiscoveryBiasPaise, 'Top-up suggestion: prefer untried products within this much', {
              rupees: false,
            }),
            text('shippingPromiseText', P.shippingPromiseText, { description: 'Shown in the cart, checkout and order page.' }),
          ],
        },
        {
          label: 'Announcement & support',
          fields: [
            {
              name: 'announcement',
              type: 'group',
              admin: { description: 'The bar above the navigation (off by default).' },
              fields: [
                { name: 'enabled', type: 'checkbox', defaultValue: P.announcement.enabled, label: 'Show the announcement bar' },
                text('text', P.announcement.text, { validate: checkAnnouncementText, maxLength: 140 }),
                text('href', P.announcement.href, {
                  validate: checkHref,
                  normalise: trimmed,
                  description: 'Optional link, e.g. /shop or https://…',
                }),
              ],
            },
            text('supportWhatsappE164', P.supportWhatsappE164, {
              validate: optional(matches(E164_RE, 'Use the international format with +, e.g. +919845262777.')),
              normalise: compact,
              description: 'WhatsApp support number in E.164, e.g. +919845262777. Empty hides WhatsApp help.',
            }),
            {
              name: 'welcomeOffer',
              type: 'group',
              admin: { description: 'Terms for the welcome code issued on newsletter confirmation.' },
              fields: [
                {
                  name: 'percent',
                  type: 'number',
                  required: true,
                  min: 1,
                  max: 100,
                  defaultValue: P.welcomeOffer.percent,
                  validate: integerIn(1, 100),
                },
                {
                  name: 'maxDiscountPaise',
                  type: 'number',
                  required: true,
                  min: 0,
                  defaultValue: P.welcomeOffer.maxDiscountPaise,
                  // 0 = no cap: the code (buildWelcomeCoupon) and the welcome email both read it that way.
                  validate: wholeRupees(0),
                  admin: { description: 'Largest discount (paise, whole rupees: ₹75 is 7500). 0 = no cap.' },
                },
                {
                  name: 'validDays',
                  type: 'number',
                  required: true,
                  min: 1,
                  max: 3650,
                  defaultValue: P.welcomeOffer.validDays,
                  validate: integerIn(1, 3650),
                },
              ],
            },
          ],
        },
        {
          label: 'Legal',
          fields: [
            {
              name: 'legal',
              type: 'group',
              admin: { description: 'Only fields that are filled in are shown on the storefront.' },
              fields: [
                text('entityName', P.legal.entityName),
                text('address', P.legal.address, { textarea: true }),
                text('fssaiLicence', P.legal.fssaiLicence, {
                  validate: optional(matches(FSSAI_RE, 'The FSSAI licence number has 14 digits.')),
                  normalise: compact,
                }),
                text('gstin', P.legal.gstin, {
                  validate: optional(matches(GSTIN_RE, 'Enter the 15-character GSTIN, e.g. 29ABCDE1234F1Z5.')),
                  normalise: upper,
                }),
                {
                  name: 'grievanceOfficer',
                  type: 'group',
                  admin: { description: 'Required by the Consumer Protection (E-Commerce) Rules, 2020.' },
                  fields: [
                    text('name', ''),
                    text('designation', ''),
                    text('email', '', { validate: optional(matches(EMAIL_RE, 'Enter a valid email address.')), normalise: trimmed }),
                    text('phone', ''),
                  ],
                },
              ],
            },
          ],
        },
        {
          label: 'Server only',
          description: 'Never published to the storefront.',
          fields: [
            {
              name: 'reservationMinutes',
              type: 'number',
              required: true,
              min: 1,
              max: 24 * 60,
              defaultValue: S.reservationMinutes,
              access: adminOnlyField,
              validate: integerIn(1, 24 * 60),
              admin: { description: 'How long stock stays reserved for an unpaid online order (1–1440).' },
            },
            pinPrefixList('blockedPinPrefixes', 'PIN prefixes we do not deliver to at all (e.g. 744 for the Andamans).'),
            pinPrefixList('codBlockedPinPrefixes', 'PIN prefixes where cash on delivery is not offered.'),
            {
              name: 'codMaxOpenPerPhone',
              type: 'number',
              required: true,
              min: 0,
              max: 1000,
              defaultValue: S.codMaxOpenPerPhone,
              access: adminOnlyField,
              validate: integerIn(0, 1000),
              admin: { description: 'Most open (unconfirmed) COD orders allowed per phone number.' },
            },
          ],
        },
      ],
    },
  ],
}
