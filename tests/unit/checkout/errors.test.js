/*
 * Error code → UI mapping: every code a checkout / retry / verify call can
 * return has human copy (never the code itself, never "undefined") and the
 * right action.
 */
import { describe, it, expect } from 'vitest';
import { describeError, KNOWN_CODES, NO_MONEY_TAKEN, MONEY_UNSURE, mayAuthoriseLate, resolvedByQuote } from '$lib/checkout/errors.js';
import { quote } from '$shared/pricing.js';
import { paymentReasonKind } from '$shared/errors.js';
import { CODES } from '$shared/errors.js';

const TABLE = [
	// code, details, ctx, kind, actions, message fragment
	['VALIDATION', { fields: { phone: 'INVALID', pin: 'REQUIRED' } }, {}, 'fields', ['focus-field'], 'highlighted'],
	['VALIDATION', null, {}, 'fields', [], 'highlighted'],
	['PIN_UNSERVICEABLE', { pin: '999999' }, {}, 'fields', ['focus-field'], 'don’t deliver to 999999'],
	['PRICE_CHANGED', { quote: { totalPaise: 52400, lines: [], issues: [] } }, {}, 'price', ['use-quote'], 'Prices changed'],
	['PRICE_CHANGED', null, {}, 'price', ['refresh-quote'], 'Prices changed'],
	['OUT_OF_STOCK', { issues: [{ slug: 'rolled-oats', name: 'Rolled Oats', code: 'OUT_OF_STOCK', available: 0 }] }, {}, 'lines', ['refresh-quote'], 'Rolled Oats just sold out'],
	['OUT_OF_STOCK', { issues: [{ slug: 'muesli', name: 'Muesli', code: 'OUT_OF_STOCK', available: 2 }] }, {}, 'lines', ['refresh-quote'], 'Only 2 packs of Muesli left'],
	['UNAVAILABLE', { issues: [{ slug: 'x', name: 'Choco Flakes', code: 'UNAVAILABLE' }] }, {}, 'lines', ['refresh-quote'], 'Choco Flakes is no longer available'],
	['QTY_LIMIT', { slug: 'muesli', name: 'Muesli', max: 10 }, {}, 'lines', ['refresh-quote'], 'up to 10 packs of Muesli'],
	['BAD_QTY', null, {}, 'lines', ['refresh-quote'], 'quantities'],
	['BAD_SLUG', null, {}, 'lines', ['refresh-quote'], 'no longer available'],
	['COD_UNAVAILABLE', { reason: 'ABOVE_MAX', codMaxPaise: 200000 }, {}, 'cod', ['disable-cod'], 'up to ₹2,000'],
	['COD_UNAVAILABLE', { reason: 'TOO_MANY_OPEN' }, {}, 'cod', ['disable-cod'], 'already have cash-on-delivery orders'],
	['COD_UNAVAILABLE', null, {}, 'cod', ['disable-cod'], 'Cash on delivery isn’t available'],
	['COUPON_INVALID', { reason: 'EXPIRED' }, {}, 'coupon', ['remove-offer'], 'expired'],
	['COUPON_INVALID', { reason: 'EMAIL_MISMATCH' }, {}, 'coupon', ['remove-offer'], 'different email'],
	['PAYMENTS_UNAVAILABLE', null, { status: 503 }, 'payments', ['offer-cod'], 'Cash on Delivery'],
	['UNAVAILABLE', null, { status: 503 }, 'payments', ['offer-cod'], 'Cash on Delivery'],
	['RATE_LIMITED', null, { status: 429 }, 'rate', [], 'wait a minute'],
	['IDEMPOTENCY_MISMATCH', null, {}, 'key', ['new-key'], 'tap the button again'],
	['IDEMPOTENCY_KEY_REQUIRED', null, {}, 'key', ['new-key'], 'tap the button again'],
	['ALREADY_PAID', null, { stage: 'retry' }, 'order', ['goto-order'], 'already paid'],
	['SIGNATURE_INVALID', null, { stage: 'verify' }, 'order', ['goto-order'], 'confirming your payment'],
	['PAYMENT_MISMATCH', null, { stage: 'verify' }, 'order', ['goto-order'], 'confirming your payment'],
	['NOT_RETRYABLE', null, { stage: 'retry' }, 'dead', ['new-key'], 'place a new order'],
	['EMPTY_CART', null, {}, 'empty', ['refresh-quote'], 'bag is empty'],
	['BELOW_MIN', null, {}, 'limit', [], 'too low'],
	['ABOVE_MAX', { limitPaise: 5000000 }, {}, 'limit', [], '₹50,000'],
	['TOO_MANY_LINES', null, {}, 'limit', [], 'too many different items'],
	['NETWORK', null, { status: 0 }, 'network', [], 'couldn’t reach Wefeasto'],
	['TIMEOUT', null, { status: 0 }, 'network', [], 'too long'],
	['NOT_FOUND', null, { stage: 'checkout', status: 404 }, 'generic', [], 'Checkout isn’t available right now'],
	['NOT_FOUND', null, { stage: 'retry', status: 404 }, 'generic', [], 'couldn’t find that order'],
	['INTERNAL', null, { status: 500 }, 'generic', [], 'went wrong'],
	['BAD_RESPONSE', null, { status: 200 }, 'generic', [], 'went wrong'],
	['CONFLICT', null, { status: 409 }, 'generic', [], 'went wrong'],
	[undefined, null, {}, 'generic', [], 'went wrong']
];

