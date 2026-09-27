/*
 * The live catalog on the browse pages (PI-EXP-1; SPEC §1 "Live price and
 * stock overlays are fetched client-side"; live-catalog.md §2/§5). /api is
 * stubbed by the helper `test` (404 = no CMS); these tests answer
 * /api/store/catalog with a crafted catalog: Cornflakes now ₹199, Choco Flakes
 * sold out. The prerendered HTML (SEO, no JS) keeps the snapshot's ₹175; once
 * the page has asked the CMS, the PDP, /shop, home, mini cards, the recipe
 * rail and search show the live price, and a sold-out product is flagged and
 * its Add button (aria-disabled, still focusable) adds nothing.
 * Full stack (a real CMS edit): e2e/full/experience/live-catalog.spec.js.
 */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test, collectErrors, expectNoHorizontalOverflow } from './helpers.js';

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

/** A /api/store/catalog body from the snapshot, with per-slug overrides. */
function liveCatalog(over = {}) {
	return {
		settings: SNAPSHOT.settings,
		products: SNAPSHOT.products.map((p) => ({
			slug: p.slug,
			name: p.name,
			pricePaise: p.pricePaise,
			inStock: p.inStock,
			lowStock: null,
			maxPerOrder: p.maxPerOrder,
			codAllowed: p.codAllowed,
			...(over[p.slug] || {})
		}))
	};
}
const LIVE = liveCatalog({ cornflakes: { pricePaise: 19900 }, 'choco-flakes': { inStock: false } });

/**
 * Answer /api/store/catalog with `body` (other /api calls keep the context's
 * 404 stub). `answered` resolves on the first answer (wrapped, so awaiting
 * serveCatalog() itself doesn't wait for it).
 */
async function serveCatalog(page, body = LIVE) {
	let done;
	const answered = new Promise((r) => (done = r));
	await page.route('**/api/store/catalog*', async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
		done();
	});
	return { answered };
}

/** The layout has mounted (the nav badge gets its class or count only then). */
async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

async function open(page, path) {
	const { answered } = await serveCatalog(page);
	await page.goto(path);
	await hydrated(page);
	await answered;
}

function recordAdds() {
	window.__adds = [];
	window.addEventListener('wf:cart-add', (e) => window.__adds.push(e.detail));
}
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const bagCount = (page) => page.evaluate(() => window.WefeastoCart.count());

test.beforeEach(async ({ page }) => page.addInitScript(recordAdds));

test.describe('product page', () => {
	test('the prerendered page keeps the snapshot price; the browser shows the live one', async ({ page, request }) => {
		const html = await (await request.get('/products/cornflakes')).text();
		expect(html).toMatch(/wf-price wf-price-large">₹175</);
		const errors = collectErrors(page);
		await open(page, '/products/cornflakes');
		await expect(page.locator('.wf-price-large')).toHaveText('₹199');
		await expect(page.locator('.div-block-76 [data-wf-soldout]')).toHaveCount(0);
		const add = page.locator('[data-wf-add="cornflakes"][data-wf-qty-input]');
		await expect(add).not.toHaveAttribute('aria-disabled', /.*/);
		await add.click();
		await expect.poll(() => bagCount(page)).toBe(1);
		expect(errors).toEqual([]);
	});

	test('sold out: a "Sold out" chip; the Add button says so, stays focusable, and neither click nor Enter adds', async ({ page }) => {
		const errors = collectErrors(page);
		await open(page, '/products/choco-flakes');
		await expect(page.locator('.div-block-76 .wf-chip[data-wf-soldout]')).toHaveText('Sold out');
		const add = page.locator('[data-wf-add="choco-flakes"][data-wf-qty-input]');
		await expect(add).toHaveAttribute('aria-disabled', 'true');
		await expect(add).toHaveText('Sold out');
		await expect(add).not.toHaveAttribute('disabled', /.*/);
		await add.click({ force: true }); // Playwright waits out aria-disabled; a person can still click it
		await add.focus();
		await expect(add).toBeFocused();
		await page.keyboard.press('Enter');
		await frames(page);
		expect(await bagCount(page)).toBe(0);
		expect(await page.evaluate(() => window.__adds)).toEqual([]);
		await expect(page.locator('[data-wf-toast]')).toHaveCount(0);
		expect(page.url()).not.toContain('#'); // the '#' href was not followed either
		expect(errors).toEqual([]);
	});

	test('without the CMS (404) the snapshot stays and Add works', async ({ page }) => {
		const live = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/store/catalog');
		await page.goto('/products/choco-flakes');
		await hydrated(page);
		expect((await live).status()).toBe(404);
		await expect(page.locator('.wf-price-large')).toHaveText('₹200');
		await page.locator('[data-wf-add="choco-flakes"][data-wf-qty-input]').click();
		await expect.poll(() => bagCount(page)).toBe(1);
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });
		test('the snapshot price and a plain Add button', async ({ page }) => {
			await page.goto('/products/choco-flakes');
			await expect(page.locator('.wf-price-large')).toHaveText('₹200');
			await expect(page.locator('[data-wf-soldout]')).toHaveCount(0);
		});
	});
});

