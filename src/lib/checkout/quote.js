/*
 * The server quote behind the checkout summary: POST /api/store/quote,
 * debounced, one request at a time (a newer ask aborts the older one, and a
 * late answer for an old ask is dropped). The page shows this quote once it
 * matches what it asked; until then (or when /api can't answer) it shows the
 * $shared quote over the live catalog, and PRICE_CHANGED at checkout catches
 * any difference.
 */
import { writable, get } from 'svelte/store';
import { formatPaise } from '$shared/money.js';
import { stableStringify, supersedeRef } from './request.js';

export { supersedeRef };

export const QUOTE_DEBOUNCE_MS = 250;

/**
 * POST /api/store/quote body (SPEC §6). Optional fields are left out when
 * empty; `email` and `pin` only when already valid (the caller checks).
 * `supersede` ({number, token}, PI-SF-1): the unpaid online order a checkout
 * of this exact bag would supersede (the caller checks the bag). The server
 * then counts the stock and the offer use that order holds as this bag's
 * own, so its last packs don't read as sold out for their replacement. It
 * is part of the quote key: a changed bag re-quotes without it.
 */
export function quoteBody({ items, couponCode = null, email = null, pin = null, method = null, supersede = null }) {
	const body = { items: (items || []).map(({ slug, qty }) => ({ slug, qty })) };
	if (couponCode) body.couponCode = couponCode;
	if (email) body.email = email;
	if (pin) body.pin = pin;
	if (method) body.method = method;
	const ref = supersedeRef(supersede);
	if (ref) body.supersede = ref;
	return body;
}

/**
 * The order to name in `supersede`: wefeasto_pending (readPending's shape)
 * when it was placed for exactly this bag; else, with storage unavailable,
 * the online order this page's flow placed for this bag. Null otherwise.
 * @param {{no: string, t: string, cartSig: string} | null} pending
 * @param {string} bagSig  cartSignature of the bag being quoted
 * @param {{order?: {number: string, token: string} | null, method?: string | null, cartSig?: string} | null} [placed]
 */
export function supersedeFor(pending, bagSig, placed = null) {
	if (!bagSig) return null;
	if (pending) return pending.cartSig && pending.cartSig === bagSig ? supersedeRef({ number: pending.no, token: pending.t }) : null;
	const o = placed?.order;
	if (o && placed.method && placed.method !== 'cod' && placed.cartSig === bagSig) return supersedeRef(o);
	return null;
}

export const quoteKey = (body) => stableStringify(body);

/** A quote as the endpoint returns it (the $shared Quote shape). */
export function isQuote(q) {
	return !!q && typeof q === 'object' && Number.isSafeInteger(q.totalPaise) && Array.isArray(q.lines) && Array.isArray(q.issues);
}

/**
 * How the checkout reads a quote for a non-empty bag:
 * - `bagBlocked`: a line (sold out, over the limit…) or the order needs a fix
 *   before paying — Pay is disabled and its label carries no amount;
 * - `allBlocked`: EVERY line has an issue (the sold-out race: the last pack
 *   went while you were typing). The quote then has no lines, so its money
 *   rows are ₹0 and its COD answer is EMPTY — neither is true of the bag, so
 *   the summary hides them and COD isn't blamed ("Add something to your bag
 *   first."): the line itself says what to do;
 * - `codAvailable`: the quote's COD answer, minus that EMPTY.
 * @param {any} q  $shared Quote
 */
export function quoteView(q) {
	const issues = Array.isArray(q?.issues) && q.issues.length > 0;
	const allBlocked = issues && !(Array.isArray(q?.lines) && q.lines.length > 0);
	const bagBlocked = issues || (!!q?.orderError && q.orderError.code !== 'EMPTY_CART');
	const codAvailable = q?.codAvailable !== false || (allBlocked && q.codUnavailableReason === 'EMPTY');
	return { allBlocked, bagBlocked, codAvailable };
}

/**
 * The Pay button's words. The amount shows only when it is what would be
 * charged: while the bag is blocked, not read yet (the prerendered page,
 * before hydration) or empty it's "Pay securely" — never "Pay ₹0".
 * @param {'upi'|'card'|'cod'} method
 * @param {number} totalPaise
 * @param {boolean} [blocked]
 */
export function payLabel(method, totalPaise, blocked = false) {
	const amount = !blocked && Number.isSafeInteger(totalPaise) && totalPaise > 0 ? formatPaise(totalPaise) : null;
	if (method === 'cod') return amount ? `Place order · Pay ${amount} on delivery` : 'Place order · Pay on delivery';
	return amount ? `Pay ${amount} securely` : 'Pay securely';
}

/**
 * @param {{ api: Function, delayMs?: number, timers?: {setTimeout: Function, clearTimeout: Function} }} deps
 */
export function createQuoter({ api, delayMs = QUOTE_DEBOUNCE_MS, timers = globalThis }) {
	/**
	 * status: idle | loading | ok | error. `quote` is the latest good answer and
	 * `key`/`body` the ask it answers; while a newer ask loads they stay (a page
	 * may keep showing them, dimmed, for the same bag).
	 */
	const state = writable({ status: 'idle', quote: null, key: null, body: null, error: null });
	let timer = null;
	let controller = null;
	let seq = 0;
	let wantKey = null;
	let wantBody = null;
	let inflight = null;

	function fire() {
		timer = null;
		controller?.abort();
		controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const my = ++seq;
		const key = wantKey;
		const body = wantBody;
		const p = api('/store/quote', { method: 'POST', body, signal: controller?.signal, timeoutMs: 8000 }).then((res) => {
			if (my !== seq) return; // superseded by a newer ask
			inflight = null;
			if (res.ok && res.data && isQuote(res.data.quote)) state.set({ status: 'ok', quote: res.data.quote, key, body, error: null });
			else state.set({ status: 'error', quote: null, key, body, error: res.error?.code || 'BAD_RESPONSE' });
		});
		inflight = p;
		return p;
	}

	/** Ask for a quote of `body` (no-op when it is already the latest ask). */
	function request(body) {
		const key = quoteKey(body);
		if (key === wantKey) return;
		wantKey = key;
		wantBody = body;
		if (timer) timers.clearTimeout(timer);
		state.update((s) => ({ ...s, status: 'loading' }));
		timer = timers.setTimeout(fire, delayMs);
	}

	/** Send a debounced ask now and wait for the answer to the latest ask. */
	async function flush() {
		if (timer) {
			timers.clearTimeout(timer);
			await fire();
		}
		while (inflight) await inflight;
		return get(state);
	}

	/** Forget the latest ask so the same body is fetched again (stock may have moved). */
	function invalidate() {
		wantKey = null;
	}

	/** Use a quote the server sent some other way (PRICE_CHANGED details.quote) for `body`. */
	function setQuote(quote, body) {
		if (!isQuote(quote)) return;
		if (timer) timers.clearTimeout(timer);
		timer = null;
		seq++;
		controller?.abort();
		inflight = null;
		wantKey = quoteKey(body);
		wantBody = body;
		state.set({ status: 'ok', quote, key: wantKey, body, error: null });
	}

	function destroy() {
		if (timer) timers.clearTimeout(timer);
		controller?.abort();
		seq++;
	}

	return { state: { subscribe: state.subscribe }, request, flush, invalidate, setQuote, destroy };
}
