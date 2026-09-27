/*
 * Round-3 helpers for the concurrency repros: quote + checkout straight at the slot CMS with a chosen
 * contact / coupon / method, and "expire this order now" (time travel + the reconcile cron).
 */
import crypto from 'node:crypto';
import { cmsCall } from '../helpers.js';

export const ADDRESS = { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };

export const freshContact = (tag = 'hunt-r3') => ({
	name: 'Hunt Round Three',
	email: `${tag}-${crypto.randomBytes(5).toString('hex')}@e2e.wefeasto.test`,
	phone: `+919${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`
});

/** The body POST /store/checkout wants (expectedTotalPaise from a fresh quote). */
export async function checkoutBody(stack, { items, contact, method = 'upi', couponCode, supersede, consent = false }) {
	const q = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method, ...(couponCode ? { couponCode } : {}), ...(supersede ? { supersede } : {}) } });
	if (q.status !== 200) throw new Error(`quote → ${q.status} ${q.text.slice(0, 200)}`);
	return {
		items,
		contact,
		address: ADDRESS,
		method,
		expectedTotalPaise: q.json.quote.totalPaise,
		consent: { marketing: consent },
		source: 'web',
		...(couponCode ? { couponCode } : {}),
		...(supersede ? { supersede } : {})
	};
}

export const postCheckout = (stack, body, key = crypto.randomUUID()) =>
	cmsCall(stack, 'POST', 'store/checkout', { body, headers: { 'Idempotency-Key': key } });

export const postRetry = (stack, { number, token }) => cmsCall(stack, 'POST', 'store/checkout/retry', { body: { number, token } });

/** Places an order and throws unless it was created. → { number, token, razorpayOrderId, totalPaise } */
export async function place(stack, opts) {
	const r = await postCheckout(stack, await checkoutBody(stack, opts));
	if (r.status !== 201) throw new Error(`checkout → ${r.status} ${r.text.slice(0, 300)}`);
	return { ...r.json.order, razorpayOrderId: r.json.payment?.razorpayOrderId ?? null };
}

/** Backdates the reservation and lets the reconcile cron expire the order (stock + coupon use given back). */
export async function expireNow(db, cron, number) {
	await db.expireReservation(number, { minutesAgo: 5 });
	const r = await cron.runReconcile({ order: number });
	if (r.status !== 200) throw new Error(`reconcile → ${r.status} ${r.text?.slice(0, 200)}`);
	const [o] = await db.query('select status from orders where number = $1', [number]);
	if (o.status !== 'expired') throw new Error(`${number} did not expire: ${o.status}`);
}
