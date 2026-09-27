import {
  APIError,
  type CollectionAfterChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  type PayloadRequest,
  type Where,
} from 'payload'

import { anyone, isAdminOrEditor, userIsStaff } from '../access'
import { lockRow } from '../commerce/checkout/db'
import { deployHook } from '../hooks/deployHook'
import { MEDIA_MIME_TYPES, stripUploadMetadata } from '../lib/imageMetadata'

/**
 * Images for products, recipes and pages. Stored on local disk (cms/media, gitignored) in dev;
 * `@payloadcms/storage-vercel-blob` takes over when BLOB_READ_WRITE_TOKEN is set (see payload.config.ts).
 * Uploads are re-encoded without their EXIF/GPS metadata, and non-web photos (TIFF, …) converted to JPEG/PNG
 * (src/lib/imageMetadata.ts); an image a product uses
 * can be neither deleted nor have its file replaced.
 */

/** Explicit error name (survives minification): payload.config.ts logs it at info level. */
export const MEDIA_IN_USE_ERROR = 'MediaInUseError'

const usedBy = (names: string[], more: number) =>
  `This image is used by ${names.map((n) => `"${n}"`).join(', ')}${more > 0 ? ` and ${more} more` : ''}. `

export const mediaInUseMessage = (names: string[], more: number) =>
  usedBy(names, more) + 'Choose another image (or an image path) for those products first.'

export const mediaReplaceInUseMessage = (names: string[], more: number) =>
  usedBy(names, more) +
  "Its file can't be replaced while they use it: the live storefront shows this file. Upload the new photo as a new image and choose it on those products."

export class MediaInUseError extends APIError<{ code: 'MEDIA_IN_USE'; products: string[] }> {
  constructor(names: string[], total: number, action: 'delete' | 'replace' = 'delete') {
    const message = action === 'replace' ? mediaReplaceInUseMessage : mediaInUseMessage
    super(message(names, total - names.length), 409, { code: 'MEDIA_IN_USE', products: names }, true)
    this.name = MEDIA_IN_USE_ERROR
  }
}

/**
 * Products that use image `id` as their upload (`imageUpload`), in the live document or in its latest draft,
 * after locking the media row when in a transaction.
 */
export async function productsUsingMedia(req: PayloadRequest, id: number | string): Promise<{ names: string[]; total: number }> {
  if (req.transactionID) await lockRow(req, 'media', id)
  const where = { imageUpload: { equals: id } }
  const common = { collection: 'products' as const, where, depth: 0, limit: 5, overrideAccess: true, req, select: { name: true } }
  const [live, drafts] = await Promise.all([req.payload.find(common), req.payload.find({ ...common, draft: true })])
  const byId = new Map<string, string>()
  for (const doc of [...live.docs, ...drafts.docs]) byId.set(String(doc.id), String((doc as { name?: unknown }).name ?? doc.id))
  return { names: [...byId.values()].slice(0, 5), total: Math.max(live.totalDocs, drafts.totalDocs, byId.size) }
}

/**
 * Refuses to delete an image a product uses as its uploaded image (`imageUpload`), in the live document or
 * in its latest draft. A product may leave the image path empty when it has an upload (cms-catalog.md §1);
 * deleting that upload would null the relation (FK ON DELETE SET NULL) and leave a published product with
 * no image, which the snapshot validator refuses (sync-cms would stop taking catalog changes).
 *
 * Runs inside the delete's transaction after locking the media row: a concurrent product save that points
 * at this image either commits first (its foreign-key check holds the row) and is counted, or waits and then
 * fails its foreign-key check once the image is gone.
 */
export const refuseDeleteWhenUsed: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { names, total } = await productsUsingMedia(req, id)
  if (total > 0) throw new MediaInUseError(names, total)
}

