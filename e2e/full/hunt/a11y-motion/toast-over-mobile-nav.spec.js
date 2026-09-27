/*
 * HUNT a11y-motion (sf-core): the mini-bag toast sits ON TOP of the open mobile menu.
 *
 * The menu (MobileNav.svelte, ≤ 991px) is an aria-modal dialog at z-index 1050; the toast
 * (CartToast.svelte) is fixed at z-index 1100 and stays up when the menu opens. Right after
 * an "Add to Cart", a shopper who opens the menu (the natural way to reach the bag on a
 * phone) gets a sheet whose entries are under the toast:
 *   - phones in landscape (844×390, 915×412): Recipes, Our Story, Contact, Account and Bag
 *     are partly covered; a tap on "Contact" lands on the toast's "View bag" (→ /cart),
 *     a tap on Recipes / Our Story lands on the toast head (a press holds the toast open);
 *   - an 800×600 window: Account and Bag are entirely covered, so a keyboard user's focus on
 *     them inside the modal menu is invisible (WCAG 2.4.11 Focus Not Obscured), and a mouse
 *     aimed at them hovers the toast, which holds it open for as long as the pointer stays.
 *
 * Expected: while the menu is open nothing outside it covers its controls (close or hide
 * the toast when the menu opens, or stack the toast below the sheet).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/toast-over-mobile-nav.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { toast } from '../../experience/helpers.js';

/** For every control in the open sheet (brought into view the keyboard way): what is on top at its centre and corners. */
async function coverage(page) {
	const out = [];
	for (const el of await page.locator('.wf-mnav a[href], .wf-mnav button').all()) {
		await el.focus(); // scrolls it into view inside the sheet, as Tab does
		out.push(
			await el.evaluate((e) => {
				const b = e.getBoundingClientRect();
				const pts = [
					[b.left + b.width / 2, b.top + b.height / 2],
					[b.left + 4, b.top + 4],
					[b.right - 4, b.top + 4],
					[b.left + 4, b.bottom - 4],
					[b.right - 4, b.bottom - 4]
				];
				const onTop = pts.map(([x, y]) => document.elementFromPoint(x, y)).map((t) => (!t ? 'nothing' : e === t || e.contains(t) ? 'self' : t.closest('[data-wf-toast]') ? 'toast' : 'other'));
				return { name: (e.getAttribute('aria-label') || e.textContent).replace(/[→\s]+/g, ' ').trim(), onTop: onTop.join(',') };
			})
		);
	}
	return out;
}

for (const vp of [
	{ width: 844, height: 390 }, // iPhone 12-15 in landscape
	{ width: 800, height: 600 } // a small window / tablet in landscape
]) {
	test(`${vp.width}×${vp.height}: the open menu is not covered by the mini-bag toast`, async ({ page, shop }) => {
		await page.setViewportSize(vp);
		await shop.visit('/products/muesli');
		await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
		await expect(toast(page)).toBeVisible();

		await page.locator('#wf-menu-btn').click();
		await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
		await page.waitForTimeout(250); // sheet slide-in

		const covered = (await coverage(page)).filter((c) => c.onTop.includes('toast'));
		expect(covered, 'menu controls with the toast on top of them (toast still open: ' + (await toast(page).count()) + ')').toEqual([]);
	});
}
