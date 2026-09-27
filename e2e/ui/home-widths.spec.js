/*
 * Home between 480 and 767px (hunt client-ux home-horizontal-scroll-480-767): 200% zoom on a
 * 1280px laptop, phones in landscape, small tablets. Webflow resets its fixed widths only below
 * 480px, so the 650px newsletter block and the side-by-side "Our Story" / "Why Wefeasto" cards
 * widened the page's grid column and the whole document scrolled sideways.
 * - no sideways scroll anywhere in the band (and at its edges);
 * - the newsletter pill keeps Submit inside the card (it used to be clipped);
 * - the story cards stack and contain their copy (no text spilling out of a 400px box);
 * - 768px+ keeps Webflow's layout (two story columns, a 650px newsletter block on desktop).
 */
import { expect } from '@playwright/test';
import { test, expectNoHorizontalOverflow } from './helpers.js';

const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;

/** Rects of the pieces under test (page coordinates, so scrolling doesn't matter). */
const layout = (page) =>
	page.evaluate(() => {
		const r = (el) => {
			const b = el.getBoundingClientRect();
			return { left: b.left, right: b.right, top: b.top + scrollY, bottom: b.bottom + scrollY, width: b.width };
		};
		const cards = [...document.querySelectorAll('#about > .grid-4')].map((g) => ({
			card: r(g),
			box: r(g.querySelector('.div-block-81')),
			copy: r(g.querySelector('.div-block-80')),
			photo: r(g.querySelector('.image-4'))
		}));
		return {
			columns: getComputedStyle(document.querySelector('#about')).gridTemplateColumns.split(' ').length,
			cards,
			newsletter: r(document.querySelector('#newsletter')),
			nlCard: r(document.querySelector('.div-block-100')),
			submit: r(document.querySelector('#email-form-2 input[type="submit"]')),
			field: r(document.querySelector('#email-form-2 input[type="email"]'))
		};
	});

test.describe('home between 480 and 767px', () => {
	for (const width of [479, 480, 500, 520, 560, 600, 640, 700, 750, 767]) {
		test(`${width}px: no sideways scroll, Submit inside its card, story copy inside its card`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await page.goto('/?nofx=1');
			await expect(page.locator('#newsletter')).toBeAttached();
			await expectNoHorizontalOverflow(page);
			const l = await layout(page);
			expect(inside(l.submit, l.nlCard), 'Submit fully inside the newsletter card').toBe(true);
			expect(l.field.width, 'the email field keeps a usable width').toBeGreaterThanOrEqual(150);
			if (width < 480) return; // Webflow hides the story cards below 480px
			expect(l.columns, 'story cards stacked').toBe(1);
			for (const c of l.cards) {
				expect(c.card.left).toBeGreaterThanOrEqual(0);
				expect(c.card.right).toBeLessThanOrEqual(width);
				expect(inside(c.copy, c.box), 'the copy stays inside its card').toBe(true);
				expect(c.photo.bottom - c.photo.top, 'the photo fills the card height').toBeGreaterThanOrEqual(c.box.bottom - c.box.top - 1);
			}
		});
	}
});

test.describe("768px and up keep Webflow's layout", () => {
	for (const width of [768, 991, 1280]) {
		test(`${width}px: two story columns, no sideways scroll`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await page.goto('/?nofx=1');
			await expectNoHorizontalOverflow(page);
			const l = await layout(page);
			expect(l.columns).toBe(2);
			if (width === 1280) expect(l.newsletter.width).toBe(650);
			expect(inside(l.submit, l.nlCard)).toBe(true);
		});
	}
});
