/*
 * Live catalog overlay end to end: a price or stock change made in the CMS reaches the
 * storefront without a rebuild (SPEC §1 "Live price and stock overlays are fetched
 * client-side"; live-catalog.md §2 `{#if $liveCatalog.ready && !row.inStock}Sold out`).
 * The bag and checkout must show live numbers and flag sold-out lines; the PDP and the
 * /shop card must not keep selling a product the CMS says is sold out.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/live-catalog.spec.js
 */
import { test, expect } from '../fixtures.js';
import { bringIntoView, cartSummary, coSummary, formatPaise, gotoLive, liveCatalog, readBag, seedBag, waitHydrated } from './helpers.js';

const STATEFUL = { tag: '@stateful' };
const SOLD_OUT_TEXT = /sold out|out of stock/i;

/** Add button is disabled for real: disabled / aria-disabled, or a click adds nothing. */
async function addIsBlocked(page, button) {
	const disabled = await button.evaluate((el) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
	if (disabled) return true;
	const before = await page.evaluate(() => window.WefeastoCart.count());
	await button.click({ trial: false }).catch(() => {});
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	return (await page.evaluate(() => window.WefeastoCart.count())) === before;
}

test.describe('live price', () => {
	test('a price changed in the CMS shows on /cart (unit, line, subtotal) and equals the checkout quote', STATEFUL, async ({ page, admin, api, shop }) => {
		await admin.setPrice('cornflakes', 19900);
		await seedBag(page, { cornflakes: 2 });
		await gotoLive(page, '/cart');
		const row = page.locator('[data-wf-row="cornflakes"]');
		await expect(row.locator('.wf-cart-unit')).toHaveText(/^₹199( · .+)?$/);
		await expect(row.locator('[data-wf-line]')).toHaveText('₹398');
		await expect(cartSummary(page).locator('[data-wf-subtotal]')).toHaveText('₹398');
		const server = (await api.quote({ items: [{ slug: 'cornflakes', qty: 2 }] })).json.quote;
		expect(server.subtotalPaise).toBe(39800);
		await shop.visit('/checkout');
		await expect(coSummary(page).locator('[data-wf-subtotal]')).toHaveText('₹398');
		await expect(coSummary(page).locator('[data-wf-total]')).toHaveText(formatPaise(server.totalPaise));
	});

	test('a price changed in the CMS shows on the product page without a rebuild', STATEFUL, async ({ page, admin, api }) => {
		await admin.setPrice('cornflakes', 19900);
		expect((await liveCatalog(api)).products.find((p) => p.slug === 'cornflakes').pricePaise).toBe(19900);
		await page.goto('/products/cornflakes');
		await waitHydrated(page);
		// Snapshot says ₹175; the store now charges ₹199 (the checkout would answer PRICE_CHANGED).
		await expect(page.locator('.wf-price-large')).toHaveText('₹199', { timeout: 10_000 });
	});
});

test.describe('sold out (stock 0 in the CMS)', () => {
	test('in the bag: /cart flags the line and leaves it out of the totals; /checkout blocks paying', STATEFUL, async ({ page, admin, api, shop }) => {
		await admin.setStock('choco-flakes', 0);
		expect((await liveCatalog(api)).products.find((p) => p.slug === 'choco-flakes').inStock).toBe(false);
		await seedBag(page, { 'choco-flakes': 1, muesli: 2 });
		await gotoLive(page, '/cart');
		const row = page.locator('[data-wf-row="choco-flakes"]');
		await expect(row.locator('[data-wf-issue]')).toHaveAttribute('data-wf-issue', 'OUT_OF_STOCK');
		await expect(row.locator('[data-wf-issue]')).toHaveText("Choco's just sold out — remove it to continue.");
		await expect(cartSummary(page).locator('[data-wf-subtotal]')).toHaveText('₹500'); // muesli only
		await expect(cartSummary(page).locator('[data-wf-total]')).toHaveText('₹500');

		await shop.visit('/checkout');
		await expect(page.locator('[data-wf-co-issue][data-wf-co-line="choco-flakes"]')).toHaveAttribute('data-wf-co-issue', 'OUT_OF_STOCK');
		await expect(page.locator('[data-wf-blocked]')).toBeVisible();
		await expect(page.locator('#wf-place-order')).not.toHaveAttribute('data-wf-pay-state', 'ready');
	});

	test('fewer left than in the bag: /checkout says how many are left', STATEFUL, async ({ page, admin, shop }) => {
		await admin.setStock('steel-cut-oats', 2);
		await seedBag(page, { 'steel-cut-oats': 3 });
		await gotoLive(page, '/checkout');
		const issue = page.locator('[data-wf-co-issue][data-wf-co-line="steel-cut-oats"]');
		await expect(issue).toHaveAttribute('data-wf-co-issue', 'OUT_OF_STOCK');
		await expect(issue).toContainText('Only 2 packs of Steel-Cut Oats left — reduce the quantity to continue.');
		await expect(page.locator('[data-wf-blocked]')).toBeVisible();
		await shop.visit('/cart'); // the bag itself is never rewritten behind the customer's back
		expect(await readBag(page)).toEqual({ 'steel-cut-oats': 3 });
	});

	test('the product page flags it and its Add button no longer adds', STATEFUL, async ({ page, admin }) => {
		await admin.setStock('choco-flakes', 0);
		await page.goto('/products/choco-flakes');
		await waitHydrated(page);
		await expect(page.locator('.div-block-76').getByText(SOLD_OUT_TEXT).first()).toBeVisible({ timeout: 10_000 });
		expect(await addIsBlocked(page, page.locator('[data-wf-add="choco-flakes"][data-wf-qty-input]'))).toBe(true);
		expect(await readBag(page)).toEqual({});
	});

	test('the /shop card flags it and its Add button no longer adds', STATEFUL, async ({ page, admin }) => {
		await admin.setStock('choco-flakes', 0);
		await page.goto('/shop');
		await waitHydrated(page);
		const card = page.locator('.wf-card', { has: page.locator('[data-wf-add="choco-flakes"]') });
		await bringIntoView(card); // below the fold: its .wf-reveal shows once scrolled to
		await expect(card.getByText(SOLD_OUT_TEXT).first()).toBeVisible({ timeout: 10_000 });
		expect(await addIsBlocked(page, card.locator('[data-wf-add="choco-flakes"]'))).toBe(true);
	});
});
