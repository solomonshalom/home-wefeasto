/*
 * Hunt (client-ux): "Pay on delivery instead" after the UPI app paid meanwhile.
 *
 * The server's HUNT-CONC-6 fix answers a checkout that names (supersede ref) this bag's order,
 * now PAID, with 409 ALREADY_PAID {order: OrderStatusDTO} instead of placing a second order, and
 * the storefront maps ALREADY_PAID to 'goto-order' (errors.js; contract: "ALREADY_PAID → /order").
 * But flow.refuse() only goes to /order when the flow itself placed an order (`&& order`). On
 * /checkout?pay=cod — reached from the pending banner or /order's "Pay on delivery instead", a
 * fresh page whose flow never placed anything — `order` is null, so the customer is left on
 * /checkout with "This order is already paid — no need to pay again.": no order number, no link,
 * the pending banner hidden (switchedFrom), the bag still full and "Place order" still offered.
 * They never see their confirmation, and the paid bag stays in the bag.
 *
 * Correct: the paid order is shown (/order?no=<that order> confirmed), as for every other
 * ALREADY_PAID; the flow has the order's number (details.order) and token (body.supersede).
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/cod-switch-already-paid-dead-end.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('pending banner → Pay on delivery instead → the UPI payment lands → Place order shows the paid order', async ({ page, shop, mock, admin }) => {
	const r = await shop.placeOnlineOrder({ items: { cornflakes: 1 }, auto: 'dismiss', expect: null });
	await expect(page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });
	const [o] = await admin.ordersByEmail(r.form.email);

	// Later: the bag page's pending banner → Check status → "Pay on delivery instead" (→ /checkout?pay=cod).
	await shop.visit('/cart');
	await page.locator('[data-wf-pending-check]').click();
	const cod = page.locator('.wf-pending [data-wf-action="pay-on-delivery"]');
	await expect(cod).toBeVisible({ timeout: 25_000 });
	await cod.click();
	await page.waitForURL(/\/checkout\?pay=cod/);
	await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready', { timeout: 15_000 });
	await expect(page.locator('#wf-co-phone')).toHaveValue(r.form.phone); // prefilled from this tab's pending form

	// Meanwhile the UPI app finishes: the order is paid (webhook).
	const pay = await mock.pay(o.razorpay.attempts.at(-1).orderId, 'success', { webhook: true });
	expect(pay.status).toBe(200);
	await expect.poll(async () => (await admin.findOrder(o.number)).status, { timeout: 15_000 }).toBe('paid');

	await page.locator('#wf-place-order').click();
	// The server refuses a second order for the bag (ALREADY_PAID) — the page must show the paid one.
	await page.waitForURL(/\/order\?/, { timeout: 15_000 });
	expect(new URL(page.url()).searchParams.get('no')).toBe(o.number);
	expect(await shop.waitOrderView(['confirmed'])).toBe('confirmed');
	expect((await admin.ordersByEmail(r.form.email)).length, 'still one order for the bag').toBe(1);
});
