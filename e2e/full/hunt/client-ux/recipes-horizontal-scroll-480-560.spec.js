/*
 * Hunt (client-ux, round 3): /recipes and every /recipes/<slug> page scroll sideways between
 * 480 and ~560 px (200–250 % zoom on a laptop, small tablets, split-screen) — and on /recipes the
 * content is centred in a column wider than the screen, so the heading ("…ecipes that start with
 * a crunch."), the "All" filter chip and the first card are cut off on the LEFT, where no scroll
 * can reach them.
 *
 * Cause: the recipe grids are `.grid-6._2` (webflow.css: 3 columns). The ≤991 px rule only
 * resets `.grid-6` to 2 columns, which the two-class `.grid-6._2` outranks, and `.grid-6._2`
 * only drops to 1 column ≤479 px. Three cards + two 42 px gaps don't fit below ~565 px, and the
 * page-wrapper grid column grows to fit them (565 px at a 480 px viewport). (Not the home page's
 * newsletter-width bug: different page, different rule.) /order's recipe grid has its own
 * override in wf-checkout.css and is fine.
 *
 * Correct: no horizontal page scroll at any width (e.g. `.grid-6._2 { grid-template-columns:
 * repeat(2, minmax(0, 1fr)) }` at ≤767/991 px, or minmax(0, 1fr) tracks).
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/recipes-horizontal-scroll-480-560.spec.js
 */
import { test, expect } from '../../fixtures.js';

const widths = () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth });

for (const width of [480, 520]) {
	test(`/recipes and a recipe page have no horizontal scroll at ${width} px`, async ({ page, shop }) => {
		await page.setViewportSize({ width, height: 800 });
		await shop.visit('/recipes?nofx=1');
		await expect(page.locator('#wf-recipe-grid .wf-recipe-item').first()).toBeVisible();
		const list = await page.evaluate(widths);
		const heading = await page.locator('h1').boundingBox();
		const recipe = await page.locator('#wf-recipe-grid a.wf-card-cover').first().getAttribute('href');

		await shop.visit(recipe + '?nofx=1');
		const detail = await page.evaluate(widths);

		expect.soft(heading.x, '/recipes heading starts on screen').toBeGreaterThanOrEqual(0);
		expect.soft(list.scrollWidth, `/recipes document width at ${width} px`).toBeLessThanOrEqual(list.clientWidth);
		expect.soft(detail.scrollWidth, `${recipe} document width at ${width} px`).toBeLessThanOrEqual(detail.clientWidth);
	});
}
