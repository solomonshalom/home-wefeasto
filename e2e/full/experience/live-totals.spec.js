/*
 * Roadmap M1 against the real stack: the Delivery row, the free-delivery note, the meter
 * and the one-tap top-up on /cart, /checkout and in the toast, all from LIVE values
 * (GET /api/store/catalog) changed through the admin API — no rebuild in between.
 * Boundaries ₹498 / ₹499 / ₹500 are made with a live price (muesli), so the storefront's
 * build snapshot (₹250) cannot produce them by accident.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/live-totals.spec.js
 */
import { test, expect } from '../fixtures.js';
import {
	adds,
	badge,
	cartSummary,
	coSummary,
	expectedQuote,
	formatPaise,
	frames,
	gotoLive,
	liveCatalog,
	readBag,
	recordAdds,
	seedBag,
	toast,
	waitHydrated
} from './helpers.js';

const STATEFUL = { tag: '@stateful' };
const meter = (scope) => scope.locator('[role="progressbar"]');

/** The /checkout summary once the server quote has settled (no .wf-loading). */
async function settledCheckout(page) {
	await expect(coSummary(page)).toBeVisible();
	await page.waitForFunction(() => {
		const s = document.querySelector('#wf-co-summary');
		return !!s && !s.textContent.includes('Loading your bag') && !s.classList.contains('wf-loading');
	});
}

test.describe('M1 boundaries with live prices', () => {
	for (const [subtotal, fee, note, pct] of [
		[49800, 4900, 'Free delivery above ₹499 — add ₹1 more', '99'],
		[49900, 0, 'Free delivery above ₹499 — yours is free!', '100'],
		[50000, 0, 'Free delivery above ₹499 — yours is free!', '100']
	]) {
		test(`₹${subtotal / 100}: Delivery ${fee ? formatPaise(fee) : 'FREE'} on cart, checkout (= server quote) and toast`, STATEFUL, async ({ page, admin, api, shop }) => {
			await admin.setPrice('muesli', subtotal);
			const cat = await liveCatalog(api);
			expect(cat.settings.freeDeliveryThresholdPaise).toBe(49900); // the seed's threshold
			expect(cat.products.find((p) => p.slug === 'muesli').pricePaise).toBe(subtotal);

			// /cart: live values replace the snapshot (₹250) without a rebuild.
			await seedBag(page, { muesli: 1 });
			await gotoLive(page, '/cart');
			const s = cartSummary(page);
			await expect(s.locator('[data-wf-subtotal]')).toHaveText(formatPaise(subtotal));
			await expect(s.locator('[data-wf-delivery]')).toHaveText(fee ? formatPaise(fee) : 'FREE');
			await expect(s.locator('[data-wf-note]')).toHaveText(note);
			await expect(s.locator('[data-wf-total]')).toHaveText(formatPaise(subtotal + fee));
			await expect(meter(s)).toHaveAttribute('aria-valuenow', pct);
			await expect(page.locator('[data-wf-row="muesli"] [data-wf-line]')).toHaveText(formatPaise(subtotal));

			// /checkout: the summary is the server quote, to the paisa.
			const server = (await api.quote({ items: [{ slug: 'muesli', qty: 1 }] })).json.quote;
			expect(server.subtotalPaise).toBe(subtotal);
			expect(server.deliveryPaise).toBe(fee);
			await shop.visit('/checkout');
			await settledCheckout(page);
			const c = coSummary(page);
			await expect(c.locator('[data-wf-subtotal]')).toHaveText(formatPaise(server.subtotalPaise));
			await expect(c.locator('[data-wf-delivery]')).toHaveText(fee ? formatPaise(fee) : 'FREE');
			await expect(c.locator('[data-wf-total]')).toHaveText(formatPaise(server.totalPaise));
			await expect(meter(c)).toHaveAttribute('aria-valuenow', pct);

			// Toast (fresh bag): "Checkout · ₹X" is subtotal + fee from the live quote.
			await page.evaluate(() => localStorage.removeItem('wefeasto_cart'));
			await shop.visit('/products/muesli');
			await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
			await expect(toast(page)).toBeVisible();
			await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText(`Checkout · ${formatPaise(subtotal + fee)}`);
			await expect(meter(toast(page))).toHaveAttribute('aria-valuenow', pct);
		});
	}

	test('store settings changed in the CMS (threshold + fee) show on /cart and /checkout without a rebuild', STATEFUL, async ({ page, admin, api, shop }) => {
		await admin.updateSettings({ freeDeliveryThresholdPaise: 60000, deliveryFeePaise: 5900 });
		await seedBag(page, { muesli: 2 }); // ₹500: free under the build snapshot, not any more
		await gotoLive(page, '/cart');
		const s = cartSummary(page);
		await expect(s.locator('[data-wf-note]')).toHaveText('Free delivery above ₹600 — add ₹100 more');
		await expect(s.locator('[data-wf-delivery]')).toHaveText('₹59');
		await expect(s.locator('[data-wf-total]')).toHaveText('₹559');
		const server = (await api.quote({ items: [{ slug: 'muesli', qty: 2 }] })).json.quote;
		expect(server.totalPaise).toBe(55900);
		await shop.visit('/checkout');
		await settledCheckout(page);
		await expect(coSummary(page).locator('[data-wf-delivery]')).toHaveText('₹59');
		await expect(coSummary(page).locator('[data-wf-total]')).toHaveText('₹559');
	});
});

