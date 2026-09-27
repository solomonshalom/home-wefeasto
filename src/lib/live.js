/*
 * Live catalog overlay: current price, stock and COD flags from the CMS
 * (GET /api/store/catalog), laid over the build-time snapshot. Prerendered
 * pages always render snapshot values. A component calls loadLive() in onMount
 * and then reads the merged view: the `liveCatalog` store, or the synchronous
 * helpers below.
 *
 * Nothing here throws. Offline, a timeout (4 s), 4xx/5xx, malformed JSON or
 * SSR all leave the snapshot values in place. The server re-quotes every
 * order, so a stale overlay can never change what a customer is charged.
 * Contract: SCRATCH/contracts/live-catalog.md.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { api } from '$lib/api.js';
import { settings as snapshotSettings, catalogForPricing as snapshotCatalog } from '$lib/data/settings.js';

export const LIVE_ENDPOINT = '/store/catalog';
export const LIVE_TTL_MS = 15000; // = the endpoint's max-age
export const LIVE_TIMEOUT_MS = 4000;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepFreeze(value) {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		Object.values(value).forEach(deepFreeze);
	}
	return value;
}

/* ------------------------------------------------------------ snapshot */

// Catalog order, kept apart from bySlug so a numeric-looking slug can't reorder it.
const ORDER = snapshotCatalog().map((p) => p.slug);
const SNAPSHOT_ROWS = Object.fromEntries(snapshotCatalog().map((p) => [p.slug, { ...p, lowStock: null }]));

/**
 * @typedef {{ slug: string, name: string, pricePaise: number, inStock: boolean,
 *   lowStock: number | null, maxPerOrder: number, codAllowed: boolean }} LiveRow
 * @typedef {{ ready: boolean, source: 'live' | 'snapshot', settings: object,
 *   bySlug: Record<string, LiveRow>, fetchedAt: number | null, error: string | null }} LiveState
 */

/** @type {LiveState} */
const SNAPSHOT_STATE = deepFreeze({
	ready: false,
	source: 'snapshot',
	settings: snapshotSettings,
	bySlug: SNAPSHOT_ROWS,
	fetchedAt: null,
	error: null
});

/* ------------------------------------------------------------- merging */

/**
 * The live payload's usable part, or null when it isn't a catalog at all.
 * An empty product list counts as malformed: a CMS that sells nothing is far
 * more likely broken than sold out.
 */
function parseLive(data) {
	if (!isPlainObject(data) || !Array.isArray(data.products)) return null;
	const rows = new Map();
	for (const row of data.products) {
		if (isPlainObject(row) && typeof row.slug === 'string' && !rows.has(row.slug)) rows.set(row.slug, row);
	}
	return rows.size ? { rows, settings: data.settings } : null;
}

/**
 * Field by field: a live value wins only when it has the right type, so one
 * bad field can't blank a price. A snapshot product the live catalog doesn't
 * list is no longer sold (unpublished since the build): not in stock. Live
 * products the snapshot doesn't know are ignored (no page, image or copy yet).
 */
function mergeRow(base, live) {
	if (!live) return { ...base, inStock: false, lowStock: null };
	const inStock = typeof live.inStock === 'boolean' ? live.inStock : base.inStock;
	return {
		slug: base.slug,
		name: typeof live.name === 'string' && live.name.trim() ? live.name : base.name,
		pricePaise: Number.isInteger(live.pricePaise) && live.pricePaise >= 100 ? live.pricePaise : base.pricePaise,
		inStock,
		// Units left when the server flags the product as running low; null otherwise.
		lowStock: inStock && Number.isInteger(live.lowStock) && live.lowStock >= 1 ? live.lowStock : null,
		maxPerOrder: Number.isInteger(live.maxPerOrder) && live.maxPerOrder >= 1 ? live.maxPerOrder : base.maxPerOrder,
		codAllowed: typeof live.codAllowed === 'boolean' ? live.codAllowed : base.codAllowed
	};
}

/** Snapshot settings with live values of the same type laid over (unknown keys ignored). */
function mergeSettings(base, live) {
	if (!isPlainObject(live)) return base;
	const out = {};
	for (const [key, b] of Object.entries(base)) {
		const v = live[key];
		if (isPlainObject(b)) out[key] = mergeSettings(b, v);
		else if (Array.isArray(b)) out[key] = Array.isArray(v) ? v : b;
		else if (typeof b === 'number') out[key] = Number.isInteger(v) && v >= 0 ? v : b;
		else out[key] = typeof v === typeof b ? v : b;
	}
	return out;
}

function liveState(live, error) {
	if (!live) return { ...SNAPSHOT_STATE, ready: true, error };
	const bySlug = {};
	for (const slug of ORDER) bySlug[slug] = mergeRow(SNAPSHOT_ROWS[slug], live.rows.get(slug));
	return {
		ready: true,
		source: 'live',
		settings: mergeSettings(snapshotSettings, live.settings),
		bySlug,
		fetchedAt: live.fetchedAt,
		error
	};
}

/* --------------------------------------------------------------- store */

