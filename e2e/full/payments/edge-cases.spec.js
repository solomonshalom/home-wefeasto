/*
 * Money edge cases a customer can reach from the page (razorpay.md §13 A.11, D.40, F.54, F.55):
 * two Razorpay orders of one order both paid (the second is refunded), the price changing while the
 * modal is open (the snapshot amount stands), a stale tab paying an order that expired meanwhile,
 * Back after paying, and a single-use offer carried over by "Pay on delivery instead".
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/edge-cases.spec.js
 */
import { test, expect } from '../fixtures.js';
import { coNote, action, modal, pendingOrder, orderPage, expectOnlyEmails, waitOrderStatus, recordCheckoutCalls, quoteSettled, answered } from './helpers.js';

test.describe('payment edge cases', () => {
	test('two Razorpay orders of one order both paid → paid once, the second payment refunded automatically + refund email', async ({
		page,
		shop,
		mock,
		admin,
		cron,
		mailpit
	}) => {
		const { form } = await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'dismiss', expect: null });
		const note = coNote(page, 'DISMISSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		const { number } = await pendingOrder(page);
		await action(note, 'try-again').click(); // a2 opens (and is dismissed again)
		await expect(coNote(page, 'DISMISSED')).toBeVisible({ timeout: 20_000 });
		const o = await admin.findOrder(number);
		expect(o.razorpay.attempts).toHaveLength(2);
		const [a1, a2] = o.razorpay.attempts;

		// Tab A's UPI app completes attempt 1, tab B's completes attempt 2.
		const p1 = await mock.pay(a1.orderId, 'success', { method: 'upi' });
		await waitOrderStatus(admin, number, 'paid');
		const p2 = await mock.pay(a2.orderId, 'success', { method: 'upi' });
		expect(p1.json.ok && p2.json.ok).toBe(true);
		await cron.runReconcile({ order: number });
		await expect
			.poll(async () => (await admin.findOrder(number))?.refunds?.map((r) => [r.reason, r.paymentId, r.status]) ?? [], { timeout: 20_000 })
			.toEqual([['duplicate_payment', p2.json.paymentId, 'processed']]);
		const after = await admin.findOrder(number);
		expect(after).toMatchObject({ status: 'paid' });
		expect(after.razorpay.paymentId).toBe(p1.json.paymentId);
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`, new RegExp(`refunded .* for order ${number}`)]);
	});

	test('the price changes while the modal is open → the customer pays (and gets) the snapshot price @stateful', async ({ page, shop, mock, admin }) => {
		await shop.setCart({ 'health-mix': 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();
		await admin.setPrice('health-mix', 99_900);
		await modal.pay(page).click();
		const { number } = await orderPage(page);
		const o = await admin.findOrder(number);
		expect(o).toMatchObject({ status: 'paid', totalPaise: 27_000 + 4_900 });
		expect(o.items[0].unitPaise).toBe(27_000);
	});

	test('stale tab: the modal stays open past the reservation (order expired) → Pay → honoured, stock re-taken, /order confirmed', async ({
		page,
		shop,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		const slug = 'cornflakes';
		await shop.setCart({ [slug]: 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();
		const { number } = await pendingOrder(page);
		const held = await db.stock(slug);
		await db.expireReservation(number, { minutesAgo: 5 });
		await cron.runReconcile({ order: number });
		await waitOrderStatus(admin, number, 'expired');
		expect(await db.stock(slug)).toBe(held + 1);

		await modal.pay(page).click();
		expect((await orderPage(page)).number).toBe(number);
		const o = await waitOrderStatus(admin, number, 'paid');
		expect(o.stockState).toBe('committed');
		expect(await db.stock(slug)).toBe(held);
		await expectOnlyEmails(mailpit, form.email, [new RegExp(`${number}`)]);
	});

	test('Back after paying → /checkout has an empty bag and no pending banner; nothing can be paid twice', async ({ page, shop, admin }) => {
		const { number, form } = await shop.placeOnlineOrder({ items: { 'steel-cut-oats': 1 }, auto: 'success' });
		await page.goBack();
		await page.waitForURL((u) => u.pathname === '/checkout');
		await shop.waitHydrated();
		await expect(page.locator('#wf-co-summary')).toContainText('Your bag is empty');
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'disabled');
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
		expect((await admin.ordersByEmail(form.email)).map((o) => o.number)).toEqual([number]);
	});

	test('single-use offer (like the welcome code) → online payment dismissed → Pay on delivery instead keeps the offer: one tap, discounted COD order', async ({
		page,
		shop,
		admin,
		mock,
		unique
	}) => {
		const email = unique.email('welcome');
		const coupon = await admin.createCoupon({ type: 'percent', value: 10, usageLimit: 1, perCustomerLimit: 1, firstOrderOnly: true, boundEmail: email });
		await shop.setCart({ muesli: 2 });
		await page.goto(`/cart?offer=${coupon.code}`);
		await shop.waitHydrated();
		await mock.setAuto(page, { auto: 'dismiss' });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi', email });
		await expect(page.locator('[data-wf-total]')).toHaveText('₹450');
		await page.locator('#wf-place-order').click();
		const note = coNote(page, 'DISMISSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		const online = await pendingOrder(page);

		await action(note, 'pay-on-delivery').click();
		await quoteSettled(page);
		await expect(page.locator(`[data-wf-offer="${coupon.code}"]`), 'the offer still applies to the COD order that replaces it').toHaveAttribute(
			'data-wf-offer-state',
			'applied'
		);
		await expect(page.locator('#wf-place-order')).toContainText('Pay ₹450 on delivery');
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		const cod = await orderPage(page);
		await answered(calls, calls.length);
		expect(calls.map((c) => c.status), 'one tap, no PRICE_CHANGED detour').toEqual([201]);
		expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending', totalPaise: 45_000, coupon: { code: coupon.code } });
		await waitOrderStatus(admin, online.number, 'cancelled');
	});

	test('the last pack, held by the dismissed online order → Pay on delivery instead (the note on /checkout) → COD order for it @stateful', async ({
		page,
		shop,
		admin
	}) => {
		const slug = 'health-mix';
		await admin.setStock(slug, 1);
		await shop.placeOnlineOrder({ items: { [slug]: 1 }, auto: 'dismiss', expect: null });
		const note = coNote(page, 'DISMISSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		const online = await pendingOrder(page);
		await action(note, 'pay-on-delivery').click();
		await quoteSettled(page);
		await expect(page.locator('[data-wf-co-issue]'), 'the pack this order already holds is not "sold out" for its replacement').toHaveCount(0);
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready');
		await page.locator('#wf-place-order').click();
		const cod = await orderPage(page);
		expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending' });
		await waitOrderStatus(admin, online.number, 'cancelled');
	});
});
