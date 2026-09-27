/*
 * Online payments that end paid (roadmap M2; razorpay.md §13 C.22, D.31): UPI and Card through
 * the real mock Checkout modal, a failed attempt retried inside the modal, and a double tap on Pay.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/online-success.spec.js
 */
import { test, expect } from '../fixtures.js';
import { modal, recordCheckoutCalls, orderPage, expectOnlyEmails, anyNote, serverTotal, answered } from './helpers.js';

test.describe('online payment → paid', () => {
	test('UPI: the modal gets the server amount + prefill, Pay → /order confirmed, one email, bag emptied', async ({ page, shop, mock, admin, mailpit, api }) => {
		const items = { muesli: 1, cornflakes: 1 };
		const { totalPaise } = await serverTotal(api, items);
		await shop.setCart(items);
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();

		await expect(modal.root(page)).toBeVisible();
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'busy');
		const [inst] = await mock.instances(page);
		await answered(calls);
		expect(calls).toHaveLength(1);
		const init = calls[0].json.payment;
		expect(calls[0].status).toBe(201);
		expect(inst.options).toMatchObject({
			key: init.keyId,
			order_id: init.razorpayOrderId,
			amount: totalPaise,
			currency: 'INR',
			prefill: { name: form.name, email: form.email, contact: `+91${form.phone}`, method: 'upi' },
			readonly: { contact: true },
			retry: { enabled: true },
			callback_url: init.callbackUrl
		});
		expect(inst.options.redirect, 'popup mode on desktop Chrome').toBeFalsy();
		expect(inst.redirect).toBeFalsy();
		await expect(modal.root(page).getByRole('combobox')).toHaveValue(/upi/i);

		await modal.pay(page).click();
		const { number, view } = await orderPage(page);
		expect(view).toBe('confirmed');
		expect(number).toBe(calls[0].json.order.number);
		await expect(page.locator('[data-wf-order-method]')).toHaveAttribute('data-wf-order-method', 'online');
		await expect(page.locator('[data-wf-order-total]')).toContainText(`₹${totalPaise / 100}`);

		const order = await admin.findOrder(number);
		expect(order).toMatchObject({ status: 'paid', paymentStatus: 'captured', requestedMethod: 'upi', paymentMethod: 'online', totalPaise });
		expect(order.razorpay.method).toBe('upi');
		expect(order.razorpay.attempts).toHaveLength(1);
		expect(order.razorpay.attempts[0]).toMatchObject({ orderId: init.razorpayOrderId, amount: totalPaise });

		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
		await expect.poll(() => shop.cartCount(), { message: 'the ordered units leave the bag' }).toBe(0);
		await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_pending'))).toBeNull();
	});

	test('Card (+ marketing consent ticked): prefill.method card → razorpay.method card, requestedMethod card, consent stored', async ({ page, shop, admin, mailpit }) => {
		const { number, form, view } = await shop.placeOnlineOrder({ items: { 'health-mix': 2 }, auto: 'success', method: 'card', form: { consent: true } });
		expect(view).toBe('confirmed');
		const order = await admin.findOrder(number);
		expect(order).toMatchObject({ status: 'paid', paymentStatus: 'captured', requestedMethod: 'card' });
		expect(order.consent).toMatchObject({ marketing: true, text: 'Send me refill reminders & recipes. Unsubscribe anytime.' });
		expect(order.razorpay.method).toBe('card');
		// The ticked box also emails the double-opt-in link (the owner confirms; retention-backend.md).
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`, 'Confirm your Wefeasto subscription']);
	});

	test('a failed attempt inside the modal, then Pay again in the same modal → paid on the same Razorpay order', async ({ page, shop, mock, admin, mailpit }) => {
		await shop.setCart({ 'rolled-oats': 2 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();

		await modal.fail(page).click();
		await expect(modal.root(page).getByRole('alert')).toHaveText(/\S/);
		await expect(modal.root(page), 'Checkout keeps the modal open for a retry').toBeVisible();
		// Nothing blocking on the page while Checkout offers its own retry.
		await expect(anyNote(page)).toHaveCount(0);
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'busy');

		await modal.pay(page).click();
		const { number } = await orderPage(page);
		const order = await admin.findOrder(number);
		expect(order.status).toBe('paid');
		expect(order.razorpay.attempts, 'one Razorpay order').toHaveLength(1);
		const byStatus = order.razorpay.payments.map((p) => p.status).sort();
		expect(byStatus).toEqual(['captured', 'failed']);
		expect(new Set(order.razorpay.payments.map((p) => p.orderId))).toEqual(new Set([order.razorpay.attempts[0].orderId]));
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
	});

	test('auto fail_then_success → /order confirmed with one failed + one captured payment', async ({ page, shop, admin }) => {
		const { number } = await shop.placeOnlineOrder({ items: { 'steel-cut-oats': 1 }, auto: 'fail_then_success', reason: 'insufficient_funds' });
		const order = await admin.findOrder(number);
		expect(order.status).toBe('paid');
		const failed = order.razorpay.payments.filter((p) => p.status === 'failed');
		expect(failed).toHaveLength(1);
		expect(failed[0].errorReason).toBe('insufficient_funds');
	});

	test('double-click (and a scripted triple tap) on Pay → one order, one Idempotency-Key, one modal', async ({ page, shop, mock, admin }) => {
		await shop.setCart({ 'choco-flakes': 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		const calls = recordCheckoutCalls(page);
		await page.evaluate(() => {
			const b = document.querySelector('#wf-place-order');
			b.click();
			b.click();
			b.click();
		});
		await page.locator('#wf-place-order').dblclick({ force: true }).catch(() => {});
		await expect(modal.root(page)).toBeVisible();
		await expect(modal.root(page)).toHaveCount(1);
		expect((await mock.instances(page)).filter((i) => i.opened)).toHaveLength(1);
		expect(new Set(calls.map((c) => c.key)).size, 'one Idempotency-Key').toBe(1);

		await modal.pay(page).click();
		const { number } = await orderPage(page);
		const orders = await admin.ordersByEmail(form.email);
		expect(orders.map((o) => o.number)).toEqual([number]);
		expect(orders[0].status).toBe('paid');
	});
});
