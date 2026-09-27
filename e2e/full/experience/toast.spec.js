/*
 * Roadmap M4 mini-bag toast on the real stack: every placement sends the right
 * `source` in the wf:cart-add detail, the toast never shows on /cart, /checkout or
 * /order (a real order), rapid adds merge, hover holds it, Esc closes it, any
 * navigation closes it, and on phones it hides the colour-mix pill while it is up.
 * Timers are measured with the page's own clock (performance.now()), not the runner's.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/toast.spec.js
 */
import { test, expect } from '../fixtures.js';
import {
	adds,
	badge,
	bringIntoView,
	clientNav,
	colorMix,
	frames,
	gotoLive,
	pageNow,
	recordAdds,
	recordToastLife,
	seedBag,
	toast,
	toastLife,
	toastLive,
	toastMounted,
	toastTitle,
	untilPageTime
} from './helpers.js';

const DISMISS_MS = 5000;
const RECIPE = '/recipes/wf-muesli-yogurt-parfait';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(recordAdds);
});

/* ---------------------------------------------------------------- placements + source */

const PLACEMENTS = [
	{ name: 'PDP main button', path: '/products/muesli', sel: '[data-wf-add="muesli"][data-wf-qty-input]', source: 'pdp' },
	{ name: '/shop grid card', path: '/shop', sel: '.wf-shop-add[data-wf-add="rolled-oats"]', source: 'card' },
	{ name: 'PDP "Goes well with" card', path: '/products/cornflakes', sel: '.grid-6._2 [data-wf-add]', source: 'goes-with' },
	{ name: 'recipe "Shop the Ingredients" card', path: RECIPE, sel: '.section .grid-6 [data-wf-add="muesli"]', source: 'recipe-ingredients' },
	{ name: 'recipe rail "Add Muesli · ₹250"', path: RECIPE, sel: '.grid-42 .wf-rail-add', source: 'recipe' }
];

for (const p of PLACEMENTS) {
	test(`${p.name} → toast, wf:cart-add source '${p.source}'`, async ({ page, shop }) => {
		await shop.visit(p.path);
		const btn = page.locator(p.sel).first();
		await bringIntoView(btn);
		const slug = await btn.getAttribute('data-wf-add');
		await btn.click();
		await expect(toast(page)).toBeVisible();
		await expect(toastTitle(page)).toHaveText(/^.+ ×1 added to your bag$/);
		await expect(toastLive(page)).toContainText('×1 added to your bag');
		await expect(badge(page)).toHaveText('1');
		expect(await adds(page)).toEqual([expect.objectContaining({ slug, qty: 1, source: p.source })]);
		// Its buttons lead on: Checkout · ₹X (live quote) → /checkout, View bag → /cart.
		await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText(/^Checkout · ₹[\d,]+$/);
		await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveAttribute('href', '/checkout');
		await expect(toast(page).locator('[data-wf-toast-bag]')).toHaveAttribute('href', '/cart');
	});
}

test('the toast Checkout button goes to /checkout, which shows the same total', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	const btn = toast(page).locator('[data-wf-toast-checkout]');
	await expect(btn).toHaveText('Checkout · ₹299'); // 250 + 49 delivery (live settings)
	await btn.click();
	await page.waitForURL((u) => u.pathname === '/checkout');
	await expect(toast(page)).toHaveCount(0);
	await expect(page.locator('#wf-co-summary [data-wf-total]')).toHaveText('₹299');
});

/* ---------------------------------------------------------------- suppression */

