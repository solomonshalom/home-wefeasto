/**
 * Expected refusals log at info on the production build (src/lib/logging.ts): Payload's logError picks the
 * level by err.name, which `next build` minifies, so the downgrade is by shape (4xx APIError), not name.
 */
import { APIError, Forbidden, ValidationError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { isExpectedRefusal, quietExpectedRefusals } from '@/lib/logging'

function fakeLogger() {
  const calls: { level: string; obj: unknown; rest: unknown[] }[] = []
  const logger = {
    error: vi.fn((obj: unknown, ...rest: unknown[]) => void calls.push({ level: 'error', obj, rest })),
    info: vi.fn((obj: unknown, ...rest: unknown[]) => void calls.push({ level: 'info', obj, rest })),
  }
  return { logger, calls }
}

/** Mimics a minified build: the class name is gone, so err.name is "u". */
function minified<T extends Error>(err: T): T {
  Object.defineProperty(err, 'name', { value: 'u' })
  return err
}

describe('isExpectedRefusal', () => {
  it('is true for 4xx APIErrors, whatever their (minified) name', () => {
    expect(isExpectedRefusal(minified(new Forbidden()))).toBe(true)
    expect(isExpectedRefusal(minified(new ValidationError({ errors: [{ message: 'x', path: 'email' }] })))).toBe(true)
    expect(isExpectedRefusal(new APIError('Too many attempts', 429))).toBe(true)
    expect(isExpectedRefusal(new APIError('Conflict', 409))).toBe(true)
  })

  it('is false for 5xx, plain errors and non-errors', () => {
    expect(isExpectedRefusal(new APIError('boom'))).toBe(false) // 500
    expect(isExpectedRefusal(new APIError('bad gateway', 502))).toBe(false)
    expect(isExpectedRefusal(Object.assign(new Error('pg'), { status: 400 }))).toBe(false) // not an APIError
    expect(isExpectedRefusal(null)).toBe(false)
    expect(isExpectedRefusal('Forbidden')).toBe(false)
  })
})

describe('quietExpectedRefusals', () => {
  it('re-issues logError’s { err } call for a refusal at info, message only (no stack)', () => {
    const { logger, calls } = fakeLogger()
    quietExpectedRefusals({ logger } as never)
    logger.error({ err: minified(new Forbidden()) })
    expect(calls).toEqual([{ level: 'info', obj: { msg: 'You are not allowed to perform this action.' }, rest: [] }])
  })

  it('leaves real errors, 5xx and our own { err, msg } logs at error', () => {
    const { logger, calls } = fakeLogger()
    quietExpectedRefusals({ logger } as never)
    const boom = new APIError('boom')
    const pg = new Error('connection refused')
    const own = { err: new APIError('refused on purpose', 400), msg: 'webhook: signature mismatch' }
    logger.error({ err: boom })
    logger.error({ err: pg })
    logger.error(own)
    logger.error('plain message')
    logger.error({ err: new Forbidden() }, 'with a message argument')
    expect(calls.map((c) => c.level)).toEqual(['error', 'error', 'error', 'error', 'error'])
    expect(calls[0].obj).toEqual({ err: boom })
    expect(calls[2].obj).toBe(own)
  })

  it('is idempotent (onInit may run again under HMR)', () => {
    const { logger, calls } = fakeLogger()
    quietExpectedRefusals({ logger } as never)
    const once = logger.error
    quietExpectedRefusals({ logger } as never)
    expect(logger.error).toBe(once)
    logger.error({ err: new ValidationError({ errors: [{ message: 'taken', path: 'email' }] }) })
    expect(calls).toHaveLength(1)
    expect(calls[0].level).toBe('info')
  })
})
