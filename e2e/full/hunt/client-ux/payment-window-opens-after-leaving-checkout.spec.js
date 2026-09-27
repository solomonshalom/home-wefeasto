/*
 * Hunt (client-ux): the payment window pops up on a page the customer has already left.
 *
 * On a slow connection checkout.js takes a few seconds ("Opening payment…"). A customer who gives
 * up and taps Shop (or Back, or the bag) leaves /checkout — but the checkout flow isn't stopped
 * when the page goes away: once the script lands, flow.pay() still runs `new Razorpay(…).open()`,
 * and the payment window for the old order appears over /shop seconds later, asking for money the
 * page no longer mentions (and possibly for a bag the customer has since changed). Dismissing it
 * leaves no trace: its note belonged to the destroyed checkout page.
 *
 * Correct: leaving /checkout cancels a payment window that hasn't opened yet (e.g. onDestroy →
 * flow.reset(true), so pay() sees a stale session and doesn't open); the order stays recoverable
 * through the pending banner / order email.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/payment-window-opens-after-leaving-checkout.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('Pay → "Opening payment…" → leave for /shop → no payment window opens on /shop', async ({ page, shop, mock }) => {
	await mock.clearAuto(page); // a real person: nothing clicks the window for them
	await shop.setCart({ 'rolled-oats': 1 });
	await shop.gotoCheckout();
	await shop.fillCheckout({ method: 'upi' });

	// A slow network: the payment script takes 4 s.
	await page.route('**/api/payments/mock/checkout.js*', async (route) => {
		await new Promise((r) => setTimeout(r, 4000));
		await route.continue();
	});
	await page.locator('#wf-place-order').click();
	await expect(page.locator('#wf-place-order')).toHaveText(/Opening payment/);

	// The customer gives up waiting and goes back to the shop.
	await page.locator('nav a[href="/shop"]').first().click();
	await page.waitForURL(/\/shop$/);
	await page.waitForTimeout(7000); // the script has long arrived

	const opened = (await mock.instances(page)).filter((i) => (i.events || []).includes('open'));
	expect(opened, 'no payment window opened after leaving /checkout').toHaveLength(0);
	await expect(mock.modal(page).getByRole('button', { name: /^Pay/ })).toHaveCount(0);
});
