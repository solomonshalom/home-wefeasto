/*
 * M9 PeepWalk crowd and the colour-mix pill (M8) on the real stack:
 * - the layout strip draws a non-blank crowd above the footer on the shopping pages, runs
 *   exactly one ticker loop while visible and does no work while scrolled off-screen;
 * - under ?nofx=1 and prefers-reduced-motion it is one still frame (two screenshots
 *   500 ms apart are identical);
 * - it is absent on /checkout, /login and /order, and /order (a real order) shows its
 *   own celebration crowd instead (bublr's 350px crowd);
 * - the colour-mix pill is hidden on /cart, /checkout and /order (the mix stays applied)
 *   and toggling it never tints the crowd (bublr's original ink-on-white sprites).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/peepwalk-colormix.spec.js
 */
import { test, expect } from '../fixtures.js';
import {
	alphaSum,
	colorMix,
	drawsDuring,
	fillColour,
	instrumentPeeps,
	peepLoops,
	scrollToStrip,
	scrollToTop,
	seedBag,
	strip,
	waitHydrated
} from './helpers.js';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(instrumentPeeps);
});

/** A confirmed COD order and its /order URL. */
async function confirmedOrderUrl(api) {
	const o = await api.placeOrder({ items: { 'steel-cut-oats': 1 }, method: 'cod' });
	expect(o.number).toMatch(/^WF-\d+$/);
	return `/order?no=${o.number}&t=${o.token}`;
}

/* ---------------------------------------------------------------- layout strip */

for (const path of ['/', '/shop', '/products/muesli', '/recipes', '/recipes/wf-muesli-yogurt-parfait', '/cart', '/terms', '/privacy']) {
	test(`${path}: a non-blank crowd above the footer, one loop while visible, none off-screen`, async ({ page, shop }) => {
		await shop.visit(path);
		await expect(strip(page)).toHaveCount(1);
		// Directly above the footer: the footer's top border is the crowd's ground.
		expect(await strip(page).evaluate((el) => {
			const footer = document.querySelector('.footer-section');
			return !!footer && !!(el.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING);
		})).toBe(true);
		await expect(strip(page)).toHaveAttribute('aria-hidden', 'true');
		await scrollToStrip(page);
		await expect(strip(page)).toHaveAttribute('data-mode', 'live');
		expect(await alphaSum(page)).toBeGreaterThan(0);
		await expect.poll(() => peepLoops(page)).toBe(1);
		await scrollToTop(page);
		// Short pages (the empty bag) show the crowd in the first viewport: then it keeps walking.
		const top = await strip(page).evaluate((el) => el.getBoundingClientRect().top - window.innerHeight);
		if (top > 300) {
			await expect.poll(() => peepLoops(page)).toBe(0);
			expect(await drawsDuring(page, 800)).toBe(0); // paused off-screen
		} else if (top < 0) {
			await expect.poll(() => peepLoops(page)).toBe(1);
		}
	});
}

test.describe('still frame without motion', () => {
	async function expectStill(page) {
		await scrollToStrip(page);
		await expect(strip(page)).toHaveAttribute('data-mode', 'still');
		expect(await alphaSum(page)).toBeGreaterThan(0);
		expect(await peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 600)).toBe(0);
		const a = await strip(page).screenshot();
		await page.waitForTimeout(500); // the check itself: nothing may change within 500 ms
		const b = await strip(page).screenshot();
		expect(Buffer.compare(a, b)).toBe(0);
	}

	test('?nofx=1 (home)', async ({ page, shop }) => {
		await shop.visit('/?nofx=1');
		await expectStill(page);
	});

	test.describe('prefers-reduced-motion', () => {
		test.use({ contextOptions: { reducedMotion: 'reduce' } });
		test('/shop', async ({ page, shop }) => {
			await shop.visit('/shop');
			await expectStill(page);
		});
	});

	test('control: the live strip does change within 500 ms', async ({ page, shop }) => {
		await shop.visit('/');
		await scrollToStrip(page);
		const a = await strip(page).screenshot();
		await page.waitForTimeout(500);
		const b = await strip(page).screenshot();
		expect(Buffer.compare(a, b)).not.toBe(0);
	});
});

