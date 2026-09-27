import { APIError, type CollectionBeforeOperationHook, type PayloadRequest, type Where } from 'payload'

import { userIsAdminOrEditor } from '../access/roles'

/**
 * A save that says neither "draft" nor "publish" must never unpublish a live document.
 *
 * Products, recipes and pages have drafts. Payload applies a non-draft update to the document's LATEST
 * VERSION and keeps that version's `_status`, so when an editor has saved unpublished changes, a plain
 * `PATCH /api/products/:id {stockAdjust: 5}` (the documented REST stock adjustment, cms-hardening.md §5),
 * `{inStock: false}`, … without `_status` writes the DRAFT's content — and `_status: 'draft'` — onto the
 * live row: the product drops out of /api/store/catalog (bags refused at checkout, page gone on the next
 * build) and the unreviewed draft price is live. The admin UI is unaffected (its buttons always send
 * `_status` or save a draft); scripts and REST callers are not.
 *
 * So, for an update with no `draft` flag and no `_status`, on a published document whose latest version is
 * an unpublished draft:
 *   - a stock-only change (`stockAdjust`) becomes a draft save: the stock hook still applies it to the live
 *     row atomically (src/lib/productStock.ts), and the published content and status stay as they are;
 *   - anything else is refused with 409 UNPUBLISHED_CHANGES, saying how to publish or save as a draft.
 * Documents without pending draft changes (or never published) are not affected.
 */

export const UNPUBLISHED_CHANGES = 'UNPUBLISHED_CHANGES'

/** Fields a stock-only request may carry (virtual, never content). */
const STOCK_ONLY_KEYS = new Set(['stockAdjust', 'stockOnHand'])

export const unpublishedChangesMessage = (noun: string): string =>
  `This ${noun} has unpublished draft changes, so a save that is neither "Publish" nor "Save draft" would take it off the ` +
  `storefront. Send _status "published" to publish them, or save with ?draft=true to keep them as a draft.`

type UpdateArgs = { id?: number | string | null; where?: Where; data?: unknown; draft?: boolean }

/** Ids of the documents this update touches (by id, or the matches of `where`). */
async function targetIds(req: PayloadRequest, slug: string, a: UpdateArgs): Promise<(number | string)[]> {
  if (a.id !== undefined && a.id !== null) return [a.id]
  if (!a.where) return []
  const res = await req.payload.find({
    collection: slug as 'products',
    where: a.where,
    pagination: false,
    depth: 0,
    select: { slug: true },
    overrideAccess: true,
    req,
  })
  return res.docs.map((d) => d.id)
}

/** True when one of `ids` is published and its latest version is an unpublished draft. */
export async function hasUnpublishedChanges(req: PayloadRequest, slug: string, ids: (number | string)[]): Promise<boolean> {
  if (!ids.length) return false
  const published = await req.payload.find({
    collection: slug as 'products',
    where: { and: [{ id: { in: ids } }, { _status: { equals: 'published' } }] },
    pagination: false,
    depth: 0,
    select: { slug: true },
    overrideAccess: true,
    req,
  })
  const live = published.docs.map((d) => d.id)
  if (!live.length) return false
  const latest = await req.payload.db.findVersions({
    collection: slug as 'products',
    where: { and: [{ parent: { in: live } }, { latest: { equals: true } }] },
    pagination: false,
    limit: 0,
    req,
  })
  return latest.docs.some((v) => (v.version as { _status?: unknown })?._status === 'draft')
}

/** beforeOperation for versioned (drafts) collections; `noun` names the document in the refusal. */
export const keepPublishStateOnPlainUpdate =
  (noun: string): CollectionBeforeOperationHook =>
  async ({ args, collection, operation, req }) => {
    if (operation !== 'update') return args
    const a = args as UpdateArgs
    if (a.draft) return args
    const data = a.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return args
    if ((data as { _status?: unknown })._status !== undefined) return args
    if (req.context?.isRestoringVersion) return args
    // REST from a non-staff user is refused by access control right after this (and must not learn
    // whether a draft exists).
    if (req.payloadAPI !== 'local' && !userIsAdminOrEditor(req.user)) return args
    if (!(await hasUnpublishedChanges(req, collection.slug, await targetIds(req, collection.slug, a)))) return args

    const keys = Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined)
    if (keys.length > 0 && keys.every((k) => STOCK_ONLY_KEYS.has(k))) {
      a.draft = true
      return args
    }
    throw new APIError(unpublishedChangesMessage(noun), 409, { code: UNPUBLISHED_CHANGES }, true)
  }
