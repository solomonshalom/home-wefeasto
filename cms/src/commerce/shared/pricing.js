/*
 * Pricing: lines, free delivery, COD availability, the quote, and the one-tap
 * top-up suggestion. The storefront runs quote() for instant display; the CMS
 * runs the same function against live DB prices/stock and that result is what
 * gets charged. Everything is integer paise; nothing here reads the clock.
 *
 * Stock problems never throw: each problem line is reported in `issues[]` and
 * EXCLUDED from the totals, so the summary always shows what could be bought
 * right now. The checkout endpoint refuses to create an order while
 * `issues.length > 0` (quote.canCheckout is false).
 */
import { MIN_ORDER_PAISE, isPaise } from './money.js';
import { parseQty, clampQty, DEFAULT_MAX_PER_ORDER, CART_QTY_CAP, QTY_PARSE_MAX } from './qty.js';
import { isSlug, isPinBlocked } from './validate.js';
import { resolveSettings } from './settings.js';
import { evaluateCoupon } from './coupons.js';

/** A request may carry at most this many raw item rows … */
export const MAX_RAW_ITEMS = 50;
/** … and at most this many distinct SKUs after merging duplicates. */
export const MAX_LINES = 20;

/** @typedef {'upi'|'card'|'cod'} RequestedMethod */

/**
 * @typedef {object} CatalogItem
 * @property {string} slug
 * @property {string} [name]
 * @property {number} pricePaise        integer paise > 0
 * @property {boolean} [inStock]        default true; false → OUT_OF_STOCK {available: 0}
 * @property {number|null} [stock]      server-only exact count; null/undefined = not tracked
 * @property {number} [maxPerOrder]     default DEFAULT_MAX_PER_ORDER (10)
 * @property {boolean} [codAllowed]     default true
 * @property {boolean} [published]      default true; false → UNAVAILABLE
 * @property {string} [image]
 */

/** @typedef {ReadonlyArray<CatalogItem> | ReadonlyMap<string, CatalogItem>} Catalog */
/** @typedef {{slug: string, qty: unknown}} ItemInput */
/** @typedef {ReadonlyArray<ItemInput> | Record<string, unknown>} ItemsInput  array of {slug, qty} or a cart map {slug: qty} */

/**
 * @typedef {object} Line
 * @property {string} slug
 * @property {string} name
 * @property {number} unitPaise
 * @property {number} qty
 * @property {number} lineTotalPaise
 * @property {boolean} codAllowed
 * @property {number} maxPerOrder
 * @property {string} [image]
 */

/** @typedef {'UNAVAILABLE'|'OUT_OF_STOCK'|'QTY_LIMIT'|'BAD_QTY'} IssueCode */

/**
 * @typedef {object} Issue
 * @property {string} slug
 * @property {string} name          catalog name, or the slug when unknown
 * @property {IssueCode} code
 * @property {number|null} requestedQty  null when the qty itself was garbage (BAD_QTY)
 * @property {number} suggestedQty  what the customer could buy instead (0 = remove the line)
 * @property {number} [available]   OUT_OF_STOCK only
 * @property {number} [max]         QTY_LIMIT only
 */

/**
 * Index a catalog (array or Map) by slug. Lookups go through a Map, so
 * '__proto__' / 'constructor' can never hit Object.prototype.
 * @param {Catalog} catalog
 * @returns {Map<string, CatalogItem>}
 */
export function indexCatalog(catalog) {
	if (catalog instanceof Map) return /** @type {Map<string, CatalogItem>} */ (catalog);
	const m = new Map();
	if (Array.isArray(catalog)) {
		for (const p of catalog) if (p && typeof p.slug === 'string' && !m.has(p.slug)) m.set(p.slug, p);
	}
	return m;
}

/**
 * Normalise either input shape to [{slug, qty}] in first-seen order WITHOUT
 * validating (buildLines does that).
 * @param {unknown} items
 * @returns {ItemInput[]}
 */
function toItemList(items) {
	if (Array.isArray(items)) {
		return items.map((it) => (it && typeof it === 'object' ? { slug: it.slug, qty: it.qty } : { slug: undefined, qty: undefined }));
	}
	if (items && typeof items === 'object' && !(items instanceof Map)) {
		return Object.keys(items).map((slug) => ({ slug, qty: /** @type {any} */ (items)[slug] }));
	}
	return [];
}

