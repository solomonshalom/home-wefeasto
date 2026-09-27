/*
 * Hunt (client-ux): pay, then one network blip → "ERROR 500 Something went wrong" instead of
 * the order.
 *
 * After the payment handler fires, flow.js always goes to /order ("the payment may be real, and
 * /order polls the server's truth") with SvelteKit's client-side goto(). /order's page code is
 * not loaded yet, so that navigation needs one more request (/_app/immutable/nodes/<n>.js). If
 * it fails — the phone just switched back from the UPI app, Wi-Fi ↔ mobile data
 * (ERR_NETWORK_CHANGED), a dead zone — SvelteKit renders the site's error page with status 500
 * on the /order URL: "ERROR 500 · Something went wrong. Please try again in a moment." The
 * order page never mounts, so nothing polls, the paid order is never shown, the bag keeps the
 * paid items, and the page stays that way after the network is back. A customer who has just
 * paid is told something went wrong. (COD's "Place order" → /order goes the same way.)
 *
 * Correct: once the money may have moved, reaching /order doesn't depend on one more request
 * succeeding — e.g. preloadCode('/order') before the payment window opens (or on /checkout
 * mount), and/or fall back to a full navigation (location.assign) when goto fails — so the
 * order view shows up and polls as designed.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/paid-then-flaky-network-error-500.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('a paid order still reaches /order when one page-code request fails right after paying', async ({ page, shop, mock, consoleErrors }) => {
	consoleErrors.allow(/ERR_INTERNET_DISCONNECTED|Failed to fetch dynamically imported module/); // the injected blip
	await mock.setAuto(page, { auto: 'success' });
	await shop.setCart({ 'rolled-oats': 1 });
	await shop.gotoCheckout();
	await shop.fillCheckout({ method: 'upi' });

	// From the tap on: the first page-code chunk fetched (the one /order needs) hits a network blip.
	let blips = 1;
	await page.route(/\/_app\/immutable\/nodes\/\d+\.[^/]+\.js$/, (route) => {
		if (blips-- > 0) {
			return route.abort('internetdisconnected');
		}
		return route.continue();
	});
	await page.locator('#wf-place-order').click();
	await page.waitForURL(/\/order\?(.*&)?no=WF-\d+/, { timeout: 20_000 });

	// The paid order is shown (the order view mounts and polls) — not the 500 error page.
	await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', 'confirmed', { timeout: 30_000 });
});
