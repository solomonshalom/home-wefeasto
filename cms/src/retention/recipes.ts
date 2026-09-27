import type { Payload, Where } from 'payload'

import type { Recipe } from '@/payload-types'

import type { EmailRecipe } from '../email/retention/shared'
import { absoluteImage, recipeUrl } from './links'
import { relId } from './util'

/**
 * Recipes for the marketing emails. Only Payload-published recipes (the same rule as the snapshot), read
 * with overrideAccess so the result never depends on who triggered the email.
 */

const PUBLISHED: Where = { _status: { equals: 'published' } }
const SELECT = { slug: true, title: true, image: true, cardAlt: true, description: true, products: true } as const

type RecipeRow = Pick<Recipe, 'id' | 'slug' | 'title' | 'image' | 'cardAlt' | 'description' | 'products'>

export function toEmailRecipe(r: RecipeRow): EmailRecipe {
  return {
    title: r.title,
    url: recipeUrl(r.slug),
    image: absoluteImage(r.image),
    alt: r.cardAlt ?? r.title,
    description: r.description ?? undefined,
  }
}

async function findRecipes(payload: Payload, where: Where, limit: number): Promise<RecipeRow[]> {
  const res = await payload.find({
    collection: 'recipes',
    where,
    sort: 'sortOrder',
    limit,
    depth: 0,
    draft: false,
    overrideAccess: true,
    select: SELECT,
  })
  return res.docs as RecipeRow[]
}

/** Up to `count` recipes for the welcome email: the home page's featured ones first, then catalog order. */
export async function pickWelcomeRecipes(payload: Payload, count = 2): Promise<EmailRecipe[]> {
  const featured = await findRecipes(payload, { and: [PUBLISHED, { homeFeatured: { equals: true } }] }, count)
  let rows = featured
  if (rows.length < count) {
    const more = await findRecipes(
      payload,
      rows.length ? { and: [PUBLISHED, { id: { not_in: rows.map((r) => r.id) } }] } : PUBLISHED,
      count - rows.length,
    )
    rows = [...rows, ...more]
  }
  return rows.map(toEmailRecipe)
}

/**
 * One published recipe that uses one of the ordered products, preferring the earliest line of the order
 * (the first product in the bag is the one the email talks about). Null when none uses them.
 */
export async function recipeForProducts(payload: Payload, items: { product?: unknown; slug?: string | null }[]): Promise<EmailRecipe | null> {
  const slugs = items.map((i) => i.slug).filter((s): s is string => typeof s === 'string' && s.length > 0)
  const products = slugs.length
    ? (
        await payload.find({
          collection: 'products',
          where: { slug: { in: slugs } },
          limit: slugs.length,
          depth: 0,
          overrideAccess: true,
          select: { slug: true },
        })
      ).docs
    : []
  const idBySlug = new Map(products.map((p) => [p.slug, p.id]))
  // Line order → product id (the order's own relationship, else by slug).
  const orderedIds: number[] = []
  for (const item of items) {
    const id = relId(item.product) ?? (item.slug ? idBySlug.get(item.slug) : undefined) ?? null
    if (id !== null && !orderedIds.includes(id)) orderedIds.push(id)
  }
  if (!orderedIds.length) return null

  const rows = await findRecipes(payload, { and: [PUBLISHED, { 'products.product': { in: orderedIds } }] }, 20)
  if (!rows.length) return null
  const rank = (r: RecipeRow): number => {
    const ids = (r.products ?? []).map((row) => relId(row.product)).filter((x): x is number => x !== null)
    const best = Math.min(...ids.map((id) => orderedIds.indexOf(id)).filter((i) => i >= 0))
    return Number.isFinite(best) ? best : Infinity
  }
  // Stable: rows are already in sortOrder, so ties keep catalog order.
  const best = rows.reduce((a, b) => (rank(b) < rank(a) ? b : a))
  return toEmailRecipe(best)
}
