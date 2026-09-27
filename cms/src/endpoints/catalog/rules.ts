/**
 * Catalog content rules shared by the Products / Recipes / Pages collections, the seed and the
 * /api/store/{snapshot,catalog} endpoints.
 *
 * They mirror REPO/src/lib/data/snapshot-schema.js (the storefront validator that `sync-cms` runs before
 * it accepts a snapshot), so an editor can never publish a value that would block the sync.
 * tests/unit/catalogRules.test.ts runs both validators over the same samples and fails on drift.
 *
 * Validators follow Payload's `validate` contract: return `true` or an error message. Content that is
 * only required to PUBLISH (not to save a draft) uses `requiredToPublish`, which skips the "required"
 * part while the document is a draft (`data._status === 'draft'`) but still checks the format of any
 * value that is present.
 */
import type { CollectionBeforeChangeHook, CollectionBeforeValidateHook, PayloadRequest, Where } from 'payload'
import { ValidationError } from 'payload'

import { MAX_UNIT_PAISE } from '../../commerce/shared/pricing.js'
import { SLUG_MAX } from '../../commerce/shared/validate.js'

/**
 * The checkout's own limits ($shared/validate.js, $shared/pricing.js): a product slug is the cart key and
 * checkout refuses one longer than SLUG_MAX (BAD_SLUG), and prices a unit above MAX_UNIT_PAISE as
 * UNAVAILABLE. The CMS refuses both on save, so it can never publish a product nobody can buy.
 */
export { MAX_UNIT_PAISE, SLUG_MAX }

/* ------------------------------------------------------------------ enums */

/** = the /shop filter chips. */
export const PRODUCT_CATEGORIES = ['Flakes', 'Oats', 'Muesli', 'Mix'] as const
/** = the /recipes filter chips. */
export const RECIPE_CATEGORIES = ['Breakfast', 'Kids', 'Snacks', 'Desserts'] as const

/**
 * Recipe tag / icon chip colours. The first four are the colour-mix accent ring (src/lib/colormix.js);
 * the last two are legacy spellings used by today's recipes (kept so the pages stay byte-identical).
 * The site's background/ink hexes (#f9f4ef, #fff6e7, #ffdede, #fffdfa, #333333) are deliberately NOT
 * offered: the snapshot validator rejects them and a cream chip on a cream page would be invisible.
 */
export const RECIPE_COLOR_OPTIONS = [
  { label: 'Coral #ff8d5e', value: '#ff8d5e' },
  { label: 'Yellow #ffc33a', value: '#ffc33a' },
  { label: 'Plum #d499eb', value: '#d499eb' },
  { label: 'Lime #2cdb69', value: '#2cdb69' },
  { label: 'Plum (legacy #d498eb)', value: '#d498eb' },
  { label: 'Lime (legacy hsla)', value: 'hsla(141, 70.74%, 51.53%, 1.00)' },
] as const
export const RECIPE_COLORS = RECIPE_COLOR_OPTIONS.map((o) => o.value)

/** Card category icons shipped in REPO/static/images. */
export const RECIPE_ICON_OPTIONS = [
  { label: 'Heart (Breakfast)', value: '/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg' },
  { label: 'Hamburger (Kids, Desserts)', value: '/images/626aeeee73f41522db4989fb_hamburger_fill.svg' },
  { label: 'Barbell (Snacks)', value: '/images/626aef0610d6909bf9f81543_barbell_fill.svg' },
] as const
export const RECIPE_ICONS = RECIPE_ICON_OPTIONS.map((o) => o.value)

/** How a mini product card spells its rating for screen readers ('decimal' → "4.0", 'plain' → "4"). */
export const RATING_STYLES = ['decimal', 'plain'] as const

