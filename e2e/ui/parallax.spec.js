/*
 * The home trailer's scroll parallax (fx.js initParallax: scale 1.06 → 1,
 * scrub 0.8) must never widen the page (PI-EXP-4). Nothing above the video
 * clipped it, so while the scrub caught up the document grew by 3-6 px at
 * >= 768 px. Its .wf-video-frame now clips it (overflow: clip) and carries
 * the 1px border the scaled video would otherwise push out of view.
 * Deterministic: ?nofx=1 (no GSAP), and the test pins the scrub's largest
 * scale itself.
 */
import { expect } from '@playwright/test';
import { test, expectNoHorizontalOverflow } from './helpers.js';

const video = (page) => page.locator('#video video.wf-parallax-img');
const frame = (page) => page.locator('#video .wf-video-frame');

// The page is otherwise clean at these widths. (The home page at 480-600 and
// 992-1024 px overflows with or without the parallax: fixed-width content in two
// sections; pre-existing at git HEAD. The scrollWidth check below still runs there.)
const CLEAN = [390, 768, 1280];

for (const width of [390, 768, 1024, 1280]) {
	test(`home trailer at its largest parallax scale stays inside the page at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/?nofx=1');
		const at = (scale) =>
			video(page).evaluate((v, s) => {
				v.style.transform = `scale(${s})`; // 1.06 is where initParallax's scrub starts
				v.scrollIntoView({ block: 'center' });
				return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.documentElement.scrollWidth))));
			}, scale);
		const rest = await at(1);
		expect(await at(1.06), 'the scaled video widens the document').toBe(rest);
		if (CLEAN.includes(width)) await expectNoHorizontalOverflow(page);
	});
}

test('the frame clips and draws the border; the video inside has none', async ({ page }) => {
	await page.goto('/?nofx=1');
	await expect(frame(page)).toHaveCSS('overflow-x', 'clip');
	await expect(frame(page)).toHaveCSS('border-top-width', '1px');
	await expect(frame(page)).toHaveCSS('border-top-color', 'rgb(0, 0, 0)');
	await expect(video(page)).toHaveCSS('border-top-width', '0px');
	await expect(frame(page)).toHaveClass(/\bwf-reveal\b/); // still revealed like before
});

test('with motion, scrolling through the page never widens it at 768px', async ({ page }) => {
	await page.setViewportSize({ width: 768, height: 900 });
	await page.goto('/');
	await page.waitForFunction(() => typeof window.ScrollTrigger !== 'undefined');
	const widest = await page.evaluate(async () => {
		let max = 0;
		let on = true;
		const sample = () => {
			max = Math.max(max, document.documentElement.scrollWidth);
			if (on) requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
		const step = Math.floor(innerHeight * 0.8);
		for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
			scrollTo(0, y);
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		}
		await new Promise((r) => setTimeout(r, 1000));
		on = false;
		return max;
	});
	expect(widest).toBeLessThanOrEqual(768);
});
