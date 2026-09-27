/*
 * Error codes and customer-facing copy. One table used by the CMS endpoints
 * (error body `{ error: { code, message, details? } }`) and by the storefront
 * (inline notes), so a message never differs between the two.
 * Copy is short, calm, and never blames the customer or leaks internals.
 */
import { formatPaise } from './money.js';

/** Every error code a custom endpoint may return. */
export const CODES = Object.freeze({
	VALIDATION: 'VALIDATION',
	BAD_REQUEST: 'BAD_REQUEST',
	BAD_QTY: 'BAD_QTY',
	BAD_SLUG: 'BAD_SLUG',
	EMPTY_CART: 'EMPTY_CART',
	TOO_MANY_LINES: 'TOO_MANY_LINES',
	UNAVAILABLE: 'UNAVAILABLE',
	OUT_OF_STOCK: 'OUT_OF_STOCK',
	QTY_LIMIT: 'QTY_LIMIT',
	PRICE_CHANGED: 'PRICE_CHANGED',
	PIN_UNSERVICEABLE: 'PIN_UNSERVICEABLE',
	COD_UNAVAILABLE: 'COD_UNAVAILABLE',
	COUPON_INVALID: 'COUPON_INVALID',
	BELOW_MIN: 'BELOW_MIN',
	ABOVE_MAX: 'ABOVE_MAX',
	RATE_LIMITED: 'RATE_LIMITED',
	PAYMENTS_UNAVAILABLE: 'PAYMENTS_UNAVAILABLE',
	IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
	IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
	ALREADY_PAID: 'ALREADY_PAID',
	NOT_RETRYABLE: 'NOT_RETRYABLE',
	SIGNATURE_INVALID: 'SIGNATURE_INVALID',
	PAYMENT_MISMATCH: 'PAYMENT_MISMATCH',
	NOT_FOUND: 'NOT_FOUND',
	UNAUTHORIZED: 'UNAUTHORIZED',
	INTERNAL: 'INTERNAL'
});

/** Recommended HTTP status per code (endpoints may deviate where the SPEC says so). */
export const HTTP_STATUS = Object.freeze({
	VALIDATION: 400,
	BAD_REQUEST: 400,
	BAD_QTY: 400,
	BAD_SLUG: 400,
	EMPTY_CART: 400,
	TOO_MANY_LINES: 400,
	UNAVAILABLE: 409,
	OUT_OF_STOCK: 409,
	QTY_LIMIT: 409,
	PRICE_CHANGED: 409,
	PIN_UNSERVICEABLE: 422,
	COD_UNAVAILABLE: 422,
	COUPON_INVALID: 422,
	BELOW_MIN: 400,
	ABOVE_MAX: 400,
	RATE_LIMITED: 429,
	PAYMENTS_UNAVAILABLE: 503,
	IDEMPOTENCY_KEY_REQUIRED: 400,
	IDEMPOTENCY_MISMATCH: 409,
	ALREADY_PAID: 409,
	NOT_RETRYABLE: 409,
	SIGNATURE_INVALID: 400,
	PAYMENT_MISMATCH: 409,
	NOT_FOUND: 404,
	UNAUTHORIZED: 401,
	INTERNAL: 500
});

const GENERIC = 'Something went wrong on our side. Please try again.';

