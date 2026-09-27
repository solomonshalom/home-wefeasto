/*
 * Hunt (client-ux): the Idempotency-Key (sessionStorage wefeasto_idem, keyed on cart signature +
 * form hash) outlives the order it was made for. Ordering the same bag again in the same tab —
 * e.g. /order's "Buy again" straight after an order, with saved details — sends the old key, the
 * server replays the finished order, and the page shows that OLD order as "Order confirmed". No
 * new order is placed, the bag keeps its items, and the customer believes they ordered again.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/same-bag-again-replays-old-order.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('COD: "Buy again" right after an order, same saved details → a NEW order, not the old one replayed', async ({ page, shop, admin }) => {
	const first = await shop.placeCodOrder({ items: { 'rolled-oats': 1 }, form: { save: true } });
	expect(first.view).toBe('confirmed');

	// The confirmation page's own "Buy again" → /cart?add=… → /checkout (details prefilled from "Save my details").
	await page.locator('[data-wf-buy-again]').click();
	await page.waitForURL(/\/cart/);
	await expect.poll(() => shop.cartCount()).toBe(1);
	await shop.gotoCheckout();
	await expect(page.locator('[data-wf-saved]')).toBeVisible();
	await page.locator('label.wf-pay-pill:has(input[value="cod"])').click();
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready');
	await page.locator('#wf-place-order').click();
	await shop.waitOrderView(['confirmed']);

	const second = new URL(page.url()).searchParams.get('no');
	expect(second, 'the second Place order lands on a new order, not the first one again').not.toBe(first.number);
	const orders = await admin.ordersByEmail(first.form.email);
	expect(orders, 'two orders exist for the two taps').toHaveLength(2);
});

test('online: paid order, then the same bag + details again in the same tab → the payment window opens for a new order', async ({ page, shop, mock, admin }) => {
	const first = await shop.placeOnlineOrder({ items: { 'rolled-oats': 1 }, auto: 'success', form: { save: true } });
	expect(first.view).toBe('confirmed');

	await page.locator('[data-wf-buy-again]').click();
	await page.waitForURL(/\/cart/);
	await expect.poll(() => shop.cartCount()).toBe(1);
	await mock.setAuto(page, { auto: 'success' });
	await shop.gotoCheckout();
	await expect(page.locator('[data-wf-saved]')).toBeVisible();
	await page.locator('label.wf-pay-pill:has(input[value="upi"])').click();
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready');
	await page.locator('#wf-place-order').click();
	await shop.waitOrderView(['confirmed']);

	const second = new URL(page.url()).searchParams.get('no');
	expect(second, 'Pay lands on a new, paid order — not the first one again').not.toBe(first.number);
	const orders = await admin.ordersByEmail(first.form.email);
	expect(orders.filter((o) => o.status === 'paid'), 'two paid orders for the two payments').toHaveLength(2);
});
