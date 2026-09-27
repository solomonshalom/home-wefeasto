/*
 * HUNT a11y-motion (sf-core): the PeepWalk crowd keeps animating while it is off-screen.
 *
 * PeepWalk uses ONE IntersectionObserver with rootMargin '300px 0px' both as the lazy
 * sprite-sheet trigger and as the run/pause gate (`visible = isIntersecting` → start()).
 * So whenever the strip is anywhere within 300px below (or above) the viewport, which is
 * where it sits while a shopper reads the last section of home, the shop grid's last row,
 * a recipe's last step, etc., the gsap.ticker loop runs at full frame rate and redraws the
 * whole crowd for nobody. The contract (ui-kit.md) says "One gsap.ticker listener while
 * visible, none off-screen", and the lazy load only needs the margin for the first fetch.
 *
 * Repro: bring the strip into view once (sheet loaded, loop running), then scroll up so its
 * top edge is 150px below the fold and count drawImage calls to the crowd canvas.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/peepwalk-offscreen.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { drawsDuring, instrumentPeeps, peepLoops, scrollToStrip, strip } from '../../experience/helpers.js';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(instrumentPeeps);
});

for (const path of ['/', '/shop']) {
	test(`${path}: no crowd frames while the strip is 150px below the fold`, async ({ page, shop }) => {
		await shop.visit(path);
		await scrollToStrip(page);
		await expect(strip(page)).toHaveAttribute('data-mode', 'live');
		await expect.poll(() => peepLoops(page)).toBe(1); // walking while on screen

		// Scroll up until the strip's top is 150px below the bottom of the viewport.
		await page.evaluate(() => {
			const el = document.querySelector('canvas.wf-peepwalk');
			const top = el.getBoundingClientRect().top + window.scrollY;
			window.scrollTo(0, top - window.innerHeight - 150);
		});
		await expect
			.poll(() => page.evaluate(() => Math.round(document.querySelector('canvas.wf-peepwalk').getBoundingClientRect().top - window.innerHeight)))
			.toBe(150);
		await page.waitForTimeout(300); // IntersectionObserver delivery

		const off = await page.evaluate(() => {
			const r = document.querySelector('canvas.wf-peepwalk').getBoundingClientRect();
			return r.top >= window.innerHeight;
		});
		expect(off, 'the strip is entirely below the viewport').toBe(true);
		expect(await drawsDuring(page, 1000), 'drawImage calls on the crowd canvas in 1 s while it is off-screen').toBe(0);
		expect(await peepLoops(page), 'PeepWalk ticker loops while off-screen').toBe(0);
	});
}
