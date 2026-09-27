/*
 * "Is Cash on Delivery available for this bag?" — asked before the pending
 * banner (/cart) and /order's failed view offer "Pay on delivery instead"
 * (canSwitchToCod in order.js decides whether the switch is safe; this
 * decides whether the COD checkout it leads to could go through at all).
 *
 * The answer is the server quote's (POST /api/store/quote with method 'cod':
 * live settings, catalog and COD rules, plus the PIN when this tab knows it).
 * When /api can't answer, the caller's local $shared quote over the live
 * catalog stands in — the same fallback /checkout uses. Stock problems are
 * not COD's to judge (the pending order itself may hold the last packs until
 * the COD order supersedes it), so only the COD answer is read, through
 * quoteView (which doesn't blame COD for an all-sold-out quote's EMPTY).
 * Server-only refusals (e.g. too many open COD orders for the phone) still
 * surface on /checkout as usual.
 */
import { quoteBody, isQuote, quoteView } from './quote.js';

export const COD_CHECK_TIMEOUT_MS = 8000;

/**
 * @param {{ items: {slug: string, qty: number}[], pin?: string | null, couponCode?: string | null }} ask
 * @param {{ api: Function, localQuote?: () => any }} deps  localQuote: the $shared quote for the same bag with method 'cod' (may be async)
 * @returns {Promise<boolean>}
 */
export async function codAvailableFor({ items, pin = null, couponCode = null }, { api, localQuote = () => null }) {
	if (!Array.isArray(items) || items.length === 0) return false;
	const body = quoteBody({ items, pin: /^\d{6}$/.test(pin ?? '') ? pin : null, couponCode, method: 'cod' });
	let res = null;
	try {
		res = await api('/store/quote', { method: 'POST', body, timeoutMs: COD_CHECK_TIMEOUT_MS });
	} catch (e) {
		res = null; // api() never throws; a stub might
	}
	const server = res && res.ok ? (res.data && typeof res.data === 'object' && 'quote' in res.data ? res.data.quote : res.data) : null;
	if (isQuote(server)) return quoteView(server).codAvailable;
	try {
		const local = await localQuote();
		return isQuote(local) ? quoteView(local).codAvailable : false;
	} catch (e) {
		return false;
	}
}

/**
 * One answer per ask: a page re-renders often, the question only changes
 * with the bag / PIN / offer. `check(key, ask)` starts (or reuses) the look
 * for `key` and calls `onAnswer(key, available)` once it lands; answers for
 * an older key are dropped by the caller comparing keys.
 * @param {{ api: Function, localQuote?: (items: any[]) => any }} deps
 */
export function createCodCheck({ api, localQuote = () => null }) {
	const cache = new Map();
	return {
		/** @returns {Promise<boolean>} */
		check(key, ask) {
			if (!cache.has(key)) {
				const p = codAvailableFor(ask, { api, localQuote: () => localQuote(ask.items, ask.pin ?? null) });
				cache.set(key, p);
				if (cache.size > 20) cache.delete(cache.keys().next().value);
			}
			return /** @type {Promise<boolean>} */ (cache.get(key));
		}
	};
}
