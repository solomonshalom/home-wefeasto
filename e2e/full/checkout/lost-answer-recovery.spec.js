/*
 * Hunt round 3 (client-ux), end to end: a checkout tap whose answer never reached the phone.
 *
 *  - online, the page reloaded during "Opening payment…": the reloaded /checkout asks for that tap's
 *    order again (flow.recall, its own request under its key), names it from then on (quote and
 *    checkout `supersede`), and says so. Changed details then replace it: one paid order, with the
 *    single-use offer the unseen order had reserved — never "fully claimed" / "just sold out" over
 *    the customer's own order;
 *  - COD, then a top-up in the summary, then "Place order": the first tap's order is kept (never a
 *    second shipment of the same bag), /order says what it holds and where it ships, and the top-up
 *    is still in the bag.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/checkout/lost-answer-recovery.spec.js
 */
import { test, expect, setMockAuto, waitOrderView, payReady } from '../fixtures.js';

/** The next POST /api/store/checkout reaches the CMS, but its answer never reaches the page. */
async function loseNextCheckoutAnswer(page) {
	let first = true;
	await page.route('**/api/store/checkout', async (route) => {
		if (!first) return route.continue();
		first = false;
		await route.fetch();
		await route.abort('connectionreset');
	});
}

const live = (orders) => orders.filter((o) => !['cancelled', 'expired'].includes(o.status));

test('online: reload mid-request → the reloaded page finds that order; changed details replace it, offer kept', async ({ page, shop, admin, consoleErrors }) => {
	consoleErrors.allow(/net::ERR_ABORTED|ERR_CONNECTION_RESET|net::ERR_FAILED/);
	await admin.setStock('health-mix', 1); // the unseen order holds the last pack
	const c = await admin.createCoupon({ type: 'percent', value: 10, usageLimit: 1 });
	await shop.setCart({ 'health-mix': 1 });
	await shop.visit('/cart?offer=' + c.code);
	await setMockAuto(page, { auto: 'success' });
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'upi' });
	await expect(page.locator('[data-wf-offer]')).toHaveAttribute('data-wf-offer-state', 'applied');

	// The CMS places the order; the page reloads before the answer arrives.
	let release;
	const held = new Promise((r) => (release = r));
	await page.route('**/api/store/checkout', async (route) => {
		const res = await route.fetch();
		await held;
		await route.fulfill({ response: res }).catch(() => {});
	});
	await page.locator('#wf-place-order').click();
	await expect.poll(async () => (await admin.ordersByEmail(f.email)).length, { timeout: 15_000 }).toBe(1);
	const [first] = await admin.ordersByEmail(f.email);
	// Reload first, then let the held answer go: it must never reach the page (the reload aborts it).
	await page.unroute('**/api/store/checkout');
	await page.reload();
	release();

	const note = page.locator('.wf-co-note[data-wf-co-note="PLACING"]');
	await expect(note).toContainText(first.number, { timeout: 20_000 });
	await expect(page.locator('#wf-co-email')).toHaveValue(f.email); // that tap's details are back
	await payReady(page);
	await expect(page.locator('[data-wf-co-issue]'), 'its own last pack is not "sold out"').toHaveCount(0);
	await expect(page.locator('[data-wf-offer]')).toHaveAttribute('data-wf-offer-state', 'applied');

	await page.fill('#wf-co-address', f.address + ', near the park');
	await payReady(page);
	await page.locator('#wf-place-order').click();
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');

	const orders = await admin.ordersByEmail(f.email);
	const paid = orders.filter((o) => o.status === 'paid');
	expect(paid, 'one paid order').toHaveLength(1);
	expect(paid[0].coupon?.code ?? paid[0].couponCode, 'with the offer').toBe(c.code);
	expect(paid[0].shippingAddress?.line1).toBe(f.address + ', near the park');
	expect(orders.find((o) => o.number === first.number)?.status, 'the unseen order was replaced').toBe('cancelled');
});

test('COD: lost answer → a top-up → Place order: no second shipment; /order names the kept order and the top-up stays', async ({ page, shop, admin, consoleErrors }) => {
	consoleErrors.allow(/ERR_CONNECTION_RESET|net::ERR_FAILED/);
	await shop.setCart({ 'choco-flakes': 1 });
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'cod' });
	await loseNextCheckoutAnswer(page);
	await page.locator('#wf-place-order').click();
	await expect(page.locator('.wf-co-note')).toContainText('couldn’t reach Wefeasto', { timeout: 20_000 });

	const topup = page.locator('[data-wf-topup]');
	await expect(topup).toBeVisible();
	const added = await topup.getAttribute('data-wf-topup');
	await topup.locator('.wf-topup-add').click();
	await expect(page.locator(`[data-wf-co-line="${added}"]`)).toBeVisible();
	await payReady(page);
	await page.locator('#wf-place-order').click();
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');

	const orders = live(await admin.ordersByEmail(f.email));
	expect(orders, 'one live order: the first tap’s').toHaveLength(1);
	expect(orders[0].items.map((i) => `${i.slug}:${i.qty}`)).toEqual(['choco-flakes:1']);
	const kept = page.locator('[data-wf-kept]');
	await expect(kept).toContainText('already placed this order');
	await expect(kept.locator('[data-wf-kept-address]')).toContainText(f.address);
	await expect(kept).toContainText('Anything you added since is still in your bag.');
	await expect.poll(() => shop.readCart()).toEqual({ [added]: 1 });
});
