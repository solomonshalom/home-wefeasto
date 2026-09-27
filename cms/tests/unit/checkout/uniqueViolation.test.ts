import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { APIError, ValidationError } from 'payload'
import { describe, expect, it } from 'vitest'

import { isPayloadValidationError, isUniqueViolation } from '@/commerce/checkout/db'

/**
 * W2V2-1: unique-violation detection must survive the production build. `next build` minifies class names
 * and Payload's APIError sets `this.name = this.constructor.name`, so a ValidationError thrown by the drizzle
 * adapter arrives named e.g. 'u'. The old check (`err.name === 'ValidationError'`) made duplicate webhook
 * deliveries and same-key checkout races 500 in production only.
 */

/** What the drizzle adapter throws for a unique index (handleUpsertError). */
const uniqueError = (fieldPath: string | null) =>
  new ValidationError({ collection: 'payment-events', errors: [{ message: 'Value must be unique', path: fieldPath as string }] })

/** The same error after minification: the instance's `name` is whatever the class got renamed to. */
const minified = <E extends Error>(e: E): E => Object.assign(e, { name: 'u' })

describe('isUniqueViolation', () => {
  it('recognises the adapter ValidationError on the given path', () => {
    expect(isUniqueViolation(uniqueError('eventId'), 'eventId')).toBe(true)
    expect(isUniqueViolation(uniqueError('eventId'), 'idempotencyKey')).toBe(false)
    expect(isUniqueViolation(uniqueError('eventId'))).toBe(true)
  })

  it('still recognises it when the class name is minified (production build)', () => {
    const err = minified(uniqueError('idempotencyKey'))
    expect(err.name).toBe('u')
    expect(isUniqueViolation(err, 'idempotencyKey')).toBe(true)
    expect(isUniqueViolation(err, 'eventId')).toBe(false)
  })

  it('recognises the error by shape when it comes from another copy of the payload module', () => {
    const foreign = Object.assign(new Error('The following field is invalid: eventId'), {
      name: 'u',
      status: 400,
      data: { errors: [{ message: 'Value must be unique', path: 'eventId' }] },
    })
    expect(foreign).not.toBeInstanceOf(ValidationError)
    expect(isUniqueViolation(foreign, 'eventId')).toBe(true)
    expect(isUniqueViolation(foreign, 'key')).toBe(false)
  })

  it('accepts the column name the adapter falls back to when it cannot map the constraint', () => {
    expect(isUniqueViolation(minified(uniqueError('idempotency_key')), 'idempotencyKey')).toBe(true)
    expect(isUniqueViolation(minified(uniqueError('event_id')), 'eventId')).toBe(true)
    expect(isUniqueViolation(minified(uniqueError(null)), 'eventId')).toBe(false)
  })

  it('recognises a raw Postgres unique violation (23505), directly or as the cause', () => {
    expect(isUniqueViolation(Object.assign(new Error('duplicate key'), { code: '23505' }), 'eventId')).toBe(true)
    expect(isUniqueViolation(new Error('wrapped', { cause: { code: '23505' } }), 'eventId')).toBe(true)
    expect(isUniqueViolation(Object.assign(new Error('deadlock'), { code: '40P01' }), 'eventId')).toBe(false)
  })

  it('rejects everything else', () => {
    for (const e of [
      new Error('connection terminated unexpectedly'),
      minified(new APIError('boom', 500, { errors: [{ path: 'eventId' }] })),
      { status: 400, data: {} },
      { status: 422, data: { errors: [{ path: 'eventId' }] } },
      null,
      undefined,
      'ValidationError',
    ]) {
      expect(isUniqueViolation(e, 'eventId')).toBe(false)
    }
  })
})

describe('isPayloadValidationError', () => {
  it('by class (whatever its name) or by shape, never by name alone', () => {
    expect(isPayloadValidationError(minified(uniqueError('x')))).toBe(true)
    expect(isPayloadValidationError({ status: 400, data: { errors: [] } })).toBe(true)
    expect(isPayloadValidationError(Object.assign(new Error('x'), { name: 'ValidationError' }))).toBe(false)
  })
})

/**
 * Guard: checkout-owned code never identifies an error by its `name` (or its constructor's name). Class
 * names don't survive minification; use instanceof or the error's shape (status/code/data).
 */
/** `x.name === 'SomeError'` / `'NotFound' !== e.name` / `constructor.name` */
const NAME_CHECK = /\.name\s*[!=]==?\s*['"`][A-Z]|['"`][A-Z]\w*['"`]\s*[!=]==?\s*[\w?.]*\.name\b|constructor\.name/

describe('no error-name comparisons in checkout code', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src')
  const owned = ['commerce/checkout', 'commerce/shared', 'endpoints/checkout', 'jobs/checkout', 'email/orders', 'collections/Orders.ts']

  const files = (p: string): string[] =>
    statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(path.join(p, f))) : /\.(ts|js)$/.test(p) ? [p] : []

  it.each(owned)('%s', (rel) => {
    const offenders: string[] = []
    for (const file of files(path.join(root, rel))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = /^\s*(\*|\/\/|\/\*)/.test(line) ? '' : line // comments may explain the rule
          if (NAME_CHECK.test(code)) {
            offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })

  it('the pattern catches the W2V2-1 check and its variants, not ordinary name fields', () => {
    for (const bad of [
      `if (e?.name === 'ValidationError' && Array.isArray(e.data?.errors)) {`,
      `if (err.name !== "NotFound") throw err`,
      `if ('ValidationError' === e?.name) return true`,
      `const kind = err.constructor.name`,
    ]) {
      expect(NAME_CHECK.test(bad), bad).toBe(true)
    }
    for (const good of [`const name = p && typeof p.name === 'string' ? p.name : slug`, `if (err instanceof ValidationError) return true`]) {
      expect(NAME_CHECK.test(good), good).toBe(false)
    }
  })
})
