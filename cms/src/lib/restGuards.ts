import { APIError, type Endpoint, type FlattenedField, type PayloadHandler, type PayloadRequest, type SanitizedConfig } from 'payload'

import { checkQuery, checkRouteId } from './restInput'

/**
 * Config post-processor: puts the REST input checks of restInput.ts in front of Payload's default collection
 * and global endpoints, and turns a crash caused by malformed client input into a 400:
 *   - multipart with a `_payload` field that isn't JSON (Payload JSON.parses it unguarded → SyntaxError);
 *   - a JSON body that parses but isn't an object (`null`, `"str"`, `42` → TypeErrors inside Payload);
 *   - text Postgres can't store (a NUL character in an email, token, name or where value: SQLSTATE 22021),
 *     which failed the query with the whole statement — and its parameters: salt, hash, tokens — at ERROR.
 * The body ones happen while Payload reads the body, before any hook, so all are mapped on the way out:
 * only when the input is the cause and the error isn't already a refusal. 400 APIErrors log at info
 * (src/lib/logging.ts) with their message only.
 */

export const INVALID_JSON = 'INVALID_JSON'
export const INVALID_TEXT = 'INVALID_TEXT'

/** Default endpoints whose query string carries where / page / limit. */
const QUERY_ENDPOINTS = new Set(['get /', 'get /count', 'get /versions', 'patch /', 'delete /'])
/** Default endpoints with an :id of the collection (or of a version). */
const ID_ENDPOINTS = new Set([
  'get /:id',
  'patch /:id',
  'delete /:id',
  'post /:id/duplicate',
  'post /access/:id?',
  'get /versions/:id',
  'post /versions/:id',
])
const BODY_METHODS = new Set(['post', 'patch', 'put'])

const isPlainObject = (v: unknown): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isRefusal = (err: unknown): boolean => {
  const status = (err as { status?: unknown })?.status
  return typeof status === 'number' && status >= 400 && status < 500
}
const contentType = (req: PayloadRequest): string => (req.headers?.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined
  const code = e?.code ?? e?.cause?.code
  return typeof code === 'string' ? code : undefined
}

/** The 400 a crash caused by the request's input becomes (see above), or the error untouched. */
export function bodyError(req: PayloadRequest, err: unknown, withBody = true): unknown {
  if (isRefusal(err)) return err
  // character_not_in_repertoire: e.g. "invalid byte sequence for encoding UTF8: 0x00" — text from the client.
  if (pgCode(err) === '22021') return new APIError("Text can't contain a NUL character.", 400, { code: INVALID_TEXT }, true)
  if (!withBody) return err
  const type = contentType(req)
  // A built-in class (never minified): JSON.parse of the `_payload` field threw before any data was parsed.
  if (type.startsWith('multipart/') && req.data === undefined && err instanceof SyntaxError) {
    return new APIError('Invalid JSON: the _payload field must be a JSON object.', 400, { code: INVALID_JSON }, true)
  }
  if (type === 'application/json' && req.data !== undefined && !isPlainObject(req.data)) {
    return new APIError('The request body must be a JSON object.', 400, { code: INVALID_JSON }, true)
  }
  return err
}

/** Fields a where on /versions refers to (version.<field>, parent, latest, …). */
function versionFields(fields: readonly FlattenedField[], parent?: string): FlattenedField[] {
  const f = (field: Record<string, unknown>) => field as unknown as FlattenedField
  return [
    ...(parent ? [f({ name: 'parent', type: 'relationship', relationTo: parent })] : []),
    f({ name: 'version', type: 'group', flattenedFields: fields }),
    f({ name: 'createdAt', type: 'date' }),
    f({ name: 'updatedAt', type: 'date' }),
    f({ name: 'latest', type: 'checkbox' }),
    f({ name: 'autosave', type: 'checkbox' }),
    f({ name: 'snapshot', type: 'checkbox' }),
  ]
}

type Entity = { slug: string; flattenedFields: FlattenedField[]; customIDType?: string; endpoints?: unknown }

function guardEndpoint(endpoint: Endpoint, entity: Entity, kind: 'collection' | 'global'): Endpoint {
  const key = `${endpoint.method} ${endpoint.path}`
  const withId = ID_ENDPOINTS.has(key)
  const withQuery = QUERY_ENDPOINTS.has(key)
  const withBody = BODY_METHODS.has(endpoint.method)
  const versions = endpoint.path.startsWith('/versions')
  const fields = versions ? versionFields(entity.flattenedFields, kind === 'collection' ? entity.slug : undefined) : entity.flattenedFields
  const handler: PayloadHandler = endpoint.handler
  return {
    ...endpoint,
    handler: async (req) => {
      const numericIds = req.payload.db.defaultIDType === 'number'
      if (withId) checkRouteId(req, numericIds && (versions || !entity.customIDType))
      if (withQuery || (withId && kind === 'collection')) checkQuery(req, entity.slug, fields)
      try {
        return await handler(req)
      } catch (err) {
        throw bodyError(req, err, withBody)
      }
    },
  }
}

/** Wraps the endpoints of every collection and global (after the other post-processors). */
export function guardRestInput(config: SanitizedConfig): SanitizedConfig {
  for (const collection of config.collections) {
    if (!Array.isArray(collection.endpoints)) continue
    collection.endpoints = collection.endpoints.map((e) => guardEndpoint(e, collection as unknown as Entity, 'collection'))
  }
  for (const global of config.globals ?? []) {
    if (!Array.isArray(global.endpoints)) continue
    global.endpoints = global.endpoints.map((e) => guardEndpoint(e, global as unknown as Entity, 'global'))
  }
  return config
}