let state = SNAPSHOT_STATE;
const store = writable(state);

/** `{ ready, source: 'live'|'snapshot', settings, bySlug, fetchedAt, error }` — read-only, deep-frozen. */
export const liveCatalog = { subscribe: store.subscribe };

let inflight = null;
let settledAt = null; // when the last attempt (good or bad) finished
let lastGood = null; // last usable live payload; a failed refresh keeps it

async function refresh() {
	let error = null;
	try {
		const res = await api(LIVE_ENDPOINT, { timeoutMs: LIVE_TIMEOUT_MS });
		const parsed = res.ok ? parseLive(res.data) : null;
		if (parsed) lastGood = { ...parsed, fetchedAt: Date.now() };
		else error = res.ok ? 'BAD_RESPONSE' : res.error?.code || 'UNKNOWN';
	} catch (e) {
		error = 'UNKNOWN';
	}
	try {
		state = deepFreeze(liveState(lastGood, error));
	} catch (e) {
		lastGood = null;
		state = deepFreeze({ ...SNAPSHOT_STATE, ready: true, error: 'UNKNOWN' });
	}
	settledAt = Date.now();
	try {
		store.set(state);
	} catch (e) {
		// A subscriber threw; that's the subscriber's bug, not a reason to reject.
	}
	return state;
}

/**
 * Fetch the live catalog (browser only). Memoized for LIVE_TTL_MS after each
 * attempt, successful or not; concurrent callers share one request. Resolves
 * with the current state and never rejects. On the server it resolves with
 * the snapshot state straight away, without fetching.
 * @param {{ force?: boolean }} [opts]  force: skip the memo (an in-flight request is still shared)
 * @returns {Promise<LiveState>}
 */
export function loadLive(opts) {
	const force = !!opts?.force;
	if (!browser) return Promise.resolve(state);
	if (inflight) return inflight;
	if (!force && settledAt !== null && Date.now() - settledAt < LIVE_TTL_MS) return Promise.resolve(state);
	const request = refresh();
	inflight = request;
	const done = () => {
		if (inflight === request) inflight = null;
	};
	request.then(done, done);
	return request;
}

/* ----------------------------------------------------- synchronous reads */

const row = (slug) => (typeof slug === 'string' && hasOwn(state.bySlug, slug) ? state.bySlug[slug] : null);

/** True only for a known product currently sold and in stock. */
export function isInStock(slug) {
	return row(slug)?.inStock === true;
}

/** Units left when the server flags the product as low on stock, else null. */
export function lowStock(slug) {
	return row(slug)?.lowStock ?? null;
}

/** Current price in paise (live when loaded, else snapshot), or null for an unknown slug. */
export function pricePaise(slug) {
	return row(slug)?.pricePaise ?? null;
}

/** Current public settings (live values over the snapshot's). Deep-frozen. */
export function liveSettings() {
	return state.settings;
}

/** `[{slug, name, pricePaise, inStock, maxPerOrder, codAllowed}]` for $shared pricing, catalog order, fresh copies. */
export function catalogForPricing() {
	return ORDER.map((slug) => {
		const { name, pricePaise, inStock, maxPerOrder, codAllowed } = state.bySlug[slug];
		return { slug, name, pricePaise, inStock, maxPerOrder, codAllowed };
	});
}

/**
 * Snapshot-shaped products with the live commerce fields (pricePaise,
 * inStock, maxPerOrder, codAllowed) laid over, as fresh copies. Feed them to
 * $lib/data/derive.js to re-derive display strings, e.g.
 * `buildShopItems({ products: withLivePrices(products) })`.
 */
export function withLivePrices(products) {
	if (!Array.isArray(products)) return [];
	return products.map((p) => {
		const live = isPlainObject(p) ? row(p.slug) : null;
		if (!live) return isPlainObject(p) ? { ...p } : p;
		return { ...p, pricePaise: live.pricePaise, inStock: live.inStock, maxPerOrder: live.maxPerOrder, codAllowed: live.codAllowed };
	});
}

/* ------------------------------------------------ display (ready-gated) */

/**
 * The row for `slug` in a `$liveCatalog` state once a load has settled
 * (`ready`), else null. Display code reads through this so the prerendered
 * and hydrated markup keep the snapshot values until the browser has asked
 * the CMS: `readyRow($liveCatalog, slug)?.pricePaise ?? snapshotPrice`.
 * After a failed load the row holds the snapshot values (see `loadLive`).
 * @param {LiveState} s
 * @param {string} slug
 * @returns {LiveRow | null}
 */
export function readyRow(s, slug) {
	if (!isPlainObject(s) || s.ready !== true || !isPlainObject(s.bySlug) || typeof slug !== 'string') return null;
	return hasOwn(s.bySlug, slug) ? s.bySlug[slug] : null;
}

/**
 * Sold out per a settled state: a known product the CMS has none of, or no
 * longer lists. False before the first load settles and for unknown slugs
 * (the cart ignores those anyway).
 * @param {LiveState} s
 * @param {string} slug
 */
export function soldOutIn(s, slug) {
	return readyRow(s, slug)?.inStock === false;
}
