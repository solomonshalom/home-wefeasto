import fs from 'fs'
import path from 'path'
import type { Payload } from 'payload'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { reservedSlugMessage } from '@/endpoints/catalog/rules'

import { createProduct } from './helpers/catalogFactories'
import { createStaff, login } from './helpers/factories'
import { getTestPayload } from './helpers/payload'
import { restGet, restPost } from './helpers/rest'

/**
 * Hunt round 3 (cms-platform): bounded public ?depth, restoring a draft version of a live document, EXIF
 * stripped from uploads, an in-use image's file not replaceable, reserved page slugs.
 */

const CTX = { context: { skipDeployHook: true } }
const MEDIA_DIR = path.resolve(process.cwd(), 'media')
let payload: Payload
let token: string
const cleanup: Array<() => Promise<unknown>> = []

beforeAll(async () => {
  payload = await getTestPayload()
  const admin = await createStaff(payload, 'admin')
  token = (await login('users', admin.email)).token
})

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined)
})

const jpegWithGps = () =>
  sharp({ create: { width: 8, height: 4, channels: 3, background: '#c33' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 15', Artist: 'Shop Owner Name' }, IFD3: { GPSLatitudeRef: 'N' } })
    .toBuffer()

async function upload(name: string, data?: Buffer, mimetype = 'image/jpeg') {
  const buf = data ?? (await jpegWithGps())
  const doc = await payload.create({ collection: 'media', data: { alt: 'Test photo' }, file: { data: buf, mimetype, name, size: buf.length } })
  cleanup.push(() => payload.delete({ collection: 'media', id: doc.id }))
  return doc
}

describe('anonymous ?depth reads stay small', () => {
  it('products linked to each other populate one level, even at ?depth=10', async () => {
    const a = await createProduct(payload)
    const b = await createProduct(payload, { goesWith: [a.id] })
    await payload.update({ collection: 'products', id: a.id, data: { goesWith: [b.id] }, ...CTX })
    cleanup.push(() => payload.delete({ collection: 'products', where: { id: { in: [a.id, b.id] } }, ...CTX }))
    const res = await restGet('products', { query: `depth=10&limit=100&where[id][in]=${a.id},${b.id}` })
    expect(res.status).toBe(200)
    expect(res.body.docs).toHaveLength(2)
    for (const doc of res.body.docs) {
      const [linked] = doc.goesWith
      expect(typeof linked).toBe('object')
      expect(linked.goesWith.every((v: unknown) => typeof v === 'number'), 'second level stays ids').toBe(true)
    }
    expect(res.text.length).toBeLessThan(64 * 1024)
  })
})

describe('restoring a draft version of a live document', () => {
  it('keeps the product published at its live price and makes the restored content the pending draft', async () => {
    const doc = await createProduct(payload, { pricePaise: 25000 })
    cleanup.push(() => payload.delete({ collection: 'products', id: doc.id, ...CTX }))
    await payload.update({ collection: 'products', id: doc.id, draft: true, data: { pricePaise: 30000, _status: 'draft' }, ...CTX })
    await payload.update({ collection: 'products', id: doc.id, data: { pricePaise: 26000, _status: 'published' }, ...CTX })
    const versions = await payload.findVersions({ collection: 'products', where: { parent: { equals: doc.id } }, depth: 0, limit: 50 })
    const draft = versions.docs.find((v) => v.version._status === 'draft')!
    const r = await restPost(`products/versions/${draft.id}`, { token, query: 'draft=false' })
    expect(r.status, r.text.slice(0, 300)).toBe(200)
    const live = await payload.findByID({ collection: 'products', id: doc.id, depth: 0 })
    expect(live).toMatchObject({ _status: 'published', pricePaise: 26000, stock: 100 })
    const pending = await payload.findByID({ collection: 'products', id: doc.id, depth: 0, draft: true })
    expect(pending).toMatchObject({ _status: 'draft', pricePaise: 30000, stock: 100 })
    const anon = await restGet('products', { query: `where[id][equals]=${doc.id}&depth=0` })
    expect(anon.body.totalDocs).toBe(1)
    // Restoring a PUBLISHED version still publishes it, as before.
    const published = versions.docs.find((v) => v.version._status === 'published' && v.version.pricePaise === 25000)!
    expect((await restPost(`products/versions/${published.id}`, { token, query: 'draft=false' })).status).toBe(200)
    expect(await payload.findByID({ collection: 'products', id: doc.id, depth: 0 })).toMatchObject({ _status: 'published', pricePaise: 25000 })
  })

  it('keeps a live page on the storefront', async () => {
    const page = await payload.create({
      collection: 'pages',
      data: { title: 'Restore test', slug: `restore-${Date.now().toString(36)}`, bodyHtml: '<p>v1</p>', published: true, _status: 'published' },
      ...CTX,
    })
    cleanup.push(() => payload.delete({ collection: 'pages', id: page.id, ...CTX }))
    await payload.update({ collection: 'pages', id: page.id, draft: true, data: { bodyHtml: '<p>v2 draft</p>', _status: 'draft' }, ...CTX })
    await payload.update({ collection: 'pages', id: page.id, data: { bodyHtml: '<p>v3</p>', _status: 'published' }, ...CTX })
    const versions = await payload.findVersions({ collection: 'pages', where: { parent: { equals: page.id } }, depth: 0, limit: 50 })
    const draft = versions.docs.find((v) => v.version._status === 'draft')!
    expect((await restPost(`pages/versions/${draft.id}`, { token, query: 'draft=false' })).status).toBe(200)
    expect(await payload.findByID({ collection: 'pages', id: page.id, depth: 0 })).toMatchObject({ _status: 'published', bodyHtml: '<p>v3</p>' })
    expect(await payload.findByID({ collection: 'pages', id: page.id, depth: 0, draft: true })).toMatchObject({ bodyHtml: '<p>v2 draft</p>' })
    expect((await restGet('pages', { query: `where[id][equals]=${page.id}` })).body.totalDocs).toBe(1)
  })
})

describe('uploaded images', () => {
  it('are stored without EXIF / GPS / author metadata', async () => {
    const media = await upload(`exif-${Date.now()}.jpg`)
    const stored = fs.readFileSync(path.join(MEDIA_DIR, media.filename!))
    const meta = await sharp(stored).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.exif).toBeUndefined()
    expect(stored.includes(Buffer.from('Shop Owner Name'))).toBe(false)
    expect(media.filesize).toBe(stored.length)
  })

  it("can't have their file replaced while a product uses them; an unused image can", async () => {
    const used = await upload(`in-use-${Date.now()}.jpg`)
    const product = await createProduct(payload, { image: '', imageUpload: used.id })
    cleanup.push(() => payload.delete({ collection: 'products', id: product.id, ...CTX }))
    const next = await jpegWithGps()
    const file = { data: next, mimetype: 'image/jpeg', name: `replacement-${Date.now()}.jpg`, size: next.length }
    await expect(payload.update({ collection: 'media', id: used.id, data: {}, file })).rejects.toMatchObject({ status: 409 })
    expect(fs.existsSync(path.join(MEDIA_DIR, used.filename!)), 'the built URL keeps working').toBe(true)
    expect((await payload.findByID({ collection: 'media', id: used.id })).filename).toBe(used.filename)
    // Alt text still editable.
    expect((await payload.update({ collection: 'media', id: used.id, data: { alt: 'New alt' } })).alt).toBe('New alt')

    const free = await upload(`free-${Date.now()}.jpg`)
    const replaced = await payload.update({ collection: 'media', id: free.id, data: {}, file: { ...file, name: `free-new-${Date.now()}.jpg` } })
    expect(replaced.filename).not.toBe(free.filename)
    expect((await sharp(fs.readFileSync(path.join(MEDIA_DIR, replaced.filename!))).metadata()).exif).toBeUndefined()
  })
})

describe('reserved page slugs', () => {
  it('a page titled "Terms" (slug terms) is refused with a 400 on slug; "Terms of sale" is fine', async () => {
    const r = await restPost('pages', { token, body: { title: 'Terms', bodyHtml: '<p>New terms.</p>', published: true, _status: 'published' } })
    expect(r.status).toBe(400)
    expect(r.body.errors[0].data.errors).toEqual([{ path: 'slug', message: reservedSlugMessage('terms') }])
    expect((await payload.count({ collection: 'pages', where: { slug: { equals: 'terms' } } })).totalDocs).toBe(0)
    const ok = await restPost('pages', { token, body: { title: `Terms of sale ${Date.now()}`, bodyHtml: '<p>x</p>', _status: 'draft' }, query: 'draft=true' })
    expect(ok.status, ok.text.slice(0, 200)).toBe(201)
    cleanup.push(() => payload.delete({ collection: 'pages', id: ok.body.doc.id, ...CTX }))
  })
})
