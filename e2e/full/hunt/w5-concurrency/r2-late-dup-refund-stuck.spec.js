/*
 * W5-CONC r2: a late authorisation on a Razorpay order that another payment already paid is refunded BY
 * RAZORPAY at once (payment.authorized, then refund.processed without our receipt). markPaid also queues its
 * own duplicate-payment refund (<no>-dup-<pay>). When Razorpay's refund.processed is recorded before our
 * refund call has settled that queued entry (both arrive within a second of the late authorisation; our call
 * runs after the webhook response and makes two gateway calls first), applyRefundUpdate files Razorpay's
 * refund as a separate entry, and issueQueuedRefunds — told "fully refunded already", finding that same
 * refund — matches it BY refundId (the separate entry, unchanged) and never touches the queued one. So the
 * duplicate refund stays `queued` forever: every reconcile run "issues" it again (a refund call +
 * fetchRefunds, refundsIssued: 1), and it holds one of the 25 slots of reconcile's queued-refund section
 * (oldest first): enough of them and a genuinely failed refund is never retried.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/r2-late-dup-refund-stuck.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { cmsCall, mockPay, placeOrder } from './helpers.js';

test.use({ failOnConsoleErrors: false });
test.beforeEach(async ({ admin }) => {
	await admin.setStock('steel-cut-oats', 50);
});

const refundsOf = (db, number) =>
	db.query(`select r.payment_id, r.refund_id, r.status, r.reason, r.receipt from orders_refunds r join orders o on o.id = r._parent_id where o.number = $1 order by r._order`, [number]);

/** Pays the order twice on one Razorpay order: a UPI payment the bank authorises late, and a second one that goes through. */
async function lateDuplicate(stack, db, unique, { faultFirstRefund }) {
	const o = await placeOrder(stack, db, { slug: 'steel-cut-oats', email: unique.email('w5r2-late') });
	const late = await mockPay(stack, o.razorpayOrderId, 'late', { webhook: true, lateAuthDelayMs: 2500 });
	const paid = await mockPay(stack, o.razorpayOrderId, 'success', { webhook: false });
	const v = await cmsCall(stack, 'POST', 'store/checkout/verify', { body: { number: o.number, token: o.token, ...paid.response } });
	expect(v.json?.order?.status).toBe('paid');
	// Our first refund call fails (a gateway blip; with Razorpay, also "payment status should be captured"
	// while the late payment is still only authorised): the webhook-first order, deterministically.
	if (faultFirstRefund) expect((await cmsCall(stack, 'POST', 'payments/mock/fault', { body: { op: 'refund', kind: 'network', times: 1 } })).status).toBe(200);
	// The late authorisation: Razorpay refunds it itself; both its webhooks are recorded.
	await expect
		.poll(async () => (await refundsOf(db, o.number)).filter((r) => r.payment_id === late.paymentId && r.refund_id && r.status === 'processed').length, { timeout: 20_000 })
		.toBeGreaterThan(0);
	return { o, late };
}

test('deterministic: after Razorpay refunded the late duplicate itself, reconcile settles our queued duplicate refund', async ({ stack, db, unique, cron }) => {
	test.setTimeout(90_000);
	const { o } = await lateDuplicate(stack, db, unique, { faultFirstRefund: true });
	for (let i = 0; i < 2; i++) expect((await cron.runReconcile({ order: o.number })).status).toBe(200);
	const rows = await refundsOf(db, o.number);
	await test.info().attach('refunds.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
	expect(rows.filter((r) => r.status === 'queued'), 'automatic refunds still queued after two reconcile runs').toEqual([]);
});
