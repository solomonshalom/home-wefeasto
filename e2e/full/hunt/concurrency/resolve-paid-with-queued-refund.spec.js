/*
 * HUNT-CONC-7 (cms-checkout, src/commerce/checkout/orderHooks.ts settlePaidByAdmin + Orders guard): money
 * that lands on a cancelled (e.g. superseded) order is recorded as the order's payment, the order goes to
 * needs_review and a full refund is QUEUED (`<no>-cxl-…`, reason order_cancelled). While that refund is still
 * queued (an authorised-only payment can't be refunded until it's captured; a gateway outage keeps it queued
 * for up to 12 reconcile runs) the admin can resolve the order needs_review → paid: the hook re-takes the
 * stock, consumes the coupon use and stamps paidVia 'admin' — and leaves the automatic refund of that very
 * payment queued. Reconcile then refunds the money of an order the shop has confirmed (and may have shipped),
 * and the paid order flips to `refunded`. Found by the fuzzer (isolated admin ops) together with the coupon
 * over-use it causes: the cancelled order's released redemption is consumed without re-checking usageLimit.
 *
 * Expected: resolving to paid is refused (400 on `status`) while a queued/pending refund exists for the
 * order's own payment — or the resolution withdraws that refund. Never both "paid" and "being refunded".
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';
import { cmsCall, mockPay } from './helpers.js';

test('an order whose payment is being auto-refunded cannot be resolved to paid', async ({ stack, db, adminSession, admin, unique }) => {
	await adminSession.login();
	const items = [{ slug: 'rolled-oats', qty: 1 }];
	const base = {
		items,
		contact: { name: 'Hunt Resolve', email: unique.email('hunt-res'), phone: unique.phone({ e164: true }) },
		address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
		consent: { marketing: false },
		source: 'web'
	};
	const checkout = async (method, extra = {}) => {
		const q = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method, ...extra } });
		const r = await cmsCall(stack, 'POST', 'store/checkout', { body: { ...base, method, expectedTotalPaise: q.json.quote.totalPaise, ...extra }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
		expect(r.status).toBe(201);
		return r.json;
	};

	// 1. online order, then "Pay on delivery instead" (same bag, naming the online order as the storefront
	//    does: `supersede: {number, token}`; a shared phone alone supersedes nothing, SUP-OWN-1) supersedes it
	const online = await checkout('upi');
	const cod = await checkout('cod', { supersede: { number: online.order.number, token: online.order.token } });
	const no = online.order.number;
	expect((await db.order(no)).status).toBe('cancelled');

	// 2. late money on the superseded order (authorised, not captured yet) → needs_review + queued refund
	const paid = await mockPay(stack, online.payment.razorpayOrderId, 'authorize_only', { webhook: true });
	await expect.poll(async () => (await db.order(no)).status, { timeout: 10_000 }).toBe('needs_review');
	const [queued] = await db.query("select r.status from orders_refunds r join orders o on o.id = r._parent_id where o.number = $1 and r.payment_id = $2", [no, paid.paymentId]);
	expect(queued?.status, 'the automatic refund is queued').toBe('queued');

	// 3. the admin resolves the review to paid
	const id = (await db.order(no)).id;
	const r = await adminSession.request('PATCH', `orders/${id}?depth=0`, { body: { status: 'paid' } });
	await new Promise((res) => setTimeout(res, 500));

	const [row] = await db.query('select status, razorpay_payment_id as pid from orders where id = $1', [id]);
	const live = await db.query("select status from orders_refunds where _parent_id = $1 and payment_id = $2 and status in ('queued','pending','processed')", [id, row.pid]);
	try {
		expect({ adminStatus: r.status, orderStatus: row.status, liveRefundsOfItsPayment: live.length }).not.toMatchObject({ orderStatus: 'paid', liveRefundsOfItsPayment: 1 });
		expect(r.status, 'refused while the payment is being refunded').toBe(400);
	} finally {
		await admin.cancelOrder(cod.order.number); // give the COD order's stock back
	}
});
