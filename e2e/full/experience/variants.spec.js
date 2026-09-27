/*
 * The main experience flows in the SPEC's variants (?nofx=1, storage throwing, storage
 * blocked) on the real stack, plus M5 "Your usual" after a real paid order.
 * In the storage variants the bag lives in memory: shop.visit() navigates client-side.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/variants.spec.js
 */
import { test, expect } from '../fixtures.js';
import { adds, badge, cartSummary, coSummary, expectedQuote, formatPaise, readBag, recordAdds, toast, toastTitle } from './helpers.js';

const meter = (scope) => scope.locator('[role="progressbar"]');

for (const variant of ['nofx', 'storage-throws', 'storage-blocked']) {
	test.describe(`[${variant}]`, () => {
		test.use({ variant });

		test('PDP add → toast → bag: top-up adds one → checkout shows the server total', async ({ page, shop, api }) => {
			await page.addInitScript(recordAdds);
			await shop.visit('/products/muesli');
			await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
			await expect(toastTitle(page)).toHaveText('Muesli ×1 added to your bag');
			await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText('Checkout · ₹299');
			await shop.visit('/cart');
			await expect(toast(page)).toHaveCount(0);
			const s = cartSummary(page);
			await expect(s.locator('[data-wf-topup]')).toHaveAttribute('data-wf-topup', 'health-mix');
			await expect(s.locator('[data-wf-delivery]')).toHaveText('₹49');
			await s.locator('.wf-topup-add').click();
			await expect(meter(s)).toHaveAttribute('aria-valuenow', '100');
			await expect(s.locator('[data-wf-delivery]')).toHaveText('FREE');
			expect(await readBag(page)).toEqual({ muesli: 1, 'health-mix': 1 });
			expect((await adds(page)).map((d) => d.source)).toContain('topup');
			if (variant === 'nofx') {
				// ?nofx=1: no GSAP tween on the meter; the width is final at once.
				expect(await page.evaluate(() => window.gsap.getTweensOf('.wf-meter-fill').length)).toBe(0);
				expect(await s.locator('[data-wf-meter-fill]').evaluate((el) => el.style.width)).toBe('100%');
			}
			await expect(badge(page)).toHaveText('2');
			const q = await expectedQuote(api, { muesli: 1, 'health-mix': 1 });
			await shop.visit('/checkout');
			await expect(coSummary(page).locator('[data-wf-total]')).toHaveText(formatPaise(q.totalPaise));
		});

		test('/cart?add= fills the bag, which survives navigation within the visit', async ({ page, shop }) => {
			await shop.setCart({ cornflakes: 2, muesli: 1 }); // storage variants: via /cart?add=
			if (variant === 'nofx') await shop.visit('/cart');
			await expect(page.locator('[data-wf-row="cornflakes"] .wf-qty-input')).toHaveValue('2');
			await shop.visit('/shop');
			await shop.visit('/cart');
			await expect(page.locator('[data-wf-row="muesli"]')).toBeVisible();
			await expect(cartSummary(page).locator('[data-wf-total]')).toHaveText('₹600');
		});
	});
}

test.describe('"Your usual" (M5) after a real paid order', () => {
	test('/shop offers the order again at current live prices; one tap adds it all with one usual event', { tag: '@stateful' }, async ({ page, shop, admin }) => {
		test.setTimeout(60_000);
		await page.addInitScript(recordAdds);
		const { number } = await shop.placeOnlineOrder({ items: { cornflakes: 2, muesli: 1 }, auto: 'success' });
		expect((await admin.findOrder(number)).status).toBe('paid');
		expect(await readBag(page)).toEqual({}); // confirmed order subtracted from the bag
		await admin.setPrice('muesli', 26000); // a price rise since: the usual shows today's total
		// The checkout just fetched /api/store/catalog, which is browser-cacheable for 15 s
		// (live-catalog.md §1). Stand in for "later" by dropping the HTTP cache, not by waiting.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Network.clearBrowserCache');
		await cdp.detach();
		await shop.visit('/shop');
		const usual = page.locator('[data-wf-usual="shop"]');
		await expect(usual).toBeVisible();
		await expect(usual.locator('.wf-usual-text')).toHaveText('Your usual: Cornflakes ×2 · Muesli ×1');
		await expect(usual.locator('[data-wf-usual-add]')).toHaveText('Add all · ₹610');
		await usual.locator('[data-wf-usual-add]').click();
		await expect(badge(page)).toHaveText('3');
		expect(await readBag(page)).toEqual({ cornflakes: 2, muesli: 1 });
		const usualAdds = (await adds(page)).filter((d) => d.source === 'usual');
		expect(usualAdds).toHaveLength(1);
		expect(usualAdds[0]).toMatchObject({ qty: 3 });
		await expect(usual).toHaveCount(0); // the bag holds the usual now
		await expect(toastTitle(page)).toHaveText('3 items added to your bag');
	});
});
