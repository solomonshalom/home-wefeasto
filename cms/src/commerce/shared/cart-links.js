/*
 * Stateless reorder / combo deep links: /cart?add=cornflakes:2,muesli:1[&src=email].
 * No token, no PII, shareable. The cart page parses them in onMount ONLY (so
 * link-preview crawlers can never touch a cart), merges them into the bag and
 * strips the param with history.replaceState. Prices are always today's.
 */
import { clampQty, LINK_QTY_MAX, LINK_MAX_LINES, DEFAULT_MAX_PER_ORDER } from './qty.js';
import { isSlug } from './validate.js';
import { indexCatalog } from './pricing.js';

/** Attribution values allowed in &src= (they map onto orders.source). */
export const CART_LINK_SOURCES = Object.freeze(['web', 'usual', 'link', 'email', 'refill', 'offer']);

/** Raw tokens / characters looked at before giving up on a pathological link. */
const MAX_TOKENS = 50;
const MAX_LINK_CHARS = 2000;

/** @typedef {'UNKNOWN'|'OUT_OF_STOCK'|'BAD_QTY'|'TOO_MANY'} DropReason */

/**
 * @typedef {object} DroppedLine
 * @property {string} slug     as written in the link (lowercased, ≤ 64 chars)
 * @property {string} name     catalog name when known, else the slug
 * @property {DropReason} reason
 */

/**
 * Parse the value of ?add= into cart lines.
 *  - Decodes percent-encoding once more if still present ('%2C', '%3A'),
 *    splits on ',' then on the first ':'; slugs are trimmed + lowercased.
 *  - Missing or empty qty → 1. Qty is read leniently and clamped to
 *    1..min(10, maxPerOrder) ('1e9' → 10); '-5', '0', 'abc' → dropped BAD_QTY.
 *  - Duplicate slugs are summed before clamping; a garbage qty token is
 *    ignored when another token for the same slug is valid.
 *  - Unknown / unpublished → dropped UNKNOWN; out of stock → OUT_OF_STOCK;
 *    beyond the first 6 valid lines → TOO_MANY. Order is first appearance.
 * @param {unknown} str
 * @param {import('./pricing.js').Catalog} catalog
 * @returns {{lines: {slug: string, qty: number}[], dropped: DroppedLine[]}}
 */
export function parseAddParam(str, catalog) {
	/** @type {{slug: string, qty: number}[]} */
	const lines = [];
	/** @type {DroppedLine[]} */
	const dropped = [];
	if (typeof str !== 'string' || !str.trim()) return { lines, dropped };

	// Bound the work on hostile links: ~2 KB of text, 50 comma tokens.
	let s = str.length > MAX_LINK_CHARS ? str.slice(0, MAX_LINK_CHARS) : str;
	if (s.includes('%')) {
		try {
			s = decodeURIComponent(s);
		} catch {
			/* malformed escape: parse what we have */
		}
	}

	const index = indexCatalog(catalog);
	// slug → summed good quantity (0 = only garbage quantities seen). A Map keeps
	// first-appearance order. A bad token never poisons a good one for the same slug.
	/** @type {Map<string, number>} */
	const sums = new Map();
	for (const token of s.split(',').slice(0, MAX_TOKENS)) {
		const t = token.trim();
		if (!t) continue;
		const colon = t.indexOf(':');
		const slug = (colon === -1 ? t : t.slice(0, colon)).trim().toLowerCase();
		if (!slug) continue;
		const rawQty = colon === -1 ? '' : t.slice(colon + 1).trim();
		const q = rawQty === '' ? 1 : clampQty(rawQty, Number.MAX_SAFE_INTEGER);
		sums.set(slug, Math.min((sums.get(slug) ?? 0) + q, Number.MAX_SAFE_INTEGER));
	}

	for (const [key, sum] of sums) {
		const p = isSlug(key) ? index.get(key) : undefined;
		const slug = key.slice(0, 64); // reported slugs are bounded; lookups used the full key
		const name = p && typeof p.name === 'string' && p.name ? p.name : slug;
		if (!p || p.published === false || !(Number.isSafeInteger(p.pricePaise) && p.pricePaise > 0)) {
			dropped.push({ slug, name, reason: 'UNKNOWN' });
		} else if (sum === 0) {
			dropped.push({ slug, name, reason: 'BAD_QTY' });
		} else if (p.inStock === false || (typeof p.stock === 'number' && !(p.stock > 0))) {
			dropped.push({ slug, name, reason: 'OUT_OF_STOCK' });
		} else if (lines.length >= LINK_MAX_LINES) {
			dropped.push({ slug, name, reason: 'TOO_MANY' });
		} else {
			const own = p.maxPerOrder;
			const max = Math.min(LINK_QTY_MAX, typeof own === 'number' && Number.isSafeInteger(own) && own >= 1 ? own : DEFAULT_MAX_PER_ORDER);
			lines.push({ slug: key, qty: Math.min(sum, max) });
		}
	}
	return { lines, dropped };
}

