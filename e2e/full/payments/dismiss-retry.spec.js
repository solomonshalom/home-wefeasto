/*
 * The payment didn't go through (roadmap M2 §8; razorpay.md §13 D.30, D.32, F.55/§3 supersede):
 * a dismissed or failed payment leaves one note with Try again (a NEW Razorpay order for the same
 * internal order) and Pay on delivery instead (a new COD order that supersedes the online one;
 * money that lands on the superseded order later is refunded automatically).
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/dismiss-retry.spec.js
 */
import { test, expect } from '../fixtures.js';
import { COPY, coNote, action, modal, pendingOrder, recordCheckoutCalls, orderPage, expectOnlyEmails, latestAttempt, waitOrderStatus, answered } from './helpers.js';

test.describe('dismissed / failed → Try again', () => {
	test('dismiss → note (no money taken) → Try again opens a new Razorpay order (a2) → paid', async ({ page, shop, mock, admin, mailpit }) => {
		const { form } = await shop.placeOnlineOrder({ items: { cornflakes: 1, 'rolled-oats': 1 }, auto: 'dismiss', expect: null });
		const note = coNote(page, 'DISMISSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText(COPY.noMoneyTaken);
		await expect(note).toBeFocused();
		await expect(action(note, 'try-again')).toBeVisible();
		await expect(action(note, 'pay-on-delivery')).toBeVisible();
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready');
		const { number } = await pendingOrder(page);
		const before = await admin.findOrder(number);
		expect(before).toMatchObject({ status: 'pending_payment', stockState: 'reserved' });
		expect(before.razorpay.attempts).toHaveLength(1);

		const calls = recordCheckoutCalls(page);
		await mock.setAuto(page, { auto: 'success' });
		await action(note, 'try-again').click();
		const { number: paidNo } = await orderPage(page);
		expect(paidNo).toBe(number);
		await answered(calls);
		expect(calls.map((c) => c.path)).toEqual(['/api/store/checkout/retry']);
		expect(calls[0].status).toBe(200);

		const order = await admin.findOrder(number);
		expect(order.status).toBe('paid');
		expect(order.razorpay.attempts.map((a) => a.receipt)).toEqual([`${number}-a1`, `${number}-a2`]);
		expect(order.razorpay.payments.find((p) => p.status === 'captured')?.orderId).toBe(order.razorpay.attempts[1].orderId);
		expect(calls[0].json.payment.razorpayOrderId).toBe(order.razorpay.attempts[1].orderId);
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
	});

	test('card declined → FAILED note (no money taken), order payment_failed → Tap Pay again = retry → paid', async ({ page, shop, mock, admin }) => {
		await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'fail', reason: 'card_declined', method: 'card', expect: null });
		const note = coNote(page, 'FAILED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText(COPY.noMoneyTaken);
		const { number } = await pendingOrder(page);
		await waitOrderStatus(admin, number, 'payment_failed');

		// Same bag + same form: tapping Pay again retries the SAME order (no second order).
		const calls = recordCheckoutCalls(page);
		await mock.setAuto(page, { auto: 'success' });
		await page.locator('#wf-place-order').click();
		const { number: paidNo } = await orderPage(page);
		expect(paidNo).toBe(number);
		expect(calls.map((c) => c.path)).toEqual(['/api/store/checkout/retry']);
		const order = await admin.findOrder(number);
		expect(order.status).toBe('paid');
		expect(order.razorpay.payments.find((p) => p.status === 'failed')?.errorReason).toBe('card_declined');
	});

	test('double-clicking Try again opens one new attempt, not two', async ({ page, shop, mock, admin }) => {
		await shop.placeOnlineOrder({ items: { 'health-mix': 1 }, auto: 'dismiss', expect: null });
		const note = coNote(page, 'DISMISSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		const { number } = await pendingOrder(page);
		const calls = recordCheckoutCalls(page);
		await mock.clearAuto(page);
		await action(note, 'try-again').dblclick();
		await expect(modal.root(page)).toBeVisible();
		await expect(modal.root(page)).toHaveCount(1);
		expect(calls.map((c) => c.path)).toEqual(['/api/store/checkout/retry']);
		expect((await admin.findOrder(number)).razorpay.attempts).toHaveLength(2);
	});

	test('a timed-out payment says money is unsure (it can still authorise), not "no money was taken"', async ({ page, shop }) => {
		await shop.placeOnlineOrder({ items: { 'steel-cut-oats': 2 }, auto: 'fail', reason: 'payment_timed_out', webhook: false, expect: null });
		const note = coNote(page, 'FAILED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText(COPY.moneyUnsure);
		await expect(note).not.toContainText('no money was taken');
	});
});

test.describe('dismissed → Pay on delivery instead (supersede)', () => {
	test('the COD order replaces the online one; late money on the old Razorpay order is refunded + refund email', async ({
		page,
		shop,
		admin,
		mock,
		cron,
		mailpit,
		db
	}) => {
		test.slow();
		const items = { 'choco-flakes': 1, cornflakes: 1 };
		const stockBefore = { 'choco-flakes': await db.stock('choco-flakes'), cornflakes: await db.stock('cornflakes') };
		const { form } = await shop.placeOnlineOrder({ items, auto: 'dismiss', expect: null });
		const note = coNote(page, 'DISMISSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		const online = await pendingOrder(page);
		const oldAttempt = await latestAttempt(admin, online.number);

		await action(note, 'pay-on-delivery').click();
		await expect(page.locator('input[name="wf-pay"][value="cod"]')).toBeChecked();
		await expect(coNote(page, 'COD_SWITCH')).toContainText('Switched to Cash on Delivery');
		await expect(page.locator('#wf-place-order')).toBeFocused();
		await expect(page.locator('#wf-place-order')).toContainText('on delivery');
		await expect(page.locator('#wf-co-phone')).toHaveValue(form.phone);
		await page.locator('#wf-place-order').click();
		const cod = await orderPage(page);
		expect(cod.number).not.toBe(online.number);
		expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending', paymentMethod: 'cod' });
		const cancelled = await waitOrderStatus(admin, online.number, 'cancelled');
		expect(cancelled.statusHistory.at(-1)?.note ?? '').toMatch(/superseded/i);
		// One set of units left the shelf (the COD order's), the online order's reservation came back.
		expect(await db.stock('choco-flakes')).toBe(stockBefore['choco-flakes'] - 1);
		expect(await db.stock('cornflakes')).toBe(stockBefore.cornflakes - 1);

		// The customer's UPI app completes the old payment after all.
		const late = await mock.pay(oldAttempt.orderId, 'success', { method: 'upi', webhook: true });
		expect(late.status).toBe(200);
		expect(late.json.ok).toBe(true);
		await expect
			.poll(async () => (await admin.findOrder(online.number))?.razorpay?.paymentId ?? null, { message: 'late payment recorded', timeout: 20_000 })
			.toBe(late.json.paymentId);
		const r = await cron.runReconcile({ order: online.number });
		expect(r.status).toBe(200);
		await expect
			.poll(async () => (await admin.findOrder(online.number))?.refunds?.map((x) => [x.reason, x.amountPaise, x.status]) ?? [], {
				message: 'automatic full refund of the late payment',
				timeout: 20_000
			})
			.toEqual([['order_cancelled', cancelled.totalPaise, 'processed']]);
		const after = await admin.findOrder(online.number);
		expect(after.status, 'never becomes a second paid order').not.toBe('paid');
		expect(['cancelled', 'refunded', 'needs_review']).toContain(after.status);
		expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending' });

		await expectOnlyEmails(mailpit, form.email, [`Order ${cod.number} placed`, new RegExp(`refunded .* for order ${online.number}`)]);
	});
});
