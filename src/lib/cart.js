/*
 * Wefeasto cart — Svelte port of the WefeastoCart runtime from js/wefeasto.js,
 * hardened for Phase 2 (roadmap F4, M8).
 * Same storage contract: localStorage 'wefeasto_cart' holding {slug: qty}.
 * A cart saved by the original static site carries straight over.
 *
 * - Read = sanitize: unknown slugs and garbage quantities are dropped (the
 *   strict $shared parseQty: '1e9', 2.5, '03', -3 and 'abc' all go), and each
 *   line is capped at the product's maxPerOrder (≤ 20). count(), total() and
 *   the derived stores all read the same sanitized map.
 * - Every write re-reads storage first, so a change made in another tab
 *   between our last read and this write is never lost; a 'storage' event
 *   from another tab updates this one live.
 * - When localStorage throws (blocked, private mode, quota) the cart lives in
 *   memory for the page session; nothing here ever throws.
 * - Cart.add / Cart.addMany dispatch window 'wf:cart-add' with
 *   detail {slug, qty, source} (qty = units actually added). The layout's
 *   badge pop ignores the detail; CartToast reads it.
 *
 * Also here: link offers and the link source (roadmap F4), plus the small
 * storage helpers the bag's neighbours share. The last order ("Your usual")
 * lives in YourUsual.svelte's module script and dismissed top-ups in
 * TopUp.svelte's, so they ship only where they are used.
 * Contract: SCRATCH/contracts/cart.md.
 *
 * Weight: Nav imports this on every page, so it only pulls the snapshot's
 * product list (already in every page's bundle) and $shared/qty.js. Caps
 * and cartTotal use build-time values; live prices/stock and the full
 * pricing rules come from $lib/live.js + $shared/pricing.js on the pages
 * that quote (bag, toast). The offer/source helpers load their $shared
 * validators on demand, so they are async.
 */
import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';
import { productBySlug } from '$lib/data/products.js';
import { products as snapshotProducts } from '$lib/data/cms-snapshot.json';
import { track } from '$lib/track.js';
import { parseQty, clampQty, CART_QTY_CAP, DEFAULT_MAX_PER_ORDER, LINK_QTY_MAX, QTY_PARSE_MAX } from '$shared/qty.js';

export const CART_KEY = 'wefeasto_cart';
export const CART_ADD_EVENT = 'wf:cart-add';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------------------------------------ pure core */

/** Per-SKU cap in the bag: the product's maxPerOrder, never above 20 (F4). */
function capOf(item) {
	const own = item && item.maxPerOrder;
	const max = Number.isSafeInteger(own) && own >= 1 ? own : DEFAULT_MAX_PER_ORDER;
	return Math.min(max, CART_QTY_CAP);
}

/** Map<slug, cap> for a pricing catalog ([{slug, maxPerOrder}] or a Map). */
export function capIndex(catalog) {
	const out = new Map();
	const rows = catalog instanceof Map ? [...catalog.values()] : Array.isArray(catalog) ? catalog : [];
	for (const row of rows) {
		if (row && typeof row.slug === 'string' && !out.has(row.slug)) out.set(row.slug, capOf(row));
	}
	return out;
}

/**
 * The stored cart made safe to use: known slugs only, quantities accepted by
 * the strict parseQty (a positive integer, or a string of plain digits), each
 * capped at the product's maxPerOrder. Key order is kept.
 *   {cornflakes: 2, ghost: 5, muesli: 'abc', oats: -3} → {cornflakes: 2}
 * @param {unknown} raw
 * @param {Array<{slug: string, maxPerOrder?: number}> | Map<string, any>} catalog
 * @returns {Record<string, number>}
 */
export function sanitizeCart(raw, catalog) {
	const out = {};
	if (!isPlainObject(raw)) return out;
	const caps = catalog instanceof Map && [...catalog.values()].every((v) => typeof v === 'number') ? catalog : capIndex(catalog);
	for (const slug of Object.keys(raw)) {
		const cap = caps.get(slug);
		if (!cap) continue;
		const qty = parseQty(raw[slug]);
		if (qty === null) continue;
		out[slug] = Math.min(qty, cap);
	}
	return out;
}

/** Sum of quantities. */
export function countOf(c) {
	let n = 0;
	for (const k in c) if (hasOwn(c, k)) n += c[k];
	return n;
}