/* --------------------------------------------------------------- patterns */

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Recipe route slugs keep the legacy `wf-` prefix (/recipes/wf-…), for old and new recipes alike. */
export const RECIPE_SLUG_RE = /^wf-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PATH_OR_URL_RE = /^(\/(?!\/)|https:\/\/)\S*$/
export const HTTPS_URL_RE = /^https:\/\/\S+$/
export const E164_RE = /^\+[1-9]\d{7,14}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const FSSAI_RE = /^\d{14}$/
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
/**
 * Storefront pages render these fields with {@html}: no script, frames, forms, handlers or JS URLs.
 * Kept identical to REPO/src/lib/data/snapshot-schema.js (same builder, drift-tested in catalogRules.test.ts).
 *   - tags: <script|iframe|object|embed|style|link|meta|base|form
 *   - on…= handlers after anything the HTML tokenizer ends an attribute (or tag name) with: whitespace, "/"
 *     (<svg/onload=…>), or a closing quote (<img src="x"onerror=…>)
 *   - javascript: as the browser reads it: any letter (or the colon) may be a numeric character reference
 *     of EITHER case, since URL schemes are case-insensitive (&#106; &#x6A; &#74; &#x4A;, leading zeros,
 *     ';' optional), and tab / LF / CR (raw or as references), which the URL parser drops, may sit between
 *     the letters (jav&#x61;script:, &#74;avascript:, javascript&colon;, java&#9;script:)
 *   - data:text/html
 */
const htmlChar = (c: string): string => {
  const codes = [...new Set([c.toLowerCase().charCodeAt(0), c.toUpperCase().charCodeAt(0)])]
  const refs = codes.map((code) => `&#0*${code};?|&#x0*${code.toString(16)};?`).join('|')
  return `(?:${c === ':' ? ':|&colon;' : c}|${refs})`
}
const URL_GAP = '(?:[\\t\\n\\r]|&#0*(?:9|10|13);?|&#x0*[9ad];?|&tab;|&newline;)*'
const JS_SCHEME = [...'javascript:'].map(htmlChar).join(URL_GAP)
export const UNSAFE_HTML_RE = new RegExp(
  `<\\s*(?:script|iframe|object|embed|style|link|meta|base|form)\\b|[\\s/"']on[a-z]+\\s*=|${JS_SCHEME}|data:text\\/html`,
  'i',
)
/**
 * Marks a page the owner has not reviewed yet: the "Draft — to be reviewed" line the policy drafts open
 * with, and the "[to be added]" placeholders for missing legal details. The snapshot validator refuses a
 * storefront page that still carries either (snapshot-schema.md §5), so the Pages collection does too.
 */
export const UNREVIEWED_TEXT_RE = /Draft\s*[—–-]+\s*to be reviewed|\[\s*to be added\s*\]/i

/** Payload fills a missing sortOrder with (current max + this) on create. */
export const SORT_STEP = 10

/* ---------------------------------------------------------------- helpers */

