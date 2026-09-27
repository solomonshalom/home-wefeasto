import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDeployHook,
  DEFAULT_DEPLOY_HOOK_DELAY_MS,
  deployHook,
  deployHookAfterChange,
  deployHookAfterDelete,
  deployHookGlobalAfterChange,
} from '@/hooks/deployHook'

/** The storefront rebuild trigger: trailing debounce, never throws, POSTs once per burst. (cms-catalog) */

const URL_ = 'https://api.vercel.com/v1/integrations/deploy/prj_test/abc'

function setup(over: Partial<Parameters<typeof createDeployHook>[0]> = {}) {
  const fetch = vi.fn(async () => ({ ok: true, status: 201 }))
  const logger = { info: vi.fn(), warn: vi.fn() }
  let url: string | undefined = URL_
  const hook = createDeployHook({ url: () => url, delayMs: () => 10_000, fetch, logger: () => logger, ...over })
  return { hook, fetch, logger, setUrl: (u: string | undefined) => (url = u) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('createDeployHook', () => {
  it('POSTs once, 10 s after the LAST change (trailing debounce)', async () => {
    const { hook, fetch } = setup()
    expect(hook.schedule('products:a update')).toBe(true)
    await vi.advanceTimersByTimeAsync(9_000)
    hook.schedule('products:b update')
    await vi.advanceTimersByTimeAsync(9_000)
    hook.schedule('recipes:c update')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetch).not.toHaveBeenCalled()
    expect(hook.isPending()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(URL_, expect.objectContaining({ method: 'POST' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(hook.isPending()).toBe(false)
  })

  it('a change after the POST schedules another one', async () => {
    const { hook, fetch } = setup()
    hook.schedule('a')
    await vi.advanceTimersByTimeAsync(10_000)
    hook.schedule('b')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('is a no-op without a URL (and re-reads the URL when the timer fires)', async () => {
    const { hook, fetch, setUrl } = setup()
    setUrl(undefined)
    expect(hook.schedule('a')).toBe(false)
    expect(hook.isPending()).toBe(false)
    setUrl('')
    expect(hook.schedule('a')).toBe(false)
    setUrl(URL_)
    hook.schedule('b')
    setUrl('') // removed before the timer fired
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws: a network error or an HTTP error is logged and swallowed', async () => {
    const failing = setup({ fetch: vi.fn(async () => Promise.reject(new Error('ECONNRESET'))) })
    failing.hook.schedule('a')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failing.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'))

    const http500 = setup({ fetch: vi.fn(async () => ({ ok: false, status: 500 })) })
    http500.hook.schedule('b')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(http500.logger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))

    const throwingUrl = setup({
      url: () => {
        throw new Error('env broken')
      },
    })
    expect(() => throwingUrl.hook.schedule('c')).not.toThrow()
    expect(throwingUrl.hook.schedule('c')).toBe(false)
  })

  it('logs the reasons of the burst on success', async () => {
    const { hook, logger } = setup()
    hook.schedule('products:muesli update')
    hook.schedule('store-settings update')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/products:muesli update, store-settings update/))
  })

  it('flush() posts a pending change immediately; flush({force}) posts even with nothing pending', async () => {
    const { hook, fetch } = setup()
    expect(await hook.flush()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    hook.schedule('a')
    expect(await hook.flush()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetch).toHaveBeenCalledTimes(1) // the timer was cancelled
    expect(await hook.flush({ force: true, reason: 'seed' })).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cancel() drops the pending POST; whenIdle() resolves once nothing is pending', async () => {
    const { hook, fetch } = setup()
    await expect(hook.whenIdle()).resolves.toBeUndefined()
    hook.schedule('a')
    let idle = false
    void hook.whenIdle().then(() => (idle = true))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(idle).toBe(false)
    hook.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(idle).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks the host to keep the invocation alive until the POST is done (serverless)', async () => {
    const kept: Promise<void>[] = []
    const { hook, fetch } = setup({ keepAlive: (p) => kept.push(p) })
    hook.schedule('a')
    expect(kept).toHaveLength(1)
    let settled = false
    void kept[0].then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(settled).toBe(true)
    // A throwing keepAlive (outside a request scope) is ignored.
    const other = setup({
      keepAlive: () => {
        throw new Error('outside request scope')
      },
    })
    expect(other.hook.schedule('b')).toBe(true)
  })

  it('defaults: 10 s, overridable with DEPLOY_HOOK_DEBOUNCE_MS', async () => {
    expect(DEFAULT_DEPLOY_HOOK_DELAY_MS).toBe(10_000)
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubEnv('DEPLOY_HOOK_DEBOUNCE_MS', '250')
    const hook = createDeployHook({ url: () => URL_, fetch, logger: () => ({ warn: vi.fn(), info: vi.fn() }) })
    hook.schedule('a')
    await vi.advanceTimersByTimeAsync(250)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('collection / global hooks', () => {
  const collection = { slug: 'products' } as never
  const global = { slug: 'store-settings' } as never
  const req = { payload: { logger: { warn: vi.fn(), info: vi.fn() } } } as never
  let schedule: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    schedule = vi.spyOn(deployHook, 'schedule').mockReturnValue(true)
  })
  afterEach(() => schedule.mockRestore())

  const change = (doc: object, previousDoc: object | undefined, context: object = {}) =>
    deployHookAfterChange({ doc, previousDoc, collection, operation: 'update', req, context, data: {} } as never)

  it('schedules for published docs, publishes and unpublishes; skips never-published drafts', () => {
    const doc = { slug: 'muesli', _status: 'published' }
    expect(change(doc, { _status: 'published' })).toBe(doc) // returns the doc untouched
    change({ slug: 'new', _status: 'published' }, { _status: 'draft' }) // publish
    change({ slug: 'gone', _status: 'draft' }, { _status: 'published' }) // unpublish / draft over published
    expect(schedule).toHaveBeenCalledTimes(3)
    expect(schedule).toHaveBeenCalledWith('products:muesli update')
    change({ slug: 'wip', _status: 'draft' }, { _status: 'draft' })
    change({ slug: 'wip', _status: 'draft' }, undefined)
    expect(schedule).toHaveBeenCalledTimes(3)
  })

  it('pages: only a page shown on the storefront (or leaving it) rebuilds; reviewing a policy draft does not', () => {
    const pages = { slug: 'pages' } as never
    const page = (doc: object, previousDoc: object | undefined) =>
      deployHookAfterChange({ doc, previousDoc, collection: pages, operation: 'update', req, context: {}, data: {} } as never)
    // Seeded policy draft being edited, published in Payload with the box unticked, saved again: not on the site.
    page({ slug: 'refunds', _status: 'draft', published: false }, { _status: 'draft', published: false })
    page({ slug: 'refunds', _status: 'published', published: false }, { _status: 'draft', published: false })
    page({ slug: 'refunds', _status: 'published', published: false }, { _status: 'published', published: false })
    page({ slug: 'refunds', _status: 'draft', published: true }, { _status: 'published', published: false }) // box ticked in a draft
    expect(schedule).not.toHaveBeenCalled()
    page({ slug: 'refunds', _status: 'published', published: true }, { _status: 'published', published: false }) // goes live
    page({ slug: 'refunds', _status: 'published', published: true }, { _status: 'published', published: true }) // live edit
    page({ slug: 'refunds', _status: 'published', published: false }, { _status: 'published', published: true }) // box unticked
    page({ slug: 'refunds', _status: 'draft', published: true }, { _status: 'published', published: true }) // unpublished
    expect(schedule).toHaveBeenCalledTimes(4)
    expect(schedule).toHaveBeenCalledWith('pages:refunds update')

    const del = (doc: object) => deployHookAfterDelete({ doc, collection: pages, req, context: {}, id: 1 } as never)
    del({ slug: 'a', _status: 'published', published: false })
    del({ slug: 'b', _status: 'draft', published: true })
    expect(schedule).toHaveBeenCalledTimes(4)
    del({ slug: 'c', _status: 'published', published: true })
    expect(schedule).toHaveBeenCalledTimes(5)
    expect(schedule).toHaveBeenLastCalledWith('pages:c delete')
  })

  it('products and recipes have no storefront box: Payload publishing alone decides', () => {
    change({ slug: 'muesli', _status: 'published', published: false }, { _status: 'published' })
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('honours context.skipDeployHook', () => {
    change({ slug: 'x', _status: 'published' }, { _status: 'published' }, { skipDeployHook: true })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('afterDelete only for published docs', () => {
    const del = (doc: object, context: object = {}) => deployHookAfterDelete({ doc, collection, req, context, id: 1 } as never)
    del({ slug: 'a', _status: 'published' })
    del({ slug: 'b', _status: 'draft' })
    del({ slug: 'c', _status: 'published' }, { skipDeployHook: true })
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledWith('products:a delete')
  })

  it('store-settings: only public setting changes rebuild the storefront', () => {
    const g = (doc: object, previousDoc: object, context: object = {}) =>
      deployHookGlobalAfterChange({ doc, previousDoc, global, req, context, data: {} } as never)
    g({ deliveryFeePaise: 5900 }, { deliveryFeePaise: 4900 })
    expect(schedule).toHaveBeenCalledTimes(1)
    g({ deliveryFeePaise: 4900, reservationMinutes: 45, blockedPinPrefixes: ['744'] }, { deliveryFeePaise: 4900, reservationMinutes: 30 })
    expect(schedule).toHaveBeenCalledTimes(1)
    g({ announcement: { enabled: true, text: 'Hi', href: '' } }, {}, { skipDeployHook: true })
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('never throws into the request, even if scheduling blows up', () => {
    schedule.mockImplementation(() => {
      throw new Error('boom')
    })
    const doc = { slug: 'a', _status: 'published' }
    expect(() => change(doc, doc)).not.toThrow()
    expect(change(doc, doc)).toBe(doc)
  })
})
