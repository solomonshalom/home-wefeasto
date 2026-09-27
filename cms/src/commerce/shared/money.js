/*
 * Money helpers. Every amount in the shared module is an integer number of
 * paise (₹1 = 100 paise); rupees only appear at the display edge.
 */

/** Razorpay refuses orders below ₹1.00. A non-empty cart never totals less. */
export const MIN_ORDER_PAISE = 100;

/**
 * True for a safe, non-negative integer amount of paise.
 * @param {unknown} v
 * @returns {v is number}
 */
export function isPaise(v) {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Rupees → integer paise, rounded to the nearest paisa.
 * Accepts a finite non-negative number or a plain decimal string ('175',
 * '175.5', '175.50'). Anything else (negative, NaN, '1e3', '₹175') → null.
 * @param {unknown} rupees
 * @returns {number | null}
 */
export function rupeesToPaise(rupees) {
	let n;
	if (typeof rupees === 'number') n = rupees;
	else if (typeof rupees === 'string' && /^[0-9]+(\.[0-9]{1,2})?$/.test(rupees)) n = Number(rupees);
	else return null;
	if (!Number.isFinite(n) || n < 0) return null;
	const p = Math.round(n * 100);
	return Number.isSafeInteger(p) ? p : null;
}

/**
 * Paise → rupees as a number (12550 → 125.5). Display/adapter use only.
 * @param {number} p
 * @returns {number}
 */
export function paiseToRupees(p) {
	return (Number(p) || 0) / 100;
}

/**
 * Format paise exactly like the storefront's formatINR(p / 100): whole rupees
 * (rounded), Indian digit grouping, '₹' prefix — 125000 → '₹1,250',
 * 12345678900 → '₹12,34,56,789'. Non-finite input → '₹0'.
 * Implemented without Intl so server and browser output never drift.
 * @param {number} p
 * @returns {string}
 */
export function formatPaise(p) {
	const n = Number(p) / 100;
	if (!Number.isFinite(n)) return '₹0';
	const r = Math.round(n) || 0; // -0 → 0
	return '₹' + (r < 0 ? '-' : '') + groupIN(String(Math.abs(r)));
}

/**
 * Like formatPaise, but keeps paise when there are any: 1750 → '₹17.50',
 * 1700 → '₹17'. For admin views and emails where rounding would mislead.
 * @param {number} p
 * @returns {string}
 */
export function formatPaiseExact(p) {
	const v = Math.round(Number(p));
	if (!Number.isFinite(v)) return '₹0';
	const abs = Math.abs(v);
	const rupees = Math.floor(abs / 100);
	const rest = abs % 100;
	return '₹' + (v < 0 ? '-' : '') + groupIN(String(rupees)) + (rest ? '.' + String(rest).padStart(2, '0') : '');
}

/**
 * '12345678' → '1,23,45,678' (last three digits, then pairs).
 * @param {string} digits
 * @returns {string}
 */
function groupIN(digits) {
	if (digits.length <= 3) return digits;
	const head = digits.slice(0, -3);
	const tail = digits.slice(-3);
	return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
}