test('checkout: a live COD fee shows as its own row only for COD, and the Pay button always carries the summary total (no drip pricing)', STATEFUL, async ({ page, admin, api, shop }) => {
	await admin.updateSettings({ codFeePaise: 2000 });
	await seedBag(page, { muesli: 1 });
	await shop.visit('/checkout');
	await settledCheckout(page);
	const c = coSummary(page);
	const pay = page.locator('#wf-place-order');
	for (const [method, fee] of [['upi', 0], ['cod', 2000], ['card', 0], ['cod', 2000]]) {
		await page.locator(`label.wf-pay-pill:has(input[value="${method}"])`).click();
		const server = (await api.quote({ items: [{ slug: 'muesli', qty: 1 }], method })).json.quote;
		expect(server.codFeePaise).toBe(fee);
		const total = formatPaise(server.totalPaise);
		await expect(c.locator('[data-wf-total]')).toHaveText(total);
		await expect(c.locator('[data-wf-cod-fee]')).toHaveCount(fee ? 1 : 0);
		if (fee) await expect(c.locator('[data-wf-cod-fee]')).toHaveText(formatPaise(fee));
		await expect(pay).toContainText(total);
		// Whatever the button says, it never names a different amount than the summary.
		const amounts = ((await pay.textContent()).match(/₹[\d,]+/g) || []);
		expect(amounts.every((a) => a === total), `${method}: button ${JSON.stringify(amounts)} vs summary ${total}`).toBe(true);
	}
});

