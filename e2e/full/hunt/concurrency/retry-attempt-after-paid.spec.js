/*
 * HUNT-CONC-R3-1 (cms-checkout: src/commerce/checkout/retry.ts retryPayment → attempts.ts createAttempt):
 * POST /store/checkout/retry decides "not paid, retryable" (findLandedPayment + the locked re-check), commits,
 * and only then opens the new Razorpay order with createAttempt(), which records it under the order lock
 * WITHOUT re-checking that the order still wants money. A UPI approval that lands in between (webhook →
 * markPaid; typically a slow UPI collect the customer gave up on just as they tapped "Try again") makes the
 * order paid, and the retry still answers 200 with a fresh payment sheet for it. The customer is asked to pay
 * a paid order again; paying it captures a second payment that is then auto-refunded as a duplicate.
 * The same gap hands out a payment sheet for an order cancelled meanwhile (admin/supersede).
 *
 * Production stack, no gates: a 'late' mock payment on attempt 1 is authorised (webhook → markPaid) a few ms
 * after the retry starts; the delay is swept until the two overlap. Evidence of the bug: the retry answered
 * 200 with a new Razorpay order that was recorded on the order AFTER it was paid (attempt createdAt > paidAt).
 * Deterministic in-process version: cms/tests/int/hunt-concurrency-r3-retry.int.spec.ts.
 */
import { test, expect } from '../../fixtures.js';
import { cmsCall } from './helpers.js';
import { freshContact, place, postRetry } from './lib/r3.js';

test('retry never hands out a new payment for an order that was paid while it was being opened', async ({ stack, db }) => {
	test.setTimeout(240_000);
	const hits = [];
	for (let delay = 0; delay <= 90 && hits.length === 0; delay += 3) {
		const a = await place(stack, { items: [{ slug: 'rolled-oats', qty: 1 }], contact: freshContact('hunt-retry') });
		const pay = await cmsCall(stack, 'POST', 'payments/mock/pay', {
			body: { razorpayOrderId: a.razorpayOrderId, outcome: 'late', webhook: true, lateAuthDelayMs: delay }
		});
		expect(pay.status).toBe(200);
		const r = await postRetry(stack, a);
		await expect.poll(async () => (await db.query('select status from orders where number = $1', [a.number]))[0].status, { timeout: 15_000 }).toBe('paid');
		if (r.status !== 200) continue;
		const [row] = await db.query(
			`select o.paid_at, a.order_id, a.created_at from orders o join orders_razorpay_attempts a on a._parent_id = o.id
			  where o.number = $1 and a.order_id = $2`,
			[a.number, r.json.payment.razorpayOrderId]
		);
		if (row && new Date(row.created_at) > new Date(row.paid_at)) hits.push({ delay, order: a.number, newRazorpayOrder: row.order_id, paidAt: row.paid_at, attemptAt: row.created_at });
	}
	expect(hits, 'retry answered 200 with a new Razorpay order recorded after the order was already paid').toEqual([]);
});
