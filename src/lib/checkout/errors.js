/*
 * Error code → what the checkout / order UI does about it. One table, so every
 * code a checkout, retry or verify call can return (SPEC §6, $shared CODES,
 * plus $lib/api.js's transport codes) has human copy and an action.
 * Copy comes from $shared/errors.js, the same text the server sends.
 */
import { checkoutErrorCopy, couponReasonCopy, codReasonCopy } from '$shared/errors.js';
import { fieldMessages } from './request.js';

const NETWORK_COPY = {
	NETWORK: 'We couldn’t reach Wefeasto — check your connection and try again.',
	TIMEOUT: 'That took too long — please try again.',
	ABORTED: 'That took too long — please try again.'
};

/** After a failure that rules money out (cancelled, declined, a plain dismiss). */
export const NO_MONEY_TAKEN = 'Payment didn’t go through — no money was taken.';
/**
 * After one that doesn't: a timeout, a technical error, or no reason at all.
 * True either way (checkout-backend.md §3): late money on this order confirms
 * it, and money on an order that can't take it (superseded by a COD order,
 * cancelled, a second payment, sold out after expiry) is refunded by itself.
 */
export const MONEY_UNSURE = 'Payment didn’t go through. If any money left your account, we’ll confirm your order or refund it automatically.';

/**
 * Razorpay reasons after which the bank can still authorise the payment
 * later (UPI collect / session timeouts): $shared files them under
 * 'cancelled', but "no money was taken" isn't certain for them.
 */
const LATE_REASONS = new Set(['payment_timed_out', 'request_timed_out', 'payment_session_expired', 'payment_collect_request_expired']);

/** @param {unknown} reason  Razorpay error.reason */
export function mayAuthoriseLate(reason) {
	return typeof reason === 'string' && LATE_REASONS.has(reason.trim().toLowerCase());
}

const OFFLINE_CHECKOUT = 'Checkout isn’t available right now — please try again in a few minutes, or message us on WhatsApp.';
const GENERIC = 'Something went wrong on our side. Please try again.';

/**
 * @typedef {'fields'|'price'|'lines'|'cod'|'coupon'|'payments'|'rate'|'key'|'order'|'dead'|'empty'|'limit'|'network'|'generic'} ErrorKind
 * @typedef {{
 *   code: string, kind: ErrorKind, message: string,
 *   fields?: Record<string, string>, issues?: any[], quote?: any, reason?: string,
 *   actions: string[]
 * }} UiError
 *
 * actions:
 *   focus-field   mark fields (aria-invalid) and focus the first one
 *   use-quote     show details.quote (the new total) and ask for another tap
 *   refresh-quote re-quote the bag (issues then show inline with remove / reduce)
 *   disable-cod   COD pill off with the reason; switch to online
 *   remove-offer  offer a "Remove offer" button (clearOffer + re-quote)
 *   offer-cod     offer "Pay on delivery instead"
 *   new-key       forget the Idempotency-Key: the next tap is a new attempt
 *   goto-order    go to /order?no=&t= (it polls the real status)
 */

/**
 * @param {string} code
 * @param {any} [details]
 * @param {{stage?: 'checkout'|'retry'|'verify', status?: number}} [ctx]
 * @returns {UiError}
 */
