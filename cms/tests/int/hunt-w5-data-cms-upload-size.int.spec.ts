import { describe, expect, it } from 'vitest'

import { config } from './helpers/payload'

/**
 * HUNT data-cms (wave 5): the media upload limit is bigger than what the production host can receive.
 *
 * The CMS runs on Vercel (cms/vercel.json crons, @payloadcms/storage-vercel-blob). A Vercel Function refuses any
 * request body over 4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE) before Payload runs; research/payload.md §"Serverless
 * limits" and the storage-vercel-blob docs say to use `clientUploads` for bigger files. Media uploads here go
 * through the function (they must: src/lib/imageMetadata.ts re-encodes every photo server-side to strip EXIF/GPS),
 * yet `upload.limits.fileSize` is 5 MB. So in production every photo between ~4.4 and 5 MB — a typical phone
 * JPEG — fails with Vercel's raw 413 page instead of being stored, and anything larger never gets Payload's own
 * "file too large" message either: the owner sees an unexplained failed upload.
 *
 * Correct behaviour: the CMS's own limit is below the platform's (multipart overhead included), so an oversize
 * photo is refused by Payload with a clear message (or uploads bypass the function and are processed after).
 */

const VERCEL_FUNCTION_BODY_LIMIT = 4.5 * 1000 * 1000
/** Multipart boundaries, headers and the `_payload` JSON (alt text …) ride in the same request body. */
const MULTIPART_OVERHEAD = 16 * 1024

describe('media upload size vs the production request limit', () => {
  it('upload.limits.fileSize leaves room under Vercel’s 4.5 MB function request body', async () => {
    const c = await config
    const cap = c.upload?.limits?.fileSize
    expect(typeof cap).toBe('number')
    expect(cap as number, `upload.limits.fileSize = ${cap} bytes`).toBeLessThanOrEqual(VERCEL_FUNCTION_BODY_LIMIT - MULTIPART_OVERHEAD)
  })
})
