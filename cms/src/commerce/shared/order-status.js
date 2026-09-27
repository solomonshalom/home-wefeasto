/*
 * Order status machine (roadmap M2 table + SPEC §4). Payment evidence can
 * arrive in any order (client verify, redirect callback, webhooks, reconcile
 * cron), so transitions are driven by EVENTS and a stale or duplicate event
 * can never move an order backwards: nextStatus() returns null ("ignore")
 * rather than downgrading. Fulfilment is a separate, simpler machine.
 *
 *   online: pending_payment → paid | payment_failed | expired | cancelled
 *           payment_failed, expired → paid (late authorisation is honoured)
 *           payment_failed, expired → pending_payment (retry endpoint only)
 *           paid → refunded | partially_refunded
 *           partially_refunded → paid (the partial refund FAILED at Razorpay: nothing was refunded)
 *   COD:    cod_pending → cod_confirmed | cancelled
 *   review: most states → needs_review → paid | cancelled | (partially_)refunded
 *   A payment for a cancelled or COD order → needs_review (never auto-paid).
 */

/** @typedef {'pending_payment'|'payment_failed'|'paid'|'cod_pending'|'cod_confirmed'|'expired'|'cancelled'|'needs_review'|'refunded'|'partially_refunded'} OrderStatus */
/** @typedef {'none'|'created'|'attempted'|'authorized'|'captured'|'failed'|'refunded'|'partially_refunded'} PaymentStatus */
/** @typedef {'unfulfilled'|'packed'|'shipped'|'delivered'|'rto'|'returned'} FulfilmentStatus */
/** @typedef {'paid'|'payment_failed'|'expire'|'retry'|'cancel'|'cod_confirm'|'review'|'resolve_paid'|'refund'|'partial_refund'|'refund_failed'} OrderEvent */

export const STATUS = Object.freeze({
	PENDING_PAYMENT: 'pending_payment',
	PAYMENT_FAILED: 'payment_failed',
	PAID: 'paid',
	COD_PENDING: 'cod_pending',
	COD_CONFIRMED: 'cod_confirmed',
	EXPIRED: 'expired',
	CANCELLED: 'cancelled',
	NEEDS_REVIEW: 'needs_review',
	REFUNDED: 'refunded',
	PARTIALLY_REFUNDED: 'partially_refunded'
});

