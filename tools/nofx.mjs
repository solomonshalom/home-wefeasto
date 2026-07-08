/*
 * Kill-switch checks on the port: ?nofx=1 and prefers-reduced-motion must
 * leave no veil and all content visible; client-side nav must stay clean.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
const browser = await chromium.launch();

async function probe(label, ctxOpts, url) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctxOpts });
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(BASE + url, { waitUntil: 'load' });
	await page.waitForTimeout(900);
	const r = await page.evaluate(() => {
		const veil = document.getElementById('wf-veil');
		const vis = (sel) => {
			const el = document.querySelector(sel);
			return el ? getComputedStyle(el).opacity : 'missing';
		};
		return {
			veil: veil ? getComputedStyle(veil).display + '/' + getComputedStyle(veil).opacity : 'absent',
			hero: vis('h1'),
			reveal: vis('.wf-reveal'),
			grid: vis('.grid-6')
		};
	});
	// client-side nav in this mode
	await page.click('a[href="/shop"]');
	await page.waitForTimeout(1200);
	const afterNav = await page.evaluate(() => {
		const veil = document.getElementById('wf-veil');
		return {
			path: location.pathname,
			veil: veil ? getComputedStyle(veil).display + '/' + getComputedStyle(veil).opacity : 'absent',
			hero: getComputedStyle(document.querySelector('h1')).opacity
		};
	});
	console.log(label, JSON.stringify({ ...r, afterNav, errors }));
	await ctx.close();
}

await probe('nofx      ', {}, '/?nofx=1');
await probe('reduced   ', { reducedMotion: 'reduce' }, '/');
await probe('normal    ', {}, '/');
await browser.close();
