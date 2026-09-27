import fs from 'fs/promises'
import { APIError, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'

import { userIsStaff } from '../access/roles'

/**
 * Uploaded photos are published as-is at /api/media/file/<name> (on the storefront origin through the /api
 * rewrite, and baked into product pages). A phone photo carries EXIF: the GPS position where it was taken,
 * the camera make/model, often the owner's name. Media has no image sizes or format options, so Payload
 * would store and serve the original bytes, metadata included.
 *
 * So every web raster upload (JPEG, PNG, WebP, AVIF) is re-encoded in its own format before Payload stores
 * it: sharp drops all metadata (EXIF, GPS, XMP, IPTC) by default, `.rotate()` first applies the EXIF
 * orientation to the pixels so the photo still shows the right way up, and colours are converted to sRGB
 * from any embedded profile. GIF and SVG are left alone (no EXIF block; re-encoding would drop animation).
 *
 * A photo browsers can't show is never published: shoppers on Chrome, Edge, Firefox and Android would see
 * a broken product image (Safari shows TIFF, so the owner wouldn't notice). A decodable non-web raster
 * (TIFF, JPEG 2000, JPEG XL, …) is converted to JPEG, or PNG when it has transparency, with the file name
 * and type changed to match. An image sharp can't decode (a corrupt file, an HEIC phone photo, a Photoshop
 * .psd, a BMP) is refused with a 400 asking for a JPEG or PNG, rather than stored as-is.
 */

type UploadFile = NonNullable<PayloadRequest['file']>
type SharpFn = (input?: Buffer, options?: Record<string, unknown>) => any

/** Web formats (sharp's names) re-encoded in place, metadata stripped. HEIF only when AV1-coded (AVIF). */
const STRIPPED = new Set(['jpeg', 'png', 'webp', 'heif'])
/** Web formats stored byte for byte (no EXIF; re-encoding would drop animation / vectors). */
const PASSED_THROUGH = new Set(['gif', 'svg'])
const PASSED_THROUGH_MIME_RE = /^image\/(gif|svg\+xml)$/i

/** What Media accepts after this hook ran (upload.mimeTypes). TIFF is listed so the picker offers it: it's converted. */
export const MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml', 'image/tiff']

export const UNREADABLE_IMAGE_MESSAGE =
  "This photo couldn't be processed. Export it as a JPEG or PNG (e.g. with the phone's share → save as JPEG) and upload that."

const unreadable = () => new APIError(UNREADABLE_IMAGE_MESSAGE, 400, { code: 'IMAGE_UNREADABLE' }, true)

/** `name` with its extension replaced by `ext` (added when it has none). */
export const withExtension = (name: string, ext: string): string => {
  const base = String(name ?? '').replace(/\.[^./\\]*$/, '')
  return `${base || 'image'}.${ext}`
}

/** The upload with its metadata stripped (a new object; `file` is untouched). */
export async function stripImageMetadata(sharp: SharpFn | undefined, file: UploadFile): Promise<UploadFile> {
  if (!sharp) return file
  // In memory, or (with upload.useTempFiles) in a temp file, which the storage adapter would otherwise re-read.
  const input =
    Buffer.isBuffer(file.data) && file.data.length > 0 ? file.data : file.tempFilePath ? await fs.readFile(file.tempFilePath) : null
  if (!input || input.length === 0) return file
  let meta: { format?: string; pages?: number; compression?: string; hasAlpha?: boolean } | null = null
  try {
    meta = await sharp(input).metadata()
  } catch {
    meta = null
  }
  if (!meta?.format) {
    // Not an image sharp can read: an image/* upload browsers may not show either (HEIC, PSD, BMP, a corrupt
    // JPEG) is refused; GIF / SVG and non-images are left to Payload's own checks (SVG safety, mimeTypes).
    const mime = String(file.mimetype ?? '')
    if (/^image\//i.test(mime) && !PASSED_THROUGH_MIME_RE.test(mime)) throw unreadable()
    return file
  }
  if (PASSED_THROUGH.has(meta.format)) return file
  const animated = STRIPPED.has(meta.format) && (meta.pages ?? 1) > 1
  let data: Buffer
  let converted: { ext: string; mimetype: string } | null = null
  try {
    let img = sharp(input, { animated })
    if (!animated) img = img.rotate()
    switch (meta.format) {
      case 'jpeg':
        img = img.jpeg({ quality: 90 })
        break
      case 'png':
        img = img.png()
        break
      case 'webp':
        img = img.webp({ quality: 90 })
        break
      case 'heif':
        // AVIF is re-encoded as AVIF; HEVC-coded HEIC can't be decoded here (and most browsers can't show it).
        if (meta.compression !== 'av1') throw unreadable()
        img = img.avif({ quality: 70 })
        break
      default:
        // TIFF & co. (first page only): a browser-safe JPEG, or PNG to keep transparency.
        converted = meta.hasAlpha ? { ext: 'png', mimetype: 'image/png' } : { ext: 'jpg', mimetype: 'image/jpeg' }
        img = meta.hasAlpha ? img.png() : img.flatten({ background: '#ffffff' }).jpeg({ quality: 90 })
    }
    data = await img.toBuffer()
  } catch {
    throw unreadable()
  }
  const out = { ...file, data, size: data.length, tempFilePath: undefined } as UploadFile
  return converted ? ({ ...out, name: withExtension(file.name, converted.ext), mimetype: converted.mimetype } as UploadFile) : out
}

/** media beforeOperation (create / update): strips the uploaded file's metadata before Payload stores it. */
export const stripUploadMetadata: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if ((operation !== 'create' && operation !== 'update') || !req.file) return args
  // Access control (after this hook) refuses a REST caller who isn't staff: don't spend a re-encode on them.
  if (req.payloadAPI !== 'local' && !userIsStaff(req.user)) return args
  req.file = await stripImageMetadata(req.payload.config.sharp as unknown as SharpFn | undefined, req.file)
  return args
}
