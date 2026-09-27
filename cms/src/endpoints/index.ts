import type { Endpoint } from 'payload'

import { accountEndpoints } from './account'
import { catalogEndpoints } from './catalog'
import { checkoutEndpoints } from './checkout'
import { cspEndpoints } from './csp'
import { retentionEndpoints } from './retention'

/**
 * Root custom endpoints, mounted at /api/<path>. Each area owns its registry file; add endpoints there,
 * not here. Custom routes live under /api/store/* and /api/payments/* so they can never collide with a
 * collection slug. Wrap handlers with withErrors() from src/lib/http.ts for the standard error body.
 */
export const endpoints: Endpoint[] = [
  ...catalogEndpoints,
  ...checkoutEndpoints,
  ...retentionEndpoints,
  ...accountEndpoints,
  ...cspEndpoints,
]

/** Throws at boot if two areas register the same METHOD + path. */
export function assertUniqueEndpoints(list: Endpoint[] = endpoints): void {
  const seen = new Set<string>()
  for (const e of list) {
    const id = `${e.method.toUpperCase()} ${e.path}`
    if (seen.has(id)) throw new Error(`Duplicate custom endpoint: ${id}`)
    seen.add(id)
  }
}