export const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/** Snapshot rule for nullable strings: null / undefined / whitespace-only → null, anything else untouched. */
export const nullableText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** Lower-case kebab-case slug from a display name ("Choco's Flakes!" → "chocos-flakes"). */
export function slugify(input: unknown): string {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A made-up slug cut to at most `max` characters at a hyphen (whole words), or mid-word when that would
 * drop more than half of it (one very long word, or only a `wf-` prefix left). Always a valid kebab-case
 * slug again (no trailing hyphen).
 */
export function truncateSlug(slug: string, max: number = SLUG_MAX): string {
  if (slug.length <= max) return slug
  const at = slug.slice(0, max + 1).lastIndexOf('-')
  return (at >= Math.ceil(max / 2) ? slug.slice(0, at) : slug.slice(0, max)).replace(/-+$/g, '')
}

/**
 * Days one eater takes to finish a pack (roadmap S2): round(packGrams / servingGrams / 0.8), at least 1.
 * null when either weight is unknown. Same rule the initial snapshot used.
 */
export function daysPerPackFrom(packGrams: unknown, servingGrams: unknown): number | null {
  if (!Number.isInteger(packGrams) || !Number.isInteger(servingGrams)) return null
  if ((packGrams as number) < 1 || (servingGrams as number) < 1) return null
  return Math.max(1, Math.round((packGrams as number) / (servingGrams as number) / 0.8))
}

/* ------------------------------------------------------------- validators */

export type ValidateArgs = {
  data?: Record<string, unknown> | null
  siblingData?: Record<string, unknown> | null
  id?: number | string
  req?: PayloadRequest
  [key: string]: unknown
}
export type Check = (value: unknown, args: ValidateArgs) => true | string
type Rule = (value: unknown, args: ValidateArgs) => true | string

const REQUIRED = 'This field is required.'

/** True while saving/keeping a draft: required-ness is relaxed, formats are still checked. */
export const isDraft = (args: ValidateArgs | undefined): boolean => args?.data?._status === 'draft'

/** Required to publish; `rule` runs on any value that is present (drafts included). */
export const requiredToPublish =
  (rule?: Rule): Check =>
  (value, args) => {
    if (isBlank(value)) return isDraft(args) ? true : REQUIRED
    return rule ? rule(value, args) : true
  }

/** Optional: blank is fine; `rule` runs on any value that is present. */
export const optional =
  (rule: Rule): Check =>
  (value, args) =>
    isBlank(value) ? true : rule(value, args)

export const matches =
  (re: RegExp, message: string): Rule =>
  (value) =>
    typeof value === 'string' && re.test(value) ? true : message

export const integerIn =
  (min: number, max = Number.MAX_SAFE_INTEGER, message?: string): Rule =>
  (value) =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
      ? true
      : (message ?? (max === Number.MAX_SAFE_INTEGER ? `Enter a whole number ≥ ${min}.` : `Enter a whole number from ${min} to ${max}.`))

/**
 * Money the storefront shows or charges: paise, in WHOLE rupees. Every price, fee, cap and threshold is
 * displayed as whole rupees (formatPaise rounds), so ₹49.40 would show as ₹49 while the order is charged
 * ₹49.40: checkout's total, the Pay button, /order and the emails would all disagree with the charge.
 */
export const isWholeRupees = (value: unknown, min = 0): boolean =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) % 100 === 0

export const wholeRupees =
  (min = 0): Rule =>
  (value) =>
    isWholeRupees(value, min)
      ? true
      : `Enter whole rupees in paise${min > 0 ? `, at least ₹${Math.ceil(min / 100)}` : ''}: ₹49 is 4900 (the shop shows whole rupees, so ₹49.40 can't be charged).`

export const oneOf =
  (values: readonly string[], what = 'value'): Rule =>
  (value) =>
    typeof value === 'string' && values.includes(value) ? true : `Choose a valid ${what}.`

/** Every rule in turn; the first message wins. */
export const allOf =
  (...rules: Rule[]): Rule =>
  (value, args) => {
    for (const rule of rules) {
      const result = rule(value, args)
      if (result !== true) return result
    }
    return true
  }

export const safeHtml: Rule = (value) =>
  typeof value !== 'string'
    ? 'Enter HTML text.'
    : UNSAFE_HTML_RE.test(value)
      ? 'HTML may not contain <script>, <style>, frames, forms, on…= handlers or javascript: links.'
      : true

/**
 * Page title / body: once the page is shown on the storefront (`published` ticked, and not a draft save),
 * it may no longer carry the Draft line or a "[to be added]" placeholder. Before that, anything goes.
 */
export const checkReviewed: Rule = (value, args) => {
  if (isDraft(args) || args?.siblingData?.published !== true || typeof value !== 'string') return true
  const hit = value.match(UNREVIEWED_TEXT_RE)
  return hit
    ? `Still contains "${hit[0]}". Review the page and remove it before ticking "Show on the storefront".`
    : true
}

export const checkSlug = matches(SLUG_RE, 'Use lower-case letters, numbers and single hyphens, e.g. rolled-oats.')
export const slugTooLongMessage = (max: number = SLUG_MAX): string =>
  `Keep the slug to ${max} characters or fewer (it is the cart key: checkout can't sell a product with a longer one).`
