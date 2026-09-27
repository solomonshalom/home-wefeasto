/*
 * Hunt (client-ux): the home page scrolls sideways between 480 and 767 px — 200% zoom on a
 * 1280 px laptop (640 CSS px), phones in landscape (667–740 px), small tablets.
 *
 * The newsletter block ("Stay Crunchy", .div-block-101) is `width: 650px` in webflow.css and is
 * only reset to `auto` below 480 px. Between 480 and 767 px it is wider than its container, the
 * home page's grid column grows to fit it (750 px at a 640 px viewport), and every section of the
 * page becomes wider than the screen: the document scrolls horizontally (695 px of content in a
 * 640 px window) and the hero, cards and buttons sit off-centre / partly off-screen. (Present in
 * the original Webflow export; still customer-visible.)
 *
 * Correct: no horizontal page scroll at any width (e.g. `.div-block-101 { width: auto;
 * max-width: 650px }` in wefeasto.css).
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/home-horizontal-scroll-480-767.spec.js
 */
import { test, expect } from '../../fixtures.js';

for (const width of [640, 700]) {
	test(`home page has no horizontal scroll at ${width} px`, async ({ page, shop }) => {
		await page.setViewportSize({ width, height: 800 });
		await shop.visit('/?nofx=1');
		await expect(page.locator('#newsletter')).toBeAttached();
		const { scrollWidth, clientWidth } = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth
		}));
		expect(scrollWidth, `document width at a ${clientWidth} px viewport`).toBeLessThanOrEqual(clientWidth);
	});
}
