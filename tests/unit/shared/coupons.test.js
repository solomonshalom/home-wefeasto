import { describe, it, expect } from 'vitest';
import { evaluateCoupon, normalizeCouponCode, buildWelcomeCoupon, toMillis, COUPON_REASONS, COUPON_TYPES, COUPON_INVALID } from '$shared/coupons.js';
import { resolveSettings } from '$shared/settings.js';

const NOW = Date.parse('2026-09-25T10:00:00Z');
const DAY = 86_400_000;
const base = (extra = {}) => ({ code: 'WELCOME10', type: 'percent', value: 10, maxDiscountPaise: 7500, active: true, usedCount: 0, ...extra });
const ctx = (extra = {}) => ({ subtotalPaise: 42500, deliveryPaise: 4900, codFeePaise: 0, now: NOW, ...extra });
const reason = (r) => r.error?.reason ?? null;

describe('normalizeCouponCode', () => {
	it.each([
		[' welcome10 ', 'WELCOME10'],
		['wf-2026_x', 'WF-2026_X'],
		['ABC', 'ABC'],
		['A'.repeat(32), 'A'.repeat(32)]
	])('%j → %j', (raw, out) => expect(normalizeCouponCode(raw)).toBe(out));

	it.each([['AB'], ['A'.repeat(33)], ['-ABC'], ['_ABC'], ['ABC DEF'], ['ABC!'], ['ÅBC'], [''], [null], [10], [{}]])('%j → null', (raw) => {
		expect(normalizeCouponCode(raw)).toBeNull();
	});
});

describe('toMillis', () => {
	it('reads numbers, ISO strings and Dates', () => {
		expect(toMillis(NOW)).toBe(NOW);
		expect(toMillis('2026-09-25T10:00:00Z')).toBe(NOW);
		expect(toMillis(new Date(NOW))).toBe(NOW);
	});
	it.each([[NaN], [Infinity], ['not a date'], [''], [new Date('x')], [null], [undefined], [{}]])('%j → null', (v) => {
		expect(toMillis(v)).toBeNull();
	});
});

