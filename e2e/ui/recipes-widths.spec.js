/*
 * Recipe grids between 480 and 767px (hunt client-ux recipes-horizontal-scroll-480-560): 200-250%
 * zoom on a laptop, small tablets, split screen. webflow.css keeps `.grid-6._2` three-up there
 * (its <=991px two-up reset is on `.grid-6`, which the two-class selector outranks), and three
 * recipe cards + two 42px gaps need ~565px: from 480 to ~560px the page's grid column grew past
 * the screen, the document scrolled sideways and the centred /recipes heading, "All" chip and
 * first card were cut off on the LEFT, where no scroll reaches.
 * - no sideways scroll on /recipes, a recipe page ("Related Posts") or /404 (bestsellers);
 * - the heading, the first chip and every card start and end on screen;
 * - the grid is one column below 480px, two from 480 to 767px (equal tracks), three from 768px
 *   (Webflow's own layout, unchanged).
 */
import { expect } from '@playwright/test';
import { test, expectNoHorizontalOverflow } from './helpers.js';

const columnsAt = (w) => (w < 480 ? 1 : w < 768 ? 2 : 3);

/** The first element `selector` matches (a `.grid-6._2`): its tracks, and the rects of the pieces under test. */
const layout = (page, selector) =>
	page.evaluate((sel) => {
		const r = (el) => {
			const b = el.getBoundingClientRect();
			return { left: b.left, right: b.right, width: b.width };
		};
		const grid = document.querySelector(sel);
		const chip = document.querySelector('.wf-filter-chip');
		return {
			tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat),
			grid: r(grid),
			items: [...grid.children].map(r),
			heading: r(document.querySelector('h1')),
			chip: chip ? r(chip) : null
		};
	}, selector);

function expectOnScreen(rect, width, what) {
	expect(rect.left, `${what} starts on screen`).toBeGreaterThanOrEqual(-0.5);
	expect(rect.right, `${what} ends on screen`).toBeLessThanOrEqual(width + 0.5);
}

function expectTracks(tracks, width) {
	expect(tracks.length, `columns at ${width}px`).toBe(columnsAt(width));
	const spread = Math.max(...tracks) - Math.min(...tracks);
	expect(spread, `equal columns at ${width}px (${tracks.join(' / ')})`).toBeLessThanOrEqual(1);
}

const PAGES = [
	{ path: '/recipes', grid: '#wf-recipe-grid', chips: true },
	{ path: '/recipes/wf-berry-overnight-steel-cut-oats', grid: '.grid-6._2' },
	{ path: '/recipes/wf-masala-cornflakes-chivda', grid: '.grid-6._2' },
	{ path: '/404', grid: '.grid-6._2' }
];

/** Webflow's own layouts on either side of the band, and the band itself (and its edges). */
const BANDS = [
	{ name: 'below 480px (one column)', widths: [479] },
	{ name: '480-767px (two columns)', widths: [480, 500, 520, 540, 560, 600, 640, 700, 767] },
	{ name: '768px and up (three columns)', widths: [768, 800, 991, 1280] }
];

test.describe('recipe grids (.grid-6._2) across widths', () => {
	for (const { path, grid, chips } of PAGES) {
		for (const band of BANDS) {
			test(`${path} ${band.name}: no sideways scroll, heading and cards on screen`, async ({ page }) => {
				test.slow(); // one page load per width
				for (const width of band.widths) {
					await page.setViewportSize({ width, height: 800 });
					await page.goto(path + '?nofx=1');
					await expect(page.locator(grid).first()).toBeAttached();
					await expectNoHorizontalOverflow(page);
					const l = await layout(page, grid);
					expectOnScreen(l.heading, width, `h1 at ${width}px`);
					expectOnScreen(l.grid, width, `the grid at ${width}px`);
					l.items.forEach((it, i) => expectOnScreen(it, width, `card ${i + 1} at ${width}px`));
					if (chips) expectOnScreen(l.chip, width, `the "All" chip at ${width}px`);
					expectTracks(l.tracks, width);
				}
			});
		}
	}
});
