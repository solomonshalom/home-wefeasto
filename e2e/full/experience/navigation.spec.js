/*
 * Getting around, on the real stack: the search overlay (open, results, keyboard, focus
 * trap, focus return, Esc; with motion and ?nofx=1), the mobile nav (≤ 991px: focus trap,
 * Esc, links, bag count) and the branded 404 (status, search, bestsellers that add with
 * source 'not-found').
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/navigation.spec.js
 */
import { test, expect } from '../fixtures.js';
import { adds, badge, bringIntoView, expectNoHorizontalOverflow, recordAdds, seedBag, strip, toastTitle, waitHydrated } from './helpers.js';

const overlay = (page) => page.locator('#wf-search-overlay');
const field = (page) => page.locator('.wf-search-input');
const cards = (page) => page.locator('.wf-search-card');
const navSearch = (page) => page.locator('.navbar .wf-search-open');
const inOverlay = (page) => page.evaluate(() => !!document.activeElement && document.getElementById('wf-search-overlay').contains(document.activeElement));

/** Results of what was typed have settled: the same non-empty list, every card fully shown. */
async function settledResults(page) {
	let last = null;
	let since = 0;
	await expect
		.poll(
			async () => {
				const s = await cards(page).evaluateAll((els) => ({
					hrefs: els.map((el) => el.getAttribute('href')).join(' '),
					shown: els.length > 0 && els.every((el) => getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity === '1')
				}));
				if (s.hrefs !== last) {
					last = s.hrefs;
					since = Date.now();
					return false;
				}
				return s.shown && Date.now() - since >= 300;
			},
			{ intervals: [100], timeout: 10_000 }
		)
		.toBe(true);
	return cards(page).count();
}

/* ---------------------------------------------------------------- search overlay */

