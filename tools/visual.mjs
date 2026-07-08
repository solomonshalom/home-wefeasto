/*
 * Visual 1:1 check — screenshots every page on both sites with JavaScript
 * DISABLED (pure markup + CSS render; the DOM was already proven equivalent)
 * and pixel-compares them. CSS animations are frozen for determinism.
 *   node visual.mjs
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'visual-out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const ORIG = { name: 'orig', base: 'http://localhost:8000', toUrl: (p) => (p === '/' ? '/index.html' : p + '.html') };
const PORT = { name: 'port', base: 'http://localhost:4173', toUrl: (p) => p };

const PAGES = [
	'/', '/shop', '/recipes', '/cart', '/checkout', '/login', '/terms', '/privacy',
	'/products/cornflakes', '/products/health-mix', '/products/muesli',
	'/recipes/wf-masala-cornflakes-chivda', '/recipes/wf-banana-oat-pancakes'
];

const VIEWPORTS = [
	{ tag: 'desktop', width: 1280, height: 900 },
	{ tag: 'mobile', width: 390, height: 844 }
];

async function shoot(browser, site, pagePath, vp, attempt = 1) {
	try {
		return await shootOnce(browser, site, pagePath, vp);
	} catch (e) {
		if (attempt >= 3) throw e;
		console.log(`  retry ${site.name} ${pagePath} (${e.message.split('\n')[0]})`);
		return shoot(browser, site, pagePath, vp, attempt + 1);
	}
}

async function shootOnce(browser, site, pagePath, vp) {
	const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, javaScriptEnabled: false });
	const page = await ctx.newPage();
	const url = site.base + site.toUrl(pagePath);
	await page.goto(url, { waitUntil: 'load', timeout: 30000 });
	await page.waitForTimeout(300);
	// No in-page JS at all (evaluate is unreliable with JS disabled here):
	// native key scrolling loads lazy images; screenshot() freezes animations.
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press('PageDown');
		await page.waitForTimeout(80);
	}
	await page.keyboard.press('End');
	await page.waitForTimeout(300);
	await page.keyboard.press('Home');
	await page.waitForTimeout(400);
	if (page.url() !== url) console.log(`  NOTE: ${site.name} ${pagePath} ended at ${page.url()}`);
	const file = path.join(OUT, `${pagePath.replace(/[\/]/g, '_') || 'home'}.${vp.tag}.${site.name}.png`);
	await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
	await ctx.close();
	return file;
}

const browser = await chromium.launch();
let bad = 0;
for (const vp of VIEWPORTS) {
	for (const p of PAGES) {
		const fa = await shoot(browser, ORIG, p, vp);
		const fb = await shoot(browser, PORT, p, vp);
		const a = PNG.sync.read(fs.readFileSync(fa));
		const b = PNG.sync.read(fs.readFileSync(fb));
		if (a.width !== b.width || a.height !== b.height) {
			console.log(`SIZE  ${vp.tag} ${p}: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
			bad++;
			continue;
		}
		const diff = new PNG({ width: a.width, height: a.height });
		const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
		const pct = ((n / (a.width * a.height)) * 100).toFixed(3);
		const ok = n / (a.width * a.height) < 0.001; // <0.1% pixels differ
		if (!ok) {
			bad++;
			fs.writeFileSync(path.join(OUT, `${p.replace(/[\/]/g, '_') || 'home'}.${vp.tag}.diff.png`), PNG.sync.write(diff));
		}
		console.log(`${ok ? 'OK  ' : 'DIFF'}  ${vp.tag}  ${p}  (${n} px, ${pct}%)`);
	}
}
await browser.close();
console.log(bad === 0 ? '\nALL SCREENSHOTS MATCH ✓' : `\n${bad} comparisons differ — see ${OUT}`);