/** @type {ReadonlyArray<OrderStatus>} */
export const ORDER_STATUSES = Object.freeze(/** @type {OrderStatus[]} */ (Object.values(STATUS)));
/** @type {ReadonlyArray<PaymentStatus>} */
export const PAYMENT_STATUSES = Object.freeze(/** @type {PaymentStatus[]} */ (['none', 'created', 'attempted', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded']));
/** @type {ReadonlyArray<FulfilmentStatus>} */
export const FULFILMENT_STATUSES = Object.freeze(/** @type {FulfilmentStatus[]} */ (['unfulfilled', 'packed', 'shipped', 'delivered', 'rto', 'returned']));
/** @type {ReadonlyArray<OrderEvent>} */
export const ORDER_EVENTS = Object.freeze(/** @type {OrderEvent[]} */ (['paid', 'payment_failed', 'expire', 'retry', 'cancel', 'cod_confirm', 'review', 'resolve_paid', 'refund', 'partial_refund', 'refund_failed']));
export const REQUESTED_METHODS = Object.freeze(['upi', 'card', 'cod']);
export const PAYMENT_METHODS = Object.freeze(['online', 'cod']);
export const ORDER_SOURCES = Object.freeze(['web', 'usual', 'link', 'email', 'refill', 'offer']);

/** Own-property check: '__proto__' / 'constructor' must never match Object.prototype. */
const own = (/** @type {object} */ o, /** @type {unknown} */ k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** A customer may open at most this many Razorpay attempts for one order. */
export const MAX_PAYMENT_ATTEMPTS = 10;

/*
 * event → { from: to }. A missing `from` means the event does not apply in
 * that state → nextStatus returns null and the caller changes nothing.
 * Self-mappings (paid + paid) make repeated deliveries idempotent no-ops.
 */
/** @type {Record<OrderEvent, Partial<Record<OrderStatus, OrderStatus>>>} */
const TABLE = {
	// Payment authorised/captured with the right amount (markPaid). A payment
	// for a cancelled or COD order is never auto-accepted: a human decides.
	paid: {
		pending_payment: 'paid',
		payment_failed: 'paid',
		expired: 'paid',
		paid: 'paid',
		cancelled: 'needs_review',
		cod_pending: 'needs_review',
		cod_confirmed: 'needs_review',
		needs_review: 'needs_review'
	},
	// A failed attempt only matters while we are still waiting for money.
	payment_failed: { pending_payment: 'payment_failed', payment_failed: 'payment_failed' },
	// Reservation TTL passed (after the reconcile check found no payment).
	expire: { pending_payment: 'expired', payment_failed: 'expired', expired: 'expired' },
	// The retry endpoint opened a new attempt (re-reserving stock if expired).
	retry: { pending_payment: 'pending_payment', payment_failed: 'pending_payment', expired: 'pending_payment' },
	// Cancel is for orders without captured money; paid orders are refunded instead.
	cancel: {
		pending_payment: 'cancelled',
		payment_failed: 'cancelled',
		expired: 'cancelled',
		cod_pending: 'cancelled',
		cod_confirmed: 'cancelled',
		needs_review: 'cancelled',
		cancelled: 'cancelled'
	},
	cod_confirm: { cod_pending: 'cod_confirmed', cod_confirmed: 'cod_confirmed' },
	// Amount mismatch, stock gone after a late payment, dispute, …
	review: {
		pending_payment: 'needs_review',
		payment_failed: 'needs_review',
		expired: 'needs_review',
		paid: 'needs_review',
		cod_pending: 'needs_review',
		cod_confirmed: 'needs_review',
		cancelled: 'needs_review',
		partially_refunded: 'needs_review',
		needs_review: 'needs_review'
	},
	resolve_paid: { needs_review: 'paid' },
	refund: {
		paid: 'refunded',
		cod_confirmed: 'refunded',
		needs_review: 'refunded',
		partially_refunded: 'refunded',
		refunded: 'refunded'
	},
	partial_refund: {
		paid: 'partially_refunded',
		cod_confirmed: 'partially_refunded',
		needs_review: 'partially_refunded',
		partially_refunded: 'partially_refunded'
	},
	// A refund counted while pending FAILED and nothing of the payment is refunded any more: the partial refund is
	// withdrawn. A hold (needs_review) stays for a human; refunded is terminal.
	refund_failed: { partially_refunded: 'paid' }
};

/**
 * Apply an event. Returns the resulting status (possibly unchanged, for an
 * idempotent repeat), or null when the event doesn't apply in this state —
 * e.g. a late payment_failed after paid, or cancel on a paid order. Unknown
 * statuses/events → null.
 * @param {unknown} current
 * @param {unknown} event
 * @returns {OrderStatus | null}
 */
export function nextStatus(current, event) {
	if (!own(TABLE, event)) return null;
	const row = TABLE[/** @type {OrderEvent} */ (event)];
	return own(row, current) ? /** @type {OrderStatus} */ (row[/** @type {OrderStatus} */ (current)]) : null;
}

/**
 * Is a direct status change allowed (for admin edits / a beforeChange hook)?
 * True when from === to, or when some event maps from → to.
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
	if (typeof from !== 'string' || typeof to !== 'string') return false;
	if (!ORDER_STATUSES.includes(/** @type {OrderStatus} */ (from)) || !ORDER_STATUSES.includes(/** @type {OrderStatus} */ (to))) return false;
	if (from === to) return true;
	return ORDER_EVENTS.some((e) => nextStatus(from, e) === to);
}

/**
 * Terminal: no event moves the order anywhere else.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminal(status) {
	return status === 'refunded';
}

/**
 * Initial status for a new order: 'cod' → 'cod_pending', otherwise 'pending_payment'.
 * @param {unknown} requestedMethod
 * @returns {OrderStatus}
 */
export function initialStatus(requestedMethod) {
	return requestedMethod === 'cod' ? 'cod_pending' : 'pending_payment';
}

/**
 * 'upi' | 'card' → 'online'; 'cod' → 'cod'.
 * @param {unknown} requestedMethod
 * @returns {'online'|'cod'}
 */
export function paymentMethodFor(requestedMethod) {
	return requestedMethod === 'cod' ? 'cod' : 'online';
}

const CONFIRMED = new Set(['paid', 'cod_pending', 'cod_confirmed', 'partially_refunded']);

/**
 * The customer may be told "Order confirmed": paid (incl. authorised), COD
 * placed or confirmed, or partly refunded (the rest still ships).
 * @param {unknown} status
 * @returns {boolean}
 */
export function isConfirmed(status) {
	return typeof status === 'string' && CONFIRMED.has(status);
}

const RETRYABLE = new Set(['pending_payment', 'payment_failed', 'expired']);

/**
 * Can the customer start another online payment attempt for this order?
 * Online orders still waiting for money, with no authorised/captured payment
 * on record and fewer than MAX_PAYMENT_ATTEMPTS attempts. (For an expired
 * order the server must still re-reserve stock or answer OUT_OF_STOCK.)
 * @param {{status?: unknown, paymentStatus?: unknown, paymentMethod?: unknown, requestedMethod?: unknown, razorpay?: {attempts?: unknown[]}} | null | undefined} order
 * @returns {boolean}
 */
export function canRetryPayment(order) {
	if (!order || typeof order !== 'object') return false;
	if (order.paymentMethod === 'cod' || order.requestedMethod === 'cod') return false;
	if (typeof order.status !== 'string' || !RETRYABLE.has(order.status)) return false;
	if (order.paymentStatus === 'authorized' || order.paymentStatus === 'captured') return false;
	const attempts = order.razorpay && Array.isArray(order.razorpay.attempts) ? order.razorpay.attempts.length : 0;
	return attempts < MAX_PAYMENT_ATTEMPTS;
}

/*
 * Precedence ranks (razorpay.md §12: refunded > partially_refunded > paid >
 * authorized > pending_payment > payment_failed > expired). Use them to pick
 * which of two conflicting reports to display or log; use nextStatus() to
 * actually move an order.
 */
/** @type {Readonly<Record<OrderStatus, number>>} */
export const STATUS_RANK = Object.freeze({
	expired: 10,
	payment_failed: 20,
	pending_payment: 30,
	cancelled: 35,
	cod_pending: 40,
	cod_confirmed: 50,
	paid: 60,
	needs_review: 65,
	partially_refunded: 70,
	refunded: 80
});

/** @type {Readonly<Record<PaymentStatus, number>>} */
export const PAYMENT_STATUS_RANK = Object.freeze({
	none: 0,
	created: 1,
	attempted: 2,
	failed: 2,
	authorized: 3,
	captured: 4,
	partially_refunded: 5,
	refunded: 6
});

/**
 * Merge an incoming payment status: the higher rank wins, ties go to the
 * incoming value (attempted ↔ failed across retries). A late 'failed' or
 * 'authorized' never overrides 'captured'. Unknown incoming → current.
 * @param {unknown} current
 * @param {unknown} incoming
 * @returns {PaymentStatus}
 */
export function mergePaymentStatus(current, incoming) {
	const cur = own(PAYMENT_STATUS_RANK, current) ? /** @type {PaymentStatus} */ (current) : 'none';
	if (!own(PAYMENT_STATUS_RANK, incoming)) return cur;
	const inc = /** @type {PaymentStatus} */ (incoming);
	return PAYMENT_STATUS_RANK[inc] >= PAYMENT_STATUS_RANK[cur] ? inc : cur;
}

/**
 * Razorpay webhook event → {orderEvent, paymentStatus} for the machine.
 * order.paid / payment.captured / payment.authorized all mean "money is
 * ours" (auto-capture on). Refund/dispute events need amounts and are left
 * to the server. Unknown → null.
 * @param {unknown} name
 * @returns {{orderEvent: OrderEvent, paymentStatus: PaymentStatus} | null}
 */
export function razorpayEventToOrderEvent(name) {
	switch (name) {
		case 'order.paid':
		case 'payment.captured':
			return { orderEvent: 'paid', paymentStatus: 'captured' };
		case 'payment.authorized':
			return { orderEvent: 'paid', paymentStatus: 'authorized' };
		case 'payment.failed':
			return { orderEvent: 'payment_failed', paymentStatus: 'failed' };
		default:
			return null;
	}
}

/* ---------- fulfilment (separate from payment) ---------- */

/** @type {Record<FulfilmentStatus, FulfilmentStatus[]>} */
const FULFILMENT_NEXT = {
	unfulfilled: ['packed', 'shipped'],
	packed: ['shipped'],
	shipped: ['delivered', 'rto'],
	delivered: ['returned'],
	rto: [],
	returned: []
};

/**
 * Forward-only fulfilment: unfulfilled → packed → shipped → delivered →
 * returned, shipped → rto; packing may be skipped. from === to is allowed.
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function canFulfilmentTransition(from, to) {
	if (!own(FULFILMENT_NEXT, from) || !own(FULFILMENT_NEXT, to)) return false;
	return from === to || FULFILMENT_NEXT[/** @type {FulfilmentStatus} */ (from)].includes(/** @type {FulfilmentStatus} */ (to));
}

