/*
 * Hunt w5-client-ux (sf-core), round 2:
 *
 * - "Add to Cart" (AddToCart.svelte: PDP, /shop, mini cards, recipe rail) is
 *   the Webflow <a href="#"> exposed as role="button": screen readers hear a
 *   button, Space adds (on key-up, like a native button) without scrolling the
 *   page, Enter still adds, and a sold-out one takes neither key.
 * - Search (overlay and the /shop filter) folds typographic punctuation:
 *   "Choco’s" as an iPhone types it (U+2019) finds Choco's.
 */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test, collectErrors } from './helpers.js';

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));
const CURLY = 'Choco’s';

const hydrated = (page) =>
	page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
const bagCount = (page) => page.evaluate(() => window.WefeastoCart.count());
const bag = (page) => page.evaluate(() => window.WefeastoCart.read());
const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function open(page, path) {
	await page.goto(path);
	await hydrated(page);
}

test.describe('Add to Cart is a button', () => {
	test('PDP: role button (not link); Space adds the chosen quantity and the page stays put; Enter adds too', async ({ page }) => {
		const errors = collectErrors(page);
		await open(page, '/products/muesli');
		await expect(page.getByRole('button', { name: 'Add to Cart', exact: true })).toHaveCount(1);
		await expect(page.getByRole('link', { name: 'Add to Cart', exact: true })).toHaveCount(0);
		await page.locator('#qty-muesli').fill('2');
		const add = page.locator('[data-wf-add="muesli"][data-wf-qty-input]');
		await add.focus();
		const y = await scrollY(page);
		await page.keyboard.press(' ');
		await expect.poll(() => bag(page)).toEqual({ muesli: 2 });
		await frames(page);
		expect(await scrollY(page)).toBe(y);
		await expect(add).toBeFocused();
		await page.keyboard.press('Enter');
		await expect.poll(() => bag(page)).toEqual({ muesli: 4 });
		expect(page.url()).not.toContain('#');
		expect(errors).toEqual([]);
	});

	test('holding Space adds once, on release; a key-up without its key-down adds nothing', async ({ page }) => {
		await open(page, '/products/muesli');
		const add = page.locator('[data-wf-add="muesli"][data-wf-qty-input]');
		await add.focus();
		const y = await scrollY(page);
		await page.keyboard.down(' ');
		for (let i = 0; i < 3; i++) await add.dispatchEvent('keydown', { key: ' ', code: 'Space', repeat: true });
		await frames(page);
		expect(await bagCount(page)).toBe(0); // nothing until the key comes up
		await page.keyboard.up(' ');
		await expect.poll(() => bagCount(page)).toBe(1);
		expect(await scrollY(page)).toBe(y);
		await page.keyboard.up(' '); // a stray key-up (Space pressed elsewhere, released here)
		await frames(page);
		expect(await bagCount(page)).toBe(1);
	});

	test('/shop card and recipe rail: buttons too, and Space adds one without scrolling', async ({ page }) => {
		await open(page, '/shop');
		// Cards below the fold wait for their reveal (hidden from the a11y tree until then): check them all by attribute.
		const roles = await page.locator('.wf-shop-item [data-wf-add]').evaluateAll((els) => els.map((el) => el.getAttribute('role')));
		expect(roles).toEqual(SNAPSHOT.products.map(() => 'button'));
		await expect(page.locator('.wf-shop-item').getByRole('button', { name: 'Add to Cart', exact: true }).first()).toBeVisible();
		await expect(page.getByRole('link', { name: 'Add to Cart', exact: true })).toHaveCount(0);
		const first = page.locator('.wf-shop-item [data-wf-add]').first();
		const slug = await first.getAttribute('data-wf-add');
		await first.scrollIntoViewIfNeeded();
		await first.focus();
		const y = await scrollY(page);
		await page.keyboard.press(' ');
		await expect.poll(() => bag(page)).toEqual({ [slug]: 1 });
		expect(await scrollY(page)).toBe(y);

		await open(page, `/recipes/${SNAPSHOT.recipes[0].slug}`);
		const rail = page.locator('a.wf-rail-add[data-wf-add]');
		await expect(rail).toHaveCount(1);
		await expect(rail).toHaveAttribute('role', 'button');
		await expect(page.getByRole('button', { name: /^Add .+ · ₹\d+$/ })).toHaveCount(1);
		await expect(page.getByRole('link', { name: /^Add .+ · ₹\d+$/ })).toHaveCount(0);
	});

	test('sold out: Space adds nothing and does not scroll', async ({ page }) => {
		const live = {
			settings: SNAPSHOT.settings,
			products: SNAPSHOT.products.map((p) => ({
				slug: p.slug,
				name: p.name,
				pricePaise: p.pricePaise,
				inStock: p.slug === 'choco-flakes' ? false : p.inStock,
				lowStock: null,
				maxPerOrder: p.maxPerOrder,
				codAllowed: p.codAllowed
			}))
		};
		await page.route('**/api/store/catalog*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(live) }));
		await open(page, '/products/choco-flakes');
		const add = page.locator('[data-wf-add="choco-flakes"][data-wf-qty-input]');
		await expect(add).toHaveAttribute('aria-disabled', 'true');
		await expect(page.getByRole('button', { name: 'Sold out', exact: true })).toHaveCount(1);
		await add.focus();
		const y = await scrollY(page);
		await page.keyboard.press(' ');
		await frames(page);
		expect(await bagCount(page)).toBe(0);
		expect(await scrollY(page)).toBe(y);
	});
});

test.describe('search folds typographic apostrophes', () => {
	test(`overlay: "${CURLY}" (U+2019) finds Choco's`, async ({ page }) => {
		await open(page, '/shop?nofx=1');
		await page.locator('.navbar .wf-search-open').click();
		await page.locator('.wf-search-input').fill(CURLY);
		await expect(page.locator('.wf-search-card-name').first()).toHaveText("Choco's");
		await expect(page.locator('#wf-search-overlay .wf-search-empty')).toHaveCount(0);
	});

	test(`/shop filter: "${CURLY}" shows the Choco's card`, async ({ page }) => {
		await open(page, '/shop?nofx=1');
		await page.locator('#wf-shop-search').fill(CURLY);
		const visible = page.locator('.wf-shop-item:visible');
		await expect(visible).toHaveCount(1);
		await expect(visible.locator('h4')).toHaveText("Choco's");
	});
});
