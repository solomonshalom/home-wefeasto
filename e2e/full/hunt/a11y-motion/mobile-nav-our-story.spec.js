/*
 * HUNT a11y-motion (sf-core): on phones (< 480px) the mobile menu's "Our Story" link goes
 * nowhere. MobileNav.svelte links it to /#about, but #about is `.grid-9._2`, which the
 * Webflow template hides below 480px (webflow.css `.grid-9._2 { display: none }`; the
 * Phase 2 fix in wefeasto.css only restacks it for 480–767px). So the sheet closes and the
 * page stays where it was: on home it stays at the top, from any other page it lands on
 * the top of home. Keyboard focus falls to <body> with nothing new on screen. The menu is
 * the only navigation on phones (Webflow hides .nav-menu at ≤ 991px), and the contract
 * (ui-kit.md) lists "Our Story" as one of its entries.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/mobile-nav-our-story.spec.js
 */
import { test, expect } from '../../fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

/** Where "Our Story" points, once the menu has closed: is it on screen? */
const target = (page) =>
	page.evaluate(() => {
		const el = document.getElementById('about');
		if (!el) return { exists: false };
		const r = el.getBoundingClientRect();
		return { exists: true, display: getComputedStyle(el).display, height: Math.round(r.height), top: Math.round(r.top), scrollY: Math.round(window.scrollY) };
	});

for (const from of ['/', '/shop']) {
	test(`390px, from ${from}: menu "Our Story" shows the Our Story section`, async ({ page, shop }) => {
		await shop.visit(from);
		await page.locator('#wf-menu-btn').click();
		const sheet = page.getByRole('dialog', { name: 'Menu' });
		await expect(sheet).toBeVisible();
		const link = sheet.getByRole('link', { name: /Our Story/ });
		await link.focus();
		await page.keyboard.press('Enter');
		await expect(sheet).toHaveCount(0);
		await expect(page).toHaveURL(/\/#about$/);
		await page.waitForTimeout(1500); // smooth scroll / route change settle

		const t = await target(page);
		expect(t.exists, '#about exists').toBe(true);
		// The section the link names must be rendered and brought into view.
		expect(t, 'the "Our Story" section is rendered on a 390px phone').toMatchObject({ display: expect.not.stringMatching(/^none$/) });
		expect(t.height, '"Our Story" section height').toBeGreaterThan(0);
		expect(Math.abs(t.top), 'the section is scrolled to (its top near the top of the viewport)').toBeLessThan(200);
		expect(t.scrollY, 'the page moved from the top').toBeGreaterThan(0);
	});
}
