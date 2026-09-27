/*
 * Hunt (payments-security) — POST /api/store/checkout/retry revives an EXPIRED order without re-validating it.
 *
 * Expiry releases the order's stock and coupon redemption. retry.ts then only re-takes the stock COUNT
 * (stock.ts reserveLines: `stock >= qty`) and re-reserves the coupon redemption unconditionally
 * (coupons.ts rereserveRedemption), with no age limit. Nothing re-checks:
 *   - the coupon: usageLimit / perCustomerLimit / firstOrderOnly / endsAt — another checkout may have taken
 *     the released use meanwhile, so a single-use code (e.g. a HELLO- welcome code) is redeemed twice;
 *   - the product: "Available for sale" (inStock=false), unpublishing, maxPerOrder — a withdrawn product is
 *     sold, at the old price, weeks later if the customer kept the /order link.
 * Both orders below pay successfully today.
 */
import { test, expect } from '../../fixtures.js';
import { payAndVerify, tryCheckout } from './helpers.js';

async function expire({ db, cron }, number) {
	await db.expireReservation(number, { minutesAgo: 5 });
	const rc = await cron.runReconcile({ order: number });
	expect(rc.json).toMatchObject({ ok: true, expired: 1 });
}

test('retrying an expired order never takes a coupon use that someone else has taken meanwhile', async ({ api, admin, db, cron, mock }) => {
	const coupon = await admin.createCoupon({ type: 'fixed', value: 5000, usageLimit: 1 });

	// A reserves the only use, then its payment window closes (reconcile expires it: redemption released).
	const a = await tryCheckout(api, { items: { muesli: 1 }, couponCode: coupon.code });
	expect(a.status, a.text).toBe(201);
	await expire({ db, cron }, a.json.order.number);

	// B (another shopper) takes the now-free use and pays.
	const b = await tryCheckout(api, { items: { muesli: 1 }, couponCode: coupon.code });
	expect(b.status, b.text).toBe(201);
	const paidB = await payAndVerify(api, mock, { ...b.json.order, razorpayOrderId: b.json.payment.razorpayOrderId });
	expect(paidB.order?.status).toBe('paid');

	// A comes back through /order "Try again".
	const retry = await api.post('store/checkout/retry', { number: a.json.order.number, token: a.json.order.token });
	if (retry.status === 200) {
		await payAndVerify(api, mock, { ...a.json.order, razorpayOrderId: retry.json.payment.razorpayOrderId });
	}

	// Whatever the retry answered, the single-use code must not end up used twice.
	const discounted = await db.query(
		"select number from orders where coupon_code = $1 and status in ('paid','cod_pending','cod_confirmed','partially_refunded','refunded')",
		[coupon.code]
	);
	expect(discounted.map((r) => r.number), `retry → ${retry.status} ${retry.text.slice(0, 200)}`).toHaveLength(1);
	expect((await admin.getCoupon(coupon.code)).usedCount).toBeLessThanOrEqual(1);
});

test('retrying an expired order refuses a product the shop has taken off sale', async ({ api, admin, db, cron, mock }) => {
	const slug = 'steel-cut-oats';
	const a = await tryCheckout(api, { items: { [slug]: 1 } });
	expect(a.status, a.text).toBe(201);
	await expire({ db, cron }, a.json.order.number);

	await admin.updateProduct(slug, { inStock: false }); // "Available for sale" off (restored after the test)
	const fresh = await api.quote({ items: [{ slug, qty: 1 }], method: 'upi' });
	expect(fresh.json.quote.issues.map((i) => i.slug)).toEqual([slug]); // a new checkout can't buy it

	const retry = await api.post('store/checkout/retry', { number: a.json.order.number, token: a.json.order.token });
	if (retry.status === 200) {
		await payAndVerify(api, mock, { ...a.json.order, razorpayOrderId: retry.json.payment.razorpayOrderId });
	}
	const row = await db.order(a.json.order.number);
	// Refused with a 4xx (409 OUT_OF_STOCK/UNAVAILABLE-style), and never paid at the old price.
	expect({ refused: retry.status >= 400 && retry.status < 500, status: row.status }, `retry → ${retry.status} ${retry.text.slice(0, 200)}`).toEqual({
		refused: true,
		status: 'expired'
	});
});