test.describe('cards and other surfaces', () => {
	test('/shop: live price line; the sold-out card says so and a tap adds nothing; another card still adds', async ({ page }) => {
		const errors = collectErrors(page);
		await open(page, '/shop');
		const card = (slug) => page.locator('.wf-shop-item', { has: page.locator(`[data-wf-add="${slug}"]`) });
		await expect(card('cornflakes').locator('.wf-price')).toHaveText('₹199 · 120 cal');
		const choco = card('choco-flakes').locator('[data-wf-add]');
		await expect(choco).toHaveText('Sold out');
		await expect(choco).toHaveAttribute('aria-disabled', 'true');
		await choco.scrollIntoViewIfNeeded();
		await choco.click({ force: true }); // as above: aria-disabled is not actionable for Playwright
		await frames(page);
		expect(await bagCount(page)).toBe(0);
		await card('muesli').locator('[data-wf-add]').click();
		await expect.poll(() => bagCount(page)).toBe(1);
		expect(new URL(page.url()).pathname).toBe('/shop');
		await expectNoHorizontalOverflow(page);
		expect(errors).toEqual([]);
	});

	test('home bestsellers: live price line and a sold-out note', async ({ page }) => {
		const errors = collectErrors(page);
		await open(page, '/');
		const line = (slug) => page.locator(`#bestsellers [role="listitem"]:has(a[href="/products/${slug}"]) .div-block-83 > div`).first();
		await expect(line('cornflakes')).toHaveText('₹199 · 120 cal');
		await expect(line('choco-flakes')).toHaveText('₹200 · 120 cal · Sold out');
		expect(errors).toEqual([]);
	});

	test('"Goes well with" on a PDP: live price and a blocked sold-out card', async ({ page }) => {
		await open(page, '/products/cornflakes');
		const choco = page.locator('.grid-6 .wf-card', { has: page.locator('[data-wf-add="choco-flakes"]') });
		await expect(choco.locator('[data-wf-add]')).toHaveAttribute('aria-disabled', 'true');
		await open(page, '/products/muesli');
		const corn = page.locator('.grid-6 .wf-card', { has: page.locator('[data-wf-add="cornflakes"]') });
		await expect(corn.locator('.wf-price')).toHaveText('₹199');
	});

	test('recipe rail: live price in the label; for a sold-out product it says so and adds nothing', async ({ page }) => {
		await open(page, '/recipes/wf-masala-cornflakes-chivda');
		await expect(page.locator('a.wf-rail-add')).toHaveText('Add Cornflakes · ₹199');
		await open(page, '/recipes/wf-choco-flakes-energy-bars');
		const rail = page.locator('a.wf-rail-add');
		await expect(rail).toHaveText("Choco's · Sold out");
		await expect(rail).toHaveAttribute('aria-disabled', 'true');
		const ingredients = page.locator('.grid-6 [data-wf-add="choco-flakes"]');
		await expect(ingredients).toHaveAttribute('aria-disabled', 'true');
	});

	test('search chips: live price, and "Sold out" for a product the CMS has none of', async ({ page }) => {
		await open(page, '/shop');
		await page.locator('.navbar .wf-search-open').first().click();
		const input = page.locator('.wf-search-input');
		await expect(input).toBeVisible();
		await input.fill('cornflakes');
		const chip = (href) => page.locator(`.wf-search-card[href="${href}"] .wf-chip`);
		await expect(chip('/products/cornflakes')).toHaveText('₹199');
		await input.fill('choco');
		await expect(chip('/products/choco-flakes')).toHaveText('₹200 · Sold out');
	});

	test('a client-side navigation after the load renders live values at once', async ({ page }) => {
		await open(page, '/shop');
		await page.evaluate(() => (window.__noReload = true));
		await page.locator('.wf-shop-item a.wf-card-cover[href="/products/choco-flakes"]').evaluate((a) => a.click()); // SvelteKit's router takes it
		await expect(page).toHaveURL(/\/products\/choco-flakes$/);
		await expect(page.locator('.div-block-76 .wf-chip[data-wf-soldout]')).toHaveText('Sold out');
		await expect(page.locator('[data-wf-add="choco-flakes"][data-wf-qty-input]')).toHaveAttribute('aria-disabled', 'true');
		expect(await page.evaluate(() => window.__noReload)).toBe(true);
	});
});