/**
 * Refuses to replace the FILE of an image a product uses (Media → × → new photo → Save, or PATCH with a
 * file). The storefront is prerendered with the image's URL (/api/media/file/<filename>) baked in, a new
 * file gets a new filename, and Payload deletes the old file (from disk before any beforeChange hook runs,
 * from the blob store after the save), so every built page would show a broken image until some unrelated
 * rebuild. Runs in beforeOperation, before any file is touched. Alt text and focal point edits (same file)
 * are not affected.
 */
export const refuseFileReplaceWhenUsed: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'update' || !req.file) return args
  // A REST caller who isn't staff is refused by access control right after this (and must learn nothing).
  if (req.payloadAPI !== 'local' && !userIsStaff(req.user)) return args
  const a = args as { id?: number | string | null; where?: Where }
  let ids: (number | string)[] = []
  if (a.id !== undefined && a.id !== null) ids = [a.id]
  else if (a.where) {
    const res = await req.payload.find({ collection: 'media', where: a.where, depth: 0, pagination: false, overrideAccess: true, req, select: { filename: true } })
    ids = res.docs.map((d) => d.id)
  }
  for (const id of ids) {
    const { names, total } = await productsUsingMedia(req, id)
    if (total > 0) throw new MediaInUseError(names, total, 'replace')
  }
  return args
}

/**
 * Safety net: if an image a PUBLISHED product shows ever gets a new URL anyway (a new filename), the
 * storefront pages that bake the old URL in must be rebuilt.
 */
export const rebuildWhenLiveImageMoves: CollectionAfterChangeHook = async ({ doc, operation, previousDoc, req, context }) => {
  try {
    if (operation !== 'update' || (context as { skipDeployHook?: boolean })?.skipDeployHook) return doc
    if (!previousDoc?.filename || previousDoc.filename === doc.filename) return doc
    const { totalDocs } = await req.payload.count({
      collection: 'products',
      where: { and: [{ imageUpload: { equals: doc.id } }, { _status: { equals: 'published' } }] },
      overrideAccess: true,
      req,
    })
    if (totalDocs > 0) deployHook.schedule(`media:${String(doc.filename)} update`)
  } catch {
    /* never throw into the request */
  }
  return doc
}

/**
 * Largest upload Payload accepts (config `upload.limits.fileSize`). Production runs on Vercel, whose functions
 * refuse a request body over 4.5 MB with a raw 413 before Payload runs, and uploads must pass through the
 * function (stripUploadMetadata re-encodes every photo server-side to drop EXIF/GPS, so no clientUploads).
 * 4 MiB leaves room for the multipart overhead, so a bigger photo gets Payload's own "file size limit" message.
 */
export const MEDIA_MAX_UPLOAD_BYTES = 4 * 1024 * 1024

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    group: 'Content',
    defaultColumns: ['filename', 'alt', 'updatedAt'],
    description: 'Images up to 4 MB each. For a bigger photo, export a smaller JPEG first (about 2000 px wide is plenty).',
  },
  access: {
    read: anyone,
    create: isAdminOrEditor,
    update: isAdminOrEditor,
    delete: isAdminOrEditor,
  },
  hooks: {
    // Order matters: refuse an in-use replacement before spending time re-encoding the new file.
    beforeOperation: [refuseFileReplaceWhenUsed, stripUploadMetadata],
    afterChange: [rebuildWhenLiveImageMoves],
    beforeDelete: [refuseDeleteWhenUsed],
  },
  upload: {
    // Relative to the process cwd (cms/ for every npm script). Not import.meta.url: Next bundles this file.
    staticDir: 'media',
    // Web formats only (JPEG, PNG, WebP, AVIF, GIF, SVG): a photo browsers can't show would be a broken product
    // image for most shoppers. TIFF is accepted because stripUploadMetadata converts it to JPEG/PNG first;
    // HEIC, PSD, BMP, … are refused there with a message asking for a JPEG or PNG.
    mimeTypes: MEDIA_MIME_TYPES,
    focalPoint: true,
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
      maxLength: 250,
      admin: { description: 'Describe the image for screen readers (what a shopper would need to know).' },
    },
  ],
  timestamps: true,
}