/** Garbage-tolerant {slug: qty} merge of lines given as [{slug, qty}] or a map. */
function linePairs(lines) {
	if (Array.isArray(lines)) return lines.map((l) => [l && l.slug, l && l.qty]);
	if (isPlainObject(lines)) return Object.entries(lines);
	return [];
}

/** 'pdp' | 'card' | 'recipe' | 'topup' | 'usual' | 'link' | … — or null. */
function cleanSource(source) {
	return typeof source === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(source) ? source : null;
}

/**
 * A cart bound to a storage + event target. The module exports one bound to
 * window.localStorage / window; tests build their own.
 * @param {{ getStorage: () => Storage | null, events: EventTarget | null, catalog: () => any[] }} env
 */
export function createCart({ getStorage, events, catalog }) {
	let memoryOnly = false; // storage write failed once: the session copy is the truth
	let current = {};

	/** Raw stored object, {} when empty/corrupt, or null when storage is unavailable. */
	function readStored() {
		if (memoryOnly) return null;
		let raw;
		try {
			const storage = getStorage();
			if (!storage) return null;
			raw = storage.getItem(CART_KEY);
		} catch (e) {
			return null;
		}
		if (!raw) return {};
		try {
			const obj = JSON.parse(raw);
			return isPlainObject(obj) ? obj : {};
		} catch (e) {
			return {};
		}
	}

	function readSanitized(caps) {
		const stored = readStored();
		return stored === null ? { ...current } : sanitizeCart(stored, caps);
	}

	function persist(next) {
		if (memoryOnly) return;
		try {
			const storage = getStorage();
			if (!storage) {
				memoryOnly = true;
				return;
			}
			storage.setItem(CART_KEY, JSON.stringify(next));
		} catch (e) {
			memoryOnly = true; // private mode / quota: keep going in memory
		}
	}

	current = readSanitized(capIndex(catalog()));
	const store = writable(current);

	function commit(next) {
		persist(next);
		current = next;
		store.set(next);
		return next;
	}

	/**
	 * Read-modify-write against the freshest stored copy (no lost updates
	 * across tabs). fn returns {next}; next === null means "no change": nothing
	 * is written, but the in-memory copy still catches up with storage.
	 */
	function mutate(fn) {
		const caps = capIndex(catalog());
		const base = readSanitized(caps);
		const result = fn({ ...base }, caps);
		if (result.next === null) {
			if (JSON.stringify(base) !== JSON.stringify(current)) {
				current = base;
				store.set(base);
			}
			return { next: base };
		}
		commit(result.next);
		return result;
	}

	function emit(detail) {
		if (!events) return;
		try {
			events.dispatchEvent(new CustomEvent(CART_ADD_EVENT, { detail }));
		} catch (e) {
			/* a listener threw — not the cart's problem */
		}
		track('add_to_cart', { slug: detail.slug, qty: detail.qty, source: detail.source });
	}

	/** Re-read storage (another tab wrote, bfcache restore). */
	function refresh() {
		const stored = readStored();
		if (stored === null) return current;
		const next = sanitizeCart(stored, capIndex(catalog()));
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			current = next;
			store.set(next);
		}
		return current;
	}

	const Cart = {
		read: () => ({ ...current }),

		/**
		 * Add `qty` (default 1) of a product, capped at its maxPerOrder.
		 * Unknown slugs are ignored. Returns the new quantity in the bag.
		 * Fires wf:cart-add {slug, qty: units added, source, requested, inBag, capped}
		 * whenever something was added or the cap stopped it.
		 */
		add(slug, qty = 1, { source = null } = {}) {
			const requested = clampQty(qty, QTY_PARSE_MAX) || 1;
			let detail = null;
			const { next } = mutate((c, caps) => {
				const cap = typeof slug === 'string' ? caps.get(slug) : undefined;
				if (!cap) return { next: null };
				const have = c[slug] || 0;
				const inBag = Math.min(have + requested, cap);
				c[slug] = inBag;
				detail = { slug, qty: inBag - have, source: cleanSource(source), requested, inBag, capped: have + requested > cap };
				return { next: c };
			});
			if (detail && (detail.qty > 0 || detail.capped)) emit(detail);
			return typeof slug === 'string' && hasOwn(next, slug) ? next[slug] : 0;
		},

		/**
		 * Add several lines in ONE write with ONE wf:cart-add event (roadmap F4).
		 * Lines: [{slug, qty}] or {slug: qty}; duplicates are summed, each line is
		 * clamped to 1–10, unknown slugs and garbage quantities are skipped, and
		 * each SKU stays within its maxPerOrder.
		 * @returns {{ added: {slug: string, qty: number}[], skipped: {slug: string, reason: 'UNKNOWN'|'BAD_QTY'|'AT_LIMIT'}[] }}
		 */
		addMany(lines, { source = null } = {}) {
			const wanted = new Map();
			const bad = new Set();
			for (const [slug, qty] of linePairs(lines)) {
				if (typeof slug !== 'string' || !slug) continue;
				const q = clampQty(qty, QTY_PARSE_MAX);
				if (q) wanted.set(slug, (wanted.get(slug) || 0) + q);
				else bad.add(slug);
			}
			// A garbage token never poisons a good one for the same slug.
			const skipped = [...bad].filter((slug) => !wanted.has(slug)).map((slug) => ({ slug, reason: 'BAD_QTY' }));
			const added = [];
			mutate((c, caps) => {
				for (const [slug, sum] of wanted) {
					const cap = caps.get(slug);
					if (!cap) {
						skipped.push({ slug, reason: 'UNKNOWN' });
						continue;
					}
					const have = c[slug] || 0;
					const inBag = Math.min(have + Math.min(sum, LINK_QTY_MAX), cap);
					if (inBag > have) {
						c[slug] = inBag;
						added.push({ slug, qty: inBag - have });
					} else {
						skipped.push({ slug, reason: 'AT_LIMIT' });
					}
				}
				return { next: added.length ? c : null };
			});
			const total = added.reduce((a, l) => a + l.qty, 0);
			if (total > 0) emit({ slug: added[0].slug, qty: total, source: cleanSource(source), lines: added });
			return { added, skipped };
		},

		/** Set a quantity (≤ 0 or garbage removes the line; capped at maxPerOrder). */
		setQty(slug, qty) {
			mutate((c, caps) => {
				const cap = typeof slug === 'string' ? caps.get(slug) : undefined;
				const n = cap ? clampQty(qty, cap) : 0;
				if (n > 0) c[slug] = n;
				else if (typeof slug === 'string') delete c[slug];
				return { next: c };
			});
		},

		/** Put a removed line back at its old position (the cart's undo). */
		restore(slug, qty, index = Infinity) {
			mutate((c, caps) => {
				const cap = typeof slug === 'string' ? caps.get(slug) : undefined;
				const n = cap ? clampQty(qty, cap) : 0;
				if (!n) return { next: null };
				const entries = Object.entries(c).filter(([k]) => k !== slug);
				const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : entries.length, entries.length));
				entries.splice(at, 0, [slug, n]);
				return { next: Object.fromEntries(entries) };
			});
		},

		remove(slug) {
			mutate((c) => {
				if (typeof slug === 'string') delete c[slug];
				return { next: c };
			});
		},

		/**
		 * After a confirmed order: take away exactly what was ordered, keeping
		 * anything added since (another tab, a later visit). Lines: [{slug, qty}]
		 * or {slug: qty}. One write, no event.
		 */
		subtractLines(lines) {
			const minus = new Map();
			for (const [slug, qty] of linePairs(lines)) {
				const q = clampQty(qty, QTY_PARSE_MAX);
				if (typeof slug === 'string' && q) minus.set(slug, (minus.get(slug) || 0) + q);
			}
			const { next } = mutate((c) => {
				for (const [slug, q] of minus) {
					if (!hasOwn(c, slug)) continue;
					const left = c[slug] - q;
					if (left > 0) c[slug] = left;
					else delete c[slug];
				}
				return { next: c };
			});
			return { ...next };
		},

		clear() {
			mutate(() => ({ next: {} }));
		},

		count: () => countOf(current),
		total: () => totalRupees(current),
		items: () => itemsOf(current),
		/** Re-read storage now (used on bfcache restore; 'storage' events do it automatically). */
		refresh
	};

	return { cart: { subscribe: store.subscribe }, Cart, refresh, isMemoryOnly: () => memoryOnly };
}