/** Own-property lookup: '__proto__' / 'constructor' must never hit Object.prototype. */
const own = (/** @type {object} */ o, /** @type {unknown} */ k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
/** A positive amount of paise worth showing to a customer. */
const amount = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** @param {number} n */
const packs = (n) => (n === 1 ? '1 pack' : `${n} packs`);
/**
 * @param {any} d
 * @param {string} fallback
 * @returns {string}
 */
const nameOr = (d, fallback) => (d && typeof d.name === 'string' && d.name.trim() ? d.name.trim() : fallback);

/**
 * Customer copy for a checkout/order error code.
 * details (all optional): name, available, max, pin, reason (coupon or COD
 * reason), limitPaise, minSubtotalPaise, subtotalPaise, codMaxPaise,
 * codMinSubtotalPaise. Unknown codes → a generic message.
 * @param {string} code
 * @param {any} [details]
 * @returns {string}
 */
export function checkoutErrorCopy(code, details) {
	const d = details && typeof details === 'object' ? details : {};
	switch (code) {
		case 'VALIDATION':
			return 'Please check the highlighted details.';
		case 'BAD_REQUEST':
		case 'IDEMPOTENCY_KEY_REQUIRED':
			return 'Something about that request wasn’t right. Please refresh the page and try again.';
		case 'BAD_QTY':
			return 'One of the quantities in your bag isn’t valid. Please update your bag and try again.';
		case 'BAD_SLUG':
		case 'UNAVAILABLE':
			return `${nameOr(d, 'An item in your bag')} is no longer available — remove it to continue.`;
		case 'EMPTY_CART':
			return 'Your bag is empty.';
		case 'TOO_MANY_LINES':
			return 'Your bag has too many different items for one order — please split it into two.';
		case 'OUT_OF_STOCK': {
			const n = Number.isSafeInteger(d.available) && d.available > 0 ? d.available : 0;
			const name = nameOr(d, 'An item in your bag');
			return n > 0
				? `Only ${packs(n)} of ${name} left — reduce the quantity to continue.`
				: `${name} just sold out — remove it to continue.`;
		}
		case 'QTY_LIMIT': {
			const max = Number.isSafeInteger(d.max) && d.max > 0 ? d.max : null;
			const name = nameOr(d, 'this item');
			return max ? `You can order up to ${packs(max)} of ${name} at a time.` : `That’s more ${name} than we can send in one order.`;
		}
		case 'PRICE_CHANGED':
			return 'Prices changed since you opened your bag — please check the new total.';
		case 'PIN_UNSERVICEABLE':
			return typeof d.pin === 'string' && /^[0-9]{6}$/.test(d.pin)
				? `Sorry, we don’t deliver to ${d.pin} yet.`
				: 'Sorry, we don’t deliver to that PIN code yet.';
		case 'COD_UNAVAILABLE':
			return d.reason ? codReasonCopy(d.reason, d) : 'Cash on delivery isn’t available for this order — please pay online.';
		case 'COUPON_INVALID':
			return couponReasonCopy(d.reason, d);
		case 'BELOW_MIN':
			return 'Your order total is too low to process.';
		case 'ABOVE_MAX':
			return amount(d.limitPaise)
				? `Orders above ${formatPaise(d.limitPaise)} can’t be placed online — please split it or message us.`
				: 'That order is too large to place online — please split it or message us.';
		case 'RATE_LIMITED':
			return 'Too many attempts — please wait a minute and try again.';
		case 'PAYMENTS_UNAVAILABLE':
			return 'Payments are temporarily unavailable. Try again, or choose Cash on Delivery.';
		case 'IDEMPOTENCY_MISMATCH':
			return 'This order was already submitted with different details. Please refresh the page and try again.';
		case 'ALREADY_PAID':
			return 'This order is already paid — no need to pay again.';
		case 'NOT_RETRYABLE':
			return 'This order can’t be paid again. Please place a new order.';
		case 'SIGNATURE_INVALID':
		case 'PAYMENT_MISMATCH':
			// Never say "failed" here: a real payment is still confirmed by webhook.
			return 'We’re confirming your payment with the bank — this can take a moment.';
		case 'NOT_FOUND':
			return 'We couldn’t find that order.';
		case 'UNAUTHORIZED':
			return 'Please log in to continue.';
		default:
			return GENERIC;
	}
}

/**
 * The SPEC error body: `{ error: { code, message, details? } }`.
 * `details` is copied through only when given (keep it free of PII/secrets).
 * @param {string} code
 * @param {any} [details]
 * @returns {{error: {code: string, message: string, details?: any}}}
 */
export function errorBody(code, details) {
	/** @type {{code: string, message: string, details?: any}} */
	const error = { code, message: checkoutErrorCopy(code, details) };
	if (details !== undefined) error.details = details;
	return { error };
}

/**
 * Copy for a COUPON_INVALID reason (see coupons.js COUPON_REASONS).
 * details: minSubtotalPaise and subtotalPaise make MIN_SUBTOTAL say how much more to add.
 * @param {string} reason
 * @param {any} [details]
 * @returns {string}
 */
export function couponReasonCopy(reason, details) {
	const d = details && typeof details === 'object' ? details : {};
	switch (reason) {
		case 'NOT_FOUND':
			return 'That offer code isn’t valid.';
		case 'INACTIVE':
			return 'That offer is no longer active.';
		case 'NOT_STARTED':
			return 'That offer hasn’t started yet.';
		case 'EXPIRED':
			return 'That offer has expired.';
		case 'USAGE_LIMIT':
			return 'That offer has been fully claimed.';
		case 'EMAIL_MISMATCH':
			return 'That offer belongs to a different email address.';
		case 'FIRST_ORDER_ONLY':
			return 'That offer is for your first order only.';
		case 'PER_CUSTOMER_LIMIT':
			return 'You’ve already used that offer.';
		case 'MIN_SUBTOTAL': {
			const min = amount(d.minSubtotalPaise) ? d.minSubtotalPaise : null;
			const sub = typeof d.subtotalPaise === 'number' && Number.isSafeInteger(d.subtotalPaise) && d.subtotalPaise >= 0 ? d.subtotalPaise : null;
			if (min !== null && sub !== null && min > sub) return `Add ${formatPaise(min - sub)} more to use this offer.`;
			if (min !== null) return `This offer needs a bag of ${formatPaise(min)} or more.`;
			return 'Add a little more to your bag to use this offer.';
		}
		default:
			return 'That offer can’t be applied to this order.';
	}
}

/**
 * Copy for a COD unavailability reason (pricing.js CodReason, plus the
 * server-only 'TOO_MANY_OPEN' for the open-orders-per-phone cap).
 * details: name (ITEM_NOT_ALLOWED), codMaxPaise (ABOVE_MAX), codMinSubtotalPaise (BELOW_MIN).
 * @param {string} reason
 * @param {any} [details]
 * @returns {string}
 */
export function codReasonCopy(reason, details) {
	const d = details && typeof details === 'object' ? details : {};
	switch (reason) {
		case 'DISABLED':
			return 'Cash on delivery isn’t available right now — please pay online.';
		case 'EMPTY':
			return 'Add something to your bag first.';
		case 'ITEM_NOT_ALLOWED':
			return typeof d.name === 'string' && d.name
				? `Cash on delivery isn’t available for ${d.name} — please pay online.`
				: 'Cash on delivery isn’t available for an item in your bag — please pay online.';
		case 'PIN_BLOCKED':
			return 'Cash on delivery isn’t available for your PIN code yet — please pay online.';
		case 'BELOW_MIN':
			return amount(d.codMinSubtotalPaise)
				? `Cash on delivery is available on orders of ${formatPaise(d.codMinSubtotalPaise)} or more.`
				: 'Cash on delivery isn’t available for an order this small — please pay online.';
		case 'ABOVE_MAX':
			return amount(d.codMaxPaise)
				? `Cash on delivery is available on orders up to ${formatPaise(d.codMaxPaise)} — please pay online.`
				: 'Cash on delivery isn’t available for an order this large — please pay online.';
		case 'TOO_MANY_OPEN':
			return 'You already have cash-on-delivery orders on the way — please pay online for this one.';
		default:
			return 'Cash on delivery isn’t available for this order — please pay online.';
	}
}

/** Copy for a checkout field error (validate.js FieldErrorCode). */
const FIELD_COPY = {
	name: { REQUIRED: 'Enter your name.', TOO_SHORT: 'Enter your full name.', TOO_LONG: 'That name is too long.', INVALID: 'Enter a valid name.' },
	email: { REQUIRED: 'Enter your email.', TOO_LONG: 'That email is too long.', INVALID: 'Enter a valid email, like name@example.com.' },
	phone: { REQUIRED: 'Enter your mobile number.', INVALID: 'Enter a valid 10-digit Indian mobile number.' },
	line1: {
		REQUIRED: 'Enter your address.',
		TOO_SHORT: 'Add a little more detail to your address.',
		TOO_LONG: 'That address is too long — shorten it a little.',
		INVALID: 'Enter a valid address.'
	},
	city: { REQUIRED: 'Enter your city.', TOO_SHORT: 'Enter your city.', TOO_LONG: 'That city name is too long.', INVALID: 'Enter a valid city.' },
	state: { REQUIRED: 'Choose your state.', INVALID: 'Choose your state from the list.' },
	pin: { REQUIRED: 'Enter your PIN code.', INVALID: 'Enter a valid 6-digit PIN code.', UNSERVICEABLE: 'Sorry, we don’t deliver to this PIN code yet.' }
};

/**
 * @param {string} field  name | email | phone | line1 | city | state | pin
 * @param {string} code   REQUIRED | INVALID | TOO_SHORT | TOO_LONG | UNSERVICEABLE
 * @returns {string}
 */
export function fieldErrorCopy(field, code) {
	const table = /** @type {Record<string, Record<string, string>>} */ (FIELD_COPY);
	if (!own(table, field) || !own(table[field], code)) return 'Please check this field.';
	return table[field][code];
}

/* ---------- Razorpay payment.failed reasons (razorpay.md §13 J.71) ---------- */

/** @typedef {'cancelled'|'declined'|'auth_failed'|'pending'|'already_paid'|'risk'|'technical'|'unknown'} PaymentReasonKind */

/** @type {Record<string, PaymentReasonKind>} */
const REASON_KIND = {
	payment_cancelled: 'cancelled',
	payment_timed_out: 'cancelled',
	payment_session_expired: 'cancelled',
	payment_collect_request_expired: 'cancelled',
	request_timed_out: 'cancelled',

	insufficient_funds: 'declined',
	card_declined: 'declined',
	card_expired: 'declined',
	debit_declined: 'declined',
	payment_declined: 'declined',
	authorisation_declined_by_psp: 'declined',
	transaction_limit_exceeded: 'declined',
	transaction_daily_limit_exceeded: 'declined',
	transaction_daily_count_exceeded: 'declined',
	international_transaction_not_allowed: 'declined',
	incorrect_card_details: 'declined',
	card_number_invalid: 'declined',
	incorrect_card_expiry_date: 'declined',
	incorrect_cvv: 'declined',
	invalid_vpa: 'declined',

	authentication_failed: 'auth_failed',
	incorrect_otp: 'auth_failed',
	incorrect_pin: 'auth_failed',
	incorrect_atm_pin: 'auth_failed',
	otp_attempts_exceeded: 'auth_failed',
	otp_expired: 'auth_failed',
	pin_attempts_exceeded: 'auth_failed',

	payment_pending: 'pending',
	deemed_transaction: 'pending',
	collect_request_pending: 'pending',

	order_already_paid: 'already_paid',

	payment_risk_check_failed: 'risk',

	bank_technical_error: 'technical',
	gateway_technical_error: 'technical',
	issuer_technical_error: 'technical',
	upi_app_technical_error: 'technical',
	server_error: 'technical',
	bank_not_available: 'technical',
	psp_not_available: 'technical',
	payment_declined_due_to_high_traffic: 'technical'
};

/**
 * Classify a Razorpay `error.reason` (case-insensitive) so the UI can pick an
 * action: cancelled → Try again; declined/auth_failed/risk → try another
 * method; pending → poll + "don't pay twice"; already_paid → go to /order;
 * technical/unknown → Try again or Pay on delivery.
 * @param {unknown} reason
 * @returns {PaymentReasonKind}
 */
export function paymentReasonKind(reason) {
	if (typeof reason !== 'string') return 'unknown';
	const key = reason.trim().toLowerCase();
	return own(REASON_KIND, key) ? REASON_KIND[key] : 'unknown';
}

/**
 * Customer copy for a Razorpay failure reason (razorpay.md §13 J.71).
 * "No money was taken" is only claimed where the reason guarantees it.
 * @param {unknown} reason
 * @returns {string}
 */
export function paymentReasonCopy(reason) {
	switch (paymentReasonKind(reason)) {
		case 'cancelled':
			return 'No money was taken. Try again.';
		case 'declined':
			return 'That payment didn’t go through. Try another card or UPI.';
		case 'auth_failed':
			return 'The payment couldn’t be verified with your bank. Try again, or use another card or UPI.';
		case 'pending':
			// deemed transactions can take until the next day, so no "within the hour" promise
			return 'Your bank is still processing this payment. We’ll confirm as soon as it clears — please don’t pay twice.';
		case 'already_paid':
			return 'This order is already paid — taking you to your order.';
		case 'risk':
			return 'That payment couldn’t be completed. Try a different method.';
		case 'technical':
			return 'Your bank or UPI app had a technical problem. Try again in a moment, or use another method.';
		default:
			return 'Payment didn’t go through. Try again, or choose Pay on delivery.';
	}
}
