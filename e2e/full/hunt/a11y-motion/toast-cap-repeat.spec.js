/*
 * HUNT a11y-motion (sf-core): at the per-order cap, a second "Add to Cart" is silent for
 * screen-reader users (WCAG 4.1.3 Status Messages).
 *
 * The mini-bag toast mirrors its message into a polite live region
 * ([data-wf-toast-live]). Every normal add changes the words ("Muesli ×2", "×3", …), so
 * each one is spoken. At the cap the words stay the same: the first capped add says
 * "Muesli ×10 is in your bag — 10 is the most we can send in one order", and every further
 * press produces exactly the same string, so Svelte never touches the region and nothing
 * is announced. Sighted shoppers get the card's scale pulse (and the timer restarts); a
 * screen-reader user pressing Add again hears nothing and cannot tell whether the add
 * worked, failed or is still pending. /checkout already handles this ("cleared first, so
 * the same words twice are still spoken twice").
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/toast-cap-repeat.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('toast: a repeated capped add is announced again', async ({ page, shop }) => {
	await shop.setCart({ muesli: 10 }); // muesli's per-order cap
	await shop.visit('/products/muesli');
	const add = page.locator('a.button:has-text("Add to Cart")').first();
	const live = page.locator('[data-wf-toast-live]');

	await add.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-wf-toast]')).toBeVisible();
	await expect(live).toContainText('10 is the most we can send in one order', { timeout: 5_000 });

	// Watch the live region, then press Add again (still at the cap; the toast is still open).
	await page.evaluate(() => {
		window.__toastLive = [];
		new MutationObserver((ms) => ms.forEach((m) => window.__toastLive.push(m.target.textContent || ''))).observe(document.querySelector('[data-wf-toast-live]'), {
			childList: true,
			subtree: true,
			characterData: true
		});
	});
	await add.focus();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(800);
	await expect(page.locator('[data-wf-toast]')).toBeVisible();
	await expect(live).toContainText('10 is the most we can send in one order');

	const spoken = await page.evaluate(() => window.__toastLive.join(' | '));
	expect(spoken, 'the second capped add re-inserts the cap message into the live region').toContain('10 is the most we can send in one order');
});
