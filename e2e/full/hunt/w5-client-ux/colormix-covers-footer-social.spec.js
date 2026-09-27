/*
 * The fixed "Mix colors" pill (bottom-left, z-index 900, every page but /cart, /checkout, /order) sits
 * exactly on the footer's Instagram and YouTube icon links once the page is scrolled to the bottom —
 * where they always are. From 480 px up they are 99–100 % covered: a click lands on the pill (it toggles
 * the site colours instead), and a keyboard user tabbing to them sees nothing (WCAG 2.4.11).
 */
import { test, expect } from '../../fixtures.js';

for (const width of [1280, 800]) {
	test(`${width}px: the footer's Instagram / YouTube links can be seen and clicked (not under the Mix colors pill)`, async ({ newContext }) => {
		const ctx = await newContext({ viewport: { width, height: 800 } });
		const page = await ctx.newPage();
		await page.goto('/shop');
		await page.locator('.wf-colormix').waitFor();
		for (const name of ['Wefeasto on Instagram', 'Wefeasto on YouTube']) {
			const link = page.locator(`a[aria-label="${name}"]`).first();
			await link.focus(); // as Tab would: scrolled into view
			const hit = await link.evaluate((a) => {
				const r = a.getBoundingClientRect();
				const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return { onTop: !!top && (top === a || a.contains(top)), topIs: top ? `${top.tagName.toLowerCase()}.${String(top.className)}` : null };
			});
			expect(hit.onTop, `${name}: the element on top of it is ${hit.topIs}`).toBe(true);
		}
	});
}