test.describe('task pages', () => {
	for (const path of ['/checkout', '/login']) {
		test(`absent on ${path}`, async ({ page, shop }) => {
			await seedBag(page, { muesli: 1 });
			await shop.visit(path);
			await expect(page.locator('.footer-section')).toHaveCount(1);
			await expect(strip(page)).toHaveCount(0);
			expect(await drawsDuring(page, 300)).toBe(0);
		});
	}

	test("/order (a real confirmed order): no layout strip, its own bublr-size (350px) celebration crowd instead", async ({ page, shop, api }) => {
		await shop.visit(await confirmedOrderUrl(api));
		await shop.waitOrderView(['confirmed']);
		const crowd = page.locator('canvas.wf-peepwalk');
		await expect(crowd).toHaveCount(1);
		await expect(crowd).toHaveClass(/wf-order-peeps/);
		expect(Math.round((await crowd.boundingBox()).height)).toBe(350);
		await crowd.scrollIntoViewIfNeeded();
		await expect(crowd).toHaveAttribute('data-ready', '', { timeout: 10_000 });
		expect(await alphaSum(page)).toBeGreaterThan(0);
		await expect.poll(() => peepLoops(page)).toBe(1);
	});

	test('leaving a crowd page for /login and back: back to one loop, nothing drawing meanwhile', async ({ page, shop }) => {
		await shop.visit('/');
		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1);
		await page.locator('.footer-section a[href="/login"]').click();
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(strip(page)).toHaveCount(0);
		await expect.poll(() => peepLoops(page)).toBe(0);
		expect(await drawsDuring(page, 500)).toBe(0);
		await page.locator('a.brand').click();
		await page.waitForURL((u) => u.pathname === '/');
		await waitHydrated(page);
		await scrollToStrip(page);
		await expect.poll(() => peepLoops(page)).toBe(1);
	});
});

/* ---------------------------------------------------------------- colour mix */

test.describe('colour-mix pill (M8)', () => {
	test('hidden on /cart, /checkout and /order; shown on /, /shop; an active mix stays applied where it is hidden', async ({ page, shop, api }) => {
		await seedBag(page, { muesli: 1 });
		await shop.visit('/shop');
		await expect(colorMix(page)).toBeVisible();
		await colorMix(page).click();
		await expect(colorMix(page)).toHaveAttribute('aria-checked', 'true');
		const mappedYellow = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_colormix')).map['#ffc33a']);
		expect(mappedYellow).toMatch(/^#[0-9a-f]{6}$/);

		for (const path of ['/cart', '/checkout', await confirmedOrderUrl(api)]) {
			await shop.visit(path);
			await expect(colorMix(page), path).toHaveCount(0);
		}
		// The mix is still on: the bag's meter fill (palette #ffc33a) is remapped.
		await shop.visit('/cart');
		const fill = page.locator('#wf-cart-summary [data-wf-meter-fill]');
		await expect(fill).toBeVisible();
		await expect.poll(() => fill.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 195, 58)');

		await shop.visit('/');
		await expect(colorMix(page)).toBeVisible();
		await expect(colorMix(page)).toHaveAttribute('aria-checked', 'true');
	});

	test("toggling the mix never tints the crowd: bublr's original ink-on-white sprites", async ({ page, shop }) => {
		await shop.visit('/');
		await scrollToStrip(page);
		await expect.poll(async () => (await fillColour(page))?.[3] || 0).toBeGreaterThan(100);
		expect((await fillColour(page)).slice(0, 3).every((v) => v >= 250)).toBe(true);
		await colorMix(page).click();
		await expect.poll(() => page.evaluate(() => !!document.getElementById('wf-colormix-style'))).toBe(true);
		await page.waitForTimeout(400);
		expect((await fillColour(page)).slice(0, 3).every((v) => v >= 250)).toBe(true);
		await colorMix(page).click();
	});
});
