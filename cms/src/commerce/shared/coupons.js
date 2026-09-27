/*
 * Coupons. There is no coupon box: codes arrive by link (/cart?offer=CODE) and
 * the server evaluates them at quote and at checkout. evaluateCoupon is pure —
 * the caller loads the coupon record and the customer's usage counts.
 *
 * Discount rules (all integer paise):
 *  - percent: floor(subtotal × value / 100), then floored to whole rupees so the
 *    rupee-rounded summary rows always add up; capped by maxDiscountPaise
 *  - fixed: value paise
 *  - free_delivery: equals the delivery fee (0 when delivery is already free)
 *  - then CLAMPED: never more than the subtotal, and never so much that a
 *    non-empty order totals below MIN_ORDER_PAISE (₹1, Razorpay's minimum).
 *    Clamping is silent (no error); `clamped: true` tells you it happened.
 */
import { MIN_ORDER_PAISE, isPaise } from './money.js';
import { normalizeEmail } from './validate.js';

export const COUPON_INVALID = 'COUPON_INVALID';

/** Every reason evaluateCoupon can return, in the order they are checked. */
export const COUPON_REASONS = Object.freeze([
	'NOT_FOUND',
	'INACTIVE',
	'NOT_STARTED',
	'EXPIRED',
	'USAGE_LIMIT',
	'EMAIL_MISMATCH',
	'FIRST_ORDER_ONLY',
	'PER_CUSTOMER_LIMIT',
	'MIN_SUBTOTAL'
]);

export const COUPON_TYPES = Object.freeze(['percent', 'fixed', 'free_delivery']);

/**
 * @typedef {object} Coupon  (mirrors the CMS `coupons` collection)
 * @property {string} code
 * @property {'percent'|'fixed'|'free_delivery'} type
 * @property {number} [value]            percent: 1..100; fixed: paise; free_delivery: ignored
 * @property {number|null} [maxDiscountPaise]
 * @property {number|null} [minSubtotalPaise]
 * @property {number|string|Date|null} [startsAt]
 * @property {number|string|Date|null} [endsAt]   exclusive: expired from this instant on
 * @property {number|null} [usageLimit]
 * @property {number} [usedCount]
 * @property {number|null} [perCustomerLimit]
 * @property {boolean} [firstOrderOnly]
 * @property {string|null} [boundEmail]
 * @property {boolean} [active]            default true
 */

/**
 * @typedef {object} CouponContext
 * @property {number} subtotalPaise              PRE-discount subtotal
 * @property {number} [deliveryPaise]            for free_delivery and the ₹1 floor
 * @property {number} [codFeePaise]              for the ₹1 floor
 * @property {number|string|Date} [now]          required when the coupon has startsAt/endsAt
 * @property {string} [email]                    omit → EMAIL_MISMATCH check deferred
 * @property {boolean} [isFirstOrder]            omit → FIRST_ORDER_ONLY check deferred
 * @property {number} [customerUsageCount]       omit → PER_CUSTOMER_LIMIT check deferred
 */

/**
 * @typedef {object} CouponResult
 * @property {number} discountPaise   0 when there is an error
 * @property {{code: 'COUPON_INVALID', reason: string} | null} error
 * @property {boolean} clamped        the raw discount was reduced by the subtotal / ₹1 floor
 * @property {string[]} deferredChecks  identity checks skipped for lack of context:
 *                                      'EMAIL' | 'FIRST_ORDER' | 'PER_CUSTOMER'. Checkout must pass
 *                                      email, isFirstOrder and customerUsageCount so this is empty.
 */

/**
 * Normalise a customer-typed or linked code: trim + uppercase, 3–32 chars of
 * A–Z, 0–9, '-' or '_', starting alphanumeric. Anything else → null.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeCouponCode(raw) {
	if (typeof raw !== 'string') return null;
	const c = raw.trim().toUpperCase();
	return /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(c) ? c : null;
}

/**
 * Milliseconds since epoch for a number/ISO string/Date, or null.
 * @param {unknown} v
 * @returns {number | null}
 */
