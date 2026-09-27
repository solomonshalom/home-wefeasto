import { APIError, type FlattenedField, type Payload, type PayloadRequest } from 'payload'

/**
 * Malformed REST input is a 4xx, never a 500 (hunt r4 malformed-rest-500).
 *
 * Payload hands several client inputs to Postgres (or to its own code) without checking them: an id that is
 * not an integer (`/api/products/abc`), a negative page (OFFSET -60), an operator that doesn't fit the field
 * (`near` on a relationship, `like` on a checkbox), a value that doesn't fit the column (`category = bogus` on
 * an enum, `goesWith = abc` on an integer foreign key). Each was a 500 with an ERROR line, a stack and the
 * failed SQL in the log, repeatable by any visitor. This module checks them first:
 *   - checkRouteId:  an id that can't exist → 404 (queries never run);
 *   - checkQuery:    page ≥ 1 and limit ≥ 0 (whole numbers, bounded), a parseable `where` / `data`, and
 *                    every where condition against the field it names: an operator that field type supports
 *                    (the admin's own list) and, for ids / relationships / checkboxes / selects, a value the
 *                    column can hold → 400 INVALID_QUERY.
 * Unknown paths are left to Payload (its own 400 "cannot be queried"). Refusals are APIErrors: logged at info.
 * Wired onto Payload's default REST endpoints by src/lib/restGuards.ts.
 */

export const INVALID_QUERY = 'INVALID_QUERY'
export const invalidQuery = (message: string) => new APIError(message, 400, { code: INVALID_QUERY }, true)

const INT4_MIN = -2_147_483_648
const INT4_MAX = 2_147_483_647
/** Upper bound for page and limit: OFFSET (page − 1) × limit stays far inside Postgres' bigint. */
export const MAX_PAGE_OR_LIMIT = 1_000_000_000

/** A value an integer id column can hold. */
export const isInt4 = (v: unknown): boolean => {
  const n = typeof v === 'string' && /^-?\d{1,10}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= INT4_MIN && n <= INT4_MAX
}

const EQ = ['equals', 'not_equals', 'in', 'not_in', 'exists']
const CMP = ['greater_than', 'greater_than_equal', 'less_than', 'less_than_equal']
const TEXT = [...EQ, 'like', 'not_like', 'contains']
/** Operators per field type: the admin's filter list (@payloadcms/ui WhereBuilder field-types) + id comparisons. */
const OPERATORS: Record<string, string[]> = {
  id: [...EQ, ...CMP],
  number: [...EQ, ...CMP],
  date: [...EQ, ...CMP],
  text: TEXT,
  textarea: TEXT,
  code: TEXT,
  email: TEXT,
  checkbox: EQ,
  select: EQ,
  radio: EQ,
  relationship: EQ,
  upload: EQ,
  point: ['equals', 'not_equals', 'exists', 'near', 'within', 'intersects'],
}

/** What a where path resolves to: a field type plus what its values must be. */
type Target = { type: string; ids?: boolean; options?: string[]; hasMany?: boolean; polymorphic?: boolean }
type Fields = readonly FlattenedField[]

const collectionOf = (payload: Payload, slug: string) =>
  (payload.collections as Record<string, { config: { customIDType?: string; flattenedFields: FlattenedField[] } } | undefined>)[slug]?.config

const idTarget = (payload: Payload, slug: string): Target => {
  const custom = collectionOf(payload, slug)?.customIDType
  return custom ? { type: custom === 'number' ? 'number' : 'text' } : { type: 'id', ids: payload.db.defaultIDType === 'number' }
}

const optionValues = (field: { options?: unknown[] }): string[] =>
  (field.options ?? []).map((o) => (o && typeof o === 'object' ? String((o as { value: unknown }).value) : String(o)))

/** Resolves a dotted where path against `fields` (through groups, tabs, arrays and single relationships). */
export function resolvePath(payload: Payload, slug: string, fields: Fields, path: string): Target | undefined {
  let current: Fields = fields
  let currentSlug: string | null = slug
  const parts = path.split('.')
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]
    const last = i === parts.length - 1
    if (name === 'id' && currentSlug) return last ? idTarget(payload, currentSlug) : undefined
    const field = current.find((f) => 'name' in f && f.name === name) as (FlattenedField & Record<string, any>) | undefined
    if (!field) return undefined
    if (field.type === 'relationship' || field.type === 'upload') {
      const relationTo = field.relationTo as string | string[]
      if (Array.isArray(relationTo)) return last ? { type: field.type, polymorphic: true } : undefined
      if (last) return { type: field.type, ids: idTarget(payload, relationTo).ids, hasMany: Boolean(field.hasMany) }
      const target = collectionOf(payload, relationTo)
      if (!target) return undefined
      current = target.flattenedFields
      currentSlug = relationTo
      continue
    }
    if (field.type === 'group' || field.type === 'tab' || field.type === 'array') {
      if (last) return undefined
      current = field.flattenedFields ?? []
      // Array rows have their own text ids; groups and tabs have none.
      currentSlug = null
      if (field.type === 'array' && parts[i + 1] === 'id') return i + 1 === parts.length - 1 ? { type: 'text' } : undefined
      continue
    }
    if (!last) return undefined
    return { type: field.type, hasMany: Boolean(field.hasMany), options: 'options' in field ? optionValues(field as { options?: unknown[] }) : undefined }
  }
  return undefined
}

