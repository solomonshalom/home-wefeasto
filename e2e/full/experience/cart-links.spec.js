/*
 * The bag page on the real stack: S4 undo-on-remove (quantity and position restored,
 * several at once, the last item), M5 /cart?add= deep links (garbage, idempotence,
 * merge, src attribution all the way to the order's `source` in the CMS) and S6
 * /cart?offer= (a real coupon: chip on /cart, applied by the checkout quote, removable).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/cart-links.spec.js
 */
import { test, expect } from '../fixtures.js';
import { adds, badge, clientNav, coSummary, gotoLive, readBag, recordAdds, seedBag, waitHydrated } from './helpers.js';

const STATEFUL = { tag: '@stateful' };
const rowSlugs = (page) => page.locator('#wf-cart-list').locator('[data-wf-row], [data-wf-undo]').evaluateAll((els) => els.map((e) => e.getAttribute('data-wf-row') || 'undo:' + e.getAttribute('data-wf-undo')));
const undoRow = (page, slug) => page.locator(`.wf-cart-undo[data-wf-undo="${slug}"]`);

test.beforeEach(async ({ page }) => {
	await page.addInitScript(recordAdds);
});

/* ---------------------------------------------------------------- S4 undo */

test.describe('undo remove (S4)', () => {
	test('removing Muesli ×4 then Undo restores 4 in the same position (focus follows)', async ({ page }) => {
		await seedBag(page, { cornflakes: 1, muesli: 4, 'rolled-oats': 2 });
		await gotoLive(page, '/cart');
		expect(await rowSlugs(page)).toEqual(['cornflakes', 'muesli', 'rolled-oats']);
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(undoRow(page, 'muesli')).toContainText('Removed Muesli ×4');
		await expect(undoRow(page, 'muesli').getByRole('button', { name: 'Undo' })).toBeFocused();
		await expect(page.locator('.wf-cart-row')).toHaveCount(2); // the undo row is not a bag line
		expect(await readBag(page)).toEqual({ cornflakes: 1, 'rolled-oats': 2 });
		await expect(badge(page)).toHaveText('3');

		await undoRow(page, 'muesli').getByRole('button', { name: 'Undo' }).click();
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('4');
		expect(await rowSlugs(page)).toEqual(['cornflakes', 'muesli', 'rolled-oats']);
		expect(Object.keys(await readBag(page))).toEqual(['cornflakes', 'muesli', 'rolled-oats']);
		await expect(page.locator('[data-wf-row="muesli"] .wf-cart-remove')).toBeFocused();
		await expect(page.locator('#wf-cart-summary [data-wf-subtotal]')).toHaveText('₹1,425'); // 175 + 4×250 + 2×125
	});

	test('several removals are pending at once; each Undo restores only its line; the window closes after ~6 s', async ({ page }) => {
		await seedBag(page, { cornflakes: 2, muesli: 1, 'rolled-oats': 3 });
		await gotoLive(page, '/cart');
		await page.locator('[data-wf-row="cornflakes"] .wf-cart-remove').click();
		await expect(undoRow(page, 'cornflakes')).toBeVisible();
		await page.locator('[data-wf-row="rolled-oats"] .wf-cart-remove').click();
		await expect(undoRow(page, 'rolled-oats')).toBeVisible();
		expect(await readBag(page)).toEqual({ muesli: 1 });

		await undoRow(page, 'rolled-oats').getByRole('button', { name: 'Undo' }).click();
		await expect(page.locator('[data-wf-row="rolled-oats"] .wf-qty-input')).toHaveValue('3');
		await expect(undoRow(page, 'cornflakes')).toBeVisible(); // still pending
		expect(await readBag(page)).toEqual({ muesli: 1, 'rolled-oats': 3 });

		await expect(undoRow(page, 'cornflakes')).toHaveCount(0, { timeout: 10_000 }); // committed
		expect(await rowSlugs(page)).toEqual(['muesli', 'rolled-oats']);
		expect(await readBag(page)).toEqual({ muesli: 1, 'rolled-oats': 3 });
	});

	test('removing the last item shows the empty bag at once, with Undo above it', async ({ page }) => {
		await seedBag(page, { muesli: 2 });
		await gotoLive(page, '/cart');
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(page.locator('.wf-cart-empty')).toBeVisible();
		await expect(page.locator('.wf-cart-empty .wf-cart-undo-stack [data-wf-undo="muesli"]')).toContainText('Removed Muesli ×2');
		await expect(badge(page)).toHaveClass(/wf-is-hidden/);
		await undoRow(page, 'muesli').getByRole('button', { name: 'Undo' }).click();
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('2');
		await expect(page.locator('.wf-cart-empty')).toHaveCount(0);
		await expect(page.locator('#wf-cart-summary [data-wf-total]')).toHaveText('₹500');
	});

	test('leaving the page commits the removal', async ({ page }) => {
		await seedBag(page, { muesli: 1, cornflakes: 1 });
		await gotoLive(page, '/cart');
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(undoRow(page, 'muesli')).toBeVisible();
		await clientNav(page, '/shop');
		await clientNav(page, '/cart');
		await expect(page.locator('[data-wf-row="cornflakes"]')).toBeVisible();
		await expect(page.locator('[data-wf-row="muesli"], [data-wf-undo="muesli"]')).toHaveCount(0);
		expect(await readBag(page)).toEqual({ cornflakes: 1 });
	});
});

