import { APIError, type Payload, ValidationError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { sendOnce } from '@/email/sendOnce'
import { isUniqueViolation } from '@/retention/util'

/**
 * Unique-constraint detection must survive the production build. `next build` minifies class names, so
 * the drizzle adapter's `new ValidationError(...)` arrives with `name === 'u'` (seen in the `next start`
 * log), and a second bundled copy of the payload module throws one that is not even `instanceof` the
 * class imported here. Dev and the integration tests keep the real name, which is how a name check
 * (`err.name === 'ValidationError'`) passed every test and still threw on every race in production.
 */

/** What the drizzle adapter throws for a unique index hit on `path` (handleUpsertError). */
const uniqueError = (path: string | null, collection = 'subscribers') =>
  new ValidationError({ collection, errors: [{ message: 'Value must be unique', path: path as string }] })

/** The same error after minification: the class name is gone. */
function minified(err: Error, name = 'u'): Error {
  Object.defineProperty(err, 'name', { value: name, configurable: true, writable: true })
  return err
}

/** The same error thrown by a second copy of the payload module: same shape, minified name, not instanceof. */
function foreign(path: string | null): Error {
  const src = uniqueError(path)
  const copy = Object.assign(new Error(src.message), { status: src.status, data: src.data, isPublic: true, isOperational: true })
  return minified(copy, 'rA')
}

describe('isUniqueViolation (retention/util)', () => {
  it('a Payload ValidationError on the path', () => {
    expect(isUniqueViolation(uniqueError('email'), 'email')).toBe(true)
    expect(isUniqueViolation(uniqueError('key', 'message-log'), 'key')).toBe(true)
    expect(isUniqueViolation(uniqueError('code', 'coupons'), 'code')).toBe(true)
  })

  it('production build: the class name is minified (name "u")', () => {
    const err = minified(uniqueError('email'))
    expect(err.name).toBe('u')
    expect(isUniqueViolation(err, 'email')).toBe(true)
    expect(isUniqueViolation(minified(uniqueError('key', 'message-log')), 'key')).toBe(true)
    expect(isUniqueViolation(minified(uniqueError('code', 'coupons')), 'code')).toBe(true)
  })

  it('production build: an error from another copy of the payload module (not instanceof, same shape)', () => {
    const err = foreign('key')
    expect(err instanceof ValidationError).toBe(false)
    expect(isUniqueViolation(err, 'key')).toBe(true)
    expect(isUniqueViolation(foreign('email'), 'email')).toBe(true)
  })

  it('only for the named path', () => {
    expect(isUniqueViolation(uniqueError('email'), 'key')).toBe(false)
    expect(isUniqueViolation(minified(uniqueError('email')), 'code')).toBe(false)
    expect(isUniqueViolation(foreign('email'), 'key')).toBe(false)
    // The adapter could not resolve the constraint to a field: not provably ours.
    expect(isUniqueViolation(uniqueError(null), 'email')).toBe(false)
    // The path may be any entry of errors[].
    const multi = minified(
      new ValidationError({
        collection: 'subscribers',
        errors: [
          { message: 'This field is required.', path: 'status' },
          { message: 'Value must be unique', path: 'email' },
        ],
      }),
    )
    expect(isUniqueViolation(multi, 'email')).toBe(true)
    expect(isUniqueViolation(multi, 'source')).toBe(false)
  })

  it('never for other errors', () => {
    expect(isUniqueViolation(new Error('The following field is invalid: email'), 'email')).toBe(false)
    expect(isUniqueViolation(new APIError('bad', 400), 'email')).toBe(false)
    expect(isUniqueViolation(new APIError('boom', 500, { errors: [{ path: 'email' }] }), 'email')).toBe(false)
    expect(isUniqueViolation({ status: 400, data: { errors: 'email' } }, 'email')).toBe(false)
    expect(isUniqueViolation({ status: 400, data: { errors: [null, 'email', { path: 'email ' }] } }, 'email')).toBe(false)
    expect(isUniqueViolation({ status: '400', data: { errors: [{ path: 'email' }] } }, 'email')).toBe(false)
    // A raw Postgres 23505 (no Payload wrapper) carries no field path we can trust here.
    expect(isUniqueViolation(Object.assign(new Error('duplicate key'), { code: '23505' }), 'email')).toBe(false)
    for (const v of [null, undefined, 0, '', 'ValidationError', { name: 'ValidationError' }]) expect(isUniqueViolation(v, 'email')).toBe(false)
  })

  it('the old name-only shape is not enough: name "ValidationError" without the 400 + errors shape', () => {
    expect(isUniqueViolation({ name: 'ValidationError', data: { errors: [{ path: 'email' }] } }, 'email')).toBe(false)
  })
})

/** A Payload stand-in for sendOnce's claim step: `create` throws `createError`, `db.updateOne` (re-claim) returns `reclaimed`. */
function fakePayload({ createError, reclaimed = null }: { createError?: unknown; reclaimed?: { id: number } | null }) {
  const sendEmail = vi.fn(async () => ({}))
  const create = vi.fn(async () => {
    if (createError) throw createError
    return { id: 1 }
  })
  const updateOne = vi.fn(async () => reclaimed)
  const payload = { create, sendEmail, db: { updateOne }, logger: { error: vi.fn() } } as unknown as Payload
  return { payload, create, sendEmail, updateOne }
}

const msg = { key: 'welcome:asha@example.com', to: 'asha@example.com', subject: 'Welcome', html: '<p>Hi</p>' }

describe('sendOnce claim under the production build', () => {
  it("a claim lost to another sender is 'duplicate', whatever the error class is called", async () => {
    for (const err of [uniqueError('key', 'message-log'), minified(uniqueError('key', 'message-log')), foreign('key')]) {
      const { payload, sendEmail, updateOne } = fakePayload({ createError: err })
      await expect(sendOnce({ ...msg, payload })).resolves.toBe('duplicate')
      expect(updateOne).toHaveBeenCalledTimes(1) // tried to re-claim a failed/stale row, found none
      expect(sendEmail).not.toHaveBeenCalled()
    }
  })

  it('a lost claim on a failed row is re-claimed and sent', async () => {
    const { payload, sendEmail, updateOne } = fakePayload({ createError: minified(uniqueError('key', 'message-log')), reclaimed: { id: 7 } })
    await expect(sendOnce({ ...msg, payload })).resolves.toBe('sent')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(updateOne).toHaveBeenLastCalledWith(expect.objectContaining({ id: 7, data: expect.objectContaining({ status: 'sent' }) }))
  })

  it('other errors from the claim still throw', async () => {
    for (const err of [minified(uniqueError('to', 'message-log')), new Error('connection refused'), new APIError('boom', 500)]) {
      const { payload, sendEmail } = fakePayload({ createError: err })
      await expect(sendOnce({ ...msg, payload })).rejects.toBe(err)
      expect(sendEmail).not.toHaveBeenCalled()
    }
  })
})
