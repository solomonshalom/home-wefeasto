/*
 * The fixed "Mix colors" pill (bottom-left) and the footer's last row (the
 * Instagram / YouTube icon links and the legal line), hunt w5 client-ux
 * colormix-covers-footer-social. That row is at the bottom-left of every page
 * scrolled to the end; without room below it the pill covered it from 768px
 * up (and the legal line from 480px), so a click toggled the mix and a
 * focused icon was hidden (WCAG 2.4.11).
 *
 * wefeasto.css gives the footer a band as tall as the pill's footprint
 * wherever the pill is rendered (.footer-section::after), plus a matching
 * scroll-padding-bottom so "just into view" focus scrolling (Firefox) stops
 * above the pill. Pages without the pill (/cart, /checkout, /order) keep the
 * original footer.
 */
import { expect } from '@playwright/test';
import { test } from './helpers.js';

const WIDTHS = [1440, 1280, 1024, 800, 768, 767, 600, 480, 479, 390, 320];
const LONG_LEGAL = '© 2026 Wefeasto Foods Private Limited. All rights reserved · FSSAI Lic. No. 12345678901234';

/** Pill rect, and for every element of the footer's last row: how much of it the pill covers and what is on top of its centre. */
const lastRow = (page) =>
	page.evaluate(() => {
		const pill = document.querySelector('.wf-colormix').getBoundingClientRect();
		const rows = [...document.querySelectorAll('.legal-wrapper a[aria-label], .legal-text')].map((el) => {
			const r = el.getBoundingClientRect();
			const w = Math.max(0, Math.min(r.right, pill.right) - Math.max(r.left, pill.left));
			const h = Math.max(0, Math.min(r.bottom, pill.bottom) - Math.max(r.top, pill.top));
			const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return { name: el.getAttribute('aria-label') || 'legal line', covered: Math.round(w * h), onTop: !!top && (top === el || el.contains(top)), gap: Math.round(pill.top - r.bottom) };
		});
		return { pill: [pill.left, innerHeight - pill.bottom, pill.width, pill.height].map(Math.round), rows };
	});

const toEnd = (page) => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

test.use({ contextOptions: { reducedMotion: 'reduce' } });

for (const path of ['/shop', '/terms']) {
	for (const width of WIDTHS) {
		test(`${path} ${width}px: scrolled to the end, the pill covers nothing in the footer's last row`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await page.goto(`${path}?nofx=1`);
			await page.locator('.wf-colormix').waitFor();
			for (const long of [false, true]) {
				if (long) await page.evaluate((t) => (document.querySelector('.legal-text').textContent = t), LONG_LEGAL);
				await toEnd(page);
				const { pill, rows } = await lastRow(page);
				// the pill itself is where it always was (inset 16px, 12px on phones)
				expect(pill.slice(0, 2)).toEqual(width < 480 ? [12, 12] : [16, 16]);
				expect(rows.map((r) => r.name)).toEqual(['Wefeasto on Instagram', 'Wefeasto on YouTube', 'legal line']);
				for (const r of rows) {
					expect(r.covered, `${r.name}${long ? ' (long legal line)' : ''}: ${r.covered}px² under the pill`).toBe(0);
					expect(r.onTop, `${r.name}${long ? ' (long legal line)' : ''} is not the topmost element at its centre`).toBe(true);
				}
			}
		});
	}
}

for (const width of [1280, 600, 390]) {
	test(`${width}px: keyboard focus on the footer icons is never under the pill (Tab, and "just into view" scrolling)`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 });
		await page.goto('/shop?nofx=1');
		await page.locator('.wf-colormix').waitFor();
		const youtube = page.locator('a[aria-label="Wefeasto on YouTube"]');
		const check = () =>
			youtube.evaluate((a) => {
				const r = a.getBoundingClientRect();
				const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return { inView: r.top >= 0 && r.bottom <= innerHeight, onTop: !!top && (top === a || a.contains(top)) };
			});
		// Tab from the Instagram icon (Chromium centres a newly focused element when it can)
		await page.locator('a[aria-label="Wefeasto on Instagram"]').focus();
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.keyboard.press('Tab');
		await expect(youtube).toBeFocused();
		expect(await check()).toEqual({ inView: true, onTop: true });
		// Firefox scrolls a newly focused element only just into view: scroll-padding keeps it above the pill
		await page.evaluate(() => window.scrollTo(0, 0));
		await youtube.evaluate((a) => a.scrollIntoView({ block: 'nearest' }));
		expect(await check()).toEqual({ inView: true, onTop: true });
	});
}

test('no pill, no extra room: /cart and /checkout keep the original footer end, also after a client-side navigation', async ({ page }) => {
	const room = () =>
		page.evaluate(() => {
			const footer = document.querySelector('.footer-section');
			const after = getComputedStyle(footer, '::after');
			const row = document.querySelector('.legal-wrapper').getBoundingClientRect();
			return {
				pill: document.querySelectorAll('.wf-colormix').length,
				after: after.content === 'none' ? 0 : Math.round(parseFloat(after.height) || 0),
				below: Math.round(footer.getBoundingClientRect().bottom - row.bottom),
				scrollPadding: getComputedStyle(document.documentElement).scrollPaddingBottom
			};
		});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/shop?nofx=1');
	await page.locator('.wf-colormix').waitFor();
	expect(await room()).toEqual({ pill: 1, after: 52, below: 68, scrollPadding: '68px' });
	await page.locator('.footer-section a[href="/cart"]').click();
	await page.waitForURL(/\/cart$/);
	await expect(page.locator('.wf-colormix')).toHaveCount(0);
	expect(await room()).toEqual({ pill: 0, after: 0, below: 16, scrollPadding: 'auto' });
	for (const [path, width, below] of [
		['/checkout', 1280, 16],
		['/cart', 390, 0]
	]) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(`${path}?nofx=1`);
		await page.locator('.footer-section').waitFor();
		expect(await room(), `${path} ${width}px`).toEqual({ pill: 0, after: 0, below, scrollPadding: 'auto' });
	}
});