/* ---------------------------------------------------------------- M5 deep links */

test.describe('/cart?add= deep links (M5)', () => {
	test('garbage: muesli:-5,foo:3,cornflakes:1e9 → Cornflakes ×10 only, with a note; the params are stripped', async ({ page }) => {
		await page.goto('/cart?add=' + encodeURIComponent('muesli:-5,foo:3,cornflakes:1e9'));
		await waitHydrated(page);
		await expect(page.locator('[data-wf-row="cornflakes"] .wf-qty-input')).toHaveValue('10');
		expect(await readBag(page)).toEqual({ cornflakes: 10 });
		await expect(page.locator('[data-wf-link-note]')).toHaveText('Added from your link: Cornflakes ×10.');
		await expect(page.locator('[data-wf-link-dropped]')).toContainText('Skipped:');
		await expect(page).toHaveURL((u) => u.pathname === '/cart' && u.search === '');
		expect((await adds(page)).map((d) => [d.slug, d.qty, d.source])).toEqual([['cornflakes', 10, 'link']]);
	});

	test('idempotent: a refresh or a second open adds nothing more; one event with the link src', async ({ page }) => {
		const link = '/cart?add=cornflakes:2,muesli:1&src=email';
		await page.goto(link);
		await waitHydrated(page);
		await expect(page.locator('[data-wf-link-note]')).toHaveText('Added from your link: Cornflakes ×2, Muesli ×1.');
		expect(await readBag(page)).toEqual({ cornflakes: 2, muesli: 1 });
		expect(await adds(page)).toEqual([expect.objectContaining({ slug: 'cornflakes', qty: 3, source: 'email', lines: [{ slug: 'cornflakes', qty: 2 }, { slug: 'muesli', qty: 1 }] })]);
		await expect(page).toHaveURL((u) => u.search === '');
		await page.reload();
		await waitHydrated(page);
		expect(await readBag(page)).toEqual({ cornflakes: 2, muesli: 1 });
		await page.goto(link);
		await waitHydrated(page);
		await expect(page.locator('[data-wf-link-note]')).toHaveText('Everything from your link is already in your bag.');
		expect(await readBag(page)).toEqual({ cornflakes: 2, muesli: 1 });
		expect(await adds(page)).toEqual([]);
		await expect(badge(page)).toHaveText('3');
	});

	test('merges into the bag (tops up to the linked quantities, never replaces)', async ({ page }) => {
		await seedBag(page, { muesli: 3, 'steel-cut-oats': 1 });
		await page.goto('/cart?add=muesli:1,cornflakes:1');
		await waitHydrated(page);
		expect(await readBag(page)).toEqual({ muesli: 3, 'steel-cut-oats': 1, cornflakes: 1 });
	});

	test('?add= on any other page is ignored', async ({ page }) => {
		await page.goto('/shop?add=muesli:2');
		await waitHydrated(page);
		expect(await readBag(page)).toEqual({});
		await expect(badge(page)).toHaveClass(/wf-is-hidden/);
	});

	test('src=email reaches the order: the CMS records source "email"', STATEFUL, async ({ page, shop, admin }) => {
		await page.goto('/cart?add=cornflakes:1&src=email');
		await waitHydrated(page);
		await expect(page.locator('[data-wf-row="cornflakes"]')).toBeVisible();
		const { number } = await shop.placeCodOrder({});
		const o = await admin.findOrder(number);
		expect(o.source).toBe('email');
		expect(o.items).toHaveLength(1);
		expect(o.items[0].qty).toBe(1);
	});

	test('a product sold out in the CMS never slips through a link unflagged', STATEFUL, async ({ page, admin }) => {
		await admin.setStock('choco-flakes', 0);
		await page.goto('/cart?add=choco-flakes:1,muesli:1');
		await waitHydrated(page);
		await expect(page.locator('[data-wf-row="muesli"]')).toBeVisible();
		await expect(page.getByText(/Choco's (is out of stock right now|just sold out)/).first()).toBeVisible();
		await expect(page.locator('#wf-cart-summary [data-wf-subtotal]')).toHaveText('₹250');
	});
});

/* ---------------------------------------------------------------- S6 offer links */

test.describe('/cart?offer= (S6)', () => {
	test('a real coupon: chip on /cart, applied by the checkout quote, removable', STATEFUL, async ({ page, admin, api, shop }) => {
		const coupon = await admin.createCoupon({ type: 'fixed', value: 5000 });
		await seedBag(page, { muesli: 2 });
		await page.goto(`/cart?offer=${coupon.code.toLowerCase()}`);
		await waitHydrated(page);
		const chip = page.locator(`#wf-cart-summary [data-wf-offer="${coupon.code}"]`);
		await expect(chip).toContainText(`Offer ${coupon.code} will be applied at checkout`);
		await expect(page).toHaveURL((u) => u.search === '');

		const server = (await api.quote({ items: [{ slug: 'muesli', qty: 2 }], couponCode: coupon.code })).json.quote;
		expect(server.discountPaise).toBe(5000);
		await shop.visit('/checkout');
		await expect(coSummary(page).locator('[data-wf-discount]')).toHaveText('−₹50');
		await expect(coSummary(page).locator(`[data-wf-offer="${coupon.code}"]`)).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(coSummary(page).locator('[data-wf-total]')).toHaveText('₹450');
		expect(server.totalPaise).toBe(45000);

		await shop.visit('/cart');
		await chip.getByRole('button', { name: `Remove offer ${coupon.code}` }).click();
		await expect(chip).toHaveCount(0);
		expect(await page.evaluate(() => localStorage.getItem('wefeasto_offer'))).toBeNull();
		await shop.visit('/checkout');
		await expect(coSummary(page).locator('[data-wf-total]')).toHaveText('₹500');
		await expect(coSummary(page).locator('[data-wf-discount]')).toHaveCount(0);
	});

	test('a malformed offer code gets a note and no chip', async ({ page }) => {
		await seedBag(page, { muesli: 1 });
		await page.goto('/cart?offer=%3Cscript%3E');
		await waitHydrated(page);
		await expect(page.locator('[data-wf-offer-note]')).toHaveText('That offer link doesn’t look right — nothing was applied.');
		await expect(page.locator('[data-wf-offer]')).toHaveCount(0);
	});
});
