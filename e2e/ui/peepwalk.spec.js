/*
 * M9 PeepWalk strip (roadmap §8), a 1:1 port of bublr's crowd: bublr's size
 * (350px x 100% at every width, full devicePixelRatio), lazy sprite, one
 * ticker loop, no work off-screen, still frame without motion, hidden on
 * task pages.
 */
import { expect } from '@playwright/test';
import {
	test,
	stubApi,
	instrumentPeeps,
	blockStorage,
	peepLoops,
	draws,
	drawsDuring,
	strip,
	scrollToStrip,
	scrollToTop,
	alphaSum,
	fillColour,
	collectErrors,
	expectNoHorizontalOverflow
} from './helpers.js';

const SHEET = /\/images\/peeps\/characters\.(webp|png)$/;

test.beforeEach(async ({ page }) => {
	await page.addInitScript(instrumentPeeps);
});

/** Hydrated: the nav badge gets its class / count only once the layout has mounted (links are then SPA links). */
async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

/**
 * A client navigation is over once the enter transition has hidden the veil
 * (fx.js playEnterTransition sets display:none when its fade ends). By then the
 * router has reset the scroll to the top, so scrolling to the strip sticks.
 */
async function navigationSettled(page) {
	await page.waitForFunction(() => {
		const v = document.getElementById('wf-veil');
		return !v || getComputedStyle(v).display === 'none';
	});
}

