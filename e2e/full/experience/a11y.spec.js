/*
 * Accessibility smoke (axe-core, WCAG 2.0/2.1 A + AA) on the real stack: home, shop, PDP,
 * cart, checkout, order (a real confirmed order), login, account (a real signed-in
 * customer with an order) and the 404, plus the Phase 2 overlays in their open state
 * (toast, search results, mobile nav, the cart's undo row).
 *
 * Only `serious` and `critical` violations count, and only those the pre-Phase-2 build
 * did not already have: a11y-baseline.json holds the same scan of that build (re-create
 * it with `node e2e/full/experience/a11y-scan.mjs --static <baseline build dir>`; today it
 * is empty — the old site had no serious/critical violations on these pages). Every
 * finding is attached to the test as a11y-<page>.json.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/a11y.spec.js
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '../fixtures.js';
import { baselineKeys, scanPage, splitNew } from './a11y-lib.js';
import { seedBag, signUpAndLogIn, toast, waitHydrated } from './helpers.js';

const BASELINE = JSON.parse(readFileSync(new URL('./a11y-baseline.json', import.meta.url), 'utf8'));
const KEYS = baselineKeys(BASELINE);
const BAG = { muesli: 1, cornflakes: 2 };

test.use({ contextOptions: { reducedMotion: 'reduce' } }); // settled colours: no tween mid-fade during the scan

/** Scan, attach the findings, and fail on serious/critical violations the old build did not have. */
async function expectNoNewViolations(page, testInfo, name, baselineName = name, opts) {
	const scan = await scanPage(page, opts);
	const { pre, fresh } = splitNew(scan, KEYS, baselineName);
	await testInfo.attach(`a11y-${name}.json`, { body: JSON.stringify({ url: page.url(), new: fresh, preExisting: pre }, null, 1), contentType: 'application/json' });
	const lines = fresh.map((v) => `${v.impact} ${v.id}: ${v.help}\n    ${v.target}\n    ${v.html}\n    ${v.summary}`);
	expect(lines, `${name}: new serious/critical axe violations`).toEqual([]);
}

const settledCheckout = (page) =>
	page.waitForFunction(() => {
		const s = document.querySelector('#wf-co-summary');
		return !!s && !s.textContent.includes('Loading your bag') && !s.classList.contains('wf-loading') && document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') !== null;
	});

test.describe('pages', () => {
	test('home', async ({ page, shop }, testInfo) => {
		await shop.visit('/');
		await expectNoNewViolations(page, testInfo, 'home');
	});

	test('shop', async ({ page, shop }, testInfo) => {
		await shop.visit('/shop');
		await expectNoNewViolations(page, testInfo, 'shop');
	});

	test('PDP (muesli), facts open', async ({ page, shop }, testInfo) => {
		await shop.visit('/products/muesli');
		await page.locator('details.wf-facts > summary').click();
		await expectNoNewViolations(page, testInfo, 'pdp');
	});

	test('cart (live totals, meter, top-up)', async ({ page, shop }, testInfo) => {
		await seedBag(page, BAG);
		await shop.visit('/cart');
		await expect(page.locator('#wf-cart-summary [role="progressbar"]')).toBeVisible();
		await expectNoNewViolations(page, testInfo, 'cart');
	});

	test('checkout (bag, summary settled)', async ({ page, shop }, testInfo) => {
		await seedBag(page, BAG);
		await shop.visit('/checkout');
		await settledCheckout(page);
		await expect.poll(() => page.locator('#wf-co-summary').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		await expectNoNewViolations(page, testInfo, 'checkout');
	});

	test('checkout with validation errors shown', async ({ page, shop }, testInfo) => {
		await seedBag(page, BAG);
		await shop.visit('/checkout');
		await settledCheckout(page);
		await page.locator('label.wf-pay-pill:has(input[value="cod"])').click();
		await page.locator('#wf-place-order').click();
		await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
		await settledCheckout(page);
		// The summary's loading fade (.wf-loading, opacity .4 s) has finished: colours are final.
		await expect.poll(() => page.locator('#wf-co-summary').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		await expectNoNewViolations(page, testInfo, 'checkout-errors');
	});

	test('order (real confirmed COD order)', async ({ page, shop, api }, testInfo) => {
		const o = await api.placeOrder({ items: { cornflakes: 1, muesli: 1 }, method: 'cod' });
		await shop.visit(`/order?no=${o.number}&t=${o.token}`);
		await shop.waitOrderView(['confirmed']);
		await expectNoNewViolations(page, testInfo, 'order');
	});

	test('login (log in + sign up tabs)', async ({ page, shop }, testInfo) => {
		await shop.visit('/login');
		await expectNoNewViolations(page, testInfo, 'login');
		await page.click('#wf-tab-signup');
		await expect(page.locator('#wf-signup-form')).toBeVisible();
		await expectNoNewViolations(page, testInfo, 'login-signup', 'login');
	});

	test('account (signed in, with an order)', async ({ page, shop, mailpit, unique, api }, testInfo) => {
		test.setTimeout(60_000);
		const email = unique.email('a11y-acct');
		await signUpAndLogIn(page, { shop, mailpit, email });
		await shop.placeCodOrder({ items: { cornflakes: 1 }, form: { email } });
		await shop.visit('/account');
		await expect(page.locator('.wf-order-row').first()).toBeVisible();
		await expectNoNewViolations(page, testInfo, 'account');
	});

	test('404', async ({ page, consoleErrors }, testInfo) => {
		consoleErrors.allow(/status of 404 \(Not Found\) \(http:\/\/localhost:\d+\/nope\)$/);
		const res = await page.goto('/nope');
		expect(res.status()).toBe(404);
		await waitHydrated(page);
		await expectNoNewViolations(page, testInfo, '404');
	});
});

test.describe('Phase 2 overlays, open', () => {
	test('mini-bag toast on the PDP', async ({ page, shop }, testInfo) => {
		await shop.visit('/products/muesli');
		await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
		await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText(/₹/);
		await toast(page).hover(); // hold it open for the scan
		await expectNoNewViolations(page, testInfo, 'toast', 'pdp');
	});

	test('search overlay with results', async ({ page, shop }, testInfo) => {
		await shop.visit('/');
		await page.locator('.navbar .wf-search-open').click();
		await expect(page.locator('.wf-search-input')).toBeFocused();
		await page.keyboard.type('oat');
		await expect(page.locator('.wf-search-card').first()).toBeVisible();
		await expectNoNewViolations(page, testInfo, 'search');
	});

	test('mobile nav sheet (390px)', async ({ page, shop }, testInfo) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await shop.visit('/');
		await page.locator('#wf-menu-btn').click();
		await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
		await expectNoNewViolations(page, testInfo, 'mobile-nav', 'home');
	});

	test('cart undo row', async ({ page, shop }, testInfo) => {
		await seedBag(page, BAG);
		await shop.visit('/cart');
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(page.locator('[data-wf-undo="muesli"]')).toBeVisible();
		await expectNoNewViolations(page, testInfo, 'cart-undo', 'cart');
	});
});