/**
 * Tolerant reader for the stored cart ({slug: qty} from localStorage, which a
 * user can edit): drops malformed slugs and non-positive/garbage quantities,
 * caps each SKU at CART_QTY_CAP (20), returns [{slug, qty}] in key order.
 * Use before quoting on the client or POSTing to /api/store/quote.
 * @param {unknown} cartMap
 * @returns {{slug: string, qty: number}[]}
 */
export function cartToItems(cartMap) {
	if (!cartMap || typeof cartMap !== 'object' || Array.isArray(cartMap)) return [];
	const out = [];
	for (const slug of Object.keys(cartMap)) {
		if (!isSlug(slug)) continue;
		const qty = clampQty(/** @type {any} */ (cartMap)[slug], CART_QTY_CAP);
		if (qty > 0) out.push({ slug, qty });
	}
	return out;
}

/**
 * STRICT request-body parser for POST /api/store/quote and /checkout.
 * Merges duplicate slugs (quantities summed) in first-seen order.
 * Errors (→ HTTP 400): VALIDATION {field:'items'} (not an array / row not an
 * object), EMPTY_CART, TOO_MANY_LINES {max}, BAD_SLUG {index, slug},
 * BAD_QTY {index, slug}. Unknown-but-well-formed slugs pass: quote() reports
 * them as UNAVAILABLE issues.
 * @param {unknown} raw
 * @returns {{ok: true, items: {slug: string, qty: number}[]} | {ok: false, error: {code: string, details?: any}}}
 */
export function parseItems(raw) {
	if (!Array.isArray(raw)) return { ok: false, error: { code: 'VALIDATION', details: { field: 'items' } } };
	if (raw.length === 0) return { ok: false, error: { code: 'EMPTY_CART' } };
	if (raw.length > MAX_RAW_ITEMS) return { ok: false, error: { code: 'TOO_MANY_LINES', details: { max: MAX_LINES } } };
	/** @type {Map<string, number>} */
	const merged = new Map();
	for (let i = 0; i < raw.length; i++) {
		const it = raw[i];
		if (!it || typeof it !== 'object' || Array.isArray(it)) {
			return { ok: false, error: { code: 'VALIDATION', details: { field: 'items', index: i } } };
		}
		if (!isSlug(it.slug)) {
			const slug = typeof it.slug === 'string' ? it.slug.slice(0, 64) : null;
			return { ok: false, error: { code: 'BAD_SLUG', details: { index: i, slug } } };
		}
		const qty = parseQty(it.qty);
		if (qty === null) return { ok: false, error: { code: 'BAD_QTY', details: { index: i, slug: it.slug } } };
		merged.set(it.slug, (merged.get(it.slug) ?? 0) + qty);
	}
	if (merged.size > MAX_LINES) return { ok: false, error: { code: 'TOO_MANY_LINES', details: { max: MAX_LINES } } };
	return { ok: true, items: [...merged].map(([slug, qty]) => ({ slug, qty })) };
}

/**
 * Units that can actually be bought for a catalog item right now
 * (Infinity when stock isn't tracked and the item is in stock).
 * @param {CatalogItem} p
 */
function availableUnits(p) {
	if (p.inStock === false) return 0;
	if (typeof p.stock === 'number') return Number.isSafeInteger(p.stock) && p.stock > 0 ? p.stock : 0;
	return Infinity;
}

/** Unit prices above ₹1 crore are treated as a catalog error (keeps every total a safe integer). */
export const MAX_UNIT_PAISE = 1_000_000_000;

/**
 * Per-order cap for a catalog item: its maxPerOrder (1..QTY_PARSE_MAX) or the default 10.
 * @param {CatalogItem} p
 * @returns {number}
 */
function maxPerOrderOf(p) {
	const m = p.maxPerOrder;
	return typeof m === 'number' && Number.isSafeInteger(m) && m >= 1 ? Math.min(m, QTY_PARSE_MAX) : DEFAULT_MAX_PER_ORDER;
}
/** @param {CatalogItem} p */
const isSellable = (p) => p.published !== false && isPaise(p.pricePaise) && p.pricePaise > 0 && p.pricePaise <= MAX_UNIT_PAISE;

