import { describe, it, expect } from 'vitest';
import {
	CODES,
	HTTP_STATUS,
	checkoutErrorCopy,
	errorBody,
	couponReasonCopy,
	codReasonCopy,
	fieldErrorCopy,
	paymentReasonCopy,
	paymentReasonKind
} from '$shared/errors.js';
import { COUPON_REASONS } from '$shared/coupons.js';
import { validateCheckoutForm } from '$shared/validate.js';
import { prng } from './_fixtures.js';

const GENERIC = checkoutErrorCopy('SOMETHING_UNKNOWN');

describe('CODES / HTTP_STATUS', () => {
	it('covers every SPEC §6 error code', () => {
		for (const c of [
			'VALIDATION',
			'PRICE_CHANGED',
			'OUT_OF_STOCK',
			'UNAVAILABLE',
			'PIN_UNSERVICEABLE',
			'COD_UNAVAILABLE',
			'COUPON_INVALID',
			'BELOW_MIN',
			'ABOVE_MAX',
			'RATE_LIMITED',
			'PAYMENTS_UNAVAILABLE',
			'IDEMPOTENCY_MISMATCH',
			'ALREADY_PAID',
			'SIGNATURE_INVALID',
			'NOT_FOUND',
			'UNAUTHORIZED'
		]) {
			expect(CODES[c]).toBe(c);
		}
	});

	it('every code maps to itself, has an HTTP status and its own copy', () => {
		for (const [k, v] of Object.entries(CODES)) {
			expect(k).toBe(v);
			expect(HTTP_STATUS[v]).toBeGreaterThanOrEqual(400);
			const copy = checkoutErrorCopy(v);
			expect(typeof copy).toBe('string');
			expect(copy.length).toBeGreaterThan(5);
			if (v !== 'INTERNAL') expect(copy).not.toBe(GENERIC);
		}
		expect(Object.keys(HTTP_STATUS).sort()).toEqual(Object.keys(CODES).sort());
		expect(HTTP_STATUS.PAYMENTS_UNAVAILABLE).toBe(503);
		expect(HTTP_STATUS.RATE_LIMITED).toBe(429);
		expect(HTTP_STATUS.NOT_FOUND).toBe(404);
		expect(Object.isFrozen(CODES)).toBe(true);
	});
});

