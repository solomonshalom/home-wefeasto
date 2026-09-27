/*
 * Hunt (payments-security, round 3) — /api/store/checkout is a free "has this phone/email ever ordered?"
 * oracle, the one serverQuote() (quote.ts) deliberately refuses to be.
 *
 * quote.ts: "For POST /store/quote … first-order and per-customer checks stay deferred so the quote
 * endpoint can't be used to probe whether an address has ordered before." placeOrder (checkout.ts) runs
 * those identity checks (isFirstOrder by email OR phone, customerUsageCount) and answers 422
 * COUPON_INVALID {reason:'FIRST_ORDER_ONLY'} BEFORE it compares expectedTotalPaise. So anyone holding a
 * public first-order code (e.g. a "FIRST50" on the announcement bar) posts a checkout with the target's
 * phone number (or email) and a deliberately wrong expectedTotalPaise: a customer who has ordered gets
 * 422 FIRST_ORDER_ONLY, a stranger gets 409 PRICE_CHANGED — and no order is ever created, so it costs
 * nothing and leaves no trace. Indian mobile numbers are trivially enumerable (20 probes/min/IP).
 *
 * Correct behaviour: a checkout that cannot be placed anyway (its expected total doesn't match) answers
 * the same body for a returning customer's phone as for a stranger's, like the quote does.
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';
import { checkoutForm } from '../../support/unique.js';
import { tryCheckout } from './helpers.js';

/** A checkout that can never be placed (expectedTotalPaise: 1): only the refusal is observed. */
async function probe(api, { phone, couponCode }) {
	const f = checkoutForm({ method: 'upi', ...(phone ? { phone } : {}) });
	const body = {
		items: [{ slug: 'muesli', qty: 1 }],
		contact: { name: f.name, email: f.email, phone: f.phone },
		address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
		method: 'upi',
		expectedTotalPaise: 1,
		consent: { marketing: false },
		couponCode
	};
	const r = await api.checkout(body, { idempotencyKey: crypto.randomUUID() });
	return { status: r.status, error: r.json?.error ?? null };
}

test('a doomed checkout does not reveal whether a phone number has ordered before', async ({ admin, api, db, unique }) => {
	const coupon = await admin.createCoupon({ type: 'fixed', value: 5000, firstOrderOnly: true });

	// The target: somebody who once placed a cash-on-delivery order (no coupon involved).
	const targetPhone = unique.phone();
	const placed = await tryCheckout(api, { items: { 'rolled-oats': 1 }, method: 'cod', form: { phone: targetPhone } });
	expect(placed.status, placed.text).toBe(201);

	const before = await db.query('select count(*)::int as n from orders');
	const returning = await probe(api, { phone: targetPhone, couponCode: coupon.code });
	const stranger = await probe(api, { phone: unique.phone(), couponCode: coupon.code });
	const after = await db.query('select count(*)::int as n from orders');

	expect(after[0].n, 'the probes placed no order').toBe(before[0].n);
	expect(stranger.status).toBeGreaterThanOrEqual(400);
	// Same answer whatever the phone's history (today: 422 FIRST_ORDER_ONLY vs 409 PRICE_CHANGED), including
	// any quote the refusal carries (its couponError / discount must not depend on the phone either).
	const shape = (p) => ({
		status: p.status,
		code: p.error?.code,
		reason: p.error?.details?.reason ?? null,
		couponError: p.error?.details?.quote?.couponError ?? null,
		discountPaise: p.error?.details?.quote?.discountPaise ?? null
	});
	expect(shape(returning), JSON.stringify({ returning, stranger }).slice(0, 600)).toEqual(shape(stranger));
});