const listOf = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v && typeof v === 'object' ? Object.values(v) : [v]
const isBooleanLike = (v: unknown) => v === true || v === false || v === 'true' || v === 'false'
const isNullish = (v: unknown) => v === null || v === 'null'

/** Does `value` fit `target` for `operator`? (Only the types whose bad values reach Postgres are checked.) */
function valueFits(target: Target, operator: string, value: unknown): boolean {
  if (operator === 'exists' || target.polymorphic) return true
  const many = operator === 'in' || operator === 'not_in'
  const values = many ? listOf(value) : [value]
  if (many && values.length === 0) return false
  const single = (v: unknown): boolean => {
    if (!many && isNullish(v)) return true
    if (target.ids) return (!many && v === '') || isInt4(v)
    if (target.type === 'checkbox') return isBooleanLike(v)
    if ((target.type === 'select' || target.type === 'radio') && target.options) return typeof v === 'string' && target.options.includes(v)
    return true
  }
  return values.every(single)
}

const hasNul = (v: unknown, depth = 0): boolean =>
  typeof v === 'string'
    ? v.includes('\u0000')
    : Boolean(v) && typeof v === 'object' && depth < 10 && Object.values(v as object).some((x) => hasNul(x, depth + 1))

/** Checks one where tree (and / or nested) against `fields`; throws INVALID_QUERY. */
export function checkWhere(payload: Payload, slug: string, fields: Fields, where: unknown, depth = 0): void {
  if (where === undefined || where === null || where === '') return
  if (typeof where !== 'object' || Array.isArray(where) || depth > 20) throw invalidQuery('The where query is malformed.')
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'and' || key === 'or') {
      for (const w of listOf(value)) checkWhere(payload, slug, fields, w, depth + 1)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidQuery(`The condition on "${key}" is malformed.`)
    if (hasNul(value)) throw invalidQuery(`Invalid value for "${key}".`) // Postgres can't compare a NUL character
    const target = resolvePath(payload, slug, fields, key)
    if (!target) continue
    const allowed = [...(OPERATORS[target.type] ?? []), ...(target.hasMany && ['select', 'text', 'number'].includes(target.type) ? ['all'] : [])]
    for (const [operator, operand] of Object.entries(value as Record<string, unknown>)) {
      if (!OPERATORS[target.type]) continue
      if (target.polymorphic ? !['equals', 'not_equals', 'exists'].includes(operator) : !allowed.includes(operator))
        throw invalidQuery(`"${operator}" can't be used on "${key}".`)
      if (!valueFits(target, operator, operand)) throw invalidQuery(`Invalid value for "${key}".`)
    }
  }
}

const wholeIn = (v: unknown, min: number): boolean => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX_PAGE_OR_LIMIT
}

/** page / limit / where / data of a REST request to a collection (or its versions: `fields` = version fields). */
export function checkQuery(req: PayloadRequest, slug: string, fields: Fields): void {
  const q = (req.query ?? {}) as Record<string, unknown>
  if ('page' in q && !wholeIn(q.page, 1)) throw invalidQuery('page must be a whole number, 1 or more.')
  if ('limit' in q && !wholeIn(q.limit, 0)) throw invalidQuery('limit must be a whole number, 0 or more.')
  for (const key of ['where', 'data'] as const) {
    if (typeof q[key] === 'string' && q[key]) {
      try {
        q[key] = JSON.parse(q[key] as string)
      } catch {
        throw invalidQuery(`${key} is not valid JSON.`)
      }
    }
  }
  if ('where' in q) checkWhere(req.payload, slug, fields, q.where)
}

/** A route id that can't exist in an integer id column → 404 before any query runs. */
export function checkRouteId(req: PayloadRequest, numeric: boolean): void {
  const id = req.routeParams?.id
  if (numeric && id !== undefined && id !== '' && !isInt4(id)) throw new APIError('Not Found', 404, undefined, true)
}