/** Products: the pattern, plus at most SLUG_MAX characters (the checkout's cart-key limit). */
export const checkProductSlug: Rule = (value, args) => {
  const pattern = checkSlug(value, args)
  if (pattern !== true) return pattern
  return (value as string).length <= SLUG_MAX ? true : slugTooLongMessage()
}
export const checkRecipeSlug = matches(RECIPE_SLUG_RE, 'Recipe slugs start with wf-, e.g. wf-masala-oats.')
export const checkPathOrUrl = matches(PATH_OR_URL_RE, 'Use a site path like /images/x.jpg or an https:// URL.')
export const checkHttpsUrl = matches(HTTPS_URL_RE, 'Use a full https:// link.')

/**
 * Whole paise, ₹1 – ₹1 crore, whole rupees only (the storefront shows whole rupees: ₹175.50 would render as
 * ₹176). Above MAX_UNIT_PAISE checkout treats the price as a catalog error and won't sell the product.
 */
export const checkPricePaise: Rule = (value) => {
  if (!Number.isSafeInteger(value)) return 'Enter the price in whole paise (₹175 = 17500).'
  if ((value as number) < 100) return 'The price must be at least ₹1 (100 paise).'
  if ((value as number) > MAX_UNIT_PAISE)
    return `The price can be at most ₹${(MAX_UNIT_PAISE / 100).toLocaleString('en-IN')} (${MAX_UNIT_PAISE} paise): checkout can't sell a pricier product.`
  if ((value as number) % 100 !== 0) return 'Use whole rupees: the price in paise must end in 00 (₹175 = 17500).'
  return true
}

/** 0–5 with at most one decimal place. */
export const checkRating: Rule = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5) return 'Enter a rating from 0 to 5.'
  return Math.abs(value * 10 - Math.round(value * 10)) > 1e-9 ? 'Use at most one decimal place, e.g. 4.3.' : true
}

/** Each entry a non-blank string (text hasMany). */
export const checkStringList: Rule = (value) =>
  value == null || (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== ''))
    ? true
    : 'Remove empty entries.'

/** Product image path: required to publish unless an uploaded image overrides it. */
export const checkImagePath: Check = (value, args) => {
  if (isBlank(value)) {
    return isDraft(args) || !isBlank(relId(args?.siblingData?.imageUpload)) ? true : 'Add an image path or upload an image.'
  }
  return checkPathOrUrl(value, args)
}

/** homeAlt is required while homeFeatured is ticked. */
export const checkHomeAlt: Check = (value, args) =>
  args?.siblingData?.homeFeatured === true && isBlank(value) && !isDraft(args)
    ? 'Required while "Show on the home page" is ticked.'
    : true

/** A relationship id, whatever depth it arrived at. */
export const relId = (v: unknown): number | string | null => {
  if (v && typeof v === 'object' && 'id' in (v as object)) return (v as { id: number | string }).id
  return typeof v === 'number' || typeof v === 'string' ? v : null
}

/** hasMany relationship: no duplicates and no reference to the document itself. */
export const checkRefList =
  (what: string): Check =>
  (value, args) => {
    if (value == null) return true
    if (!Array.isArray(value)) return `Choose ${what}.`
    const ids = value.map(relId).map(String)
    if (args?.id != null && ids.includes(String(args.id))) return `A ${what.replace(/s$/, '')} cannot link to itself.`
    if (new Set(ids).size !== ids.length) return `Each ${what.replace(/s$/, '')} can only be listed once.`
    return true
  }

/* ---------------------------------------------------------- visibility */

/**
 * A page is on the storefront when it is Payload-published AND "Show on the storefront" is ticked
 * (snapshot-schema.md §5.2). This is both the snapshot's page filter and what customers and guests may
 * read through REST/GraphQL: the policy drafts are staff-only until the owner has reviewed them.
 * A fresh object each call (Payload combines access results into the query it builds).
 */
