/*
 * Former backend gaps around "Pay on delivery instead" (storefront-fixes productIssues), now fixed
 * and kept as regression tests:
 *
 *  PI-SF-1  POST /api/store/quote takes `supersede: {number, token}` (the pending order): the
 *           dismissed online order's held last pack (and coupon reservation) count as available for
 *           the COD order that replaces it, as placeOrder counts them.
 *  PI-SF-2  Supersede also cancels `expired` orders (same phone + bag, within the window), so late
 *           money on the replaced order is refunded (refund_cancelled) instead of making a second,
 *           paid order.
 *
 * Run: E2E_SLOT=4 npx playwright test --project=full e2e/full/checkout/pay-on-delivery-known-issues.spec.js
 */
import { test, expect, waitOrderView } from '../fixtures.js';

async function dismissedOnlineOrder(page, shop, items) {
	const r = await shop.placeOnlineOrder({ items, auto: 'dismiss', expect: null });
	await expect(page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });
	const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_pending')));
	return { number: pending.no, token: pending.t, form: r.form };
}

/** /order's failed view (a still-unpaid order arrives there as the redirect would send it) → Pay on delivery instead. */
async function switchFromOrderPage(page, shop, online, extra = '') {
	await shop.visit(`/order?no=${online.number}&t=${online.token}${extra}`);
	expect(await waitOrderView(page, ['failed'])).toBe('failed');
	await page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]').click();
	await page.waitForURL(/\/checkout\?pay=cod$/);
	await expect(page.locator('#wf-co-phone')).toHaveValue(online.form.phone);
}

test('PI-SF-1: the last pack, held by the dismissed online order, can still go on delivery', async ({ page, shop, admin }) => {
	await admin.setStock('rolled-oats', 1);
	const online = await dismissedOnlineOrder(page, shop, { 'rolled-oats': 1 });
	await switchFromOrderPage(page, shop, online, '&payment=failed&reason=payment_cancelled');
	await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.classList.contains('wf-loading'), null, { timeout: 20_000 });
	await expect(page.locator('[data-wf-co-issue]'), 'the held pack is shown as sold out').toHaveCount(0, { timeout: 5000 });
	await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready', { timeout: 5000 });
	await page.locator('#wf-place-order').click();
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
	await expect.poll(async () => (await admin.findOrder(online.number))?.status).toBe('cancelled');
});

test('PI-SF-2: late money on an expired order that a COD order replaced is refunded, not a second order', async ({ page, shop, admin, db, cron, mock }) => {
	const online = await dismissedOnlineOrder(page, shop, { cornflakes: 1 });
	await db.expireReservation(online.number, { minutesAgo: 5 });
	await cron.runReconcile({ order: online.number });
	await expect.poll(async () => (await admin.findOrder(online.number))?.status).toBe('expired');

	await switchFromOrderPage(page, shop, online);
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready', null, { timeout: 20_000 });
	await page.locator('#wf-place-order').click();
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');

	// The customer's bank authorises the old payment after all.
	const expired = await admin.findOrder(online.number);
	const rzpOrderId = expired.razorpay.attempts.at(-1).orderId;
	const paid = await mock.pay(rzpOrderId, 'success', { method: 'upi', webhook: true });
	expect(paid.status).toBeLessThan(300);
	await expect.poll(async () => (await admin.findOrder(online.number))?.razorpay?.paymentId ?? null, { timeout: 20_000 }).not.toBeNull();
	const after = await admin.findOrder(online.number);
	expect(after.status, 'the replaced order must not become a second paid order').not.toBe('paid');
	expect(after.refunds?.length ?? 0, 'the late payment is refunded').toBeGreaterThan(0);
});
