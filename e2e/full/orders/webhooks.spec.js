/*
 * Webhook storms against the production CMS (razorpay.md §13 E42/43, roadmap M3 acceptance
 * "exactly one confirmation email per order, even with 3 duplicate webhooks"): Razorpay-shaped,
 * correctly signed deliveries — the same event id re-delivered and different events for the same
 * payment, all at once — pay the order once, send one email and queue one refill reminder. A bad
 * signature changes nothing.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/orders/webhooks.spec.js
 */
import crypto from 'node:crypto';
import { test, expect, waitOrderView } from '../fixtures.js';
import {
	apiOnlineOrder,
	mockPay,
	waitOrder,
	historyOf,
	SUBJECT,
	subjectsTo,
	sortedSubjects,
	refillJobs,
	paymentEntity,
	deliverWebhook as deliver,
	staysEqual
} from './helpers.js';

test.describe('webhook storms', { tag: ['@orders', '@webhooks', '@stateful'] }, () => {
	test('the same capture delivered 3× plus order.paid and payment.authorized, all at once → paid once, one email, one reminder job', async ({
		stack,
		api,
		mock,
		admin,
		db,
		mailpit
	}) => {
		const o = await apiOnlineOrder(api, { items: { cornflakes: 1 }, consent: true });
		const paid = await mockPay(mock, o.rzpOrderId, 'success', { webhook: false }); // the webhooks come from us instead
		const base = { paymentId: paid.paymentId, rzpOrderId: o.rzpOrderId, amount: o.totalPaise, number: o.number };
		const order = { id: o.rzpOrderId, entity: 'order', amount: o.totalPaise, amount_paid: o.totalPaise, amount_due: 0, currency: 'INR', receipt: `${o.number}-a1`, status: 'paid', attempts: 1, notes: { wf_order: o.number } };
		const tag = crypto.randomBytes(4).toString('hex');
		const captured = { event: 'payment.captured', payload: { payment: paymentEntity({ ...base, status: 'captured' }) }, eventId: `E2EEvt${tag}cap` };

		const results = await Promise.all([
			deliver(stack, captured),
			deliver(stack, captured),
			deliver(stack, captured),
			deliver(stack, { event: 'order.paid', payload: { payment: paymentEntity({ ...base, status: 'captured' }), order }, eventId: `E2EEvt${tag}ord` }),
			deliver(stack, { event: 'payment.authorized', payload: { payment: paymentEntity({ ...base, status: 'authorized' }) }, eventId: `E2EEvt${tag}aut` })
		]);
		for (const r of results) expect(r.status, JSON.stringify(r.json)).toBe(200);
		const outcomes = results.map((r) => r.json?.outcome);
		expect(outcomes.filter((x) => x === 'paid'), `outcomes ${outcomes.join(', ')}`).toHaveLength(1);
		for (const x of outcomes) expect(['paid', 'already_paid', 'duplicate']).toContain(x);

		const doc = await waitOrder(admin, o.number, { status: 'paid', paymentStatus: 'captured', paidVia: 'webhook', razorpay: { paymentId: paid.paymentId } });
		expect(historyOf(doc)).toEqual(['pending_payment', 'paid']);
		expect(doc.refunds).toEqual([]);

		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		// One order confirmation, and the ticked consent box's one opt-in email (the owner confirms by email).
		const once = [SUBJECT.confirmed(o.number), SUBJECT.optIn].sort();
		expect(await sortedSubjects(mailpit, o.form.email)).toEqual(once);
		await staysEqual(async () => (await refillJobs(db, o.number)).map((j) => j.input.stamp), ['h0']);

		// A replay later (support re-sends the event) is still a no-op.
		const replay = await deliver(stack, captured);
		expect(replay).toMatchObject({ status: 200, json: { outcome: 'duplicate' } });
		expect(await sortedSubjects(mailpit, o.form.email, { quietMs: 2000 })).toEqual(once);
	});

	test('a badly signed "captured" webhook is refused and changes nothing', async ({ stack, api, mock, admin, mailpit, cron }) => {
		const o = await apiOnlineOrder(api, { items: { muesli: 1 } });
		const paid = await mockPay(mock, o.rzpOrderId, 'success', { webhook: false });
		const forged = await deliver(stack, {
			event: 'payment.captured',
			payload: { payment: paymentEntity({ paymentId: paid.paymentId, rzpOrderId: o.rzpOrderId, amount: o.totalPaise, number: o.number, status: 'captured' }) },
			eventId: `E2EEvt${crypto.randomBytes(4).toString('hex')}bad`,
			secret: 'not-the-webhook-secret'
		});
		expect(forged.status).toBe(400);
		expect(forged.json?.error?.code).toBe('SIGNATURE_INVALID');
		const doc = await admin.findOrder(o.number);
		expect(doc).toMatchObject({ status: 'pending_payment', paymentStatus: 'created' });
		expect(doc.razorpay.paymentId ?? null).toBeNull();
		expect(await subjectsTo(mailpit, o.form.email, { quietMs: 2000 })).toEqual([]);

		// The real payment is still there: settle it now so no later sweep mails this address.
		expect((await cron.runReconcile({ order: o.number })).json).toMatchObject({ paid: 1 });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
	});

	test('an underpaid capture (amount mismatch) is never "paid": needs_review, no email, /order says we are checking; an admin resolving it confirms once', async ({
		page,
		shop,
		stack,
		api,
		mock,
		admin,
		db,
		mailpit
	}) => {
		await admin.setStock('muesli', 10);
		const o = await apiOnlineOrder(api, { items: { muesli: 1 }, consent: true });
		const paid = await mockPay(mock, o.rzpOrderId, 'success', { webhook: false });
		const r = await deliver(stack, {
			event: 'payment.captured',
			payload: { payment: paymentEntity({ paymentId: paid.paymentId, rzpOrderId: o.rzpOrderId, amount: 100, number: o.number, status: 'captured' }) },
			eventId: `E2EEvt${crypto.randomBytes(4).toString('hex')}amt`
		});
		expect(r).toMatchObject({ status: 200, json: { outcome: 'amount_mismatch' } });
		const review = await waitOrder(admin, o.number, { status: 'needs_review' });
		expect(review.reviewReason).toBeTruthy();
		expect(review.refunds).toEqual([]);
		expect(await subjectsTo(mailpit, o.form.email, { quietMs: 2000 })).toEqual([]);
		expect(await refillJobs(db, o.number)).toEqual([]);

		await shop.visit(`/order?no=${o.number}&t=${o.token}`);
		expect(await waitOrderView(page, ['review'])).toBe('review');
		await expect(page.locator('#wf-co-thanks')).toHaveCount(0);

		// A human checks it with Razorpay and resolves it to paid.
		const resolved = await admin.updateOrder(o.number, { status: 'paid' });
		expect(resolved.status, JSON.stringify(resolved.error)).toBe(200);
		const doc = await waitOrder(admin, o.number, { status: 'paid', paidVia: 'admin', stockState: 'committed' });
		expect(doc.paidAt).toBeTruthy();
		expect(await db.stock('muesli')).toBe(9);
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		expect(await sortedSubjects(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number), SUBJECT.optIn].sort());
		await expect.poll(async () => (await refillJobs(db, o.number)).map((j) => j.input.stamp), { message: 'order.confirmed → refill job' }).toEqual(['h0']);
		await page.reload();
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
	});

	test('a failed attempt reported after another attempt paid changes nothing (no downgrade, no failure side effects)', async ({ stack, api, mock, admin, mailpit }) => {
		const o = await apiOnlineOrder(api, { items: { 'rolled-oats': 1 } });
		const failed = await mockPay(mock, o.rzpOrderId, 'fail', { webhook: false, reason: 'card_declined' });
		expect(failed.ok).toBe(false);
		const retry = await api.post('store/checkout/retry', { number: o.number, token: o.token });
		expect(retry.status, retry.text).toBe(200);
		const a2 = retry.json.payment.razorpayOrderId;
		await mockPay(mock, a2, 'success', { webhook: true });
		await waitOrder(admin, o.number, { status: 'paid', paymentStatus: 'captured' });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });

		// Attempt 1's payment.failed finally arrives.
		const late = await deliver(stack, {
			event: 'payment.failed',
			payload: {
				payment: {
					...paymentEntity({ paymentId: failed.paymentId, rzpOrderId: o.rzpOrderId, amount: o.totalPaise, number: o.number, status: 'failed' }),
					error_code: 'BAD_REQUEST_ERROR',
					error_reason: 'card_declined',
					error_description: 'Your payment could not be completed as this card was declined by the bank.'
				}
			},
			eventId: `E2EEvt${crypto.randomBytes(4).toString('hex')}fail`
		});
		expect(late.status).toBe(200);
		expect(late.json.outcome).toMatch(/^payment_failed/); // appended to the attempt log at most
		const doc = await admin.findOrder(o.number);
		expect(doc).toMatchObject({ status: 'paid', paymentStatus: 'captured' });
		expect(historyOf(doc).at(-1)).toBe('paid');
		expect(historyOf(doc, 'paymentStatus').at(-1)).toBe('captured');
		expect(doc.razorpay.payments.find((x) => x.paymentId === failed.paymentId)).toMatchObject({ status: 'failed', errorReason: 'card_declined' });
		expect((await api.status(o.number, o.token)).json).toMatchObject({ status: 'paid', isConfirmed: true });
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number)]);
	});
});

