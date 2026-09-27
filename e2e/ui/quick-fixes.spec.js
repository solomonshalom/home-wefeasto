/*
 * M8 quick fixes and the M7 icon owned by ui-kit: colour-mix pill hidden on
 * the task pages (mix still applied), PDP eyebrow = product category, and
 * the Wefeasto webclip.
 */
import { expect } from '@playwright/test';
import { test, blockStorage, collectErrors } from './helpers.js';

const pill = (page) => page.locator('.wf-colormix');
const mixApplied = (page) => page.evaluate(() => !!document.getElementById('wf-colormix-style'));

/**
 * The layout has mounted: the nav badge gets its wf-is-hidden class (empty
 * bag) or its count only then. Until hydration the pill is server-rendered
 * markup without its click handler.
 */
const hydrated = (page) =>
	page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});

test.describe('colour-mix pill', () => {
	for (const path of ['/cart', '/checkout', '/order']) {
		test(`is not rendered on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('.footer-section')).toHaveCount(1);
			await expect(pill(page)).toHaveCount(0);
		});
	}

	for (const path of ['/', '/shop', '/products/muesli', '/recipes', '/login', '/nope']) {
		test(`is still there on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(pill(page)).toBeVisible();
		});
	}

	test('an active mix stays applied on the bag page (client navigation)', async ({ page }) => {
		await page.goto('/shop');
		await hydrated(page);
		await pill(page).click();
		await expect(pill(page)).toHaveAttribute('aria-checked', 'true');
		expect(await mixApplied(page)).toBe(true);
		const coral = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--coral').trim());
		expect(coral).not.toBe('#ff8d5e');
		await page.locator('.wf-cart-anchor').click();
		await page.waitForURL('**/cart');
		await expect(pill(page)).toHaveCount(0);
		expect(await mixApplied(page)).toBe(true);
		expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--coral').trim())).toBe(coral);
		// and the pill comes back, still on, after leaving
		await page.locator('.nav-menu a[href="/shop"]').click();
		await page.waitForURL('**/shop');
		await expect(pill(page)).toHaveAttribute('aria-checked', 'true');
	});

	test('a stored mix applies on a direct load of /checkout', async ({ page }) => {
		await page.goto('/');
		await hydrated(page);
		await pill(page).click();
		await expect(pill(page)).toHaveAttribute('aria-checked', 'true'); // stored before we leave
		await page.goto('/checkout');
		await expect(pill(page)).toHaveCount(0);
		await expect.poll(() => mixApplied(page)).toBe(true);
	});

	test('no errors when localStorage throws', async ({ page }) => {
		// Its own /api stub too (page routes win over the helper's context
		// route): every /api call this test causes is a clean 404, whatever
		// runs behind the preview's proxy.
		await page.route('**/api/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
		await page.addInitScript(blockStorage);
		const errors = collectErrors(page);
		await page.goto('/cart');
		await hydrated(page);
		await expect(pill(page)).toHaveCount(0);
		await page.goto('/');
		await hydrated(page); // a click before hydration hits the server-rendered pill, which does nothing
		await pill(page).click(); // mix works for the page, just not persisted
		await expect(pill(page)).toHaveAttribute('aria-checked', 'true');
		await expect.poll(() => mixApplied(page)).toBe(true);
		expect(errors).toEqual([]);
	});
});

test.describe('no CMS needed (the /api stub from helpers.js)', () => {
	// /cart fetches the live catalog on mount. Unstubbed, the answer depends on
	// the machine: the preview proxy's 500 when no CMS runs (a console error),
	// or live prices from a running one.
	test("answers the bag page's live catalog fetch with a 404", async ({ page }) => {
		const errors = collectErrors(page);
		const live = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/store/catalog');
		await page.goto('/cart');
		const res = await live;
		expect(res.status()).toBe(404);
		expect(await res.text()).toBe('{}');
		await expect(page.locator('.footer-section')).toHaveCount(1);
		expect(errors).toEqual([]);
	});

	test('an API error that gets past it is reported, with its URL', async ({ page }) => {
		await page.route('**/api/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
		const errors = collectErrors(page);
		const live = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/store/catalog');
		await page.goto('/cart');
		expect((await live).status()).toBe(500);
		await expect.poll(() => errors.length).toBeGreaterThan(0);
		expect(errors[0]).toMatch(/status of 500 .*\/api\/store\/catalog/);
	});
});

test('PDP eyebrow shows each product category (as on /shop)', async ({ page, request }) => {
	const shop = await (await request.get('/shop')).text();
	const cats = {};
	for (const m of shop.matchAll(/data-name="([^"]+)" data-category="([^"]+)"/g)) cats[m[1].replace(/&#39;|&apos;/g, "'")] = m[2];
	expect(Object.keys(cats).length).toBeGreaterThanOrEqual(6);
	const links = [...new Set([...shop.matchAll(/href="\/products\/([a-z-]+)"/g)].map((m) => m[1]))];
	expect(links.length).toBeGreaterThanOrEqual(6);
	const seen = new Set();
	for (const slug of links) {
		await page.goto(`/products/${slug}`);
		const name = (await page.locator('h1.heading-2').textContent()).trim();
		const eyebrow = (await page.locator('.div-block-78 .text-block-3').first().textContent()).trim();
		expect(eyebrow, slug).toBe(cats[name]);
		expect(eyebrow).not.toBe('Oats & Muesli');
		seen.add(eyebrow);
	}
	expect([...seen].sort()).toEqual(['Flakes', 'Mix', 'Muesli', 'Oats']);
});

test('webclip is the Wefeasto mark: 256x256 PNG, opaque (no Webflow logo)', async ({ page, request }) => {
	const res = await request.get('/images/webclip.png');
	expect(res.status()).toBe(200);
	const buf = await res.body();
	expect(buf.subarray(1, 4).toString()).toBe('PNG');
	expect(buf.readUInt32BE(16)).toBe(256); // IHDR width
	expect(buf.readUInt32BE(20)).toBe(256); // IHDR height
	await page.goto('/');
	const px = await page.evaluate(async () => {
		const img = new Image();
		img.src = '/images/webclip.png';
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const g = c.getContext('2d');
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		let dark = 0;
		let white = 0;
		let transparent = 0;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i + 3] < 255) transparent++;
			else if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++;
			else if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
		}
		const corner = [...d.slice(0, 4)];
		return { dark, white, transparent, corner, total: d.length / 4 };
	});
	expect(px.transparent).toBe(0); // iOS would paint transparency black
	expect(px.corner).toEqual([255, 255, 255, 255]); // Webflow's was a dark rounded tile
	expect(px.white / px.total).toBeGreaterThan(0.6);
	expect(px.dark / px.total).toBeGreaterThan(0.03); // the ink mark
	await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', /\/images\/webclip\.png$/);
});