/**
 * Price the items against the catalog. Duplicate slugs are merged first.
 * Problem lines go to `issues` and are left out of `lines`:
 *  - UNAVAILABLE: unknown, malformed or unpublished slug, or a bad catalog price
 *  - BAD_QTY: quantity isn't a strict positive integer (parseQty)
 *  - OUT_OF_STOCK {available}: inStock false, or qty > stock
 *  - QTY_LIMIT {max}: qty > maxPerOrder
 * @param {unknown} items  array of {slug, qty} or a cart map {slug: qty}
 * @param {Catalog} catalog
 * @returns {{lines: Line[], issues: Issue[]}}
 */
export function buildLines(items, catalog) {
	const index = indexCatalog(catalog);
	/** @type {Map<string, number|null>} merged qty per slug; null = garbage qty seen */
	const merged = new Map();
	for (const { slug, qty } of toItemList(items)) {
		const key = typeof slug === 'string' ? slug : '';
		const q = parseQty(qty);
		const prev = merged.get(key);
		if (prev === null) continue; // already poisoned by a garbage qty
		merged.set(key, q === null ? null : (prev ?? 0) + q);
	}

	/** @type {Line[]} */
	const lines = [];
	/** @type {Issue[]} */
	const issues = [];
	for (const [key, qty] of merged) {
		const p = isSlug(key) ? index.get(key) : undefined;
		const slug = key.slice(0, 64); // reported slugs are bounded; lookups used the full key
		const name = p && typeof p.name === 'string' && p.name ? p.name : slug;
		if (!p || !isSellable(p)) {
			issues.push({ slug, name, code: 'UNAVAILABLE', requestedQty: qty, suggestedQty: 0 });
			continue;
		}
		if (qty === null) {
			issues.push({ slug, name, code: 'BAD_QTY', requestedQty: null, suggestedQty: 0 });
			continue;
		}
		const max = maxPerOrderOf(p);
		const available = availableUnits(p);
		if (qty > available) {
			issues.push({ slug, name, code: 'OUT_OF_STOCK', requestedQty: qty, available, suggestedQty: Math.min(available, max) });
			continue;
		}
		if (qty > max) {
			issues.push({ slug, name, code: 'QTY_LIMIT', requestedQty: qty, max, suggestedQty: max });
			continue;
		}
		/** @type {Line} */
		const line = {
			slug,
			name,
			unitPaise: p.pricePaise,
			qty,
			lineTotalPaise: p.pricePaise * qty,
			codAllowed: p.codAllowed !== false,
			maxPerOrder: max
		};
		if (typeof p.image === 'string' && p.image) line.image = p.image;
		lines.push(line);
	}
	return { lines, issues };
}

/**
 * Free-delivery maths on the PRE-discount subtotal (a coupon never changes
 * eligibility). Empty bag → no fee, full amount still to go.
 * A delivery fee of 0 means delivery is free for every non-empty bag, whatever
 * the threshold: isFreeDelivery, nothing left to go, progress 1 (so the bag
 * says FREE and never asks for "₹… more" for a delivery that costs nothing).
 * @param {number} subtotalPaise
 * @param {any} [settings]
 * @returns {{deliveryPaise: number, isFreeDelivery: boolean, thresholdPaise: number, amountToFreeDeliveryPaise: number, freeDeliveryProgress: number}}
 */
export function freeDelivery(subtotalPaise, settings) {
	const s = resolveSettings(settings);
	const subtotal = isPaise(subtotalPaise) ? subtotalPaise : 0;
	const threshold = s.freeDeliveryThresholdPaise;
	const isFreeDelivery = subtotal > 0 && (subtotal >= threshold || s.deliveryFeePaise === 0);
	const deliveryPaise = subtotal === 0 || isFreeDelivery ? 0 : s.deliveryFeePaise;
	if (isFreeDelivery) return { deliveryPaise, isFreeDelivery, thresholdPaise: threshold, amountToFreeDeliveryPaise: 0, freeDeliveryProgress: 1 };
	const amountToFreeDeliveryPaise = subtotal === 0 ? threshold : threshold - subtotal;
	const freeDeliveryProgress = threshold <= 0 ? 0 : Math.min(1, subtotal / threshold);
	return { deliveryPaise, isFreeDelivery, thresholdPaise: threshold, amountToFreeDeliveryPaise, freeDeliveryProgress };
}