test('never on /cart, /checkout or /order (a real order), even for adds made there; /shop still shows it', async ({ page, api, shop }) => {
	// /cart: the top-up adds in place, no toast.
	await seedBag(page, { muesli: 1 });
	await gotoLive(page, '/cart');
	await page.locator('#wf-cart-summary .wf-topup-add').click();
	await expect(badge(page)).toHaveText('2');
	await toastMounted(page); // the toast module has seen the add
	await frames(page);
	await expect(toast(page)).toHaveCount(0);

	// /checkout: the summary's top-up, no toast.
	await shop.visit('/checkout');
	await expect(page.locator('#wf-co-summary')).toBeVisible();
	await page.evaluate(() => window.WefeastoCart.add('cornflakes', 1, { source: 'topup' }));
	await expect(badge(page)).toHaveText('3');
	await toastMounted(page);
	await frames(page);
	await expect(toast(page)).toHaveCount(0);

	// /order of a real COD order.
	const o = await api.placeOrder({ items: { 'steel-cut-oats': 1 }, method: 'cod' });
	await shop.visit(`/order?no=${o.number}&t=${o.token}`);
	await shop.waitOrderView(['confirmed']);
	const before = (await adds(page)).length;
	await page.evaluate(() => window.WefeastoCart.add('muesli', 1, { source: 'pdp' }));
	await expect.poll(async () => (await adds(page)).length).toBe(before + 1);
	await toastMounted(page);
	await frames(page);
	await expect(toast(page)).toHaveCount(0);

	// Positive control: the same add on /shop does show it.
	await shop.visit('/shop');
	await page.locator('.wf-shop-add[data-wf-add="rolled-oats"]').click();
	await expect(toastTitle(page)).toHaveText('Rolled Oats ×1 added to your bag');
});

/* ---------------------------------------------------------------- merge, timers, keyboard, navigation */

test('5 rapid adds → one toast reading ×5, badge 5, five events', async ({ page, shop }) => {
	await shop.visit('/products/cornflakes');
	const add = page.locator('[data-wf-add="cornflakes"][data-wf-qty-input]');
	for (let i = 0; i < 5; i++) await add.click();
	await expect(toast(page)).toHaveCount(1);
	await expect(toastTitle(page)).toHaveText('Cornflakes ×5 added to your bag');
	await expect(badge(page)).toHaveText('5');
	expect((await adds(page)).map((d) => [d.slug, d.qty, d.source])).toEqual(Array(5).fill(['cornflakes', 1, 'pdp']));
	await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText('Checkout · ₹875'); // free delivery
});

test('"+ Add" inside the toast updates it in place (no second toast): exactly one unit, source topup', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect(toast(page).locator('[data-wf-topup]')).toHaveAttribute('data-wf-topup', 'health-mix');
	await toast(page).locator('.wf-topup-add').click();
	await expect(toast(page)).toHaveCount(1);
	await expect(toastTitle(page)).toHaveText('2 items added to your bag');
	await expect(toast(page).locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '100');
	await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText('Checkout · ₹520');
	await expect(badge(page)).toHaveText('2');
	expect((await adds(page)).map((d) => [d.slug, d.qty, d.source])).toEqual([
		['muesli', 1, 'pdp'],
		['health-mix', 1, 'topup']
	]);
});

test('non-modal: while it is open the page scrolls and other Add buttons work (the card merges)', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect(toast(page)).toBeVisible();
	expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
	await expect(page.locator('[aria-modal="true"]:visible')).toHaveCount(0);
	const other = page.locator('.grid-6._2 [data-wf-add]').first();
	await bringIntoView(other);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
	await other.click();
	await expect(toast(page)).toHaveCount(1);
	await expect(toastTitle(page)).toHaveText('2 items added to your bag');
	await expect(badge(page)).toHaveText('2');
});

