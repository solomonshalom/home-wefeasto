/*
 * Quantity parsing. Two deliberately different readers:
 *  - parseQty: STRICT, for request bodies. Anything that isn't obviously a
 *    positive whole number is rejected (the old parseInt read '2.9' as 2).
 *  - clampQty: LENIENT, for data we already own (localStorage cart, deep
 *    links): garbage becomes 0 ("drop the line"), big values are capped.
 */

/** parseQty never returns more than this (keeps price × qty a safe integer). */
export const QTY_PARSE_MAX = 9999;
/** Per-SKU cap per order when the catalog item has no maxPerOrder. */
export const DEFAULT_MAX_PER_ORDER = 10;
/** Cap for a single SKU in the stored cart (roadmap F4). */
export const CART_QTY_CAP = 20;
/** Deep-link (/cart?add=) per-line cap and line limit (roadmap M5). */
export const LINK_QTY_MAX = 10;
export const LINK_MAX_LINES = 6;

/**
 * Strict quantity parser: a positive safe integer ≤ QTY_PARSE_MAX, given as a
 * number or as a string of plain ASCII digits without a leading zero.
 * Rejects 0, negatives, 2.5, '2.5', '1e3', '0x10', ' 3', '03', '', true,
 * [], {}, null, NaN, Infinity, 2**53 and '99999' → null.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseQty(raw) {
	if (typeof raw === 'number') {
		return Number.isSafeInteger(raw) && raw > 0 && raw <= QTY_PARSE_MAX ? raw : null;
	}
	if (typeof raw === 'string' && /^[1-9][0-9]{0,3}$/.test(raw)) return Number(raw);
	return null;
}

/**
 * Lenient clamp to [1, max]: returns 0 for anything that isn't a number ≥ 1
 * (NaN, negatives, 0.5, 'abc', '0x10', objects), otherwise
 * min(floor(value), max). Numeric strings in plain or exponent form are read
 * ('2', '2.7', '1e9'); Infinity → max.
 * @param {unknown} q
 * @param {number} [max=DEFAULT_MAX_PER_ORDER] positive integer cap
 * @returns {number}
 */
export function clampQty(q, max = DEFAULT_MAX_PER_ORDER) {
	const cap = Number.isSafeInteger(max) && max >= 1 ? max : DEFAULT_MAX_PER_ORDER;
	let n;
	if (typeof q === 'number') n = q;
	else if (typeof q === 'string' && /^\s*[0-9]+(\.[0-9]+)?(e\+?[0-9]+)?\s*$/i.test(q)) n = Number(q);
	else return 0;
	if (!(n >= 1)) return 0; // NaN, negatives, fractions below one
	return Math.min(Math.floor(n), cap);
}
