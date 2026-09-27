import { describe, it, expect } from 'vitest';
import {
	STATUS,
	ORDER_STATUSES,
	PAYMENT_STATUSES,
	FULFILMENT_STATUSES,
	ORDER_EVENTS,
	nextStatus,
	canTransition,
	isTerminal,
	initialStatus,
	paymentMethodFor,
	isConfirmed,
	canRetryPayment,
	STATUS_RANK,
	PAYMENT_STATUS_RANK,
	mergePaymentStatus,
	razorpayEventToOrderEvent,
	canFulfilmentTransition,
	canFulfil,
	STATUS_LABELS,
	FULFILMENT_LABELS,
	formatOrderNumber,
	isOrderNumber,
	ORDER_NUMBER_START,
	MAX_PAYMENT_ATTEMPTS,
	REQUESTED_METHODS,
	PAYMENT_METHODS,
	ORDER_SOURCES
} from '$shared/order-status.js';

describe('status vocabularies match SPEC §4', () => {
	it('lists', () => {
		expect(ORDER_STATUSES).toEqual(['pending_payment', 'payment_failed', 'paid', 'cod_pending', 'cod_confirmed', 'expired', 'cancelled', 'needs_review', 'refunded', 'partially_refunded']);
		expect(PAYMENT_STATUSES).toEqual(['none', 'created', 'attempted', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded']);
		expect(FULFILMENT_STATUSES).toEqual(['unfulfilled', 'packed', 'shipped', 'delivered', 'rto', 'returned']);
		expect(REQUESTED_METHODS).toEqual(['upi', 'card', 'cod']);
		expect(PAYMENT_METHODS).toEqual(['online', 'cod']);
		expect(ORDER_SOURCES).toEqual(['web', 'usual', 'link', 'email', 'refill', 'offer']);
		expect(STATUS.PAID).toBe('paid');
		expect(Object.keys(STATUS_LABELS).sort()).toEqual([...ORDER_STATUSES].sort());
		expect(Object.keys(FULFILMENT_LABELS).sort()).toEqual([...FULFILMENT_STATUSES].sort());
		expect(Object.keys(STATUS_RANK).sort()).toEqual([...ORDER_STATUSES].sort());
		expect(Object.keys(PAYMENT_STATUS_RANK).sort()).toEqual([...PAYMENT_STATUSES].sort());
	});
});

/*
 * The full machine: EXPECTED[status][event] (missing = null = "ignore / not allowed").
 */
const EXPECTED = {
	pending_payment: { paid: 'paid', payment_failed: 'payment_failed', expire: 'expired', retry: 'pending_payment', cancel: 'cancelled', review: 'needs_review' },
	payment_failed: { paid: 'paid', payment_failed: 'payment_failed', expire: 'expired', retry: 'pending_payment', cancel: 'cancelled', review: 'needs_review' },
	expired: { paid: 'paid', expire: 'expired', retry: 'pending_payment', cancel: 'cancelled', review: 'needs_review' },
	paid: { paid: 'paid', review: 'needs_review', refund: 'refunded', partial_refund: 'partially_refunded' },
	cod_pending: { paid: 'needs_review', cancel: 'cancelled', cod_confirm: 'cod_confirmed', review: 'needs_review' },
	cod_confirmed: { paid: 'needs_review', cancel: 'cancelled', cod_confirm: 'cod_confirmed', review: 'needs_review', refund: 'refunded', partial_refund: 'partially_refunded' },
	cancelled: { paid: 'needs_review', cancel: 'cancelled', review: 'needs_review' },
	needs_review: { paid: 'needs_review', cancel: 'cancelled', review: 'needs_review', resolve_paid: 'paid', refund: 'refunded', partial_refund: 'partially_refunded' },
	refunded: { refund: 'refunded' },
	// refund_failed: the partial refund FAILED at Razorpay and nothing of the payment is refunded any more.
	partially_refunded: { review: 'needs_review', refund: 'refunded', partial_refund: 'partially_refunded', refund_failed: 'paid' }
};

describe('nextStatus — full status × event matrix', () => {
	const cells = [];
	for (const s of ORDER_STATUSES) for (const e of ORDER_EVENTS) cells.push([s, e, EXPECTED[s][e] ?? null]);
	it.each(cells)('%s + %s → %s', (s, e, out) => {
		expect(nextStatus(s, e)).toBe(out);
	});

	it('unknown statuses/events and prototype keys → null', () => {
		for (const [s, e] of [
			['paid', 'teleport'],
			['shipped', 'paid'],
			['__proto__', 'paid'],
			['paid', '__proto__'],
			['constructor', 'paid'],
			['paid', 'constructor'],
			['paid', 'toString'],
			[null, 'paid'],
			['paid', undefined],
			[1, 2]
		]) {
			expect(nextStatus(s, e)).toBeNull();
		}
	});

	it('late failures never undo a payment; late payments are honoured', () => {
		expect(nextStatus('paid', 'payment_failed')).toBeNull();
		expect(nextStatus('paid', 'expire')).toBeNull();
		expect(nextStatus('paid', 'retry')).toBeNull();
		expect(nextStatus('paid', 'cancel')).toBeNull(); // refund instead
		expect(nextStatus('payment_failed', 'paid')).toBe('paid');
		expect(nextStatus('expired', 'paid')).toBe('paid');
		expect(nextStatus('expired', 'payment_failed')).toBeNull();
	});

	it('refunded is terminal', () => {
		expect(isTerminal('refunded')).toBe(true);
		for (const s of ORDER_STATUSES.filter((x) => x !== 'refunded')) expect(isTerminal(s)).toBe(false);
		for (const e of ORDER_EVENTS) {
			const n = nextStatus('refunded', e);
			expect(n === null || n === 'refunded').toBe(true);
		}
	});
});

describe('canTransition (admin edits / beforeChange hook)', () => {
	it.each([
		['pending_payment', 'paid', true],
		['pending_payment', 'expired', true],
		['payment_failed', 'paid', true],
		['expired', 'paid', true],
		['expired', 'pending_payment', true],
		['cod_pending', 'cod_confirmed', true],
		['cod_confirmed', 'refunded', true],
		['paid', 'refunded', true],
		['paid', 'partially_refunded', true],
		['partially_refunded', 'refunded', true],
		['needs_review', 'paid', true],
		['paid', 'paid', true],
		['paid', 'pending_payment', false],
		['paid', 'cancelled', false],
		['paid', 'expired', false],
		['paid', 'cod_pending', false],
		['refunded', 'paid', false],
		['refunded', 'needs_review', false],
		['cod_pending', 'paid', false],
		['cancelled', 'paid', false],
		['cancelled', 'pending_payment', false],
		['partially_refunded', 'paid', true], // refund_failed (the admin guard also checks the refunds)
		['paid', 'shipped', false],
		['bogus', 'bogus', false],
		['paid', undefined, false]
	])('%s → %s: %s', (from, to, ok) => {
		expect(canTransition(from, to)).toBe(ok);
	});

	it('agrees with the event table on every pair', () => {
		for (const from of ORDER_STATUSES) {
			for (const to of ORDER_STATUSES) {
				const viaEvent = from === to || ORDER_EVENTS.some((e) => EXPECTED[from][e] === to);
				expect(canTransition(from, to)).toBe(viaEvent);
			}
		}
	});
});

describe('helpers', () => {
	it('initialStatus / paymentMethodFor', () => {
		expect(initialStatus('cod')).toBe('cod_pending');
		expect(initialStatus('upi')).toBe('pending_payment');
		expect(initialStatus('card')).toBe('pending_payment');
		expect(initialStatus(undefined)).toBe('pending_payment');
		expect(paymentMethodFor('cod')).toBe('cod');
		expect(paymentMethodFor('upi')).toBe('online');
		expect(paymentMethodFor('card')).toBe('online');
	});

	it.each([
		['paid', true],
		['cod_pending', true],
		['cod_confirmed', true],
		['partially_refunded', true],
		['pending_payment', false],
		['payment_failed', false],
		['expired', false],
		['cancelled', false],
		['needs_review', false],
		['refunded', false],
		['constructor', false],
		[undefined, false]
	])('isConfirmed(%s) = %s', (s, v) => {
		expect(isConfirmed(s)).toBe(v);
	});

	it.each([
		['pending online', { status: 'pending_payment', paymentMethod: 'online' }, true],
		['failed online', { status: 'payment_failed', paymentMethod: 'online', paymentStatus: 'failed' }, true],
		['expired online', { status: 'expired', requestedMethod: 'upi' }, true],
		['paid', { status: 'paid', paymentMethod: 'online' }, false],
		['cod', { status: 'cod_pending', paymentMethod: 'cod' }, false],
		['cod requested but pending', { status: 'pending_payment', requestedMethod: 'cod' }, false],
		['authorized in flight', { status: 'pending_payment', paymentStatus: 'authorized' }, false],
		['captured in flight', { status: 'payment_failed', paymentStatus: 'captured' }, false],
		['cancelled', { status: 'cancelled' }, false],
		['needs_review', { status: 'needs_review' }, false],
		['attempts left', { status: 'payment_failed', razorpay: { attempts: Array(MAX_PAYMENT_ATTEMPTS - 1).fill({}) } }, true],
		['attempts exhausted', { status: 'payment_failed', razorpay: { attempts: Array(MAX_PAYMENT_ATTEMPTS).fill({}) } }, false],
		['null', null, false],
		['string', 'pending_payment', false]
	])('canRetryPayment: %s → %s', (_label, order, v) => {
		expect(canRetryPayment(order)).toBe(v);
	});

	it('STATUS_RANK follows razorpay.md §12 precedence', () => {
		const r = STATUS_RANK;
		expect(r.refunded).toBeGreaterThan(r.partially_refunded);
		expect(r.partially_refunded).toBeGreaterThan(r.paid);
		expect(r.paid).toBeGreaterThan(r.pending_payment);
		expect(r.pending_payment).toBeGreaterThan(r.payment_failed);
		expect(r.payment_failed).toBeGreaterThan(r.expired);
	});

	it.each([
		['none', 'created', 'created'],
		['created', 'attempted', 'attempted'],
		['attempted', 'failed', 'failed'],
		['failed', 'attempted', 'attempted'], // a retry after a failure
		['failed', 'authorized', 'authorized'], // late authorisation
		['authorized', 'failed', 'authorized'],
		['authorized', 'captured', 'captured'],
		['captured', 'authorized', 'captured'], // out-of-order webhooks
		['captured', 'failed', 'captured'],
		['captured', 'partially_refunded', 'partially_refunded'],
		['partially_refunded', 'refunded', 'refunded'],
		['refunded', 'captured', 'refunded'],
		['captured', 'bogus', 'captured'],
		['bogus', 'created', 'created'],
		['constructor', '__proto__', 'none']
	])('mergePaymentStatus(%s, %s) → %s', (a, b, out) => {
		expect(mergePaymentStatus(a, b)).toBe(out);
	});

	it('razorpayEventToOrderEvent', () => {
		expect(razorpayEventToOrderEvent('order.paid')).toEqual({ orderEvent: 'paid', paymentStatus: 'captured' });
		expect(razorpayEventToOrderEvent('payment.captured')).toEqual({ orderEvent: 'paid', paymentStatus: 'captured' });
		expect(razorpayEventToOrderEvent('payment.authorized')).toEqual({ orderEvent: 'paid', paymentStatus: 'authorized' });
		expect(razorpayEventToOrderEvent('payment.failed')).toEqual({ orderEvent: 'payment_failed', paymentStatus: 'failed' });
		expect(razorpayEventToOrderEvent('refund.processed')).toBeNull();
		expect(razorpayEventToOrderEvent(undefined)).toBeNull();
	});
});

describe('fulfilment', () => {
	const ALLOWED = new Set(['unfulfilled>packed', 'unfulfilled>shipped', 'packed>shipped', 'shipped>delivered', 'shipped>rto', 'delivered>returned']);
	it('only forward moves are allowed', () => {
		for (const a of FULFILMENT_STATUSES) {
			for (const b of FULFILMENT_STATUSES) {
				expect(canFulfilmentTransition(a, b)).toBe(a === b || ALLOWED.has(`${a}>${b}`));
			}
		}
		expect(canFulfilmentTransition('constructor', 'packed')).toBe(false);
		expect(canFulfilmentTransition('unfulfilled', 'constructor')).toBe(false);
		expect(canFulfilmentTransition('shipped', undefined)).toBe(false);
	});

	it.each([
		['paid', true],
		['cod_confirmed', true],
		['partially_refunded', true],
		['cod_pending', false],
		['pending_payment', false],
		['needs_review', false],
		['refunded', false],
		['cancelled', false]
	])('canFulfil(%s) = %s', (s, v) => {
		expect(canFulfil(s)).toBe(v);
	});
});

describe('order numbers', () => {
	it('formats and recognises WF-10001', () => {
		expect(ORDER_NUMBER_START).toBe(10001);
		expect(formatOrderNumber(10001)).toBe('WF-10001');
		expect(formatOrderNumber(123456)).toBe('WF-123456');
		expect(formatOrderNumber(7)).toBe('WF-00007');
		expect(() => formatOrderNumber(0)).toThrow(TypeError);
		expect(() => formatOrderNumber(1.5)).toThrow(TypeError);
		expect(() => formatOrderNumber(Number('x'))).toThrow(TypeError);
		for (const ok of ['WF-10001', 'WF-999999', ' WF-10001 ']) expect(isOrderNumber(ok)).toBe(true);
		for (const bad of ['wf-10001', 'WF-1', 'WF-10001a', 'WF10001', 'WF-' + '9'.repeat(13), '', null, 10001]) expect(isOrderNumber(bad)).toBe(false);
	});
});