export function toMillis(v) {
	if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v) {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

/**
 * null/undefined → null (no limit); a safe int ≥ 0 → itself; anything else → NaN (malformed).
 * @param {unknown} v
 * @returns {number | null}
 */
const optCount = (v) => (v === null || v === undefined ? null : Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : NaN);

/**
 * Evaluate a coupon against a cart. Never throws for customer-facing
 * problems; throws TypeError only for a programming error (a dated coupon
 * evaluated without ctx.now). A malformed coupon record behaves as INACTIVE.
 * @param {Coupon | null | undefined} coupon  null/undefined → NOT_FOUND
 * @param {CouponContext} ctx
 * @returns {CouponResult}
 */
export function evaluateCoupon(coupon, ctx) {
	const subtotal = isPaise(ctx?.subtotalPaise) ? ctx.subtotalPaise : 0;
	const delivery = isPaise(ctx?.deliveryPaise) ? ctx.deliveryPaise : 0;
	const codFee = isPaise(ctx?.codFeePaise) ? ctx.codFeePaise : 0;
	/** @type {string[]} */
	const deferredChecks = [];
	/** @param {string} reason */
	const fail = (reason) => ({ discountPaise: 0, error: { code: /** @type {'COUPON_INVALID'} */ (COUPON_INVALID), reason }, clamped: false, deferredChecks });

	if (!coupon || typeof coupon !== 'object') return fail('NOT_FOUND');
	if (coupon.active === false || !isWellFormed(coupon)) return fail('INACTIVE');

	const hasStart = !(coupon.startsAt == null || coupon.startsAt === '');
	const hasEnd = !(coupon.endsAt == null || coupon.endsAt === '');
	const starts = hasStart ? toMillis(coupon.startsAt) : null;
	const ends = hasEnd ? toMillis(coupon.endsAt) : null;
	if ((hasStart && starts === null) || (hasEnd && ends === null)) return fail('INACTIVE'); // unparseable window: fail closed
	if (starts !== null || ends !== null) {
		const now = toMillis(ctx?.now);
		if (now === null) throw new TypeError('evaluateCoupon: ctx.now is required for a coupon with startsAt/endsAt');
		if (starts !== null && now < starts) return fail('NOT_STARTED');
		if (ends !== null && now >= ends) return fail('EXPIRED');
	}

	const usageLimit = optCount(coupon.usageLimit);
	const used = optCount(coupon.usedCount) ?? 0;
	if (usageLimit !== null && used >= usageLimit) return fail('USAGE_LIMIT');

	if (typeof coupon.boundEmail === 'string' && coupon.boundEmail.trim()) {
		if (ctx?.email === undefined || ctx?.email === null || ctx?.email === '') deferredChecks.push('EMAIL');
		else if (normalizeEmail(ctx.email) !== normalizeEmail(coupon.boundEmail)) return fail('EMAIL_MISMATCH');
	}
	if (coupon.firstOrderOnly === true) {
		if (typeof ctx?.isFirstOrder !== 'boolean') deferredChecks.push('FIRST_ORDER');
		else if (!ctx.isFirstOrder) return fail('FIRST_ORDER_ONLY');
	}
	const perCustomer = optCount(coupon.perCustomerLimit);
	if (perCustomer !== null) {
		const usedByCustomer = ctx?.customerUsageCount;
		if (!(Number.isSafeInteger(usedByCustomer) && /** @type {number} */ (usedByCustomer) >= 0)) deferredChecks.push('PER_CUSTOMER');
		else if (/** @type {number} */ (usedByCustomer) >= perCustomer) return fail('PER_CUSTOMER_LIMIT');
	}

	const minSubtotal = optCount(coupon.minSubtotalPaise);
	if (minSubtotal !== null && subtotal < minSubtotal) return fail('MIN_SUBTOTAL');

	let raw = 0;
	if (coupon.type === 'percent') {
		raw = Math.floor((subtotal * /** @type {number} */ (coupon.value)) / 100);
		raw -= raw % 100; // whole rupees
	} else if (coupon.type === 'fixed') {
		raw = /** @type {number} */ (coupon.value);
	} else {
		raw = delivery;
	}
	const cap = optCount(coupon.maxDiscountPaise);
	if (cap !== null) raw = Math.min(raw, cap);

	// Clamp: ≤ subtotal, and a non-empty order keeps a total of at least ₹1.
	const floorRoom = subtotal > 0 ? subtotal + delivery + codFee - MIN_ORDER_PAISE : 0;
	const discountPaise = Math.max(0, Math.min(raw, subtotal, floorRoom));
	return { discountPaise, error: null, clamped: discountPaise < raw, deferredChecks };
}

/**
 * Type/value sane and every optional count null/undefined or a safe int ≥ 0.
 * A malformed record fails closed (INACTIVE) rather than skipping a limit.
 * @param {Coupon} c
 */
function isWellFormed(c) {
	if (!COUPON_TYPES.includes(c.type)) return false;
	for (const k of /** @type {const} */ (['maxDiscountPaise', 'minSubtotalPaise', 'usageLimit', 'usedCount', 'perCustomerLimit'])) {
		if (Number.isNaN(optCount(c[k]))) return false;
	}
	if (c.type === 'percent') return Number.isSafeInteger(c.value) && /** @type {number} */ (c.value) >= 1 && /** @type {number} */ (c.value) <= 100;
	if (c.type === 'fixed') return isPaise(c.value) && /** @type {number} */ (c.value) > 0;
	return true;
}

/**
 * Build the per-subscriber welcome coupon record from settings.welcomeOffer:
 * percent off, capped (maxDiscountPaise 0 = no cap → null), single use, first order only, bound to the email,
 * valid for validDays from `now`. The caller generates the random code.
 * @param {{code: string, email: string, now: number|string|Date, settings?: any}} args
 * @returns {Coupon & {usedCount: number}}
 */
export function buildWelcomeCoupon({ code, email, now, settings }) {
	const wo = settings?.welcomeOffer ?? {};
	const percent = Number.isSafeInteger(wo.percent) && wo.percent >= 1 && wo.percent <= 100 ? wo.percent : 10;
	// 0 = no cap (the Store settings field says so, and the welcome email reads it that way): a ₹0 cap
	// would be a code that gives nothing yet uses up its single redemption.
	const maxDiscountPaise = wo.maxDiscountPaise === 0 ? null : isPaise(wo.maxDiscountPaise) ? wo.maxDiscountPaise : 7500;
	const validDays = Number.isSafeInteger(wo.validDays) && wo.validDays >= 1 ? wo.validDays : 30;
	const start = toMillis(now);
	if (start === null) throw new TypeError('buildWelcomeCoupon: now is required');
	const c = normalizeCouponCode(code);
	if (!c) throw new TypeError('buildWelcomeCoupon: invalid code');
	const bound = normalizeEmail(email);
	if (!bound) throw new TypeError('buildWelcomeCoupon: invalid email');
	return {
		code: c,
		type: 'percent',
		value: percent,
		maxDiscountPaise,
		minSubtotalPaise: null,
		startsAt: new Date(start).toISOString(),
		endsAt: new Date(start + validDays * 86_400_000).toISOString(),
		usageLimit: 1,
		usedCount: 0,
		perCustomerLimit: 1,
		firstOrderOnly: true,
		boundEmail: bound,
		active: true
	};
}
