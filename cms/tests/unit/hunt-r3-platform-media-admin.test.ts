import { APIError, type PayloadRequest, ValidationError } from 'payload'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import { keepLastAdminAccount, keepLastAdminRole, LAST_ADMIN, LAST_ADMIN_ERROR, lastAdminMessage } from '@/auth/lastAdmin'
import { Media, MEDIA_IN_USE_ERROR, mediaReplaceInUseMessage, refuseFileReplaceWhenUsed } from '@/collections/Media'
import { Users } from '@/collections/Users'
import { stripImageMetadata, stripUploadMetadata, UNREADABLE_IMAGE_MESSAGE } from '@/lib/imageMetadata'

/**
 * Hunt round 3 (cms-platform): EXIF/GPS stripped from uploads, an in-use image's file can't be replaced, and
 * the last admin can be neither demoted nor deleted. DB behaviour: tests/int/hunt-r3-platform.int.spec.ts and
 * tests/int/hunt-data-cms-last-admin.int.spec.ts.
 */

const EXIF = { IFD0: { Make: 'Apple', Model: 'iPhone 15', Artist: 'Shop Owner Name' } }
const file = (data: Buffer, mimetype: string, name = 'x') => ({ data, mimetype, name, size: data.length }) as any
const phoneJpeg = () =>
  sharp({ create: { width: 4, height: 2, channels: 3, background: '#c33' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif(EXIF)
    .toBuffer()

describe('uploads are re-encoded without their metadata', () => {
  it('a phone JPEG loses its EXIF (author, camera) but keeps its orientation', async () => {
    const input = await phoneJpeg()
    const before = await sharp(input).metadata()
    expect(before.exif?.toString('latin1')).toContain('Shop Owner Name')
    const out = await stripImageMetadata(sharp as never, file(input, 'image/jpeg'))
    const after = await sharp(out.data).metadata()
    expect(after.format).toBe('jpeg')
    expect(after.exif).toBeUndefined()
    expect(after.orientation).toBeUndefined()
    // Orientation 6 (rotate 90°) is applied to the pixels: 4×2 becomes 2×4.
    expect([after.width, after.height]).toEqual([2, 4])
    expect(out.size).toBe(out.data.length)
  })

  it('PNG and WebP keep their format; GIF and SVG are left byte for byte', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0000' } }).png().withExif(EXIF).toBuffer()
    const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).webp().withExif(EXIF).toBuffer()
    for (const [buf, mime, format] of [[png, 'image/png', 'png'], [webp, 'image/webp', 'webp']] as const) {
      const out = await stripImageMetadata(sharp as never, file(buf, mime))
      const meta = await sharp(out.data).metadata()
      expect(meta.format).toBe(format)
      expect(meta.exif).toBeUndefined()
    }
    const gif = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).gif().toBuffer()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
    for (const [buf, mime] of [[gif, 'image/gif'], [svg, 'image/svg+xml']] as const) {
      const f = file(buf, mime)
      expect(await stripImageMetadata(sharp as never, f)).toBe(f)
    }
  })

  it('a raster image that cannot be decoded is refused (400), never stored with its metadata', async () => {
    const err = await stripImageMetadata(sharp as never, file(Buffer.from('not a jpeg'), 'image/jpeg')).catch((e: any) => e)
    expect(err).toBeInstanceOf(APIError)
    expect(err.status).toBe(400)
    expect(err.message).toBe(UNREADABLE_IMAGE_MESSAGE)
  })

  it('runs as a Media beforeOperation on create and update only', async () => {
    expect(Media.hooks?.beforeOperation).toContain(stripUploadMetadata)
    const input = await phoneJpeg()
    const req = { file: file(input, 'image/jpeg'), payload: { config: { sharp } }, payloadAPI: 'REST', user: { collection: 'users', role: 'editor' } } as unknown as PayloadRequest
    await stripUploadMetadata({ args: {}, operation: 'read', req } as never)
    expect(req.file?.data).toBe(input)
    await stripUploadMetadata({ args: {}, operation: 'create', req } as never)
    expect((await sharp(req.file!.data).metadata()).exif).toBeUndefined()
    // A REST caller who isn't staff is refused by access control next: no re-encode spent on them.
    const anon = { file: file(input, 'image/jpeg'), payload: { config: { sharp } }, payloadAPI: 'REST', user: null } as unknown as PayloadRequest
    await stripUploadMetadata({ args: {}, operation: 'create', req: anon } as never)
    expect(anon.file?.data).toBe(input)
  })
})