/**
 * @typedef {'DISABLED'|'EMPTY'|'ITEM_NOT_ALLOWED'|'PIN_BLOCKED'|'BELOW_MIN'|'ABOVE_MAX'} CodReason
 */

/**
 * COD availability for priced lines. `codTotalPaise` is what the customer
 * would pay on delivery (subtotal − discount + delivery + COD fee).
 * Checked in order: DISABLED, EMPTY, ITEM_NOT_ALLOWED, PIN_BLOCKED (only when
 * a pin is given), BELOW_MIN (subtotal < codMinSubtotalPaise), ABOVE_MAX
 * (codTotal > codMaxPaise). The per-phone open-order cap needs the DB and is
 * the server's job (reason 'TOO_MANY_OPEN' in errors.js copy).
 * @param {{lines: Line[], subtotalPaise: number, codTotalPaise: number, pin?: string|null, settings?: any}} args
 * @returns {{codAvailable: boolean, codUnavailableReason: CodReason|null}}
 */
export function codAvailability({ lines, subtotalPaise, codTotalPaise, pin, settings }) {
	const s = resolveSettings(settings);
	/** @param {CodReason} r */
	const no = (r) => ({ codAvailable: false, codUnavailableReason: r });
	if (!s.codEnabled) return no('DISABLED');
	if (!lines.length) return no('EMPTY');
	if (lines.some((l) => l.codAllowed === false)) return no('ITEM_NOT_ALLOWED');
	if (typeof pin === 'string' && pin && isPinBlocked(pin, s.codBlockedPinPrefixes)) return no('PIN_BLOCKED');
	if (subtotalPaise < s.codMinSubtotalPaise) return no('BELOW_MIN');
	if (codTotalPaise > s.codMaxPaise) return no('ABOVE_MAX');
	return { codAvailable: true, codUnavailableReason: null };
}

/**
 * @typedef {object} QuoteContext
 * @property {number|string|Date} [now]      required when the coupon has startsAt/endsAt
 * @property {string} [email]                enables the EMAIL_MISMATCH check
 * @property {boolean} [isFirstOrder]        enables FIRST_ORDER_ONLY
 * @property {number} [customerUsageCount]   enables PER_CUSTOMER_LIMIT
 * @property {string} [couponCode]           code the customer sent; with coupon=null → NOT_FOUND
 * @property {string} [pin]                  enables PIN checks (pinServiceable, COD PIN_BLOCKED)
 */

/**
 * @typedef {object} Quote
 * @property {Line[]} lines
 * @property {Issue[]} issues
 * @property {number} itemCount                  units across priced lines
 * @property {number} subtotalPaise
 * @property {number} discountPaise
 * @property {number} deliveryPaise
 * @property {number} codFeePaise                only when method === 'cod' and the bag isn't empty
 * @property {number} totalPaise                 subtotal − discount + delivery + codFee
 * @property {'INR'} currency
 * @property {number} freeDeliveryThresholdPaise
 * @property {number} amountToFreeDeliveryPaise
 * @property {number} freeDeliveryProgress       0..1
 * @property {boolean} isFreeDelivery
 * @property {boolean} codAvailable
 * @property {CodReason|null} codUnavailableReason
 * @property {boolean|null} pinServiceable       null when no pin was given
 * @property {{code: string, type: string, discountPaise: number, deferredChecks: string[]}|null} coupon
 * @property {{code: 'COUPON_INVALID', reason: string}|null} couponError
 * @property {{code: 'EMPTY_CART'|'BELOW_MIN'|'ABOVE_MAX', limitPaise?: number}|null} orderError
 * @property {boolean} canCheckout               no issues and no orderError
 * @property {RequestedMethod|null} method
 */

const METHODS = new Set(['upi', 'card', 'cod']);

