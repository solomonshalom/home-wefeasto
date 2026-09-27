/*
 * HUNT a11y-motion (sf-core): the PeepWalk crowd moves forever with no way to pause it
 * (WCAG 2.2.2 Pause, Stop, Hide, level A).
 *
 * On /order the confirmed view opens with a full-width, 350px-tall walking crowd (bublr size) right
 * above "Order confirmed" and the receipt (roadmap §8.2 #2); on home, shop, PDPs, recipes,
 * the bag and the 404 the 350px strip walks above the footer. The animation starts by
 * itself, runs at ~60 fps (≈ 5 000 drawImage calls a second on /order at 1280px) for as long
 * as it is on screen, sits next to the content people are reading, and the page offers no
 * control to pause, stop or hide it. Only the OS-level prefers-reduced-motion setting (or
 * ?nofx=1) stills it, which SC 2.2.2 does not count as a mechanism the content provides.
 *
 * Expected: either the crowd settles into its still frame by itself within 5 s, or a
 * visible control (e.g. a "Pause animation" toggle) stops it.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/peepwalk-pause.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { drawsDuring, instrumentPeeps, scrollToStrip } from '../../experience/helpers.js';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(instrumentPeeps);
});

/** A visible control that pauses / stops the animation, if the page has one. */
const pauseControl = (page) => page.getByRole('button', { name: /pause|stop|animation|motion/i }).or(page.getByRole('switch', { name: /pause|stop|animation|motion/i }));

async function expectStoppable(page, where) {
	// Moving well past the 5 s the SC allows.
	await page.waitForTimeout(5500);
	const control = pauseControl(page);
	if (await control.count()) {
		await control.first().click();
		await page.waitForTimeout(300);
	}
	expect(await drawsDuring(page, 1000), `${where}: crowd frames drawn per second after 5.5 s (pause control: ${await control.count() ? 'pressed' : 'none'})`).toBe(0);
}

test('/order confirmed: the celebration crowd stops, or can be paused', async ({ page, shop, api }) => {
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	await shop.visit(`/order?no=${o.number}&t=${o.token}`);
	await shop.waitOrderView(['confirmed']);
	await expect(page.locator('canvas.wf-peepwalk')).toBeVisible();
	await expectStoppable(page, '/order');
});

test('home: the footer strip stops, or can be paused', async ({ page, shop }) => {
	await shop.visit('/');
	await scrollToStrip(page);
	await expect(page.locator('canvas.wf-peepwalk')).toHaveAttribute('data-mode', 'live');
	await expectStoppable(page, 'home strip');
});