describe('evaluateCoupon — reasons', () => {
	it('reason list and types are as specified', () => {
		expect(COUPON_REASONS).toEqual(['NOT_FOUND', 'INACTIVE', 'NOT_STARTED', 'EXPIRED', 'USAGE_LIMIT', 'EMAIL_MISMATCH', 'FIRST_ORDER_ONLY', 'PER_CUSTOMER_LIMIT', 'MIN_SUBTOTAL']);
		expect(COUPON_TYPES).toEqual(['percent', 'fixed', 'free_delivery']);
		expect(COUPON_INVALID).toBe('COUPON_INVALID');
	});

	it.each([
		['null coupon', null, {}, 'NOT_FOUND'],
		['undefined coupon', undefined, {}, 'NOT_FOUND'],
		['non-object', 'WELCOME10', {}, 'NOT_FOUND'],
		['inactive', base({ active: false }), {}, 'INACTIVE'],
		['unknown type', base({ type: 'bogo' }), {}, 'INACTIVE'],
		['percent 0', base({ value: 0 }), {}, 'INACTIVE'],
		['percent 101', base({ value: 101 }), {}, 'INACTIVE'],
		['percent 12.5', base({ value: 12.5 }), {}, 'INACTIVE'],
		['fixed 0', base({ type: 'fixed', value: 0 }), {}, 'INACTIVE'],
		['fixed -500', base({ type: 'fixed', value: -500 }), {}, 'INACTIVE'],
		['fixed 1.5', base({ type: 'fixed', value: 1.5 }), {}, 'INACTIVE'],
		['usageLimit -1', base({ usageLimit: -1 }), {}, 'INACTIVE'],
		['usedCount "3"', base({ usedCount: '3' }), {}, 'INACTIVE'],
		['maxDiscount NaN', base({ maxDiscountPaise: NaN }), {}, 'INACTIVE'],
		['unparseable startsAt', base({ startsAt: 'soon' }), {}, 'INACTIVE'],
		['unparseable endsAt', base({ endsAt: 'later' }), {}, 'INACTIVE'],
		['not started', base({ startsAt: NOW + 1 }), {}, 'NOT_STARTED'],
		['starts now', base({ startsAt: NOW }), {}, null],
		['expired', base({ endsAt: NOW - DAY }), {}, 'EXPIRED'],
		['ends exactly now (exclusive)', base({ endsAt: NOW }), {}, 'EXPIRED'],
		['ends in 1 ms', base({ endsAt: NOW + 1 }), {}, null],
		['ISO window', base({ startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }), {}, null],
		['Date window', base({ startsAt: new Date(NOW - DAY), endsAt: new Date(NOW + DAY) }), {}, null],
		['usage exhausted', base({ usageLimit: 5, usedCount: 5 }), {}, 'USAGE_LIMIT'],
		['usage limit 0', base({ usageLimit: 0 }), {}, 'USAGE_LIMIT'],
		['one use left', base({ usageLimit: 5, usedCount: 4 }), {}, null],
		['usedCount missing', base({ usageLimit: 1, usedCount: undefined }), {}, null],
		['bound email matches (normalised)', base({ boundEmail: 'asha@example.com' }), { email: '  ASHA@Example.com ' }, null],
		['bound email mismatch', base({ boundEmail: 'asha@example.com' }), { email: 'ravi@example.com' }, 'EMAIL_MISMATCH'],
		['bound email vs invalid email', base({ boundEmail: 'asha@example.com' }), { email: 'not-an-email' }, 'EMAIL_MISMATCH'],
		['first order only, repeat customer', base({ firstOrderOnly: true }), { isFirstOrder: false }, 'FIRST_ORDER_ONLY'],
		['first order only, first order', base({ firstOrderOnly: true }), { isFirstOrder: true }, null],
		['per-customer limit reached', base({ perCustomerLimit: 1 }), { customerUsageCount: 1 }, 'PER_CUSTOMER_LIMIT'],
		['per-customer limit free', base({ perCustomerLimit: 2 }), { customerUsageCount: 1 }, null],
		['min subtotal not met', base({ minSubtotalPaise: 50000 }), {}, 'MIN_SUBTOTAL'],
		['min subtotal met exactly', base({ minSubtotalPaise: 42500 }), {}, null]
	])('%s → %s', (_label, coupon, extra, expected) => {
		const r = evaluateCoupon(coupon, ctx(extra));
		expect(reason(r)).toBe(expected);
		if (expected) {
			expect(r.error).toEqual({ code: 'COUPON_INVALID', reason: expected });
			expect(r.discountPaise).toBe(0);
		}
	});

	it('checks in the documented order (first failing reason wins)', () => {
		let c = { ...base(), active: false, startsAt: NOW + DAY, endsAt: NOW - DAY, usageLimit: 1, usedCount: 1, boundEmail: 'a@b.co', firstOrderOnly: true, perCustomerLimit: 1, minSubtotalPaise: 10 ** 9 };
		const x = { email: 'z@y.co', isFirstOrder: false, customerUsageCount: 5 };
		const seen = [];
		const fixes = [
			['INACTIVE', () => (c = { ...c, active: true })],
			['NOT_STARTED', () => (c = { ...c, startsAt: null })],
			['EXPIRED', () => (c = { ...c, endsAt: null })],
			['USAGE_LIMIT', () => (c = { ...c, usageLimit: null })],
			['EMAIL_MISMATCH', () => (c = { ...c, boundEmail: null })],
			['FIRST_ORDER_ONLY', () => (c = { ...c, firstOrderOnly: false })],
			['PER_CUSTOMER_LIMIT', () => (c = { ...c, perCustomerLimit: null })],
			['MIN_SUBTOTAL', () => (c = { ...c, minSubtotalPaise: null })]
		];
		for (const [expected, fix] of fixes) {
			seen.push(reason(evaluateCoupon(c, ctx(x))));
			expect(seen.at(-1)).toBe(expected);
			fix();
		}
		expect(evaluateCoupon(c, ctx(x)).error).toBeNull();
	});

	it('identity checks are deferred when identity is unknown', () => {
		const c = base({ boundEmail: 'asha@example.com', firstOrderOnly: true, perCustomerLimit: 1 });
		const r = evaluateCoupon(c, ctx());
		expect(r.error).toBeNull();
		expect(r.deferredChecks).toEqual(['EMAIL', 'FIRST_ORDER', 'PER_CUSTOMER']);
		expect(evaluateCoupon(c, ctx({ email: '', isFirstOrder: 'yes', customerUsageCount: -1 })).deferredChecks).toEqual(['EMAIL', 'FIRST_ORDER', 'PER_CUSTOMER']);
		expect(evaluateCoupon(c, ctx({ email: 'asha@example.com', isFirstOrder: true, customerUsageCount: 0 })).deferredChecks).toEqual([]);
		expect(evaluateCoupon(base(), ctx()).deferredChecks).toEqual([]);
	});

	it('a dated coupon without ctx.now is a programming error', () => {
		expect(() => evaluateCoupon(base({ endsAt: NOW + DAY }), { subtotalPaise: 42500 })).toThrow(TypeError);
		expect(() => evaluateCoupon(base({ startsAt: NOW }), { subtotalPaise: 42500, now: 'garbage' })).toThrow(TypeError);
		expect(evaluateCoupon(base(), { subtotalPaise: 42500 }).discountPaise).toBe(4200); // undated: no clock needed
	});
});