/**
 * The quote. Pure and deterministic: same input → same output, no clock.
 * Order of operations:
 *  1. buildLines (issue lines excluded), subtotal = Σ line totals
 *  2. delivery from the PRE-discount subtotal (freeDelivery)
 *  3. COD fee = settings.codFeePaise when method === 'cod' (and the bag isn't empty)
 *  4. coupon via evaluateCoupon — the discount is CLAMPED so it never exceeds
 *     the subtotal and never pushes a non-empty total below MIN_ORDER_PAISE
 *  5. total = subtotal − discount + delivery + codFee
 *  6. COD availability on the hypothetical COD total (independent of method)
 *  7. orderError: EMPTY_CART (no priced lines), BELOW_MIN, ABOVE_MAX (maxOrderPaise)
 * @param {{items: unknown, catalog: Catalog, settings?: any, coupon?: any, method?: unknown, context?: QuoteContext}} args
 * @returns {Quote}
 */
export function quote({ items, catalog, settings, coupon = null, method, context = {} }) {
	const s = resolveSettings(settings);
	const ctx = context && typeof context === 'object' ? context : {};
	const m = typeof method === 'string' && METHODS.has(method) ? /** @type {RequestedMethod} */ (method) : null;

	const { lines, issues } = buildLines(items, catalog);
	const subtotalPaise = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
	const itemCount = lines.reduce((a, l) => a + l.qty, 0);
	const fd = freeDelivery(subtotalPaise, s);
	const deliveryPaise = fd.deliveryPaise;
	const codFeeIfCod = lines.length ? s.codFeePaise : 0;
	const codFeePaise = m === 'cod' ? codFeeIfCod : 0;

	// Coupon (evaluated twice only because the ₹1 floor depends on the COD fee).
	const hasCode = typeof ctx.couponCode === 'string' && ctx.couponCode.trim() !== '';
	let discountPaise = 0;
	let discountIfCod = 0;
	/** @type {Quote['coupon']} */
	let couponOut = null;
	/** @type {Quote['couponError']} */
	let couponError = null;
	if (coupon || hasCode) {
		const base = {
			subtotalPaise,
			deliveryPaise,
			now: ctx.now,
			email: ctx.email,
			isFirstOrder: ctx.isFirstOrder,
			customerUsageCount: ctx.customerUsageCount
		};
		const r = evaluateCoupon(coupon, { ...base, codFeePaise });
		if (r.error) {
			couponError = r.error;
		} else {
			discountPaise = r.discountPaise;
			discountIfCod = evaluateCoupon(coupon, { ...base, codFeePaise: codFeeIfCod }).discountPaise;
			couponOut = { code: String(coupon.code ?? ''), type: String(coupon.type ?? ''), discountPaise, deferredChecks: r.deferredChecks };
		}
	}

	const totalPaise = subtotalPaise - discountPaise + deliveryPaise + codFeePaise;
	const codTotalPaise = subtotalPaise - discountIfCod + deliveryPaise + codFeeIfCod;
	const pin = typeof ctx.pin === 'string' && ctx.pin ? ctx.pin : null;
	const cod = codAvailability({ lines, subtotalPaise, codTotalPaise, pin, settings: s });

	/** @type {Quote['orderError']} */
	let orderError = null;
	if (!lines.length) orderError = { code: 'EMPTY_CART' };
	else if (totalPaise < MIN_ORDER_PAISE) orderError = { code: 'BELOW_MIN', limitPaise: MIN_ORDER_PAISE };
	else if (totalPaise > s.maxOrderPaise) orderError = { code: 'ABOVE_MAX', limitPaise: s.maxOrderPaise };

	return {
		lines,
		issues,
		itemCount,
		subtotalPaise,
		discountPaise,
		deliveryPaise,
		codFeePaise,
		totalPaise,
		currency: 'INR',
		freeDeliveryThresholdPaise: fd.thresholdPaise,
		amountToFreeDeliveryPaise: fd.amountToFreeDeliveryPaise,
		freeDeliveryProgress: fd.freeDeliveryProgress,
		isFreeDelivery: fd.isFreeDelivery,
		codAvailable: cod.codAvailable,
		codUnavailableReason: cod.codUnavailableReason,
		pinServiceable: pin === null ? null : !isPinBlocked(pin, s.blockedPinPrefixes),
		coupon: couponOut,
		couponError,
		orderError,
		canCheckout: issues.length === 0 && orderError === null,
		method: m
	};
}

