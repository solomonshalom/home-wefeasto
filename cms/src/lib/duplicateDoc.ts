import type { CollectionBeforeOperationHook, FieldHook } from 'payload'

import { SLUG_MAX, truncateSlug } from '../endpoints/catalog/rules'

/**
 * Admin ⋯ → Duplicate (POST /api/<collection>/:id/duplicate) for products, recipes and pages.
 *
 * Payload's default for a unique text field turns the slug into "health-mix - Copy", which no slug rule
 * accepts (guardSlug: "The following field is invalid: slug"), and its default for a unique number keeps
 * the SAME sortOrder (a unique-index clash). So the copy is made like this instead:
 *   - slug: `<slug>-copy`, then `-copy-2`, `-copy-3`, … the first one no document uses (drafts included),
 *     cut to SLUG_MAX characters; a recipe's `wf-` prefix stays. Copying a copy counts on from its stem
 *     (health-mix-copy → health-mix-copy-2, not health-mix-copy-copy).
 *   - sortOrder: emptied, so fillSlugAndSortOrder gives it the next free spot (after the last one).
 *   - it is always saved as a DRAFT: a published copy would put a second identical product / recipe / page
 *     on the storefront before the editor has changed anything.
 * A slug the caller sends with the request still wins (and is checked by guardSlug like any new slug).
 */

type CopyableCollection = 'products' | 'recipes' | 'pages'

const COPY_TAIL_RE = /-copy(?:-\d+)?$/
const BATCH = 50
const MAX_TRIES = 1000

/** `<stem>-copy` (n = 1) or `<stem>-copy-<n>`, at most `max` characters, where `stem` drops an earlier copy tail. */
export function copySlug(slug: string, n: number, max: number = SLUG_MAX): string {
  const stem = slug.replace(COPY_TAIL_RE, '') || slug
  const tail = n <= 1 ? '-copy' : `-copy-${n}`
  return `${truncateSlug(stem, max - tail.length)}${tail}`
}

/** Field beforeDuplicate for `slug`: the first `<slug>-copy[-n]` no document of `collection` has. */
export const duplicateSlug =
  (collection: CopyableCollection): FieldHook =>
  async ({ value, req }) => {
    if (typeof value !== 'string' || value === '') return value
    for (let from = 1; from <= MAX_TRIES; from += BATCH) {
      const candidates = Array.from({ length: BATCH }, (_, i) => copySlug(value, from + i))
      const taken = await req.payload.find({
        collection,
        where: { slug: { in: candidates } },
        pagination: false,
        depth: 0,
        select: { slug: true },
        overrideAccess: true,
        req,
      })
      const used = new Set(taken.docs.map((d) => (d as { slug?: unknown }).slug))
      const free = candidates.find((c) => !used.has(c))
      if (free) return free
    }
    // A thousand copies of one document: fall back to a time-based tail (still kebab-case, still unique).
    const tail = `-copy-${Date.now().toString(36)}`
    return `${truncateSlug(value.replace(COPY_TAIL_RE, '') || value, SLUG_MAX - tail.length)}${tail}`
  }

/** Field beforeDuplicate: the copy starts with this field empty (null), e.g. sortOrder → next free spot. */
export const emptyOnDuplicate: FieldHook = () => null

/** Field beforeDuplicate: the copy starts with this value (e.g. stock → 0 packs of a new product). */
export const resetOnDuplicate =
  (value: unknown): FieldHook =>
  () =>
    value

/** Collection beforeOperation: a duplicate is always created as a draft, whatever the request asked for. */
export const duplicateAsDraft: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'create') return args
  const a = args as { duplicateFromID?: unknown; data?: Record<string, unknown> | null }
  if (a.duplicateFromID === undefined || a.duplicateFromID === null) return args
  return { ...args, draft: true, data: { ...(a.data ?? {}), _status: 'draft' } }
}
