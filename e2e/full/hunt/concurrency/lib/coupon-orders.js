/*
 * Round-2 helpers: place + pay orders that use a coupon, straight at the slot CMS, and read the coupon's
 * bookkeeping (usedCount vs. its redemption rows) in one SQL statement.
 */
import crypto from 'node:crypto';
import { cmsCall } from '../helpers.js';

const freshPhone = () => `+919${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;

/** quote → checkout (online by default) with `couponCode`. → { status, json, number, token, razorpayOrderId } */
export async function checkoutWithCoupon(stack, { slug = 'cornflakes', qty = 1, email, couponCode, method = 'upi', phone = freshPhone() }) {
	const items = [{ slug, qty }];
	const q = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method, couponCode, email } });
	if (q.status !== 200) throw new Error(`quote → ${q.status} ${q.text.slice(0, 200)}`);
	const body = {
		items,
		contact: { name: 'Hunt Coupon', email, phone },
		address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
		method,
		expectedTotalPaise: q.json.quote.totalPaise,
		consent: { marketing: false },
		source: 'web',
		couponCode
	};
	const r = await cmsCall(stack, 'POST', 'store/checkout', { body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
	return {
		status: r.status,
		json: r.json,
		number: r.json?.order?.number ?? null,
		token: r.json?.order?.token ?? null,
		razorpayOrderId: r.json?.payment?.razorpayOrderId ?? null,
		quote: q.json.quote
	};
}

/** Mock-pays the order's Razorpay order (no webhook) and confirms it through /checkout/verify. → verify response */
export async function payAndVerify(stack, placed) {
	const pay = await cmsCall(stack, 'POST', 'payments/mock/pay', { body: { razorpayOrderId: placed.razorpayOrderId, outcome: 'success', webhook: false } });
	if (pay.status !== 200 || !pay.json?.response) throw new Error(`mock pay → ${pay.status} ${pay.text.slice(0, 200)}`);
	return cmsCall(stack, 'POST', 'store/checkout/verify', { body: { number: placed.number, token: placed.token, ...pay.json.response } });
}

/** usedCount, usageLimit and the redemption rows by status, from one snapshot. */
export async function couponBook(db, code) {
	const [row] = await db.query(
		`select c.id, c.used_count::int as used, c.usage_limit::int as lim,
		        (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'consumed')::int as consumed,
		        (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'reserved')::int as reserved
		   from coupons c where c.code = $1`,
		[code]
	);
	return row;
}