describe("an in-use image's file can't be replaced", () => {
  const fakeReq = (usedBy: string[], withFile = true) => {
    const find = vi.fn(async () => ({ docs: usedBy.map((name, i) => ({ id: i + 1, name })), totalDocs: usedBy.length }))
    const req = { file: withFile ? file(Buffer.from('x'), 'image/png') : undefined, payload: { find }, payloadAPI: 'local' }
    return { find, req: req as unknown as PayloadRequest }
  }
  const run = (req: PayloadRequest, operation = 'update') =>
    Promise.resolve(refuseFileReplaceWhenUsed({ args: { id: 9 }, operation, req } as never))

  it('is registered before the metadata stripping', () => {
    expect(Media.hooks?.beforeOperation?.[0]).toBe(refuseFileReplaceWhenUsed)
  })

  it('refuses a new file (409 MEDIA_IN_USE) while products use the image', async () => {
    const { req, find } = fakeReq(['Rolled Oats'])
    const err = await run(req).catch((e: any) => e)
    expect(err).toBeInstanceOf(APIError)
    expect(err.status).toBe(409)
    expect(err.name).toBe(MEDIA_IN_USE_ERROR)
    expect(err.data).toEqual({ code: 'MEDIA_IN_USE', products: ['Rolled Oats'] })
    expect(err.message).toBe(mediaReplaceInUseMessage(['Rolled Oats'], 0))
    expect(err.message).toMatch(/Upload the new photo as a new image/)
    // Live products and their latest drafts, with the request (same transaction).
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ collection: 'products', where: { imageUpload: { equals: 9 } }, req }))
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ draft: true }))
  })

  it('lets through an unused image, an edit without a file (alt text, focal point) and a create', async () => {
    await expect(run(fakeReq([]).req)).resolves.toEqual({ id: 9 })
    const noFile = fakeReq(['Rolled Oats'], false)
    await expect(run(noFile.req)).resolves.toEqual({ id: 9 })
    await expect(run(fakeReq(['Rolled Oats']).req, 'create')).resolves.toEqual({ id: 9 })
    expect(noFile.find).not.toHaveBeenCalled()
  })

  it('says nothing to a REST caller who is not staff (access control refuses them next)', async () => {
    const { req, find } = fakeReq(['Draft-only product'])
    Object.assign(req, { payloadAPI: 'REST', user: { collection: 'customers' } })
    await expect(run(req)).resolves.toEqual({ id: 9 })
    expect(find).not.toHaveBeenCalled()
  })
})

describe('the last admin stays an admin', () => {
  const fakeReq = (otherAdmins: number, role = 'admin') => {
    const count = vi.fn(async () => ({ totalDocs: otherAdmins }))
    const findByID = vi.fn(async () => ({ id: 1, role }))
    return { count, req: { payload: { count, findByID }, transactionID: undefined } as unknown as PayloadRequest }
  }
  const demote = (req: PayloadRequest, from = 'admin', to = 'editor') =>
    keepLastAdminRole({ data: { role: to }, operation: 'update', originalDoc: { id: 1, role: from }, req } as never)

  it('is registered on Users (beforeChange + beforeDelete)', () => {
    expect(Users.hooks?.beforeChange).toContain(keepLastAdminRole)
    expect(Users.hooks?.beforeDelete).toContain(keepLastAdminAccount)
  })

  it('demoting the last admin is a 400 on `role`; with another admin it goes through', async () => {
    const err = await demote(fakeReq(0).req).catch((e: any) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.data.errors).toEqual([{ path: 'role', message: lastAdminMessage('demote') }])
    const { req, count } = fakeReq(1)
    await expect(demote(req)).resolves.toEqual({ role: 'editor' })
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'users', where: { and: [{ role: { equals: 'admin' } }, { id: { not_equals: 1 } }] }, req }),
    )
  })

  it('editors, unchanged roles and creates are not counted', async () => {
    const { req, count } = fakeReq(0)
    await demote(req, 'editor', 'editor')
    await demote(req, 'admin', 'admin')
    await keepLastAdminRole({ data: { role: 'editor' }, operation: 'create', req } as never)
    expect(count).not.toHaveBeenCalled()
  })

  it('deleting the last admin is a 409 LAST_ADMIN; an editor or a second admin can go', async () => {
    const err = await keepLastAdminAccount({ id: 1, req: fakeReq(0).req } as never).catch((e: any) => e)
    expect(err).toBeInstanceOf(APIError)
    expect(err.status).toBe(409)
    expect(err.name).toBe(LAST_ADMIN_ERROR)
    expect(err.data).toEqual({ code: LAST_ADMIN })
    await expect(keepLastAdminAccount({ id: 1, req: fakeReq(1).req } as never)).resolves.toBeUndefined()
    await expect(keepLastAdminAccount({ id: 1, req: fakeReq(0, 'editor').req } as never)).resolves.toBeUndefined()
  })
})