const FULFILLABLE = new Set(['paid', 'cod_confirmed', 'partially_refunded']);

/**
 * May this order be packed/shipped? Paid (or partly refunded) online orders,
 * and COD orders once confirmed.
 * @param {unknown} status
 * @returns {boolean}
 */
export function canFulfil(status) {
	return typeof status === 'string' && FULFILLABLE.has(status);
}

/* ---------- display ---------- */

/** Customer-facing labels for /order and emails. */
export const STATUS_LABELS = Object.freeze({
	pending_payment: 'Waiting for payment',
	payment_failed: 'Payment didn’t go through',
	paid: 'Order confirmed',
	cod_pending: 'Order placed · pay on delivery',
	cod_confirmed: 'Order confirmed · pay on delivery',
	expired: 'Payment window closed',
	cancelled: 'Cancelled',
	needs_review: 'We’re checking your order',
	refunded: 'Refunded',
	partially_refunded: 'Partly refunded'
});

export const FULFILMENT_LABELS = Object.freeze({
	unfulfilled: 'Getting it ready',
	packed: 'Packed',
	shipped: 'Shipped',
	delivered: 'Delivered',
	rto: 'Returned to us',
	returned: 'Returned'
});

/* ---------- order numbers ---------- */

/** First order number issued by the counter. */
export const ORDER_NUMBER_START = 10001;
export const ORDER_NUMBER_RE = /^WF-[0-9]{5,12}$/;

/**
 * 10001 → 'WF-10001'. Throws on a non-positive or unsafe integer.
 * @param {number} n
 * @returns {string}
 */
export function formatOrderNumber(n) {
	if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('formatOrderNumber: positive integer required');
	return 'WF-' + String(n).padStart(5, '0');
}

/**
 * Shape check for a public order number ('WF-10001'); trims, case-sensitive.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isOrderNumber(s) {
	return typeof s === 'string' && ORDER_NUMBER_RE.test(s.trim());
}
