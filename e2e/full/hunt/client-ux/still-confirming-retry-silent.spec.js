/*
 * Hunt (client-ux): /order's "Still confirming" view (after 2 minutes of polling a
 * pending_payment order) offers "Didn't finish paying? Try again", but that branch of the
 * page never renders the flow's note (flowNote is only rendered in the failed view). A retry
 * that fails — offline, a 5xx, a refusal such as the order having expired — leaves the page
 * exactly as it was: the tap looks dead and the customer isn't told anything.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/still-confirming-retry-silent.spec.js
 */
import { test, expect } from '../../fixtures.js';

// The fake clock below walks 2 minutes of polling in 2.5s steps, and every step fires ~150
// animation frames: a walking PeepWalk crowd would be drawn 150 times per step for nothing
// (that alone timed this spec out). Reduced motion = one still crowd frame; the retry note
// does not depend on motion.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test('"Still confirming" → Try again while offline → the page says the retry did not go through', async ({ page, shop, api, consoleErrors }) => {
	consoleErrors.allow(/net::ERR_INTERNET_DISCONNECTED/); // the aborted retry
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'upi' });
	expect(o.status).toBe('pending_payment');
	await page.clock.install();
	await page.goto(`/order?no=${o.number}&t=${o.token}`);
	await shop.waitOrderView(['confirming']);
	// The confirming schedule runs out after 2 minutes of (visible) polling → "Still confirming".
	for (let i = 0; i < 60 && (await page.locator('[data-wf-order-view]').getAttribute('data-wf-order-view')) !== 'slow'; i++) await page.clock.runFor(2500);
	await shop.waitOrderView(['slow'], { timeout: 10_000 });
	await expect(page.locator('[data-wf-still-confirming]')).toBeVisible();

	await page.route('**/api/store/checkout/retry', (r) => r.abort('internetdisconnected'));
	const sent = page.waitForRequest((r) => r.url().endsWith('/api/store/checkout/retry'));
	await page.locator('[data-wf-confirming] [data-wf-action="try-again"]').click();
	await sent; // the retry really went out (and died on the network)
	await page.clock.runFor(1000);
	await expect(page.locator('[data-wf-order-view] [data-wf-co-note]'), 'the failed retry is explained on the page').toBeVisible({ timeout: 10_000 });
	await expect(page.locator('[data-wf-order-view] [data-wf-co-note]')).toContainText(/couldn.t reach|connection/i);
});