export function describeError(code, details, ctx = {}) {
	const d = details && typeof details === 'object' ? details : {};
	const stage = ctx.stage || 'checkout';
	const copy = (c = code, dd = d) => checkoutErrorCopy(c, dd);
	switch (code) {
		case 'VALIDATION': {
			const fields = fieldMessages(d.fields || d.errors);
			return { code, kind: 'fields', message: copy(), fields, actions: Object.keys(fields).length ? ['focus-field'] : [] };
		}
		case 'PIN_UNSERVICEABLE':
			return { code, kind: 'fields', message: copy(), fields: { pin: copy() }, actions: ['focus-field'] };
		case 'PRICE_CHANGED':
			return { code, kind: 'price', message: copy(), quote: d.quote || null, actions: d.quote ? ['use-quote'] : ['refresh-quote'] };
		case 'OUT_OF_STOCK':
		case 'UNAVAILABLE':
		case 'QTY_LIMIT':
		case 'BAD_QTY':
		case 'BAD_SLUG': {
			if (code === 'UNAVAILABLE' && ctx.status === 503) return describeError('PAYMENTS_UNAVAILABLE', d, ctx);
			const issues = Array.isArray(d.issues) ? d.issues : d.slug ? [d] : [];
			const first = issues[0] || d;
			return { code, kind: 'lines', message: copy(first.code || code, first), issues, actions: ['refresh-quote'] };
		}
		case 'COD_UNAVAILABLE':
			return {
				code,
				kind: 'cod',
				message: d.reason ? codReasonCopy(d.reason, d) : copy(),
				reason: typeof d.reason === 'string' ? d.reason : 'DISABLED',
				actions: ['disable-cod']
			};
		case 'COUPON_INVALID':
			return { code, kind: 'coupon', message: couponReasonCopy(d.reason, d), reason: d.reason, actions: ['remove-offer'] };
		case 'PAYMENTS_UNAVAILABLE':
			return { code, kind: 'payments', message: copy('PAYMENTS_UNAVAILABLE'), actions: ['offer-cod'] };
		case 'RATE_LIMITED':
			return { code, kind: 'rate', message: copy(), actions: [] };
		case 'IDEMPOTENCY_MISMATCH':
		case 'IDEMPOTENCY_KEY_REQUIRED':
			return { code, kind: 'key', message: 'Something changed while we were placing your order — please tap the button again.', actions: ['new-key'] };
		case 'ALREADY_PAID':
			return { code, kind: 'order', message: copy(), actions: ['goto-order'] };
		case 'SIGNATURE_INVALID':
		case 'PAYMENT_MISMATCH':
			// Never "failed": a real payment is still confirmed by the webhook; /order polls.
			return { code, kind: 'order', message: copy(), actions: ['goto-order'] };
		case 'NOT_RETRYABLE':
			return { code, kind: 'dead', message: copy(), actions: ['new-key'] };
		case 'EMPTY_CART':
			return { code, kind: 'empty', message: copy(), actions: ['refresh-quote'] };
		case 'BELOW_MIN':
		case 'ABOVE_MAX':
		case 'TOO_MANY_LINES':
			return { code, kind: 'limit', message: copy(), actions: [] };
		case 'NETWORK':
		case 'TIMEOUT':
		case 'ABORTED':
			// Keep the key: the order may exist already, and a replay returns it.
			return { code, kind: 'network', message: NETWORK_COPY[code], actions: [] };
		case 'NOT_FOUND':
			if (stage === 'checkout') return { code, kind: 'generic', message: OFFLINE_CHECKOUT, actions: [] };
			return { code, kind: 'generic', message: copy(), actions: [] };
		default:
			return { code: code || 'INTERNAL', kind: 'generic', message: ctx.status === 503 ? OFFLINE_CHECKOUT : GENERIC, actions: [] };
	}
}

/**
 * An API refusal the page is showing that a newer server quote has since
 * answered, so its note should go: the offer now applies (e.g. the email was
 * corrected for a bound offer), the lines are all in stock, the new PIN is
 * served, the order is back within limits. The caller only asks with a quote
 * for a DIFFERENT ask than the refused checkout (a quote for the same ask
 * that disagrees with the server is a race, not a fix). Refusals a quote
 * can't speak to (fields, price, COD, payments, keys…) never resolve here.
 * @param {UiError|null} error
 * @param {any} fresh  $shared Quote
 */
export function resolvedByQuote(error, fresh) {
	if (!error || !fresh || typeof fresh !== 'object' || !Array.isArray(fresh.issues) || !Array.isArray(fresh.lines)) return false;
	switch (error.kind) {
		case 'coupon':
			return !!fresh.coupon && !fresh.couponError;
		case 'lines':
			return fresh.issues.length === 0 && fresh.lines.length > 0;
		case 'limit':
			return !fresh.orderError && fresh.lines.length > 0;
		case 'fields':
			return error.code === 'PIN_UNSERVICEABLE' && fresh.pinServiceable === true;
		default:
			return false;
	}
}

/** Every code the table knows (tests walk it). */
export const KNOWN_CODES = Object.freeze([
	'VALIDATION', 'PIN_UNSERVICEABLE', 'PRICE_CHANGED', 'OUT_OF_STOCK', 'UNAVAILABLE', 'QTY_LIMIT', 'BAD_QTY', 'BAD_SLUG',
	'COD_UNAVAILABLE', 'COUPON_INVALID', 'PAYMENTS_UNAVAILABLE', 'RATE_LIMITED', 'IDEMPOTENCY_MISMATCH',
	'IDEMPOTENCY_KEY_REQUIRED', 'ALREADY_PAID', 'SIGNATURE_INVALID', 'PAYMENT_MISMATCH', 'NOT_RETRYABLE', 'EMPTY_CART',
	'BELOW_MIN', 'ABOVE_MAX', 'TOO_MANY_LINES', 'NETWORK', 'TIMEOUT', 'ABORTED', 'NOT_FOUND', 'INTERNAL'
]);
