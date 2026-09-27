/*
 * W5-CONC: an admin order Save sends the WHOLE form, reviewReason included (probe: the admin UI's
 * `_payload` carries every field as the page loaded it). The stale-form guard (adminEdits.ts
 * staleStatusEdit) only notices writes that grew statusHistory. Server writes that leave the three
 * statuses alone are invisible to it:
 *   - refund.failed (a Razorpay refund, ours or a Dashboard one, failed): refunds[] + reviewReason
 *     "… FAILED at Razorpay — pay the customer back manually." on a PAID order;
 *   - payment.dispute.created on an order that is already needs_review: dispute + reviewReason
 *     "Chargeback … — hold fulfilment", status stays needs_review (the hold).
 * A Save from a page opened before that write therefore erases the alert, and on the review order it
 * resolves to "paid" (fulfilment allowed) an order with a chargeback the admin never saw.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/order-form-erases-alerts.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { adminLogin, hex, orderRow, paymentEntity, placePaid, refundEntity, webhook } from './helpers.js';

test.use({ failOnConsoleErrors: false });

/** The admin form as the page loaded it (what a Save sends back), with the admin's own change applied. */
const asForm = ({ id, createdAt, updatedAt, ...doc }, change) => ({ ...doc, ...change });

async function failedDashboardRefund(stack, o) {
	const payment = paymentEntity({ id: o.paymentId, orderId: o.razorpayOrderId, amount: o.totalPaise, status: 'captured', wfOrder: o.number });
	const refund = refundEntity({ paymentId: o.paymentId, amount: 5000, status: 'failed' });
	const r = await webhook(stack, 'refund.failed', { refund, payment });
	expect(r.status, r.text).toBe(200);
	return refund;
}

test('REST: packing from a form loaded before a refund failed keeps the "pay the customer back" alert', async ({ stack, db, adminSession, unique }) => {
	const o = await placePaid(stack, db, { email: unique.email('w5-rr') });
	const loaded = (await adminSession.ok('GET', `orders/${o.id}?depth=0`)).valueOf();

	const refund = await failedDashboardRefund(stack, o);
	const alerted = await orderRow(db, o.number);
	expect(alerted.review_reason, 'the webhook recorded the failed refund for a human').toContain(`Refund ${refund.id} of payment ${o.paymentId} FAILED`);

	// The packer's Save: the form it loaded (reviewReason empty) + fulfilment → packed.
	const r = await adminSession.request('PATCH', `orders/${o.id}?depth=0`, { body: asForm(loaded, { fulfilmentStatus: 'packed' }) });
	const after = await orderRow(db, o.number);
	// Either the stale form is refused, or the alert survives the save.
	if (r.status === 200) expect(after.review_reason ?? '', 'reviewReason after the packer saved a stale form').toContain(`Refund ${refund.id} of payment ${o.paymentId} FAILED`);
	else expect(r.status).toBe(400);
});

test('REST: resolving a review from a form loaded before a chargeback keeps the order on hold', async ({ stack, db, adminSession, unique }) => {
	const o = await placePaid(stack, db, { email: unique.email('w5-rr') });
	// First chargeback → needs_review (the order is on hold); the admin opens it to look into it.
	const payment = paymentEntity({ id: o.paymentId, orderId: o.razorpayOrderId, amount: o.totalPaise, status: 'captured', wfOrder: o.number });
	const d1 = { id: `disp_W5${hex(5)}`, entity: 'dispute', payment_id: o.paymentId, amount: o.totalPaise, currency: 'INR', reason_code: 'fraud', status: 'open', phase: 'retrieval', created_at: Math.floor(Date.now() / 1000) };
	expect((await webhook(stack, 'payment.dispute.created', { payment, dispute: d1 })).json?.outcome).toBe('dispute_flagged');
	expect((await orderRow(db, o.number)).status).toBe('needs_review');
	const loaded = await adminSession.ok('GET', `orders/${o.id}?depth=0`);

	// While the page is open, the bank opens the chargeback proper (a new dispute on the same payment).
	const d2 = { ...d1, id: `disp_W5${hex(5)}`, phase: 'chargeback', created_at: Math.floor(Date.now() / 1000) };
	expect((await webhook(stack, 'payment.dispute.created', { payment, dispute: d2 })).json?.outcome).toBe('dispute_flagged');
	expect((await orderRow(db, o.number)).review_reason).toContain(`Chargeback ${d2.id}`);

	// The admin resolves the review they were looking at (the retrieval request) → paid.
	const r = await adminSession.request('PATCH', `orders/${o.id}?depth=0`, { body: asForm(loaded, { status: 'paid' }) });
	const after = await orderRow(db, o.number);
	if (r.status === 200) {
		expect({ status: after.status, alert: /Chargeback disp_W5\w+ opened/.test(after.review_reason ?? '') && (after.review_reason ?? '').includes(d2.id) }, 'a chargeback the admin never saw').toEqual({
			status: 'needs_review',
			alert: true
		});
	} else expect(r.status).toBe(400);
});

test('admin UI: Save after marking "packed" keeps a refund-failure alert that arrived while the page was open', async ({ page, stack, db, unique }) => {
	test.setTimeout(120_000);
	const o = await placePaid(stack, db, { email: unique.email('w5-rr') });
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/orders/${o.id}`);
	const fulfil = page.locator('#field-fulfilmentStatus');
	await fulfil.waitFor({ timeout: 30_000 });
	// The admin starts editing (Payload's stale-data check runs once, on the first change: nothing moved yet).
	await fulfil.click();
	await page.getByRole('option', { name: 'packed', exact: true }).click();
	await page.waitForTimeout(1500);

	const refund = await failedDashboardRefund(stack, o);
	expect((await orderRow(db, o.number)).review_reason).toContain(refund.id);

	const saved = page.waitForResponse((r) => r.url().includes(`/api/orders/${o.id}`) && r.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	const res = await saved;
	const after = await orderRow(db, o.number);
	if (res.status() === 200) expect(after.review_reason ?? '', 'reviewReason after the Save').toContain(`Refund ${refund.id} of payment ${o.paymentId} FAILED`);
	else expect(after.fulfilment_status).toBe('unfulfilled');
});