describe('checkoutErrorCopy', () => {
	it.each([
		['OUT_OF_STOCK', { name: 'Rolled Oats', available: 0 }, 'Rolled Oats just sold out — remove it to continue.'],
		['OUT_OF_STOCK', { name: 'Rolled Oats', available: 1 }, 'Only 1 pack of Rolled Oats left — reduce the quantity to continue.'],
		['OUT_OF_STOCK', { name: 'Muesli', available: 3 }, 'Only 3 packs of Muesli left — reduce the quantity to continue.'],
		['OUT_OF_STOCK', {}, 'An item in your bag just sold out — remove it to continue.'],
		['UNAVAILABLE', { name: 'Granola' }, 'Granola is no longer available — remove it to continue.'],
		['UNAVAILABLE', undefined, 'An item in your bag is no longer available — remove it to continue.'],
		['QTY_LIMIT', { name: 'Muesli', max: 10 }, 'You can order up to 10 packs of Muesli at a time.'],
		['PIN_UNSERVICEABLE', { pin: '744101' }, 'Sorry, we don’t deliver to 744101 yet.'],
		['PIN_UNSERVICEABLE', { pin: '<script>' }, 'Sorry, we don’t deliver to that PIN code yet.'],
		['ABOVE_MAX', { limitPaise: 5000000 }, 'Orders above ₹50,000 can’t be placed online — please split it or message us.'],
		['COD_UNAVAILABLE', { reason: 'ABOVE_MAX', codMaxPaise: 200000 }, 'Cash on delivery is available on orders up to ₹2,000 — please pay online.'],
		['COD_UNAVAILABLE', {}, 'Cash on delivery isn’t available for this order — please pay online.'],
		['COUPON_INVALID', { reason: 'EXPIRED' }, 'That offer has expired.'],
		['PAYMENTS_UNAVAILABLE', undefined, 'Payments are temporarily unavailable. Try again, or choose Cash on Delivery.'],
		['EMPTY_CART', undefined, 'Your bag is empty.']
	])('%s %j', (code, details, out) => {
		expect(checkoutErrorCopy(code, details)).toBe(out);
	});

	it('signature problems never say "failed"', () => {
		expect(checkoutErrorCopy('SIGNATURE_INVALID')).not.toMatch(/fail/i);
		expect(checkoutErrorCopy('PAYMENT_MISMATCH')).not.toMatch(/fail/i);
	});

	it('never renders undefined/NaN/[object …] for random details', () => {
		const r = prng(71);
		const junk = [undefined, null, 0, -1, 1.5, NaN, '', 'x', {}, [], true, 'Muesli', 3, 200000];
		for (let i = 0; i < 3000; i++) {
			const code = r.pick([...Object.keys(CODES), 'NOPE']);
			const details = r.bool(0.1)
				? r.pick(junk)
				: { name: r.pick(junk), available: r.pick(junk), max: r.pick(junk), pin: r.pick(junk), reason: r.pick([...COUPON_REASONS, 'ABOVE_MAX', 'DISABLED', r.pick(junk)]), limitPaise: r.pick(junk), minSubtotalPaise: r.pick(junk), subtotalPaise: r.pick(junk), codMaxPaise: r.pick(junk) };
			const s = checkoutErrorCopy(code, details);
			expect(s).not.toMatch(/undefined|NaN|\[object|null/);
			expect(s.length).toBeGreaterThan(5);
		}
	});
});

describe('errorBody', () => {
	it('matches the SPEC error envelope', () => {
		expect(errorBody('OUT_OF_STOCK', { slug: 'muesli', name: 'Muesli', available: 0 })).toEqual({
			error: { code: 'OUT_OF_STOCK', message: 'Muesli just sold out — remove it to continue.', details: { slug: 'muesli', name: 'Muesli', available: 0 } }
		});
		expect(errorBody('RATE_LIMITED')).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many attempts — please wait a minute and try again.' } });
	});
});

describe('couponReasonCopy', () => {
	it('has distinct copy for every reason', () => {
		const seen = new Set();
		for (const r of COUPON_REASONS) {
			const s = couponReasonCopy(r);
			expect(s).toMatch(/offer/);
			seen.add(s);
		}
		expect(seen.size).toBe(COUPON_REASONS.length);
	});

	it('MIN_SUBTOTAL tells you how much more to add', () => {
		expect(couponReasonCopy('MIN_SUBTOTAL', { minSubtotalPaise: 49900, subtotalPaise: 42400 })).toBe('Add ₹75 more to use this offer.');
		expect(couponReasonCopy('MIN_SUBTOTAL', { minSubtotalPaise: 49900 })).toBe('This offer needs a bag of ₹499 or more.');
		expect(couponReasonCopy('MIN_SUBTOTAL')).toBe('Add a little more to your bag to use this offer.');
		expect(couponReasonCopy('WHATEVER')).toBe('That offer can’t be applied to this order.');
	});
});

describe('codReasonCopy', () => {
	it.each([
		['DISABLED', {}, 'Cash on delivery isn’t available right now — please pay online.'],
		['ITEM_NOT_ALLOWED', { name: 'Muesli' }, 'Cash on delivery isn’t available for Muesli — please pay online.'],
		['PIN_BLOCKED', {}, 'Cash on delivery isn’t available for your PIN code yet — please pay online.'],
		['BELOW_MIN', { codMinSubtotalPaise: 19900 }, 'Cash on delivery is available on orders of ₹199 or more.'],
		['ABOVE_MAX', { codMaxPaise: 200000 }, 'Cash on delivery is available on orders up to ₹2,000 — please pay online.'],
		['TOO_MANY_OPEN', {}, 'You already have cash-on-delivery orders on the way — please pay online for this one.'],
		['EMPTY', {}, 'Add something to your bag first.'],
		['???', {}, 'Cash on delivery isn’t available for this order — please pay online.']
	])('%s', (reason, details, out) => {
		expect(codReasonCopy(reason, details)).toBe(out);
	});
});

describe('fieldErrorCopy', () => {
	it('has specific copy for every error validateCheckoutForm can produce', () => {
		const samples = [
			{},
			{ name: 'A', email: 'x', phone: '1', line1: 'ab', city: 'B', state: 'Nowhere', pin: '0' },
			{ name: 'A'.repeat(99), email: 'a'.repeat(260) + '@x.com', line1: 'x'.repeat(300), city: 'x'.repeat(70), pin: '060001' },
			{ name: '123', city: '123', email: {}, phone: {}, pin: {} }
		];
		const generic = fieldErrorCopy('nope', 'nope');
		let checked = 0;
		for (const s of samples) {
			const { errors } = validateCheckoutForm(s, { blockedPinPrefixes: [] });
			for (const [field, code] of Object.entries(errors)) {
				expect(fieldErrorCopy(field, code)).not.toBe(generic);
				checked++;
			}
		}
		expect(fieldErrorCopy('pin', 'UNSERVICEABLE')).toBe('Sorry, we don’t deliver to this PIN code yet.');
		expect(fieldErrorCopy('phone', 'INVALID')).toBe('Enter a valid 10-digit Indian mobile number.');
		expect(checked).toBeGreaterThan(15);
	});
});

describe('paymentReasonCopy / paymentReasonKind (razorpay.md §13 J.71)', () => {
	it.each([
		['payment_cancelled', 'cancelled', 'No money was taken. Try again.'],
		['payment_timed_out', 'cancelled', 'No money was taken. Try again.'],
		['payment_session_expired', 'cancelled', 'No money was taken. Try again.'],
		['insufficient_funds', 'declined', 'That payment didn’t go through. Try another card or UPI.'],
		['card_declined', 'declined', 'That payment didn’t go through. Try another card or UPI.'],
		['payment_pending', 'pending', 'Your bank is still processing this payment. We’ll confirm as soon as it clears — please don’t pay twice.'],
		['deemed_transaction', 'pending', 'Your bank is still processing this payment. We’ll confirm as soon as it clears — please don’t pay twice.'],
		['order_already_paid', 'already_paid', 'This order is already paid — taking you to your order.'],
		['payment_risk_check_failed', 'risk', 'That payment couldn’t be completed. Try a different method.'],
		['authentication_failed', 'auth_failed', 'The payment couldn’t be verified with your bank. Try again, or use another card or UPI.'],
		['bank_technical_error', 'technical', 'Your bank or UPI app had a technical problem. Try again in a moment, or use another method.'],
		['payment_failed', 'unknown', 'Payment didn’t go through. Try again, or choose Pay on delivery.'],
		['something_new', 'unknown', 'Payment didn’t go through. Try again, or choose Pay on delivery.']
	])('%s → %s', (reason, kind, copy) => {
		expect(paymentReasonKind(reason)).toBe(kind);
		expect(paymentReasonCopy(reason)).toBe(copy);
	});

	it('is case- and whitespace-insensitive; non-strings are unknown', () => {
		expect(paymentReasonKind(' PAYMENT_CANCELLED ')).toBe('cancelled');
		for (const v of [undefined, null, 42, {}, ['payment_cancelled']]) {
			expect(paymentReasonKind(v)).toBe('unknown');
			expect(paymentReasonCopy(v)).toBe('Payment didn’t go through. Try again, or choose Pay on delivery.');
		}
		expect(paymentReasonKind('__proto__')).toBe('unknown');
		expect(paymentReasonKind('constructor')).toBe('unknown');
	});

	it('only claims "no money was taken" for cancel/timeout reasons', () => {
		for (const r of ['insufficient_funds', 'payment_pending', 'bank_technical_error', 'authentication_failed', 'payment_failed', 'xyz']) {
			expect(paymentReasonCopy(r)).not.toMatch(/no money was taken/i);
		}
	});
});
