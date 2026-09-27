import type { PayloadRequest } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearOrderEventHandlers,
  emitOrderEvent,
  onOrderEvent,
  orderEventHandlerNames,
  type OrderEvent,
} from '@/commerce/events'
import type { Order } from '@/payload-types'

const logger = { warn: vi.fn(), error: vi.fn() }
const req = { payload: { logger } } as unknown as PayloadRequest
const order = { id: 1, number: 'WF-10001', status: 'paid' } as unknown as Order

afterEach(() => {
  clearOrderEventHandlers()
  vi.clearAllMocks()
})

describe('order events', () => {
  it('delivers the event with defaults filled in', async () => {
    const seen: OrderEvent[] = []
    onOrderEvent('order.confirmed', 'spy', (e) => {
      seen.push(e)
    })
    const res = await emitOrderEvent(req, { type: 'order.confirmed', order, source: 'webhook' })
    expect(res).toEqual([{ name: 'spy', ok: true, ms: expect.any(Number) }])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'order.confirmed', order, source: 'webhook', previousStatus: null })
    expect(seen[0].at).toBeInstanceOf(Date)
  })

  it('only runs handlers for the emitted type', async () => {
    const a = vi.fn()
    const b = vi.fn()
    onOrderEvent('order.confirmed', 'a', a)
    onOrderEvent('order.shipped', 'b', b)
    await emitOrderEvent(req, { type: 'order.shipped', order, source: 'admin' })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('re-registering a name replaces the handler (HMR-safe) and unsubscribe removes it', async () => {
    const first = vi.fn()
    const second = vi.fn()
    onOrderEvent('order.confirmed', 'refill', first)
    const off = onOrderEvent('order.confirmed', 'refill', second)
    expect(orderEventHandlerNames('order.confirmed')).toEqual(['refill'])
    await emitOrderEvent(req, { type: 'order.confirmed', order, source: 'client' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    off()
    expect(orderEventHandlerNames('order.confirmed')).toEqual([])
  })

  it('a stale unsubscribe does not remove a newer handler with the same name', () => {
    const off = onOrderEvent('order.confirmed', 'x', vi.fn())
    onOrderEvent('order.confirmed', 'x', vi.fn())
    off()
    expect(orderEventHandlerNames('order.confirmed')).toEqual(['x'])
  })

  it('isolates throwing, rejecting and hanging handlers; never throws', async () => {
    const good = vi.fn()
    onOrderEvent('order.confirmed', 'throws', () => {
      throw new Error('boom')
    })
    onOrderEvent('order.confirmed', 'rejects', async () => {
      throw { code: 'SMTP' }
    })
    onOrderEvent('order.confirmed', 'hangs', () => new Promise(() => {}))
    onOrderEvent('order.confirmed', 'good', good)
    const res = await emitOrderEvent(req, { type: 'order.confirmed', order, source: 'webhook' }, { timeoutMs: 30 })
    const byName = Object.fromEntries(res.map((r) => [r.name, r]))
    expect(byName.throws).toMatchObject({ ok: false, error: 'boom' })
    expect(byName.rejects).toMatchObject({ ok: false, error: '{"code":"SMTP"}' })
    expect(byName.hangs).toMatchObject({ ok: false, timedOut: true })
    expect(byName.good).toMatchObject({ ok: true })
    expect(good).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('runs handlers concurrently', async () => {
    const order_: string[] = []
    onOrderEvent('order.confirmed', 'slow', async () => {
      await new Promise((r) => setTimeout(r, 20))
      order_.push('slow')
    })
    onOrderEvent('order.confirmed', 'fast', () => {
      order_.push('fast')
    })
    await emitOrderEvent(req, { type: 'order.confirmed', order, source: 'client' })
    expect(order_).toEqual(['fast', 'slow'])
  })

  it('returns [] with no handlers and tolerates a request without a logger', async () => {
    expect(await emitOrderEvent(req, { type: 'order.expired', order, source: 'reconcile' })).toEqual([])
    onOrderEvent('order.expired', 'bad', () => {
      throw new Error('x')
    })
    const res = await emitOrderEvent({} as PayloadRequest, { type: 'order.expired', order, source: 'reconcile' })
    expect(res[0]).toMatchObject({ ok: false, error: 'x' })
  })

  it('rejects unknown types and missing names at registration', () => {
    // @ts-expect-error unknown type
    expect(() => onOrderEvent('order.nope', 'x', vi.fn())).toThrow(/Unknown order event type/)
    expect(() => onOrderEvent('order.confirmed', '', vi.fn())).toThrow(/name is required/)
  })

  it('shares one registry across module instances (globalThis)', async () => {
    onOrderEvent('order.refunded', 'shared', vi.fn())
    vi.resetModules()
    const again = await import('@/commerce/events')
    expect(again.orderEventHandlerNames('order.refunded')).toEqual(['shared'])
  })
})
