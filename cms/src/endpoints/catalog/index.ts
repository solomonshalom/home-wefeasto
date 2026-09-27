import type { Endpoint } from 'payload'

import { json, withErrors } from '../../lib/http'
import { enforceRateLimit } from '../../lib/rateLimit'
import { buildLiveCatalog, buildSnapshot } from './data'

/**
 * Catalog endpoints — OWNER: cms-catalog. Contract: SCRATCH/contracts/cms-catalog.md.
 *
 *   GET /api/store/snapshot  Published catalog in exactly the storefront snapshot shape
 *                            (src/lib/data/cms-snapshot.json). Read by scripts/sync-cms.mjs at build time.
 *                            Cache-Control: no-store.
 *   GET /api/store/catalog   Live overlay: public settings + {slug, name, pricePaise, inStock, lowStock,
 *                            maxPerOrder, codAllowed} for every published product. CDN-cacheable for 15/30 s.
 *
 * Neither response depends on who is asking (drafts and server-only fields are never included).
 */
export const catalogEndpoints: Endpoint[] = [
  {
    path: '/store/snapshot',
    method: 'get',
    handler: withErrors(async (req) => {
      // A build fetches this once; the limit only stops someone hammering an uncached, multi-query route.
      const limited = enforceRateLimit(req, 'store-snapshot', { limit: 30, windowMs: 60_000 })
      if (limited) return limited
      return json(await buildSnapshot(req), { cache: 'no-store' })
    }),
  },
  {
    path: '/store/catalog',
    method: 'get',
    handler: withErrors(async (req) => json(await buildLiveCatalog(req), { cache: 'public, max-age=15, s-maxage=30' })),
  },
]
