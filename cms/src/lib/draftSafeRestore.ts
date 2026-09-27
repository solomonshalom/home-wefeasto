import {
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionSlug,
  type PayloadRequest,
  type RequestContext,
  restoreVersionOperation,
} from 'payload'

/**
 * Restoring a DRAFT version never takes a live document off the storefront.
 *
 * Payload's "Restore this version" on a draft version (the only restore the admin offers for one: its
 * "Restore as draft" option is hidden when the version is a draft) POSTs /api/<collection>/versions/:id
 * ?draft=false, and restoreVersion then writes the draft's content WITH `_status: 'draft'` onto the live
 * row: the product leaves /api/store/catalog (bags refused at checkout), the page leaves the snapshot and
 * footer, and the deploy hook rebuilds the storefront without it. The admin only sees "Restored".
 *
 * Same rule as src/lib/draftSafeUpdate.ts (a save that says neither draft nor publish never unpublishes):
 * when a published document is restored to a draft version without `draft=true`, the restore becomes a
 * restore AS A DRAFT — the live row, its content and its status stay as they are, and the restored content
 * becomes the pending draft (latest version) to review and publish, exactly what `?draft=true` does.
 *
 * Payload reads `draft` before beforeOperation hooks run (so they cannot flip it), hence three hooks:
 *   - beforeOperation records the request (version id, draft flag) in req.context;
 *   - beforeChange (first in the list) replaces the restored data with the live document, so the non-draft
 *     restore rewrites the live row unchanged (and saves it as a published version);
 *   - afterChange then restores the same version with `draft: true` in the same transaction, which makes
 *     the restored content the latest (draft) version on top.
 * Restoring a published version, or restoring onto a document that is not published, is left to Payload.
 *
 * Two Payload details this relies on: every Local API call made with `req` replaces `req.context` with a copy
 * (createLocalReq), so the context is always re-read from `req` after an await, never cached; and the Local
 * API `payload.restoreVersion` drops the `draft` option, so the draft restore calls the operation itself.
 */

const PENDING = 'wfRestoreRequest'
const CONVERT = 'wfRestoreAsDraft'

type RestoreRequest = { versionId: number | string; draft: boolean }
type Ctx = RequestContext & { [PENDING]?: RestoreRequest; [CONVERT]?: RestoreRequest; isRestoringVersion?: boolean }

/** Keys Payload manages itself or that are not content (virtual stock fields are re-derived). */
const NOT_CONTENT = new Set(['id', 'createdAt', 'updatedAt', 'stockAdjust', 'stockOnHand'])

export const recordRestoreRequest: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'restoreVersion') return args
  const a = args as { id?: number | string; draft?: boolean }
  if (a.id !== undefined && a.id !== null) (req.context as Ctx)[PENDING] = { versionId: a.id, draft: Boolean(a.draft) }
  return args
}

const ctxOf = (req: PayloadRequest): Ctx => req.context as Ctx

export const keepLiveDocOnDraftRestore: CollectionBeforeChangeHook = async ({ collection, data, operation, originalDoc, req }) => {
  const pending = ctxOf(req)[PENDING]
  if (operation !== 'update' || !ctxOf(req).isRestoringVersion || !pending) return data
  delete ctxOf(req)[PENDING]
  if (pending.draft || !data || (data as { _status?: unknown })._status !== 'draft') return data
  const id = (originalDoc as { id?: number | string } | undefined)?.id
  if (id === undefined || id === null) return data
  const slug = collection.slug as CollectionSlug
  const live = await req.payload.db.findOne({ collection: slug, where: { id: { equals: id } }, req })
  if ((live as { _status?: unknown } | null)?._status !== 'published') return data

  // The live document as a save would send it (depth 0, every field): the restore rewrites it unchanged.
  const doc = (await req.payload.findByID({
    collection: slug,
    id,
    depth: 0,
    draft: false,
    overrideAccess: true,
    showHiddenFields: true,
    req,
  })) as unknown as Record<string, unknown>
  const same: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) if (!NOT_CONTENT.has(k)) same[k] = v
  same._status = 'published'
  ctxOf(req)[CONVERT] = pending
  return same
}

export const restoreAsPendingDraft: CollectionAfterChangeHook = async ({ collection, doc, req }) => {
  const convert = ctxOf(req)[CONVERT]
  if (!convert) return doc
  delete ctxOf(req)[CONVERT]
  // Same req and transaction: if this fails, the whole restore is rolled back.
  await restoreVersionOperation({
    id: convert.versionId,
    collection: req.payload.collections[collection.slug as CollectionSlug],
    depth: 0,
    draft: true,
    overrideAccess: true,
    req,
  })
  return doc
}

/** The three hooks for a versioned (drafts) collection. `beforeChange` must run before the others. */
export const draftSafeRestore = {
  beforeOperation: recordRestoreRequest,
  beforeChange: keepLiveDocOnDraftRestore,
  afterChange: restoreAsPendingDraft,
}