/**
 * @typedef {object} TopUp
 * @property {string} slug
 * @property {string} name
 * @property {number} pricePaise
 * @property {boolean} crosses            adding it reaches free delivery
 * @property {number} gapPaise            amount still needed before adding
 * @property {number} remainingAfterPaise gap left after adding one (0 when crosses)
 * @property {number} overshootPaise      how far past the threshold it lands (0 when not crossing)
 * @property {boolean} inCart
 */

/**
 * One-tap top-up (roadmap F1, C's scoring): the single in-stock SKU that best
 * closes the free-delivery gap. Returns null for an empty bag or when delivery
 * is already free (over the threshold, or a delivery fee of 0).
 *  - Candidates: sellable, in stock, and one more unit still fits maxPerOrder
 *    and stock. SKUs in `options.exclude` (rejected suggestions) are skipped.
 *  - Crossing candidates (price ≥ gap) win, scored by overshoot plus
 *    settings.topUpDiscoveryBiasPaise when the SKU is already in the bag
 *    (bias 0 → "second pack" behaviour). Ties → lower price → catalog order.
 *  - Otherwise the biggest step: not-in-bag first, then highest price, then
 *    catalog order; `crosses` is false and remainingAfterPaise > 0.
 * Deterministic and independent of the cart's key order.
 * @param {unknown} cartMap  {slug: qty} (or [{slug, qty}])
 * @param {Catalog} catalog
 * @param {any} [settings]
 * @param {{exclude?: ReadonlyArray<string>}} [options]
 * @returns {TopUp | null}
 */
export function topUpSuggestion(cartMap, catalog, settings, options = {}) {
	const s = resolveSettings(settings);
	const { lines, issues } = buildLines(cartMap, catalog);
	const subtotal = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
	const gap = s.freeDeliveryThresholdPaise - subtotal;
	// Delivery fee 0: every bag already has free delivery, nothing to top up for.
	if (subtotal === 0 || gap <= 0 || s.deliveryFeePaise === 0) return null;

	const bias = s.topUpDiscoveryBiasPaise;
	// "In the bag" includes lines held back by an issue (e.g. over maxPerOrder),
	// so we never suggest one more of something the customer must already reduce.
	/** @type {Map<string, number>} */
	const qtyIn = new Map(lines.map((l) => [l.slug, l.qty]));
	for (const i of issues) if (typeof i.requestedQty === 'number') qtyIn.set(i.slug, i.requestedQty);
	const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
	const all = [...indexCatalog(catalog).values()];
	const idx = new Map(all.map((p, i) => [p, i]));
	const pool = all.filter((p) => {
		if (!isSlug(p.slug) || !isSellable(p) || exclude.has(p.slug)) return false;
		const next = (qtyIn.get(p.slug) ?? 0) + 1;
		return next <= availableUnits(p) && next <= maxPerOrderOf(p);
	});
	if (!pool.length) return null;

	/** @param {CatalogItem} p */
	const inCart = (p) => qtyIn.has(p.slug);
	/** @param {CatalogItem} p */
	const score = (p) => p.pricePaise - gap + (inCart(p) ? bias : 0);
	const order = (/** @type {CatalogItem} */ a, /** @type {CatalogItem} */ b) => /** @type {number} */ (idx.get(a)) - /** @type {number} */ (idx.get(b));

	const crossing = pool.filter((p) => p.pricePaise >= gap).sort((a, b) => score(a) - score(b) || a.pricePaise - b.pricePaise || order(a, b));
	const pick =
		crossing[0] ??
		pool.slice().sort((a, b) => Number(inCart(a)) - Number(inCart(b)) || b.pricePaise - a.pricePaise || order(a, b))[0];

	const crosses = pick.pricePaise >= gap;
	return {
		slug: pick.slug,
		name: typeof pick.name === 'string' && pick.name ? pick.name : pick.slug,
		pricePaise: pick.pricePaise,
		crosses,
		gapPaise: gap,
		remainingAfterPaise: crosses ? 0 : gap - pick.pricePaise,
		overshootPaise: crosses ? pick.pricePaise - gap : 0,
		inCart: inCart(pick)
	};
}

