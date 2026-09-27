/*
 * HUNT a11y-motion (sf-checkout): /checkout fills City and State from the PIN silently.
 *
 * Typing a known PIN (560001) writes "Bengaluru" into City and "Karnataka" into State and
 * shows "Filled in from your PIN — change it if it's not right." ([data-wf-pin-hint]).
 * That note is a plain <p>: it is not a live region, and neither the PIN field nor City /
 * State point at it with aria-describedby. The page's own status region
 * ([data-wf-co-live], src/lib/checkout/announce.js) says nothing either. A screen-reader
 * user typing the PIN gets no word that two other fields just changed, or that they should
 * check them (WCAG 4.1.3 Status Messages).
 *
 * Expected: the fill is announced (e.g. "City and state filled in from your PIN:
 * Bengaluru, Karnataka — change them if they're not right") through a polite live region
 * (the page's existing [data-wf-co-live] would do); tying the hint to City/State with
 * aria-describedby is a good addition but is not a status message on its own.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/pin-autofill-status.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { seedBag } from '../../experience/helpers.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

/** Record every text a live region (aria-live / status / alert) takes from now on. */
const recordLive = (page) =>
	page.evaluate(() => {
		window.__live = [];
		const sel = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
		const grab = () => {
			for (const el of document.querySelectorAll(sel)) {
				const t = el.textContent.replace(/\s+/g, ' ').trim();
				if (t && !window.__live.includes(t)) window.__live.push(t);
			}
		};
		new MutationObserver(grab).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
	});

test('/checkout: City/State filled from the PIN is announced', async ({ page, shop }) => {
	await seedBag(page, { muesli: 1 });
	await shop.visit('/checkout');
	await shop.payReady();
	await recordLive(page);

	await page.locator('#wf-co-pin').focus();
	await page.keyboard.type('560001', { delay: 30 });
	await expect(page.locator('[data-wf-pin-hint]')).toBeVisible({ timeout: 10_000 });
	await expect(page.locator('#wf-co-city')).toHaveValue('Bengaluru');
	await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
	await page.waitForTimeout(1000); // any debounced status message

	const spoken = await page.evaluate(() => window.__live);
	const announced = spoken.some((t) => /PIN/i.test(t) && /(Bengaluru|city)/i.test(t));

	expect({ announced, liveRegionTexts: spoken }, 'the PIN autofill of City/State is announced by a live region').toMatchObject({ announced: true });
});
