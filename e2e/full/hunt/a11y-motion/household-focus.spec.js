/*
 * HUNT a11y-motion (sf-checkout): /order "Breakfast for how many?" drops keyboard focus.
 *
 * The four household pills (1 / 2 / 3 / 4+) are rendered with
 * `disabled={householdState === 'saving' || undefined}`. Pressing one with the keyboard
 * disables the very button that has focus, so the browser moves focus to <body> the moment
 * the save starts, and nothing brings it back when the pills are re-enabled: a screen-reader
 * user is left on the document with the pressed state never read back. (Same pattern the
 * earlier rounds fixed for the bag, /account and /login controls: busy controls stay
 * focusable with aria-disabled, or focus is put back once they settle — see
 * src/routes/login/focus.js focusIfLost.)
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/household-focus.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { expectFocusKept, focused } from './helpers.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

test('/order: a household pill pressed from the keyboard keeps focus', async ({ page, shop, api }) => {
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	await shop.visit(`/order?no=${o.number}&t=${o.token}`);
	await shop.waitOrderView(['confirmed']);

	const two = page.locator('[data-wf-household="2"]');
	await two.focus();
	await expect(two).toBeFocused();
	await page.keyboard.press('Enter');

	// The save lands ("Thanks — we'll time your refill reminder to match.") …
	await expect(page.locator('[data-wf-household-saved]')).toBeVisible();
	await expect(two).toHaveAttribute('aria-pressed', 'true');
	await expect(two).toBeEnabled();

	// … and the keyboard user is still on the pill they pressed.
	await expectFocusKept(page, 'after saving "Breakfast for 2"', { ms: 300 });
	expect((await focused(page)).text, 'focus is back on the pressed pill').toBe('2');
});
