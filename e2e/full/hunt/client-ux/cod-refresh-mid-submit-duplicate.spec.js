/*
 * Hunt (client-ux): a COD "Place order" is slow ("Placing your order…" spins), the customer
 * refreshes. The CMS had already created the order (cod_pending, confirmation email sent), but the
 * reloaded /checkout keeps no trace of it: the bag is still full, the form is empty (details not
 * saved), no banner (wefeasto_pending is for online orders only; markPlaced runs after the
 * response). Re-typing the details with any small difference (", near the park") gives a new
 * Idempotency-Key, and supersede only replaces UNPAID ONLINE orders — so a second COD order for
 * the same bag and phone is created: two shipments.
 *
 * Correct: either the reloaded page tells the customer about the order it just placed (names
 * it / links to it), or the second submission does not create a second order.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/cod-refresh-mid-submit-duplicate.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('refresh during "Placing your order…" (COD) → no duplicate order for the same bag and phone', async ({ page, shop, admin, consoleErrors }) => {
	consoleErrors.allow(/net::ERR_ABORTED/); // the held request dies with the reload
	await shop.setCart({ 'choco-flakes': 1 });
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'cod' });

	// The CMS answers, but the answer never reaches the page before the customer reloads.
	let release;
	const held = new Promise((r) => (release = r));
	await page.route('**/api/store/checkout', async (route) => {
		const res = await route.fetch();
		await held;
		await route.fulfill({ response: res }).catch(() => {});
	});
	await page.locator('#wf-place-order').click();
	await expect(page.locator('#wf-place-order')).toHaveText(/Placing your order/);
	await expect.poll(async () => (await admin.ordersByEmail(f.email)).length, { timeout: 15_000 }).toBe(1);
	const [first] = await admin.ordersByEmail(f.email);
	const firstNo = first.number ?? first.orderNumber;
	await page.unroute('**/api/store/checkout');
	release();
	await page.reload();
	await shop.waitHydrated?.(page);

	// Told about it? Then the customer knows not to order again.
	const told = await page
		.getByText(firstNo)
		.first()
		.waitFor({ state: 'visible', timeout: 10_000 })
		.then(() => true)
		.catch(() => false);
	if (told) return;

	// Not told: they order again, with a slightly different address → must not become a second order.
	await shop.fillCheckout({ name: f.name, phone: f.phone, email: f.email, address: f.address + ', near the park', method: 'cod' });
	await page.locator('#wf-place-order').click();
	await page.waitForURL(/\/order\?/, { timeout: 20_000 }).catch(() => {});
	const orders = await admin.ordersByEmail(f.email);
	expect(orders.map((o) => `${o.number ?? o.orderNumber}:${o.status}`), 'one live order for one bag').toHaveLength(1);
});