describe('evaluateCoupon — discount maths', () => {
	it.each([
		['10% of ₹425 floors to ₹42', base({ maxDiscountPaise: null }), { subtotalPaise: 42500 }, 4200, false],
		['10% of ₹175', base(), { subtotalPaise: 17500 }, 1700, false],
		['10% of ₹250', base(), { subtotalPaise: 25000 }, 2500, false],
		['10% capped at ₹75', base(), { subtotalPaise: 100000 }, 7500, false],
		['33% of ₹175 = ₹57.75 → ₹57', base({ value: 33, maxDiscountPaise: null }), { subtotalPaise: 17500 }, 5700, false],
		['cap 0', base({ maxDiscountPaise: 0 }), { subtotalPaise: 42500 }, 0, false],
		['fixed ₹50', base({ type: 'fixed', value: 5000, maxDiscountPaise: null }), { subtotalPaise: 17500 }, 5000, false],
		['fixed ₹500 on ₹175 → subtotal', base({ type: 'fixed', value: 50000, maxDiscountPaise: null }), { subtotalPaise: 17500 }, 17500, true],
		['fixed ₹500 on free-delivery ₹500 → ₹1 floor', base({ type: 'fixed', value: 50000, maxDiscountPaise: null }), { subtotalPaise: 50000, deliveryPaise: 0 }, 49900, true],
		['100% with delivery → whole subtotal', base({ value: 100, maxDiscountPaise: null }), { subtotalPaise: 17500 }, 17500, false],
		['100% free delivery → ₹1 floor', base({ value: 100, maxDiscountPaise: null }), { subtotalPaise: 50000, deliveryPaise: 0 }, 49900, true],
		['100% + COD fee keeps ₹1 via the fee', base({ value: 100, maxDiscountPaise: null }), { subtotalPaise: 50000, deliveryPaise: 0, codFeePaise: 2500 }, 50000, false],
		['free_delivery = fee', base({ type: 'free_delivery', value: undefined, maxDiscountPaise: null }), { subtotalPaise: 17500, deliveryPaise: 4900 }, 4900, false],
		['free_delivery when already free', base({ type: 'free_delivery', maxDiscountPaise: null }), { subtotalPaise: 50000, deliveryPaise: 0 }, 0, false],
		['free_delivery capped by subtotal', base({ type: 'free_delivery', maxDiscountPaise: null }), { subtotalPaise: 3000, deliveryPaise: 4900 }, 3000, true],
		['empty bag → 0', base(), { subtotalPaise: 0, deliveryPaise: 0 }, 0, false],
		['junk subtotal → 0', base(), { subtotalPaise: -5, deliveryPaise: 'x' }, 0, false]
	])('%s', (_label, coupon, c, discount, clamped) => {
		const r = evaluateCoupon(coupon, { deliveryPaise: 4900, now: NOW, ...c });
		expect(r.error).toBeNull();
		expect(r.discountPaise).toBe(discount);
		expect(r.clamped).toBe(clamped);
		expect(Number.isSafeInteger(r.discountPaise)).toBe(true);
	});
});

describe('buildWelcomeCoupon', () => {
	it('builds a single-use, first-order, email-bound percent coupon from settings', () => {
		const c = buildWelcomeCoupon({ code: 'welcome-7k2m9q', email: ' Asha@Example.com ', now: NOW, settings: resolveSettings() });
		expect(c).toEqual({
			code: 'WELCOME-7K2M9Q',
			type: 'percent',
			value: 10,
			maxDiscountPaise: 7500,
			minSubtotalPaise: null,
			startsAt: '2026-09-25T10:00:00.000Z',
			endsAt: '2026-10-25T10:00:00.000Z',
			usageLimit: 1,
			usedCount: 0,
			perCustomerLimit: 1,
			firstOrderOnly: true,
			boundEmail: 'asha@example.com',
			active: true
		});
		const ok = evaluateCoupon(c, { subtotalPaise: 42500, deliveryPaise: 4900, now: NOW + DAY, email: 'asha@example.com', isFirstOrder: true, customerUsageCount: 0 });
		expect(ok).toEqual({ discountPaise: 4200, error: null, clamped: false, deferredChecks: [] });
		expect(reason(evaluateCoupon(c, { subtotalPaise: 42500, now: NOW + 30 * DAY }))).toBe('EXPIRED');
		expect(reason(evaluateCoupon({ ...c, usedCount: 1 }, { subtotalPaise: 42500, now: NOW }))).toBe('USAGE_LIMIT');
	});

	it('honours welcomeOffer overrides and falls back on junk', () => {
		const c = buildWelcomeCoupon({ code: 'HELLO15', email: 'a@b.co', now: NOW, settings: { welcomeOffer: { percent: 15, maxDiscountPaise: 10000, validDays: 7 } } });
		expect(c).toMatchObject({ value: 15, maxDiscountPaise: 10000, endsAt: new Date(NOW + 7 * DAY).toISOString() });
		const d = buildWelcomeCoupon({ code: 'HELLO', email: 'a@b.co', now: NOW });
		expect(d).toMatchObject({ value: 10, maxDiscountPaise: 7500, endsAt: new Date(NOW + 30 * DAY).toISOString() });
	});

	it('throws on a bad code, email or clock', () => {
		expect(() => buildWelcomeCoupon({ code: 'x', email: 'a@b.co', now: NOW })).toThrow(TypeError);
		expect(() => buildWelcomeCoupon({ code: 'HELLO', email: 'nope', now: NOW })).toThrow(TypeError);
		expect(() => buildWelcomeCoupon({ code: 'HELLO', email: 'a@b.co', now: undefined })).toThrow(TypeError);
	});
});
