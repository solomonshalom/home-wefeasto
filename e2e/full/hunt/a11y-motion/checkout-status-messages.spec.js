/*
 * HUNT a11y-motion (sf-checkout): /checkout changes the order under the shopper without a
 * status message (WCAG 4.1.3). Phase 2 made the checkout summary server-driven (top-up
 * suggestions, coupons, delivery/COD fees, sold-out lines), but #wf-co-summary has no live
 * region and the mini-bag toast, the only other "added" announcement, is suppressed on
 * /checkout. (The /cart list is aria-live, so the same actions there are announced.)
 *
 *   - "+ Add" on the summary's top-up adds a product and raises the total: nothing is
 *     announced, and the button the shopper pressed disappears.
 *   - The same add makes a pending offer valid (min subtotal reached): the discount and the
 *     new total appear silently.
 *
 * Both tests press the control from the keyboard, then look for the change in any live
 * region (aria-live / role=status|alert|log) that already existed before the press.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/checkout-status-messages.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { keyboardActivate, seedStorage } from './helpers.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';

/** Tag every live region present now, so later text can be checked against pre-existing regions only. */
const tagLiveRegions = (page) => page.evaluate((sel) => document.querySelectorAll(sel).forEach((n) => (n.dataset.huntLive = '1')), LIVE);
const preexistingLiveText = (page) =>
	page.evaluate(() => [...document.querySelectorAll('[data-hunt-live]')].filter((n) => n.isConnected).map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' | '));

const settled = (page) =>
	page.waitForFunction(() => {
		const s = document.querySelector('#wf-co-summary');
		return !!s && !s.classList.contains('wf-loading') && !s.textContent.includes('Loading your bag');
	});

test('/checkout top-up "+ Add" announces what was added', async ({ page, shop }) => {
	await seedStorage(page, { wefeasto_cart: { cornflakes: 1 } }); // ₹175: below free delivery
	await shop.visit('/checkout');
	await shop.payReady();
	await settled(page);
	const row = page.locator('#wf-co-summary .wf-topup');
	await expect(row).toBeVisible();
	const slug = await row.getAttribute('data-wf-topup');
	const name = (await row.locator('.wf-topup-text strong').textContent()).split(' · ')[0].trim();

	await tagLiveRegions(page);
	await keyboardActivate(row.locator('.wf-topup-add'));
	await expect.poll(() => page.evaluate((s) => window.WefeastoCart.read()[s] || 0, slug)).toBe(1);
	await settled(page);
	await page.waitForTimeout(500);
	expect(await preexistingLiveText(page), `a status message mentions ${name}`).toContain(name);
});

test('/checkout: an offer that becomes valid after "+ Add" is announced', async ({ page, shop, admin }) => {
	const coupon = await admin.createCoupon({ type: 'percent', value: 10, minSubtotalPaise: 17600 }); // needs > ₹175
	await seedStorage(page, { wefeasto_cart: { cornflakes: 1 } });
	await shop.visit(`/cart?offer=${coupon.code}`);
	await expect(page.locator(`[data-wf-offer="${coupon.code}"]`)).toBeVisible();
	await shop.visit('/checkout');
	await shop.payReady();
	await settled(page);
	const offer = page.locator(`#wf-co-summary [data-wf-offer="${coupon.code}"]`);
	await expect(offer).toHaveAttribute('data-wf-offer-state', 'invalid');

	await tagLiveRegions(page);
	await keyboardActivate(page.locator('#wf-co-summary .wf-topup-add'));
	await expect(offer).toHaveAttribute('data-wf-offer-state', 'applied', { timeout: 15_000 });
	await expect(page.locator('#wf-co-summary [data-wf-discount]')).toBeVisible();
	await page.waitForTimeout(500);
	expect(await preexistingLiveText(page), 'a status message says the offer now applies').toMatch(new RegExp(`${coupon.code}[^|]*applied|applied[^|]*${coupon.code}`, 'i'));
});