for (const q of ['', '?nofx=1']) {
	test.describe(`search overlay${q ? ' (' + q + ')' : ''}`, () => {
		test('opens from the nav with focus in the field; results; Tab stays inside; Esc closes and returns focus', async ({ page, shop }) => {
			await shop.visit('/shop' + q);
			await navSearch(page).click();
			await expect(overlay(page)).toBeVisible();
			await expect(page.getByRole('dialog', { name: 'Search Wefeasto' })).toBeVisible();
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('oat');
			await expect(field(page)).toHaveValue('oat');
			const n = await settledResults(page);
			expect(n).toBeGreaterThanOrEqual(2);
			await expect(cards(page).first()).toContainText(/oat/i);
			// Focus trap: 2 × (field + close + cards) presses never leave the dialog.
			for (let i = 0; i < 2 * (n + 2); i++) {
				await page.keyboard.press('Tab');
				expect(await inOverlay(page)).toBe(true);
			}
			await field(page).focus();
			await page.keyboard.press('Shift+Tab');
			expect(await inOverlay(page)).toBe(true);
			await page.keyboard.press('Escape');
			await expect(overlay(page)).toBeHidden();
			await expect(navSearch(page)).toBeFocused();
		});

		test('keyboard only: Enter opens it, Tab to a result, Enter navigates there (overlay shut, query cleared)', async ({ page, shop }) => {
			await shop.visit('/' + q);
			await navSearch(page).focus();
			await page.keyboard.press('Enter');
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('muesli');
			await expect(field(page)).toHaveValue('muesli');
			await settledResults(page);
			const href = await cards(page).first().getAttribute('href');
			expect(href).toMatch(/^\/(products|recipes)\//);
			await cards(page).first().focus();
			await page.keyboard.press('Enter');
			await page.waitForURL((u) => u.pathname === href);
			await expect(overlay(page)).toBeHidden();
			await navSearch(page).click();
			await expect(field(page)).toHaveValue('');
			await page.locator('.wf-search-close').click();
			await expect(overlay(page)).toBeHidden();
			await expect(navSearch(page)).toBeFocused();
		});

		test('no results: a message, and Tab cycles between the field and close', async ({ page, shop }) => {
			await shop.visit('/' + q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('zzzzqqq');
			await expect(field(page)).toHaveValue('zzzzqqq');
			await expect(cards(page)).toHaveCount(0);
			await expect(overlay(page)).toContainText(/no (results|matches)|nothing/i);
			for (let i = 0; i < 4; i++) {
				await page.keyboard.press('Tab');
				expect(await inOverlay(page)).toBe(true);
			}
		});
	});
}

/* ---------------------------------------------------------------- mobile nav */

test.describe('mobile nav', () => {
	for (const width of [991, 390]) {
		test(`${width}px: hamburger opens the sheet, focus trapped, Esc returns focus; links and bag count`, async ({ page, shop }) => {
			await page.setViewportSize({ width, height: 844 });
			await seedBag(page, { cornflakes: 2, muesli: 1 });
			await shop.visit('/');
			const burger = page.locator('#wf-menu-btn');
			const sheet = page.getByRole('dialog', { name: 'Menu' });
			await expect(burger).toBeVisible();
			await expect(page.locator('.nav-menu')).toBeHidden();
			await expectNoHorizontalOverflow(page);
			await burger.click();
			await expect(sheet).toBeVisible();
			await expect(burger).toHaveAttribute('aria-expanded', 'true');
			await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
			for (const [name, href] of [['Shop', '/shop'], ['Recipes', '/recipes'], ['Our Story', '/#about'], ['Contact', '/#contact'], ['Account', '/login']]) {
				await expect(sheet.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
			}
			await expect(sheet.getByRole('link', { name: 'Bag, 3 items' })).toHaveAttribute('href', '/cart');
			const controls = await sheet.locator('a[href], button').count();
			for (let i = 0; i < controls + 2; i++) {
				await page.keyboard.press('Tab');
				expect(await page.evaluate(() => !!document.activeElement?.closest('.wf-mnav'))).toBe(true);
			}
			await page.keyboard.press('Escape');
			await expect(sheet).toHaveCount(0);
			await expect(burger).toBeFocused();
			await expect(burger).toHaveAttribute('aria-expanded', 'false');

			await burger.click();
			await sheet.getByRole('link', { name: 'Shop', exact: true }).click();
			await page.waitForURL((u) => u.pathname === '/shop');
			await expect(sheet).toHaveCount(0);
			expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
		});
	}

	test('992px and up: no hamburger, the desktop links show', async ({ page, shop }) => {
		await page.setViewportSize({ width: 992, height: 800 });
		await shop.visit('/');
		await expect(page.locator('#wf-menu-btn')).toBeHidden();
		await expect(page.locator('.nav-menu a[href="/shop"]')).toBeVisible();
	});
});

/* ---------------------------------------------------------------- 404 */

test.describe('404 (S9)', () => {
	// The browser logs the 404 of the document itself ("Failed to load resource … 404 (…/nope)"):
	// that is the status we want. Allowed for the page URLs of these tests only.
	test.beforeEach(({ consoleErrors }) => {
		consoleErrors.allow(/status of 404 \(Not Found\) \(http:\/\/localhost:\d+\/(nope|this-page-does-not-exist)\)$/);
	});

	test('unknown URL: 404 status, branded page, site chrome and the crowd', async ({ page }) => {
		const res = await page.goto('/this-page-does-not-exist');
		expect(res.status()).toBe(404);
		await waitHydrated(page);
		await expect(page).toHaveTitle('Wefeasto — Page not found');
		await expect(page.getByRole('heading', { level: 1, name: 'This page wandered off.' })).toBeVisible();
		await expect(page.locator('.wf-notfound .wf-chip')).toHaveText('Error 404');
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
		await expect(page.getByRole('link', { name: 'Shop Breakfast' })).toHaveAttribute('href', '/shop');
		await expect(page.locator('.navbar')).toBeVisible();
		await expect(page.locator('.footer-section')).toBeVisible();
		await expect(strip(page)).toHaveCount(1);
	});

	test('"Search Wefeasto" opens search with focus in the field; Esc gives focus back', async ({ page }) => {
		await page.goto('/nope');
		await waitHydrated(page);
		const button = page.getByRole('button', { name: 'Search Wefeasto' });
		await button.click();
		await expect(field(page)).toBeFocused();
		await page.keyboard.type('muesli');
		await expect(field(page)).toHaveValue('muesli');
		await expect(cards(page).first()).toContainText('Muesli');
		await page.keyboard.press('Escape');
		await expect(overlay(page)).toBeHidden();
		await expect(button).toBeFocused();
	});

	test('three bestsellers that add to the bag with source not-found (server and client-rendered 404)', async ({ page, shop }) => {
		await page.addInitScript(recordAdds);
		await page.goto('/nope');
		await waitHydrated(page);
		const grid = page.locator('.page-wrapper .grid-6 .wf-card');
		await expect(grid).toHaveCount(3);
		const add = grid.first().locator('[data-wf-add]');
		await bringIntoView(add);
		const slug = await add.getAttribute('data-wf-add');
		await add.click();
		await expect(toastTitle(page)).toHaveText(/×1 added to your bag$/);
		expect(await adds(page)).toEqual([expect.objectContaining({ slug, qty: 1, source: 'not-found' })]);
		await expect(badge(page)).toHaveText('1');

		// Client-side: a missing product renders the same page without a reload.
		await shop.visit('/shop');
		await page.evaluate(() => (window.__noReload = true));
		await page.evaluate(() => {
			const a = document.createElement('a');
			a.href = '/products/not-a-cereal';
			document.querySelector('.page-wrapper').appendChild(a);
			a.click();
		});
		await expect(page.getByRole('heading', { level: 1, name: 'This page wandered off.' })).toBeVisible();
		expect(await page.evaluate(() => window.__noReload)).toBe(true);
		const add2 = page.locator('.page-wrapper .grid-6 .wf-card [data-wf-add]').nth(1);
		await bringIntoView(add2);
		await add2.click();
		await expect.poll(async () => (await adds(page)).at(-1)?.source).toBe('not-found');
	});
});
