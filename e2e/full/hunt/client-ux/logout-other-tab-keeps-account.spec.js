/*
 * Hunt (client-ux, round 3): the customer has /account open in one tab and logs out in another
 * (the same /account's "Log out", on a shared family laptop or a library PC). The first tab keeps
 * showing "Welcome back, Asha.", the name / phone / email form and the whole order list — with
 * working "View" links (/order?no=…&t=<guest token>, which need no session) — for as long as it
 * stays open, even after it is brought back to the front. Nothing in $lib/session.js notices a
 * logout made elsewhere (no 'storage' listener on the wefeasto_signed_in hint, no
 * BroadcastChannel, no re-check on focus / visibilitychange). Roadmap S3 acceptance: "Logging
 * out hides the orders."
 *
 * Correct: once the customer has logged out in any tab, the other tabs stop showing their account
 * (e.g. session.js listens for the hint's removal and goes anonymous → /account sends the tab to
 * /login, as it already does for a session that ends mid-visit).
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/logout-other-tab-keeps-account.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { createCustomer, apiLogin, placeOrderAs } from '../../accounts/helpers.js';

test('logging out in one tab hides the account (orders, details) in the other open tab', async ({ page, context, shop, stack, mailpit, unique }) => {
	const c = await createCustomer({ stack, mailpit, unique });
	await apiLogin(page, shop, c.email, c.password);
	await placeOrderAs(page, shop, unique, { items: { muesli: 1 }, method: 'cod', form: { email: c.email } });
	await shop.visit('/account');
	await expect(page.locator('[data-wf-orders] [data-wf-order]')).toHaveCount(1, { timeout: 15_000 });

	const other = await context.newPage();
	await other.goto('/account');
	await other.locator('[data-wf-logout]').click();
	await other.waitForURL((u) => u.pathname === '/');

	// Back to the first tab.
	await page.bringToFront();
	await page.evaluate(() => {
		document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('focus'));
	});
	await expect(page.locator('[data-wf-orders]'), 'the order list is gone from the other tab').toHaveCount(0, { timeout: 10_000 });
	await expect(page.locator('#wf-account-form')).toHaveCount(0);
});