test('auto-dismisses ~5 s after opening; hover holds it open and leaving restarts the timer', async ({ page, shop }) => {
	test.setTimeout(60_000);
	await page.addInitScript(recordToastLife);
	await shop.visit('/products/muesli?nofx=1');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect(toast(page)).toBeVisible();
	await page.mouse.move(10, 10);
	const opened = (await toastLife(page))[0];
	expect(opened.on).toBe(true);
	await expect(toast(page)).toHaveCount(0, { timeout: 12_000 });
	const closedAt = (await toastLife(page)).at(-1);
	expect(closedAt.on).toBe(false);
	expect(closedAt.t - opened.t).toBeGreaterThanOrEqual(DISMISS_MS - 100);
	expect(closedAt.t - opened.t).toBeLessThan(DISMISS_MS + 3000);

	// Hover: still open well past 5 s; leaving gives a fresh 5 s.
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect(toast(page)).toBeVisible();
	await toast(page).hover();
	const hoveredAt = await pageNow(page);
	await untilPageTime(page, hoveredAt + DISMISS_MS + 1000);
	await expect(toast(page)).toBeVisible();
	await page.mouse.move(10, 10);
	const leftAt = await pageNow(page);
	await expect(toast(page)).toHaveCount(0, { timeout: 12_000 });
	const stayed = (await toastLife(page)).at(-1).t - leftAt;
	expect(stayed).toBeGreaterThanOrEqual(DISMISS_MS - 150);
	expect(stayed).toBeLessThan(DISMISS_MS + 3000);
});

test('Esc closes it when focus is inside and focus goes back to the Add button', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	const add = page.locator('[data-wf-add="muesli"][data-wf-qty-input]');
	await add.focus();
	await page.keyboard.press('Enter');
	await expect(toast(page)).toBeVisible();
	await toast(page).locator('.wf-toast-close').focus();
	await page.keyboard.press('Escape');
	await expect(toast(page)).toHaveCount(0);
	expect(await page.evaluate(() => document.activeElement?.getAttribute('data-wf-add'))).toBe('muesli');
	await expect(toastLive(page)).toHaveText('');
});

test('any navigation closes it and leaves no toast nodes behind (View bag, then a client link)', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect(toast(page)).toBeVisible();
	await toast(page).locator('[data-wf-toast-bag]').click();
	await page.waitForURL((u) => u.pathname === '/cart');
	await expect(page.locator('.wf-toast, [data-wf-toast]')).toHaveCount(0);
	await expect(page.locator('[data-wf-row="muesli"]')).toBeVisible();

	await clientNav(page, '/products/cornflakes');
	await page.locator('[data-wf-add="cornflakes"][data-wf-qty-input]').click();
	await expect(toastTitle(page)).toHaveText('Cornflakes ×1 added to your bag');
	await clientNav(page, '/shop');
	await expect(page.locator('.wf-toast, [data-wf-toast]')).toHaveCount(0);
	await expect(toastLive(page)).toHaveText('');
});

/* ---------------------------------------------------------------- phone layout + colour-mix pill */

test.describe('phone (390px)', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test('full-width card at the bottom; the colour-mix pill hides under it and comes back after', async ({ page, shop }) => {
		await shop.visit('/products/muesli');
		await expect(colorMix(page)).toBeVisible();
		await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').tap();
		await expect(toast(page)).toBeVisible();
		await expect(colorMix(page)).toBeHidden(); // stays mounted (the mix stays applied), just not visible
		await expect(colorMix(page)).toHaveCount(1);
		await page.waitForFunction(() => document.querySelector('[data-wf-toast]').getAnimations().every((a) => a.playState !== 'running'));
		const box = await toast(page).boundingBox();
		expect(Math.round(box.x)).toBe(16);
		expect(Math.round(box.width)).toBe(390 - 32);
		expect(Math.round(844 - (box.y + box.height))).toBeGreaterThanOrEqual(16);
		const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
		expect(o.sw).toBeLessThanOrEqual(o.iw);
		await toast(page).locator('.wf-toast-close').tap();
		await expect(toast(page)).toHaveCount(0);
		await expect(colorMix(page)).toBeVisible();
	});
});

test('desktop (1280px): 360px card bottom-right, the colour-mix pill stays visible beside it', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect(toast(page)).toBeVisible();
	await page.waitForFunction(() => document.querySelector('[data-wf-toast]').getAnimations().every((a) => a.playState !== 'running'));
	const box = await toast(page).boundingBox();
	expect(Math.round(box.width)).toBe(360);
	expect(Math.round(1280 - (box.x + box.width))).toBeLessThanOrEqual(40);
	await expect(colorMix(page)).toBeVisible();
});