/* --------------------------------------------------- derived read models */

/** Bag total in rupees at build-time prices (the legacy contract; quote() has the live, honest total). */
function totalRupees(c) {
	let sum = 0;
	for (const k in c) {
		if (!hasOwn(c, k)) continue;
		const p = productBySlug(k);
		if (p) sum += c[k] * p.price;
	}
	return sum;
}

function itemsOf(c) {
	return Object.keys(c).map((k) => ({ slug: k, qty: c[k], product: productBySlug(k) }));
}

/* ------------------------------------------------------ the page's cart */

function browserStorage() {
	return browser ? window.localStorage : null; // the getter itself may throw: callers catch
}

/** Known products and their caps: the build snapshot (maxPerOrder rarely changes; quote() flags QTY_LIMIT). */
const SNAPSHOT_CATALOG = () => snapshotProducts;

const core = createCart({
	getStorage: browserStorage,
	events: browser ? window : null,
	catalog: SNAPSHOT_CATALOG
});

/** Sanitized {slug: qty} store. */
export const cart = core.cart;
export const Cart = core.Cart;

if (browser) {
	try {
		window.addEventListener('storage', (e) => {
			if (e.key === CART_KEY || e.key === null) core.refresh();
		});
		window.addEventListener('pageshow', (e) => {
			if (e.persisted) core.refresh();
		});
	} catch (e) {
		/* noop */
	}
}