test.describe('layout strip', () => {
	test('sits between the page and the footer, decorative and SSR-safe', async ({ page, request }) => {
		const html = await (await request.get('/')).text();
		// prerendered: a bare decorative canvas, no runtime attributes
		expect(html).toMatch(/<canvas class="wf-peepwalk" aria-hidden="true"><\/canvas>/);
		await page.goto('/');
		const c = strip(page);
		await expect(c).toHaveCount(1);
		await expect(c).toHaveAttribute('aria-hidden', 'true');
		const layout = await page.evaluate(() => {
			const canvas = document.querySelector('canvas.wf-peepwalk');
			const footer = document.querySelector('.footer-section');
			return {
				nextIsFooter: canvas.nextElementSibling === footer,
				// a sibling of the page (not inside .page-wrapper), after it
				afterPage:
					canvas.parentElement === document.querySelector('.page-wrapper').parentElement &&
					!!(document.querySelector('.page-wrapper').compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING),
				gap: Math.round(footer.getBoundingClientRect().top - canvas.getBoundingClientRect().bottom),
				height: canvas.clientHeight,
				pointerEvents: getComputedStyle(canvas).pointerEvents,
				mask: getComputedStyle(canvas).maskImage || getComputedStyle(canvas).webkitMaskImage
			};
		});
		expect(layout.nextIsFooter).toBe(true);
		expect(layout.afterPage).toBe(true);
		expect(layout.gap).toBe(0); // the footer's top border is the ground
		expect(layout.height).toBe(350); // bublr's <PeepWalk height="350px" width="100%" />
		expect(layout.pointerEvents).toBe('none');
		expect(layout.mask).toBe('none'); // like bublr: no edge fade
	});

	test('is 350px tall on phones too (bublr has no mobile size)', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 800 });
		await page.goto('/shop');
		await expect.poll(() => strip(page).evaluate((el) => el.clientHeight)).toBe(350);
	});

	test('sprite is not requested until the strip is within 300px of the viewport', async ({ page }) => {
		const sheet = [];
		page.on('request', (r) => {
			if (SHEET.test(new URL(r.url()).pathname)) sheet.push(new URL(r.url()).pathname);
		});
		await page.goto('/');
		await page.waitForTimeout(1200);
		expect(sheet).toEqual([]);
		expect(await draws(page)).toBe(0);

		const stripTop = await strip(page).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
		// 700px below the fold: still nothing
		await page.evaluate((y) => window.scrollTo(0, y), stripTop - (await page.evaluate(() => innerHeight)) - 700);
		await page.waitForTimeout(800);
		expect(sheet).toEqual([]);
		// 150px below the fold: loads bublr's sheet
		await page.evaluate((y) => window.scrollTo(0, y), stripTop - (await page.evaluate(() => innerHeight)) - 150);
		await expect.poll(() => sheet.length).toBeGreaterThan(0);
		expect(sheet[0]).toBe('/images/peeps/characters.png');
		await expect(strip(page)).toHaveAttribute('data-ready', '');
		expect(sheet).toEqual(['/images/peeps/characters.png']); // loaded once
	});

	test('draws a non-blank crowd, crisp and sized to the device', async ({ page }) => {
		const errors = collectErrors(page);
		await page.goto('/');
		await scrollToStrip(page);
		await expect.poll(() => alphaSum(page)).toBeGreaterThan(0);
		const size = await strip(page).evaluate((el) => ({ w: el.width, h: el.height, cw: el.clientWidth, ch: el.clientHeight }));
		expect(size).toEqual({ w: 1280, h: 350, cw: 1280, ch: 350 }); // DPR 1
		await expect(strip(page)).toHaveAttribute('data-mode', 'live');
		expect(errors).toEqual([]);
	});

	test('uses the full devicePixelRatio like bublr (DPR 3 phone)', async ({ browser }) => {
		const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 3 });
		await stubApi(ctx);
		const page = await ctx.newPage();
		await page.addInitScript(instrumentPeeps);
		await page.goto('/shop');
		await scrollToStrip(page);
		const size = await strip(page).evaluate((el) => ({ w: el.width, h: el.height }));
		expect(size).toEqual({ w: 1170, h: 1050 }); // 390 x 350 CSS px at DPR 3
		expect(await alphaSum(page)).toBeGreaterThan(0);
		await ctx.close();
	});

	test('runs exactly one ticker loop while visible and none off-screen', async ({ page }) => {
		await page.goto('/');
		expect(await peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 800)).toBe(0); // page top: no rAF work at all

		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1);
		expect(await drawsDuring(page, 600)).toBeGreaterThan(10);

		await scrollToTop(page);
		await expect.poll(() => peepLoops(page)).toBe(0);
		await page.waitForTimeout(200);
		expect(await drawsDuring(page, 1000)).toBe(0); // zero draws off-screen

		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1); // resumes
	});

	// The 300px margin is only the sheet's prefetch band (hunt a11y-motion peepwalk-offscreen):
	// just below the fold the strip is off-screen, so nothing may walk or draw there.
	test('the 300px prefetch band loads the sheet but runs no loop and draws nothing', async ({ page }) => {
		await page.goto('/');
		const belowFold = async (gap) => {
			await page.evaluate((g) => {
				const el = document.querySelector('canvas.wf-peepwalk');
				window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight - g);
			}, gap);
			await expect.poll(() => strip(page).evaluate((el) => Math.round(el.getBoundingClientRect().top - window.innerHeight))).toBe(gap);
		};
		await belowFold(150);
		await expect(strip(page)).toHaveAttribute('data-ready', ''); // prefetched in the band
		await page.waitForTimeout(300);
		expect(await peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 1000)).toBe(0);

		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1); // on screen: walks
		expect(await drawsDuring(page, 600)).toBeGreaterThan(10);

		await belowFold(10); // back off-screen, barely
		await expect.poll(() => peepLoops(page)).toBe(0);
		await page.waitForTimeout(200);
		expect(await drawsDuring(page, 1000)).toBe(0);
	});

	test('stops while the tab is hidden', async ({ page }) => {
		await page.goto('/');
		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1);
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await expect.poll(() => peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 600)).toBe(0);
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await expect.poll(() => peepLoops(page)).toBe(1);
	});

	test('exactly one loop after 10 home <-> shop navigations', async ({ page }) => {
		// Ten real client navigations (leave veil, enter veil, sprite load) by design: a budget to
		// match, and no fixed settle waits — each step waits for the navigation to finish.
		test.setTimeout(90_000);
		const errors = collectErrors(page);
		await page.goto('/');
		await hydrated(page);
		for (let i = 0; i < 10; i++) {
			const to = i % 2 === 0 ? '/shop' : '/';
			await page.locator(i % 2 === 0 ? '.nav-menu a[href="/shop"]' : 'a.brand').click();
			await page.waitForURL((u) => u.pathname === to);
			await navigationSettled(page);
			await scrollToStrip(page, { settle: 100 });
			// this page's strip is running — and only it: a leaked loop from an earlier page shows up here
			await expect.poll(() => peepLoops(page)).toBe(1);
		}
		await expect(strip(page)).toHaveCount(1);
		expect(errors).toEqual([]);
	});

	test('unmounts cleanly on task pages and remounts with a single loop', async ({ page }) => {
		await page.goto('/');
		for (let i = 0; i < 3; i++) {
			await scrollToStrip(page);
			await expect.poll(() => peepLoops(page)).toBe(1);
			await page.locator('.footer-section a[href="/login"]').click();
			await page.waitForURL('**/login');
			await expect(strip(page)).toHaveCount(0);
			await expect.poll(() => peepLoops(page)).toBe(0); // back to baseline
			expect(await drawsDuring(page, 500)).toBe(0); // nothing drawing into a detached canvas
			await page.locator('a.brand').click();
			await page.waitForURL((u) => u.pathname === '/');
		}
		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1);
	});

	for (const path of ['/checkout', '/login', '/order', '/reset-password']) {
		test(`is absent on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('.footer-section')).toHaveCount(1);
			await expect(strip(page)).toHaveCount(0);
		});
	}

	test("serves bublr's sheet, byte for byte", async ({ request }) => {
		const res = await request.get('/images/peeps/characters.png');
		expect(res.status()).toBe(200);
		const { createHash } = await import('node:crypto');
		expect(createHash('sha1').update(await res.body()).digest('hex')).toBe('7a79dc800d0bb0ca67d4abe9e76914e7748eabeb');
	});

	test('stays a quiet blank strip when the sheet is missing entirely', async ({ page }) => {
		const errors = collectErrors(page);
		await page.route('**/images/peeps/characters.*', (r) => r.fulfill({ status: 404, body: 'nope' }));
		await page.goto('/');
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await expect(strip(page)).toHaveAttribute('data-failed', '');
		expect(await alphaSum(page)).toBe(0);
		expect(await peepLoops(page)).toBe(0);
		expect(errors).toEqual([]);
	});
});

test.describe('still frame without motion', () => {
	async function expectStill(page) {
		await scrollToStrip(page);
		await expect(strip(page)).toHaveAttribute('data-mode', 'still');
		expect(await alphaSum(page)).toBeGreaterThan(0);
		expect(await peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 700)).toBe(0);
		const a = await strip(page).screenshot();
		await page.waitForTimeout(500);
		const b = await strip(page).screenshot();
		expect(Buffer.compare(a, b)).toBe(0); // pixel-identical 500ms apart
	}

	test('?nofx=1 draws one still frame', async ({ page }) => {
		await page.goto('/?nofx=1');
		await expectStill(page);
	});

	test('prefers-reduced-motion draws one still frame', async ({ browser }) => {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
		await stubApi(ctx);
		const page = await ctx.newPage();
		await page.addInitScript(instrumentPeeps);
		await page.goto('/shop');
		await expectStill(page);
		await ctx.close();
	});

	test('the live strip really animates (control for the still-frame check)', async ({ page }) => {
		await page.goto('/');
		await scrollToStrip(page);
		const a = await strip(page).screenshot();
		await page.waitForTimeout(500);
		const b = await strip(page).screenshot();
		expect(Buffer.compare(a, b)).not.toBe(0);
	});

	test('turning reduced motion on live stops the loop', async ({ page }) => {
		await page.goto('/');
		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(strip(page)).toHaveAttribute('data-mode', 'still');
		await expect.poll(() => peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 600)).toBe(0);
	});

	test('?nofx=1 is per-URL: the strip comes alive after navigating away from it', async ({ page }) => {
		await page.goto('/?nofx=1');
		await scrollToStrip(page);
		await expect(strip(page)).toHaveAttribute('data-mode', 'still');
		await page.locator('.footer-section a[href="/shop"]').click();
		await page.waitForURL('**/shop');
		await expect(strip(page)).toHaveAttribute('data-mode', 'live');
	});

	// A synthetic sheet where every "peep" is a narrow opaque bar ending at
	// 86% of its cell (the shortest real torso). Any bar that doesn't reach
	// the strip's bottom edge is a floating torso.
	async function barSheet(browser) {
		const ctx = await browser.newContext();
		await stubApi(ctx);
		const p = await ctx.newPage();
		const b64 = await p.evaluate(() => {
			const c = document.createElement('canvas');
			c.width = 3600;
			c.height = 2268;
			const g = c.getContext('2d');
			g.fillStyle = '#000';
			for (let i = 0; i < 105; i++) {
				const x = (i % 15) * 240;
				const y = Math.floor(i / 15) * 324;
				g.fillRect(x + 110, y + 20, 20, Math.round(324 * 0.86) - 20);
			}
			return c.toDataURL('image/png').split(',')[1];
		});
		await ctx.close();
		return Buffer.from(b64, 'base64');
	}

	// bublr's geometry, measured on the synthetic bar sheet: every peep is drawn
	// at its native 240 x 324 px (each 20px bar stays 20px wide) and its cell
	// top sits where bublr puts it: y = max(10, 350 - 324 + offsetY), offsetY in
	// (-150, 100], plus the 10px bob. The bar starts 20px into its cell.
	test("draws bublr's crowd: native-size peeps within bublr's depth range", async ({ browser }) => {
		const sheet = await barSheet(browser);
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		await stubApi(ctx);
		const page = await ctx.newPage();
		await page.route('**/images/peeps/characters.png', (r) => r.fulfill({ body: sheet, contentType: 'image/png' }));
		await page.goto('/');
		await scrollToStrip(page);
		await expect(strip(page)).toHaveAttribute('data-ready', '');
		const r = await strip(page).evaluate((el) => {
			const { width: w, height: h } = el;
			const d = el.getContext('2d').getImageData(0, 0, w, h).data;
			const solid = (x, y) => d[(y * w + x) * 4 + 3] > 200;
			// runs of solid columns = bars; for each run record its width and top
			const bars = [];
			let x = 0;
			while (x < w) {
				let top = -1;
				for (let y = 0; y < h && top < 0; y++) if (solid(x, y)) top = y;
				if (top < 0) {
					x++;
					continue;
				}
				let x2 = x;
				let runTop = top;
				while (x2 < w) {
					let t = -1;
					for (let y = 0; y < h && t < 0; y++) if (solid(x2, y)) t = y;
					if (t < 0) break;
					runTop = Math.min(runTop, t);
					x2++;
				}
				bars.push({ width: x2 - x, top: runTop, edge: x === 0 || x2 === w });
				x = x2;
			}
			return { h, bars };
		});
		expect(r.h).toBe(350);
		expect(r.bars.length).toBeGreaterThan(8);
		// overlapping bars merge, so look at isolated runs: a native-size bar is 20px
		// (±1px of anti-aliasing at sub-pixel x); a rescaled crowd would be far off
		const isolated = r.bars.filter((b) => !b.edge && b.width <= 21);
		expect(isolated.length).toBeGreaterThan(0);
		for (const b of isolated) expect(Math.abs(b.width - 20)).toBeLessThanOrEqual(1);
		for (const b of r.bars) {
			expect(b.top).toBeGreaterThanOrEqual(10 + 20 - 10); // min cell top 10, minus the bob
			expect(b.top).toBeLessThanOrEqual(350 - 324 + 100 + 20); // deepest cell top 126
		}
		await ctx.close();
	});
});

test.describe('colour mix', () => {
	test("keeps bublr's original ink-on-white sprites (the mix never tints the crowd)", async ({ page }) => {
		await page.goto('/');
		await scrollToStrip(page);
		await expect.poll(async () => (await fillColour(page))?.[3] || 0).toBeGreaterThan(100);
		const before = await fillColour(page);
		expect(before.slice(0, 3).every((v) => v >= 250)).toBe(true); // the sheet's white fill
		await page.locator('.wf-colormix').click();
		await expect.poll(() => page.evaluate(() => !!document.getElementById('wf-colormix-style'))).toBe(true);
		await page.waitForTimeout(400);
		const after = await fillColour(page);
		expect(after.slice(0, 3).every((v) => v >= 250)).toBe(true);
		await page.locator('.wf-colormix').click();
	});
});

test.describe('robustness', () => {
	test('works when localStorage throws', async ({ page }) => {
		await page.addInitScript(blockStorage);
		const errors = collectErrors(page);
		await page.goto('/');
		await scrollToStrip(page);
		expect(await alphaSum(page)).toBeGreaterThan(0);
		await expect.poll(() => peepLoops(page)).toBe(1);
		expect(errors).toEqual([]);
	});

	for (const path of ['/', '/shop', '/products/cornflakes', '/recipes', '/cart', '/nope']) {
		test(`no horizontal overflow at 360px on ${path}`, async ({ page }) => {
			await page.setViewportSize({ width: 360, height: 740 });
			await page.goto(path);
			await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			await page.waitForTimeout(300);
			await expectNoHorizontalOverflow(page);
			const w = await strip(page).evaluate((el) => el.getBoundingClientRect().width);
			expect(w).toBeLessThanOrEqual(360);
		});
	}
});
