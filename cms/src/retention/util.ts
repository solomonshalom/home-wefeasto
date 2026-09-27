import { ValidationError } from 'payload'

/** Small helpers shared by the retention modules. */

/**
 * A Payload ValidationError on `path` (e.g. 'email', 'code', 'key'): what the DB adapter throws when an
 * insert hits a unique index. Never compare `err.name`: the production build minifies class names
 * ('ValidationError' → 'u'), so a name check passes in dev and tests and fails under `next start`.
 * `instanceof` is the primary test; the shape (status 400 + data.errors[].path) also covers an error
 * thrown by a second bundled copy of the payload module, where instanceof is false.
 */
export function isUniqueViolation(err: unknown, path: string): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; data?: { errors?: unknown } | null }
  if (!(err instanceof ValidationError) && e.status !== 400) return false
  const errors = e.data?.errors
  return Array.isArray(errors) && errors.some((x) => Boolean(x) && typeof x === 'object' && (x as { path?: unknown }).path === path)
}

/** A valid Date from a Date / ISO string / epoch ms, else null. */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value as string | number)
  return Number.isFinite(d.getTime()) ? d : null
}

/** Relationship value (id or populated doc) → id. */
export function relId(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'number') return (value as { id: number }).id
  return null
}

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