/**
 * Build the ?add= value from lines ([{slug, qty}] or a {slug: qty} map):
 * 'cornflakes:2,muesli:1'. Malformed slugs and garbage quantities are skipped,
 * duplicates summed, each qty clamped to 1..10, at most 6 lines, first-seen
 * order. The result round-trips through parseAddParam for in-stock SKUs.
 * The value is URL-safe as is (slugs are [a-z0-9-]; ',' and ':' are legal in
 * a query string).
 * @param {unknown} lines
 * @returns {string}
 */
export function buildAddParam(lines) {
	/** @type {[string, unknown][]} */
	const pairs = Array.isArray(lines)
		? lines.map((l) => [l && l.slug, l && l.qty])
		: lines && typeof lines === 'object'
			? Object.entries(lines)
			: [];
	/** @type {Map<string, number>} */
	const sums = new Map();
	for (const [slug, qty] of pairs) {
		if (!isSlug(slug)) continue;
		const q = clampQty(qty, Number.MAX_SAFE_INTEGER);
		if (q === 0) continue;
		if (!sums.has(slug) && sums.size >= LINK_MAX_LINES) continue;
		sums.set(slug, Math.min((sums.get(slug) ?? 0) + q, Number.MAX_SAFE_INTEGER));
	}
	return [...sums].map(([slug, q]) => `${slug}:${Math.min(q, LINK_QTY_MAX)}`).join(',');
}

/**
 * Validate &src= for attribution → one of CART_LINK_SOURCES, or null.
 * @param {unknown} v
 * @returns {string | null}
 */
export function parseSrcParam(v) {
	if (typeof v !== 'string') return null;
	const s = v.trim().toLowerCase();
	return CART_LINK_SOURCES.includes(s) ? s : null;
}

/**
 * Relative deep link for emails, /order "Buy again" and WhatsApp shares:
 * '/cart?add=cornflakes:2,muesli:1&src=email'. Returns '/cart' when no line
 * survives. Prefix with the storefront origin for absolute links.
 * @param {unknown} lines
 * @param {{src?: string}} [options]
 * @returns {string}
 */
export function buildCartLink(lines, options = {}) {
	const add = buildAddParam(lines);
	if (!add) return '/cart';
	const src = parseSrcParam(options.src);
	return `/cart?add=${add}${src ? `&src=${src}` : ''}`;
}

/**
 * Order-insensitive signature of a bag: merged, sorted 'slug:qty' pairs joined
 * by ','. Used as wefeasto_pending.cartSig and for request hashing, so two
 * bags with the same contents always match. Garbage entries are ignored;
 * quantities are NOT clamped (a signature must distinguish 12 from 10).
 * @param {unknown} items  [{slug, qty}] or {slug: qty}
 * @returns {string}
 */
export function cartSignature(items) {
	/** @type {[unknown, unknown][]} */
	const pairs = Array.isArray(items)
		? items.map((l) => [l && l.slug, l && l.qty])
		: items && typeof items === 'object'
			? Object.entries(items)
			: [];
	/** @type {Map<string, number>} */
	const sums = new Map();
	for (const [slug, qty] of pairs) {
		if (!isSlug(slug)) continue;
		const q = clampQty(qty, Number.MAX_SAFE_INTEGER);
		if (q > 0) sums.set(/** @type {string} */ (slug), (sums.get(/** @type {string} */ (slug)) ?? 0) + q);
	}
	return [...sums]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([s, q]) => `${s}:${q}`)
		.join(',');
}