test.describe('M1 top-up', () => {
	test('Muesli + Cornflakes: ~85%, suggests Rolled Oats; nothing is added until "+ Add", which adds exactly one', async ({ page, api }) => {
		await page.addInitScript(recordAdds);
		await seedBag(page, { muesli: 1, cornflakes: 1 });
		await gotoLive(page, '/cart');
		const s = cartSummary(page);
		const q = await expectedQuote(api, { muesli: 1, cornflakes: 1 });
		expect(q.subtotalPaise).toBe(42500);
		await expect(meter(s)).toHaveAttribute('aria-valuenow', String(Math.floor(q.freeDeliveryProgress * 100)));
		await expect(s.locator('[data-wf-topup]')).toHaveAttribute('data-wf-topup', 'rolled-oats');
		await expect(s.locator('.wf-topup-text')).toHaveText('Add Rolled Oats · ₹125 → free delivery');
		await expect(s.locator('[data-wf-note]')).toHaveText('Free delivery above ₹499 — add ₹74 more');

		// Never added automatically: the live data has arrived, the page has settled, the bag is as seeded.
		await frames(page);
		expect(await readBag(page)).toEqual({ muesli: 1, cornflakes: 1 });
		expect(await adds(page)).toEqual([]);
		await expect(badge(page)).toHaveText('2');

		await s.locator('.wf-topup-add').click();
		await expect(badge(page)).toHaveText('3');
		expect(await readBag(page)).toEqual({ muesli: 1, cornflakes: 1, 'rolled-oats': 1 });
		expect(await adds(page)).toEqual([expect.objectContaining({ slug: 'rolled-oats', qty: 1, source: 'topup' })]);
		await expect(meter(s)).toHaveAttribute('aria-valuenow', '100');
		await expect(s.locator('[data-wf-note]')).toHaveText('Free delivery above ₹499 — yours is free!');
		await expect(s.locator('[data-wf-delivery]')).toHaveText('FREE');
		await expect(s.locator('[data-wf-total]')).toHaveText('₹550');
		await expect(page.locator('[data-wf-row="rolled-oats"]')).toBeVisible();
	});

	test('the suggestion is never a sold-out SKU (live stock 0 in the CMS)', STATEFUL, async ({ page, admin, api }) => {
		await admin.setStock('rolled-oats', 0);
		const cat = await liveCatalog(api);
		expect(cat.products.find((p) => p.slug === 'rolled-oats').inStock).toBe(false);
		await seedBag(page, { muesli: 1, cornflakes: 1 });
		await gotoLive(page, '/cart');
		const topup = cartSummary(page).locator('[data-wf-topup]');
		await expect(topup).toBeVisible();
		await expect(topup).not.toHaveAttribute('data-wf-topup', 'rolled-oats');
		const slug = await topup.getAttribute('data-wf-topup');
		expect(cat.products.find((p) => p.slug === slug)?.inStock, `${slug} is in stock`).toBe(true);
	});

	test('skipping every suggestion leaves just the gap (meter + note), and the bag untouched', async ({ page, api }) => {
		await page.addInitScript(recordAdds);
		await seedBag(page, { 'rolled-oats': 1 });
		await gotoLive(page, '/cart');
		const s = cartSummary(page);
		const cat = await liveCatalog(api);
		const seen = [];
		for (let i = 0; i <= cat.products.length && (await s.locator('[data-wf-topup]').count()); i++) {
			const slug = await s.locator('[data-wf-topup]').getAttribute('data-wf-topup');
			expect(seen, 'each suggestion only once').not.toContain(slug);
			seen.push(slug);
			await s.locator('.wf-topup-skip').click();
			await expect(s.locator(`[data-wf-topup="${slug}"]`)).toHaveCount(0);
		}
		await expect(s.locator('[data-wf-topup]')).toHaveCount(0);
		expect(seen.length).toBeGreaterThan(0);
		await expect(s.locator('[data-wf-note]')).toHaveText('Free delivery above ₹499 — add ₹374 more');
		await expect(meter(s)).toBeVisible();
		expect(await readBag(page)).toEqual({ 'rolled-oats': 1 });
		expect(await adds(page)).toEqual([]);
	});

	test('meter and suggestion follow qty +/−, remove, and a change made in another tab', async ({ page, context }) => {
		await seedBag(page, { muesli: 1, cornflakes: 1 });
		await gotoLive(page, '/cart');
		const s = cartSummary(page);
		await expect(meter(s)).toHaveAttribute('aria-valuenow', '85');
		await page.locator('[data-wf-row="muesli"] [data-wf-qty-plus]').click();
		await expect(meter(s)).toHaveAttribute('aria-valuenow', '100');
		await expect(s.locator('[data-wf-delivery]')).toHaveText('FREE');
		await expect(s.locator('[data-wf-note]')).toHaveText('Free delivery above ₹499 — yours is free!');
		await page.locator('[data-wf-row="muesli"] [data-wf-qty-minus]').click();
		await expect(meter(s)).toHaveAttribute('aria-valuenow', '85');
		await expect(s.locator('[data-wf-topup]')).toBeVisible();
		await expect(s.locator('[data-wf-delivery]')).toHaveText('₹49');
		await page.locator('[data-wf-row="cornflakes"] .wf-cart-remove').click();
		await expect(page.locator('[data-wf-row="cornflakes"]')).toHaveCount(0);
		await expect(meter(s)).toHaveAttribute('aria-valuenow', '50');
		await expect(s.locator('[data-wf-note]')).toHaveText('Free delivery above ₹499 — add ₹249 more');

		// Another tab adds 2 × Cornflakes: the storage event re-renders this summary.
		const other = await context.newPage();
		await other.goto('/shop');
		await waitHydrated(other);
		await other.evaluate(() => window.WefeastoCart.add('cornflakes', 2, { source: 'card' }));
		await expect(meter(s)).toHaveAttribute('aria-valuenow', '100');
		await expect(s.locator('[data-wf-subtotal]')).toHaveText('₹600');
		await expect(page.locator('[data-wf-row="cornflakes"] .wf-qty-input')).toHaveValue('2');
		await other.close();
	});

	test('an empty bag has no Delivery row, meter or top-up', async ({ page }) => {
		await page.goto('/cart');
		await waitHydrated(page);
		await expect(page.locator('.wf-cart-empty')).toBeVisible();
		await expect(page.locator('[data-wf-delivery], [role="progressbar"], [data-wf-topup]')).toHaveCount(0);
	});
});