export const cartCount = derived(cart, countOf);
/** Bag total in rupees at build-time prices (existing contract). */
export const cartTotal = derived(cart, totalRupees);
export const cartItems = derived(cart, itemsOf);

// Console/debug parity with the original runtime.
if (browser) window.WefeastoCart = Cart;

/* ============================================ neighbouring client state */
/* Every access is wrapped: storage may throw, and then these features hide
   (Your usual) or live for this page session only (offer chip). */

/** JSON from localStorage: the value, null when absent, undefined when unavailable or corrupt. */
export function lsGet(key) {
	try {
		const raw = window.localStorage.getItem(key);
		return raw === null ? null : JSON.parse(raw);
	} catch (e) {
		return undefined; // unavailable or corrupt
	}
}

/** JSON into localStorage; false when storage is unavailable. */
export function lsSet(key, value) {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (e) {
		return false;
	}
}

function lsRemove(key) {
	try {
		window.localStorage.removeItem(key);
	} catch (e) {
		/* noop */
	}
}

export const DAY = 86400000;

/* ---- link offers: /cart?offer=CODE (S6). The server validates at checkout. ---- */
/* The validators live in $shared and are loaded on demand (see "Weight" above). */

export const OFFER_KEY = 'wefeasto_offer';
export const OFFER_MAX_AGE_DAYS = 30;
let offerMemory = null; // the session copy when storage is unavailable

const couponCode = async (raw) => (await import('$shared/coupons.js')).normalizeCouponCode(raw);
const srcParam = async (raw) => (await import('$shared/cart-links.js')).parseSrcParam(raw);

/** Promise of {code, at} or null (expired after 30 days, malformed, or removed). */
export async function readOffer(now = Date.now()) {
	// Storage unavailable (undefined) or a write that failed (null): the session copy.
	const o = lsGet(OFFER_KEY) ?? offerMemory;
	if (!isPlainObject(o)) return null;
	const code = await couponCode(o.code);
	if (!code || typeof o.at !== 'number' || now - o.at > OFFER_MAX_AGE_DAYS * DAY || o.at > now + DAY) return null;
	return { code, at: o.at };
}

/** Store a link offer; resolves to the normalized {code, at}, or null for a malformed code. */
export async function saveOffer(raw, now = Date.now()) {
	const code = await couponCode(raw);
	if (!code) return null;
	const offer = { code, at: now };
	offerMemory = offer;
	lsSet(OFFER_KEY, offer);
	return offer;
}

export function clearOffer() {
	offerMemory = null;
	lsRemove(OFFER_KEY);
}

/* ---- link attribution: &src= on /cart?add= (M5), per tab ---- */

export const SOURCE_KEY = 'wefeasto_src';

/** Remember a valid src (web|usual|link|email|refill|offer) for this tab's checkout; resolves to it or null. */
export async function rememberSource(raw, now = Date.now()) {
	const src = await srcParam(raw);
	if (!src) return null;
	try {
		window.sessionStorage.setItem(SOURCE_KEY, JSON.stringify({ src, at: now }));
	} catch (e) {
		/* attribution is best-effort */
	}
	return src;
}

/** Promise of the remembered src for this tab (checkout reads it for orders.source), or null. */
export async function readSource() {
	let o = null;
	try {
		o = JSON.parse(window.sessionStorage.getItem(SOURCE_KEY) || 'null');
	} catch (e) {
		return null;
	}
	return isPlainObject(o) ? srcParam(o.src) : null;
}
