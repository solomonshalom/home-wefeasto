/*
 * W5-CONC r2: a chargeback puts a paid order on hold (payment.dispute.created → needs_review: "hold
 * fulfilment and send evidence"; needs_review is not fulfillable). The shared state machine also maps
 * needs_review + partial_refund → partially_refunded (fulfillable) and applyRefundUpdate applies it to ANY
 * later change of a refund entry of the order's payment. So the hold depends on webhook ORDER:
 *   refund.created (a partial Dashboard refund, pending) → dispute.created → refund.processed (days later,
 *   when the bank settles the refund) ⇒ needs_review → partially_refunded: the hold is gone and the order
 *   can be packed and shipped while the chargeback is still open.
 * With the same events in another order (refund processed before the dispute) the order stays on hold.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/r2-refund-releases-chargeback-hold.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { hex, orderRow, paymentEntity, placePaid, refundEntity, webhook } from './helpers.js';

test.use({ failOnConsoleErrors: false });
// placePaid buys one steel-cut-oats: make sure there is one (the admin fixture puts the stock back afterwards).
test.beforeEach(async ({ admin }) => {
	await admin.setStock('steel-cut-oats', 50);
});

const dispute = (o) => ({
	id: `disp_W5R2${hex(4)}`,
	entity: 'dispute',
	payment_id: o.paymentId,
	amount: o.totalPaise,
	currency: 'INR',
	reason_code: 'goods_not_received',
	status: 'open',
	phase: 'chargeback',
	created_at: Math.floor(Date.now() / 1000)
});

test('a partial refund settled after a chargeback keeps the order on hold (not packable)', async ({ stack, db, unique, adminSession }) => {
	const o = await placePaid(stack, db, { email: unique.email('w5r2-cb') });
	const pay = (refunded) => ({ ...paymentEntity({ id: o.paymentId, orderId: o.razorpayOrderId, amount: o.totalPaise, status: 'captured', wfOrder: o.number }), amount_refunded: refunded, refund_status: refunded ? 'partial' : null });

	// 10:00 — the owner refunds ₹50 for a missing item in the Razorpay Dashboard (normal speed: pending for days).
	const refund = refundEntity({ paymentId: o.paymentId, amount: 5000, status: 'pending' });
	expect((await webhook(stack, 'refund.created', { refund, payment: pay(5000) })).status).toBe(200);
	expect((await orderRow(db, o.number)).status).toBe('partially_refunded');

	// 11:00 — the customer files a chargeback: the order goes on hold.
	const d = dispute(o);
	const r1 = await webhook(stack, 'payment.dispute.created', { payment: pay(5000), dispute: d });
	expect(r1.json?.outcome).toBe('dispute_flagged');
	expect((await orderRow(db, o.number)).status).toBe('needs_review');

	// Days later — the bank settles that ₹50 refund.
	const r2 = await webhook(stack, 'refund.processed', { refund: { ...refund, status: 'processed' }, payment: pay(5000) });
	expect(r2.status).toBe(200);

	const after = await orderRow(db, o.number);
	const pack = await adminSession.request('PATCH', `orders/${o.id}?depth=0`, { body: { fulfilmentStatus: 'packed' } });
	const packed = (await orderRow(db, o.number)).fulfilment_status;
	expect(
		{ status: after.status, stillAlerted: (after.review_reason ?? '').includes(`Chargeback ${d.id}`), packAnswer: pack.status, fulfilment: packed },
		'the chargeback is still open: the order must stay on hold'
	).toEqual({ status: 'needs_review', stillAlerted: true, packAnswer: 400, fulfilment: 'unfulfilled' });
});

test('control: the same events with the refund settled BEFORE the chargeback leave the order on hold', async ({ stack, db, unique }) => {
	const o = await placePaid(stack, db, { email: unique.email('w5r2-cb') });
	const pay = (refunded) => ({ ...paymentEntity({ id: o.paymentId, orderId: o.razorpayOrderId, amount: o.totalPaise, status: 'captured', wfOrder: o.number }), amount_refunded: refunded, refund_status: refunded ? 'partial' : null });
	const refund = refundEntity({ paymentId: o.paymentId, amount: 5000, status: 'pending' });
	await webhook(stack, 'refund.created', { refund, payment: pay(5000) });
	await webhook(stack, 'refund.processed', { refund: { ...refund, status: 'processed' }, payment: pay(5000) });
	await webhook(stack, 'payment.dispute.created', { payment: pay(5000), dispute: dispute(o) });
	expect((await orderRow(db, o.number)).status).toBe('needs_review');
});

test('a refund that FAILS, whose events arrive after the chargeback, keeps the order on hold', async ({ stack, db, unique }) => {
	const o = await placePaid(stack, db, { email: unique.email('w5r2-cb') });
	const pay = (refunded) => ({ ...paymentEntity({ id: o.paymentId, orderId: o.razorpayOrderId, amount: o.totalPaise, status: 'captured', wfOrder: o.number }), amount_refunded: refunded, refund_status: refunded ? 'partial' : null });
	// A ₹20 refund was requested a moment before the chargeback; its events are delivered after it.
	const d = dispute(o);
	expect((await webhook(stack, 'payment.dispute.created', { payment: pay(0), dispute: d })).json?.outcome).toBe('dispute_flagged');
	const refund = refundEntity({ paymentId: o.paymentId, amount: 2000, status: 'pending' });
	await webhook(stack, 'refund.created', { refund, payment: pay(2000) });
	await webhook(stack, 'refund.failed', { refund: { ...refund, status: 'failed' }, payment: pay(0) });
	const after = await orderRow(db, o.number);
	expect({ status: after.status, stillAlerted: (after.review_reason ?? '').includes(`Chargeback ${d.id}`) }, 'no money moved, the chargeback is open').toEqual({ status: 'needs_review', stillAlerted: true });
});
