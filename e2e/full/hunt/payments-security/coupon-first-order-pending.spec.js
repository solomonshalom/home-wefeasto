/*
 * Hunt (payments-security) — "first order only" is granted to every order placed before the first one is paid.
 *
 * isFirstOrder() (coupons.ts) only counts CONFIRMED orders (paid, COD, refunded…) for the email or phone,
 * and markPaid never looks again. A shopper who places several ONLINE orders with a firstOrderOnly code
 * (same phone, a different email per order so perCustomerLimit — keyed on email only — doesn't bite, and a
 * different bag so supersede doesn't cancel the earlier one) and then pays them all gets the first-order
 * discount on every one. Sequentially (pay, then order again) the same code is refused: FIRST_ORDER_ONLY.
 */
import { test, expect } from '../../fixtures.js';
import { payAndVerify, tryCheckout } from './helpers.js';

test('one phone gets a first-order-only discount on at most one confirmed order, even when both were placed before paying', async ({ api, admin, db, mock, unique }) => {
	const coupon = await admin.createCoupon({ type: 'fixed', value: 5000, firstOrderOnly: true, perCustomerLimit: 1 });
	const phone = unique.phone();

	const a = await tryCheckout(api, { items: { muesli: 1 }, form: { phone }, couponCode: coupon.code });
	expect(a.status, a.text).toBe(201);
	const b = await tryCheckout(api, { items: { muesli: 2 }, form: { phone }, couponCode: coupon.code });

	for (const o of [a, b]) {
		if (o.status !== 201) continue; // a fix may refuse the second order up front (COUPON_INVALID)
		const r = await payAndVerify(api, mock, { ...o.json.order, razorpayOrderId: o.json.payment.razorpayOrderId });
		expect(r.status).toBeLessThan(300);
	}

	const withDiscount = await db.query(
		"select number, status, discount_paise from orders where contact_phone = $1 and coupon_code = $2 and discount_paise > 0 and status in ('paid','cod_pending','cod_confirmed','partially_refunded','refunded')",
		[`+91${phone}`, coupon.code]
	);
	expect(withDiscount.map((r) => `${r.number} ${r.status}`), `second checkout → ${b.status}`).toHaveLength(1);
});