export const livePageWhere = (): Where => ({
  and: [{ _status: { equals: 'published' } }, { published: { equals: true } }],
})

/* ------------------------------------------------------------ slug guard */

/**
 * Top-level storefront paths a CMS page can never take: the storefront's own routes, static folders and
 * the API. The storefront silently gives a page with one of these slugs no route and no footer link
 * (src/params/policy.js RESERVED_SLUGS, which this mirrors; tests/unit/reservedSlugs.test.ts keeps the two
 * in step), so the Pages collection refuses them when the page is created.
 */
export const RESERVED_PAGE_SLUGS: readonly string[] = Object.freeze([
  '404',
  '_app',
  'account',
  'api',
  'cart',
  'checkout',
  'color-combos',
  'css',
  'fonts',
  'images',
  'js',
  'login',
  'order',
  'pin',
  'privacy',
  'products',
  'recipes',
  'reset-password',
  'shop',
  'terms',
  'videos',
])

export const reservedSlugMessage = (slug: string): string =>
  `The storefront already uses /${slug} for its own page, so a page with the slug "${slug}" would never be shown ` +
  `(no route, no footer link). Choose another slug, e.g. ${slug}-policy.`

/**
 * Collection beforeChange: the slug is the public URL (and the cart key for products), so it is
 * required, must match `re`, may not be one of `reserved` (paths the storefront keeps for itself), and can
 * never change after create — existing links, carts and orders use it. Runs for drafts too (field validation is skipped for draft saves).
 */
export function guardSlug(
  collection: string,
  re: RegExp,
  message: string,
  reserved: readonly string[] = [],
  maxLength = Infinity,
): CollectionBeforeChangeHook {
  return ({ data, originalDoc, operation, req }) => {
    const fail = (msg: string) => {
      throw new ValidationError({ collection, errors: [{ path: 'slug', message: msg }], req })
    }
    if (operation === 'create') {
      if (typeof data.slug !== 'string' || data.slug === '') fail(REQUIRED)
      if (!re.test(data.slug as string)) fail(message)
      if ((data.slug as string).length > maxLength) fail(slugTooLongMessage(maxLength))
      if (reserved.includes(data.slug as string)) fail(reservedSlugMessage(data.slug as string))
      return data
    }
    const before = originalDoc?.slug
    if (data.slug !== undefined && typeof before === 'string' && data.slug !== before) {
      fail(`The slug can't be changed after creation (links, carts and orders use "${before}"). Create a new entry instead.`)
    }
    return data
  }
}

/**
 * Collection beforeValidate for create: fills `slug` from the name/title (cut to SLUG_MAX characters at a
 * word boundary, so a long product name still makes a sellable cart key) and `sortOrder` with
 * (current max + SORT_STEP) when they are missing, so editors can leave both empty.
 */
export function fillSlugAndSortOrder(
  collection: 'products' | 'recipes' | 'pages',
  titleField: string,
  slugPrefix = '',
): CollectionBeforeValidateHook {
  return async ({ data, operation, req }) => {
    if (!data || operation !== 'create') return data
    if (isBlank(data.slug) && !isBlank(data[titleField])) {
      const base = slugify(data[titleField])
      if (base) data.slug = truncateSlug(slugPrefix && !base.startsWith(slugPrefix) ? `${slugPrefix}${base}` : base)
    }
    if (data.sortOrder === undefined || data.sortOrder === null) {
      const top = await req.payload.find({
        collection,
        sort: '-sortOrder',
        limit: 1,
        depth: 0,
        overrideAccess: true,
        where: { sortOrder: { exists: true } },
        req,
      })
      const max = (top.docs[0] as { sortOrder?: number } | undefined)?.sortOrder
      data.sortOrder = (Number.isSafeInteger(max) ? (max as number) : 0) + SORT_STEP
    }
    return data
  }
}
