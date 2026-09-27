/*
 * Un-losable orders (roadmap M2 §11 + acceptance; razorpay.md §13 D.33, D.40): a reload or a killed
 * tab mid-payment leaves wefeasto_pending, the pending banner on /checkout and /cart resolves it
 * (Check status → /order when paid; Retry payment → a fresh Razorpay order when not), and paying
 * again with the same bag + details replays the same order instead of making a second one.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/recovery.spec.js
 */
import { test, expect, waitHydrated, waitOrderView, orderFromUrl } from '../fixtures.js';
import { modal, pendingOrder, recordCheckoutCalls, orderPage, latestAttempt, waitOrderStatus, expectOnlyEmails, answered } from './helpers.js';

const banner = (page, no) => page.locator(`[data-wf-pending="${no}"]`);

/** Bag → /checkout → form → Pay with the modal left open (manual mode). Resolves {form, number, token}. */
async function openModal(page, shop, mock, items, form = {}) {
	await shop.setCart(items);
	await mock.clearAuto(page);
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'upi', ...form });
	await page.locator('#wf-place-order').click();
	await expect(modal.root(page)).toBeVisible();
	const p = await pendingOrder(page);
	return { form: f, ...p };
}

test.describe('reload / killed tab mid-payment', () => {
	test('reload with the modal open → banner on /checkout → Check status (stuck) → Retry payment → paid @slow', async ({ page, shop, mock, admin }) => {
		test.slow();
		const { number } = await openModal(page, shop, mock, { muesli: 1 });
		await page.reload();
		await waitHydrated(page);
		const b = banner(page, number);
		await expect(b).toHaveAttribute('data-wf-pending-view', 'idle');
		await expect(b).toContainText(`Your order ${number} is waiting for payment`);
		await b.locator('[data-wf-pending-check]').click();
		await expect(b).toHaveAttribute('data-wf-pending-view', 'stuck', { timeout: 30_000 });
		await expect(b).toContainText('hasn’t come through');

		await mock.setAuto(page, { auto: 'success' });
		await b.locator('[data-wf-action="retry-payment"]').click();
		expect((await orderPage(page)).number).toBe(number);
		const o = await admin.findOrder(number);
		expect(o.status).toBe('paid');
		expect(o.razorpay.attempts.map((a) => a.receipt)).toEqual([`${number}-a1`, `${number}-a2`]);
	});

	test('tab killed after paying in the UPI app → webhook → reopen /cart → banner → Check status → /order confirmed, bag emptied', async ({
		page,
		shop,
		mock,
		admin,
		mailpit
	}) => {
		const { form, number } = await openModal(page, shop, mock, { 'choco-flakes': 2 });
		const ctx = page.context();
		const attempt = await latestAttempt(admin, number);
		await page.close();
		const paid = await mock.pay(attempt.orderId, 'success', { method: 'upi', webhook: true });
		expect(paid.json.ok).toBe(true);
		await waitOrderStatus(admin, number, 'paid');

		const p2 = await ctx.newPage();
		await p2.goto('/cart');
		await waitHydrated(p2);
		const b = banner(p2, number);
		await expect(b).toBeVisible();
		await b.locator('[data-wf-pending-check]').click();
		expect(await waitOrderView(p2, ['confirmed'])).toBe('confirmed');
		expect(orderFromUrl(p2.url()).number).toBe(number);
		await expect.poll(() => p2.evaluate(() => localStorage.getItem('wefeasto_pending'))).toBeNull();
		await expect.poll(() => p2.evaluate(() => window.WefeastoCart?.count?.() ?? -1), { message: 'bag emptied by the ordered quantities' }).toBe(0);
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
		await p2.goto('/cart');
		await waitHydrated(p2);
		await expect(p2.locator('[data-wf-pending]')).toHaveCount(0);
	});

	test('reload, same bag + same details, Pay again → the same order is replayed (no second order) → paid', async ({ page, shop, mock, admin }) => {
		const first = await openModal(page, shop, mock, { cornflakes: 1, 'steel-cut-oats': 1 });
		await page.reload();
		await waitHydrated(page);
		await mock.setAuto(page, { auto: 'success' });
		const calls = recordCheckoutCalls(page);
		const { method, consent, save, ...same } = first.form;
		await shop.fillCheckout({ ...same, method: 'upi' });
		await page.locator('#wf-place-order').click();
		expect((await orderPage(page)).number).toBe(first.number);
		await answered(calls);
		expect(calls[0].status, 'a replay of the same attempt').toBe(200);
		const mine = await admin.ordersByEmail(first.form.email);
		expect(mine.map((o) => o.number)).toEqual([first.number]);
		expect(mine[0].status).toBe('paid');
	});
});