describe('describeError', () => {
	it.each(TABLE)('%s %j → %s', (code, details, ctx, kind, actions, fragment) => {
		const ui = describeError(code, details, ctx);
		expect(ui.kind).toBe(kind);
		expect(ui.actions).toEqual(actions);
		expect(ui.message).toContain(fragment);
		expect(ui.message).not.toMatch(/undefined|NaN|\[object/);
	});

	it('VALIDATION carries field messages keyed by validate field', () => {
		expect(describeError('VALIDATION', { fields: { phone: 'INVALID', line1: 'TOO_SHORT' } }).fields).toEqual({
			phone: 'Enter a valid 10-digit Indian mobile number.',
			line1: 'Add a little more detail to your address.'
		});
	});

	it('PIN_UNSERVICEABLE lands on the pin field', () => {
		expect(describeError('PIN_UNSERVICEABLE', { pin: '194101' }).fields).toEqual({ pin: 'Sorry, we don’t deliver to 194101 yet.' });
	});

	it('PRICE_CHANGED hands over the new quote', () => {
		const quote = { totalPaise: 1, lines: [], issues: [] };
		expect(describeError('PRICE_CHANGED', { quote }).quote).toBe(quote);
	});

	it('stock errors pass the issues through', () => {
		const issues = [{ slug: 'a', code: 'OUT_OF_STOCK', available: 0 }];
		expect(describeError('OUT_OF_STOCK', { issues }).issues).toBe(issues);
	});

	it('every shared CODE (and the transport codes) is in the table and never yields a bare code', () => {
		for (const code of [...Object.values(CODES), 'NETWORK', 'TIMEOUT', 'ABORTED', 'BAD_RESPONSE']) {
			for (const stage of ['checkout', 'retry', 'verify']) {
				const ui = describeError(code, { junk: true }, { stage });
				expect(typeof ui.message).toBe('string');
				expect(ui.message.length).toBeGreaterThan(10);
				expect(ui.message).not.toBe(code);
				expect(ui.message).not.toMatch(/undefined|NaN/);
			}
		}
		for (const code of KNOWN_CODES) expect(describeError(code).code).toBe(code);
	});
});

describe('failed-payment copy', () => {
	it('mayAuthoriseLate: the timeout family only (case-insensitive), never a decline or a cancel', () => {
		for (const r of ['payment_timed_out', 'request_timed_out', 'payment_session_expired', 'payment_collect_request_expired', ' Payment_Timed_Out ']) {
			expect(mayAuthoriseLate(r)).toBe(true);
		}
		for (const r of ['payment_cancelled', 'card_declined', 'payment_pending', 'bank_technical_error', '', null, undefined, 42]) {
			expect(mayAuthoriseLate(r)).toBe(false);
		}
		// $shared files the timeouts as 'cancelled' (Try again) — that's why the page asks this separately.
		expect(paymentReasonKind('payment_timed_out')).toBe('cancelled');
	});

	it('the unsure line never promises "no money was taken", and says what happens to any money', () => {
		expect(NO_MONEY_TAKEN).toBe('Payment didn’t go through — no money was taken.');
		expect(MONEY_UNSURE).not.toMatch(/no money/i);
		expect(MONEY_UNSURE).toMatch(/confirm your order or refund it automatically/);
	});
});

describe('resolvedByQuote (W2V2-4: a refusal a newer quote has fixed loses its note)', () => {
	const CATALOG = [
		{ slug: 'muesli', name: 'Muesli', pricePaise: 25000 },
		{ slug: 'cornflakes', name: 'Cornflakes', pricePaise: 17500 }
	];
	const SETTINGS = { freeDeliveryThresholdPaise: 49900, deliveryFeePaise: 4900, codEnabled: true, codFeePaise: 0, codMaxPaise: 200000, codMinSubtotalPaise: 0, blockedPinPrefixes: ['1941'] };
	const BOUND = { code: 'ASHA10', type: 'percent', value: 10, maxDiscountPaise: 7500, active: true, boundEmail: 'asha@example.com' };
	const q = ({ items = [{ slug: 'muesli', qty: 1 }], catalog = CATALOG, coupon = null, email, pin, settings = SETTINGS } = {}) =>
		quote({ items, catalog, settings, coupon, method: 'cod', context: { email, pin, couponCode: coupon?.code } });

	it('COUPON_INVALID: resolved once the quote applies the offer (the email was corrected), not while it still refuses', () => {
		const e = describeError('COUPON_INVALID', { reason: 'EMAIL_MISMATCH' });
		const wrong = q({ coupon: BOUND, email: 'someone@example.com' });
		const right = q({ coupon: BOUND, email: 'asha@example.com' });
		expect(wrong.couponError).toMatchObject({ reason: 'EMAIL_MISMATCH' });
		expect(right.coupon).toMatchObject({ code: 'ASHA10' });
		expect(resolvedByQuote(e, wrong)).toBe(false);
		expect(resolvedByQuote(e, right)).toBe(true);
		expect(resolvedByQuote(e, q())).toBe(false); // no offer in the quote at all: nothing was applied
	});

	it('stock refusals: resolved only when every line is priced with no issue', () => {
		const e = describeError('OUT_OF_STOCK', { issues: [{ slug: 'cornflakes', name: 'Cornflakes', code: 'OUT_OF_STOCK', available: 0 }] });
		const soldOut = CATALOG.map((p) => (p.slug === 'cornflakes' ? { ...p, inStock: false } : p));
		expect(resolvedByQuote(e, q({ items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }], catalog: soldOut }))).toBe(false);
		expect(resolvedByQuote(e, q({ items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }] }))).toBe(true);
		expect(resolvedByQuote(e, q({ items: [] }))).toBe(false); // an empty bag has its own state
	});

	it('order limits: resolved when the quote has no orderError', () => {
		const e = describeError('ABOVE_MAX', { limitPaise: 1000000 });
		expect(resolvedByQuote(e, q({ settings: { ...SETTINGS, maxOrderPaise: 10000 } }))).toBe(false);
		expect(resolvedByQuote(e, q())).toBe(true);
	});

	it('PIN_UNSERVICEABLE: resolved by a quote that serves the (new) PIN; other field errors never', () => {
		const e = describeError('PIN_UNSERVICEABLE', { pin: '194101' });
		expect(resolvedByQuote(e, q({ pin: '194101' }))).toBe(false);
		expect(resolvedByQuote(e, q())).toBe(false); // no PIN in the ask: pinServiceable is null
		expect(resolvedByQuote(e, q({ pin: '560001' }))).toBe(true);
		expect(resolvedByQuote(describeError('VALIDATION', { fields: { phone: 'INVALID' } }), q({ pin: '560001' }))).toBe(false);
	});

	it('refusals a quote cannot speak to never resolve; junk in → false', () => {
		const good = q({ coupon: BOUND, email: 'asha@example.com', pin: '560001' });
		for (const code of ['PRICE_CHANGED', 'COD_UNAVAILABLE', 'PAYMENTS_UNAVAILABLE', 'RATE_LIMITED', 'IDEMPOTENCY_MISMATCH', 'NETWORK', 'INTERNAL', 'NOT_RETRYABLE']) {
			expect(resolvedByQuote(describeError(code, { reason: 'TOO_MANY_OPEN' }), good)).toBe(false);
		}
		expect(resolvedByQuote(null, good)).toBe(false);
		expect(resolvedByQuote(describeError('COUPON_INVALID', { reason: 'EMAIL_MISMATCH' }), null)).toBe(false);
		expect(resolvedByQuote(describeError('COUPON_INVALID', { reason: 'EMAIL_MISMATCH' }), { coupon: { code: 'X' } })).toBe(false);
	});
});
