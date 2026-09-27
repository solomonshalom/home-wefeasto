/*
 * Hunt (client-ux, sf-checkout): a first-time customer with a welcome (first-order-only) offer
 * closes the payment window, then on /cart the pending banner asks about it. They tap "Not now"
 * (after Check status) or × ("Forget this order on this device") and check the same bag out again
 * — with the same details, choosing Pay on delivery.
 *
 * Both buttons clear wefeasto_pending, the device's only proof that the unpaid order is theirs
 * (SUP-OWN-1: the checkout must name it as `supersede`). The order itself stays open, holding the
 * first-order claim. So /checkout shows "Offer … applied · −₹45 · Total ₹454", and "Place order"
 * answers "That offer is for your first order only." — to a customer who has never had an order.
 * The only ways on are "Remove offer" (pay ₹45 more) or waiting out the reservation.
 *
 * Correct: "Not now" only hides the banner (the order can still be replaced), and forgetting an
 * unpaid order doesn't leave it holding the customer's offer (and stock) against them — the new
 * checkout goes through with the offer.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/banner-not-now-locks-own-offer.spec.js
 */
import { test, expect } from '../../fixtures.js';

for (const how of ['Not now', '× (forget on this device)']) {
	test(`dismissed payment → banner "${how}" → same bag again with Pay on delivery: the welcome offer still applies`, async ({ page, shop, admin }) => {
		const c = await admin.createCoupon({ type: 'percent', value: 10, firstOrderOnly: true });
		await shop.setCart({ 'choco-flakes': 1, muesli: 1 });
		await shop.visit('/cart?offer=' + c.code);
		const first = await shop.placeOnlineOrder({ auto: 'dismiss', expect: null });
		await expect(page.locator('.wf-co-note')).toContainText('no money was taken', { timeout: 20_000 });

		await shop.clientNav('/cart');
		const banner = page.locator('[data-wf-pending]');
		await expect(banner).toBeVisible();
		if (how === 'Not now') {
			await banner.locator('[data-wf-pending-check]').click();
			await banner.locator('[data-wf-action="forget"]').click({ timeout: 30_000 });
		} else {
			await banner.locator('.wf-pending-close').click();
		}
		await expect(banner).toHaveCount(0);

		await shop.clientNav('/checkout');
		await shop.fillCheckout({ ...first.form, method: 'cod' });
		await expect(page.locator('[data-wf-offer]')).toHaveAttribute('data-wf-offer-state', 'applied');
		await page.locator('#wf-place-order').click();
		const outcome = await Promise.race([
			page.waitForURL(/\/order\?/, { timeout: 20_000 }).then(() => 'order'),
			page.locator('.wf-co-note').waitFor({ timeout: 20_000 }).then(async () => 'refused: ' + (await page.locator('.wf-co-note').innerText()).replace(/\s+/g, ' '))
		]);
		expect(outcome, 'not refused over the customer’s own unpaid order').toBe('order');
		const cod = (await admin.ordersByEmail(first.form.email)).find((o) => o.paymentMethod === 'cod' || o.status === 'cod_pending');
		expect(cod?.coupon?.code, 'the COD order carries the welcome offer').toBe(c.code);
	});
}
