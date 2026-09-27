import { APIError } from 'payload'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { Media } from '@/collections/Media'
import { MEDIA_MIME_TYPES, stripImageMetadata, UNREADABLE_IMAGE_MESSAGE, withExtension } from '@/lib/imageMetadata'

/**
 * Hunt r4 (tiff-upload-broken-image): a product photo is only ever published in a format every browser shows.
 * TIFF (Safari-only) is converted to JPEG, or PNG with transparency; undecodable image types (PSD, BMP,
 * HEIC, …) are refused with a helpful 400; Media's allow-list is web formats only.
 */

const EXIF = { IFD0: { Make: 'Apple', Model: 'iPhone 15', Artist: 'Shop Owner Name' } }
const file = (data: Buffer, mimetype: string, name = 'x') => ({ data, mimetype, name, size: data.length }) as any
const tiff = (channels: 3 | 4) =>
  sharp({ create: { width: 8, height: 6, channels, background: channels === 4 ? { r: 200, g: 50, b: 50, alpha: 0.5 } : '#c33' } })
    .tiff({ compression: 'lzw' }) // the default (JPEG-in-TIFF) has no alpha channel
    .withExif(EXIF)
    .toBuffer()

describe('non-web photos are converted, never published as-is', () => {
  it('an opaque TIFF becomes a JPEG named .jpg (metadata gone, size kept)', async () => {
    const input = await tiff(3)
    const out = await stripImageMetadata(sharp as never, file(input, 'image/tiff', 'hunt-photo.tif'))
    const meta = await sharp(out.data).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.exif).toBeUndefined()
    expect([meta.width, meta.height]).toEqual([8, 6])
    expect(out.name).toBe('hunt-photo.jpg')
    expect(out.mimetype).toBe('image/jpeg')
    expect(out.size).toBe(out.data.length)
  })

  it('a TIFF with transparency becomes a PNG named .png', async () => {
    const out = await stripImageMetadata(sharp as never, file(await tiff(4), 'image/tiff', 'logo.tiff'))
    const meta = await sharp(out.data).metadata()
    expect(meta.format).toBe('png')
    expect(meta.hasAlpha).toBe(true)
    expect(out.name).toBe('logo.png')
    expect(out.mimetype).toBe('image/png')
  })

  it('the TIFF is detected by content, whatever the client claimed', async () => {
    const out = await stripImageMetadata(sharp as never, file(await tiff(3), 'image/png', 'photo.png'))
    expect((await sharp(out.data).metadata()).format).toBe('jpeg')
    expect(out.mimetype).toBe('image/jpeg')
    expect(out.name).toBe('photo.jpg')
  })

  it('web formats keep their name and type', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0000' } }).png().toBuffer()
    const out = await stripImageMetadata(sharp as never, file(png, 'image/png', 'a.png'))
    expect(out.name).toBe('a.png')
    expect(out.mimetype).toBe('image/png')
  })

  it('an image type sharp cannot decode (PSD, BMP, JPEG XL) is refused with the JPEG/PNG message', async () => {
    const psd = Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(64)])
    for (const [buf, mime] of [
      [psd, 'image/vnd.adobe.photoshop'],
      [Buffer.from('BM' + '\0'.repeat(60)), 'image/bmp'],
      [Buffer.from([0xff, 0x0a, 1, 2, 3]), 'image/jxl'],
    ] as const) {
      const err = await stripImageMetadata(sharp as never, file(buf, mime)).catch((e: any) => e)
      expect(err, mime).toBeInstanceOf(APIError)
      expect(err.status).toBe(400)
      expect(err.message).toBe(UNREADABLE_IMAGE_MESSAGE)
    }
    // Not an image at all: left to Payload's mimeTypes check (a 400 there).
    const pdf = file(Buffer.from('%PDF-1.4 nope'), 'application/pdf')
    expect(await stripImageMetadata(sharp as never, pdf)).toBe(pdf)
  })

  it('withExtension', () => {
    expect(withExtension('a.tif', 'jpg')).toBe('a.jpg')
    expect(withExtension('my.photo.TIFF', 'png')).toBe('my.photo.png')
    expect(withExtension('noext', 'jpg')).toBe('noext.jpg')
    expect(withExtension('', 'jpg')).toBe('image.jpg')
  })

  it('Media accepts web formats only (TIFF is converted before Payload checks the type)', () => {
    const upload = Media.upload as { mimeTypes?: string[] }
    expect(upload.mimeTypes).toBe(MEDIA_MIME_TYPES)
    expect(MEDIA_MIME_TYPES).not.toContain('image/*')
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml']) expect(MEDIA_MIME_TYPES).toContain(t)
    for (const t of ['image/heic', 'image/vnd.adobe.photoshop', 'image/jxl', 'image/bmp']) expect(MEDIA_MIME_TYPES).not.toContain(t)
  })
})
