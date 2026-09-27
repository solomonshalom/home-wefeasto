import type { Access, Endpoint, PayloadHandler, SanitizedConfig } from 'payload'

import { userIsStaff } from './roles'

/**
 * Payload adds internal collections during sanitisation, after plugins run, with "any logged-in user"
 * access. With storefront customers logged in, that would let a customer list admin document locks
 * (payload-locked-documents) or store arbitrary admin-UI preferences (payload-preferences, whose
 * /:key endpoints skip access functions entirely). Restrict both, access functions and custom
 * endpoints, to staff. Staff keep the original behaviour.
 */
export const STAFF_ONLY_INTERNAL_COLLECTIONS = ['payload-locked-documents', 'payload-preferences'] as const

const OPS = ['create', 'read', 'update', 'delete', 'readVersions', 'unlock'] as const

const forbidden = () =>
  Response.json({ errors: [{ message: 'You are not allowed to perform this action.' }] }, { status: 403 })

export function hardenInternalCollections(config: SanitizedConfig): SanitizedConfig {
  for (const slug of STAFF_ONLY_INTERNAL_COLLECTIONS) {
    const collection = config.collections.find((c) => c.slug === slug)
    if (!collection) continue
    const access = collection.access as Record<string, Access | undefined>
    for (const op of OPS) {
      const original = access[op]
      if (!original && op !== 'create' && op !== 'read') continue
      access[op] = (args) => (userIsStaff(args.req.user) ? (original ? original(args) : true) : false)
    }
    if (Array.isArray(collection.endpoints)) {
      collection.endpoints = collection.endpoints.map((endpoint: Endpoint) => {
        const handler: PayloadHandler = endpoint.handler
        return { ...endpoint, handler: (req) => (userIsStaff(req.user) ? handler(req) : forbidden()) }
      })
    }
  }
  return hardenVersionAccess(config)
}

/** GET /versions, GET /versions/:id, POST /versions/:id (restore) of a collection or global. */
export const isVersionsEndpoint = (endpoint: Pick<Endpoint, 'path'>): boolean => /^\/versions(\/|$)/.test(endpoint.path)

const noVersions: Access = () => false

/**
 * Version history. Payload registers the /versions endpoints on EVERY collection and global, and its default
 * `readVersions` is "any logged-in user". Only products, recipes and pages have versions (and set it).
 *   - Without versions: nobody may read them, and the endpoints answer 403 before Payload looks for a
 *     versions table that does not exist (a customer, or any guest on POST /versions/:id, used to get a 500
 *     plus an ERROR log line with a stack).
 *   - With versions: staff only, on top of the collection's own rule (customers never read history).
 */
export function hardenVersionAccess(config: SanitizedConfig): SanitizedConfig {
  const entities = [...config.collections, ...(config.globals ?? [])]
  for (const entity of entities) {
    const access = entity.access as Record<string, Access | undefined>
    if (!entity.versions) {
      access.readVersions = noVersions
      if (Array.isArray(entity.endpoints)) {
        entity.endpoints = entity.endpoints.map((endpoint: Endpoint) =>
          isVersionsEndpoint(endpoint) ? { ...endpoint, handler: () => forbidden() } : endpoint,
        )
      }
      continue
    }
    const original = access.readVersions
    access.readVersions = (args) => (userIsStaff(args.req.user) ? (original ? original(args) : true) : false)
  }
  return config
}
