import type { CollectionAfterOperationHook, PayloadRequest } from 'payload'
import { APIError } from 'payload'

type BulkError = { id: number | string; message?: string; isPublic?: boolean }
export type BulkRefusal = { label?: string; errors: { path: string; message: string }[] }

/**
 * Payload's bulk update (PATCH /api/<collection>?where=…, the admin list's "Edit" drawer) runs every selected
 * document in ONE shared transaction, catches each document's error into `result.errors`, answers 400
 * "Unable to update N out of M …" and then COMMITS it (payload/dist/collections/operations/update.js; the
 * Postgres adapter doesn't set bulkOperationsSingleTransaction). Whatever a refused document had already
 * written is kept: an order row written before its afterChange hook refused "→ paid" (out of stock), a
 * product's "Adjust stock by" applied before its validation failed.
 *
 * This afterOperation hook runs before that commit. When any document failed it throws, so the operation's
 * catch rolls the whole transaction back: a bulk edit is all-or-nothing, like a single-document save, and
 * the answer says nothing was saved and why. `refusal(req, id)` may name the reason a document was refused
 * (the per-document error keeps only a generic message such as "The following field is invalid: status");
 * its field errors are also returned as `data.errors`, so the Edit drawer marks the field.
 * Single-document saves (operation 'updateByID') roll back on their own and are left alone.
 */
export function bulkUpdateAllOrNothing(opts: {
  plural: string
  refusal?: (req: PayloadRequest, id: number | string) => BulkRefusal | undefined
}): CollectionAfterOperationHook {
  return async ({ operation, req, result }) => {
    if (operation !== 'update') return result
    const r = result as { docs?: unknown[]; errors?: BulkError[] } | undefined
    const errors = Array.isArray(r?.errors) ? r.errors : []
    if (errors.length === 0) return result
    const total = errors.length + (Array.isArray(r?.docs) ? r.docs.length : 0)
    const fieldErrors: { path: string; message: string }[] = []
    const reasons = errors.map((e) => {
      const known = opts.refusal?.(req, e.id)
      if (known?.errors.length) {
        fieldErrors.push(...known.errors)
        return `${known.label ?? `#${e.id}`}: ${known.errors.map((x) => x.message).join(' ')}`
      }
      return `#${e.id}: ${e.isPublic && e.message ? e.message : 'Something went wrong.'}`
    })
    const message = `Nothing was saved: ${errors.length} of ${total} ${opts.plural} could not be updated. ${reasons.join(' | ')}`
    throw new APIError(message, 400, { errors: fieldErrors }, true)
  }
}
