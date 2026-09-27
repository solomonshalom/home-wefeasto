/*
 * Mobile nav (<= 991px): hamburger in Nav.svelte + MobileNav sheet.
 * Desktop must stay exactly as before.
 */
import { expect } from '@playwright/test';
import { test, blockStorage, collectErrors, expectNoHorizontalOverflow } from './helpers.js';

const burger = (page) => page.locator('#wf-menu-btn');
const sheet = (page) => page.getByRole('dialog', { name: 'Menu' });
const inSheet = (page) =>
	page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.wf-mnav'));

/**
 * Open via a real click inside one page task and report the sheet's intro
 * animation (Svelte transitions run on the Web Animations API), so the result
 * doesn't depend on how fast the test runner gets back to the page.
 */
const clickAndInspectIntro = (page) =>
	page.evaluate(async () => {
		document.getElementById('wf-menu-btn').click();
		let sheetEl = null;
		for (let i = 0; i < 5 && !sheetEl; i++) {
			await Promise.resolve(); // Svelte flushes in a microtask
			sheetEl = document.querySelector('.wf-mnav');
		}
		// Svelte 5 plays a zero-length "delay" animation before the real one,
		// so watch a few frames and keep the longest animation seen.
		let running = 0;
		let duration = 0;
		for (let f = 0; f < 4 && sheetEl; f++) {
			for (const a of sheetEl.getAnimations()) {
				if (a.playState === 'running' || a.pending) running++;
				duration = Math.max(duration, Number(a.effect.getTiming().duration) || 0);
			}
			await new Promise((r) => requestAnimationFrame(() => r()));
		}
		return { present: !!sheetEl, running, duration };
	});

/**
 * Hydrated: the nav badge only gets its wf-is-hidden class (empty bag) or its
 * count once the layout's components have mounted — the hamburger's click and
 * key handlers are attached by then. Before that, the prerendered button is
 * visible (CSS) but inert, so a click or Enter would be lost.
 */
async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

async function openMenu(page) {
	await hydrated(page);
	await burger(page).click();
	await expect(sheet(page)).toBeVisible();
	await expect(burger(page)).toHaveAttribute('aria-expanded', 'true');
}

test.describe('desktop (> 991px) is unchanged', () => {
	for (const width of [1280, 992]) {
		test(`no hamburger at ${width}px; nav links and icons as before`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await page.goto('/');
			await expect(burger(page)).toBeHidden();
			await expect(page.locator('.wf-menu-sep')).toBeHidden();
			await expect(page.locator('.nav-menu')).toBeVisible();
			for (const name of ['Shop', 'Recipes', 'Our Story', 'Contact']) {
				await expect(page.locator('.nav-menu').getByRole('link', { name, exact: true })).toBeVisible();
			}
			// the bag icon is still the last thing in the icon row, flush right
			const geo = await page.evaluate(() => {
				const row = document.querySelector('.grid-8').getBoundingClientRect();
				const bag = document.querySelector('.wf-cart-anchor').getBoundingClientRect();
				const visible = [...document.querySelector('.grid-8').children].filter(
					(el) => getComputedStyle(el).display !== 'none'
				).length;
				return { rowRight: Math.round(row.right), bagRight: Math.round(bag.right), visible, bagW: bag.width };
			});
			expect(geo.bagRight).toBe(geo.rowRight);
			expect(geo.visible).toBe(7); // nav + 3 separators + 3 icons, as in the original
			expect(geo.bagW).toBe(70);
		});
	}

	test('prerendered markup: button is closed, controls the (empty) host', async ({ request }) => {
		const html = await (await request.get('/shop')).text();
		expect(html).toMatch(/<button type="button" id="wf-menu-btn" class="link-block-3 wf-menu-btn" aria-label="Menu" aria-expanded="false" aria-controls="wf-mobile-nav">/);
		// empty apart from Svelte's hydration markers
		expect(html).toMatch(/<div id="wf-mobile-nav" class="wf-mnav-host">(<!--[^>]*-->)*<\/div>/);
	});
});

test('the icon row with the hamburger fits at every width from 320 to 991px', async ({ page }) => {
	// /shop, not /: the home hero overflows at 480-749px on its own (it did before the menu).
	// 480-509px used to overflow: 24px padding + Webflow's fixed 200px brand box + 4 x 70px icons.
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto('/shop');
	for (const width of [320, 360, 390, 479, 480, 495, 509, 510, 560, 640, 767, 768, 991]) {
		await page.setViewportSize({ width, height: 800 });
		const geo = await page.evaluate(() => {
			const r = (s) => document.querySelector(s).getBoundingClientRect();
			return { iw: window.innerWidth, row: r('.grid-8').right, burger: r('#wf-menu-btn').right, logo: r('.wf-brand-logo').right, rowLeft: r('.grid-8').left };
		});
		expect(geo.burger, `${width}px: hamburger on screen`).toBeLessThanOrEqual(geo.iw);
		expect(geo.burger, `${width}px: hamburger is the last icon`).toBe(geo.row);
		expect(geo.logo, `${width}px: logo clear of the icons`).toBeLessThan(geo.rowLeft);
		await expectNoHorizontalOverflow(page);
	}
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('hamburger shows at <= 991px, links hidden', async ({ page }) => {
		for (const width of [991, 768, 390, 360]) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto('/');
			await expect(burger(page)).toBeVisible();
			await expect(page.locator('.nav-menu')).toBeHidden();
			await expectNoHorizontalOverflow(page);
		}
	});

	test('opens and closes; focus moves in and returns; scroll locked while open', async ({ page }) => {
		const errors = collectErrors(page);
		await page.goto('/');
		await expect(sheet(page)).toHaveCount(0);
		await openMenu(page);
		await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
		expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(true);
		expect(await page.evaluate(() => document.documentElement.classList.contains('lenis-stopped'))).toBe(true);
		await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
		await expect(sheet(page)).toHaveAttribute('data-lenis-prevent', '');
		// full width on a phone once the slide has settled
		await expect.poll(async () => (await sheet(page).boundingBox()).x).toBe(0);
		expect((await sheet(page).boundingBox()).width).toBe(390);

		for (const [name, href] of [
			['Shop', '/shop'],
			['Recipes', '/recipes'],
			['Our Story', '/#about'],
			['Contact', '/#contact'],
			['Account', '/login'],
			['Bag', '/cart']
		]) {
			await expect(sheet(page).getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
		}

		await page.getByRole('button', { name: 'Close menu' }).click();
		await expect(sheet(page)).toHaveCount(0);
		await expect(burger(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(burger(page)).toBeFocused();
		expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
		expect(await page.evaluate(() => document.documentElement.classList.contains('lenis-stopped'))).toBe(false);
		expect(errors).toEqual([]);
	});

	test('Esc closes and returns focus to the hamburger', async ({ page }) => {
		await page.goto('/shop');
		await hydrated(page); // Enter on the not-yet-hydrated button would do nothing
		await burger(page).focus();
		await page.keyboard.press('Enter');
		await expect(sheet(page)).toBeVisible();
		expect(await inSheet(page)).toBe(true);
		await page.keyboard.press('Tab');
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toHaveCount(0);
		await expect(burger(page)).toBeFocused();
		await expect(burger(page)).toHaveAttribute('aria-expanded', 'false');
	});

	test('traps focus: Tab and Shift+Tab cycle inside the sheet', async ({ page }) => {
		await page.goto('/');
		await openMenu(page);
		const count = await sheet(page).locator('a[href], button').count();
		expect(count).toBe(7); // close + 4 links + Account + Bag
		const seen = new Set();
		for (let i = 0; i < count * 2 + 1; i++) {
			await page.keyboard.press('Tab');
			expect(await inSheet(page)).toBe(true);
			seen.add(await page.evaluate(() => document.activeElement.textContent.trim() || document.activeElement.getAttribute('aria-label')));
		}
		expect(seen.size).toBe(count); // every control reachable
		// Shift+Tab from the first control wraps to the last (Bag)
		await page.getByRole('button', { name: 'Close menu' }).focus();
		await page.keyboard.press('Shift+Tab');
		await expect(sheet(page).getByRole('link', { name: 'Bag', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
	});

	test('a link navigates and closes the sheet', async ({ page }) => {
		await page.goto('/');
		await openMenu(page);
		await sheet(page).getByRole('link', { name: 'Shop', exact: true }).click();
		await page.waitForURL('**/shop');
		await expect(sheet(page)).toHaveCount(0);
		await expect(burger(page)).toHaveAttribute('aria-expanded', 'false');
		expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
		// current page is marked
		await openMenu(page);
		await expect(sheet(page).getByRole('link', { name: 'Shop', exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(sheet(page).getByRole('link', { name: 'Recipes', exact: true })).not.toHaveAttribute('aria-current', 'page');
	});

	test('a same-page hash link closes the sheet and scrolls', async ({ page }) => {
		await page.goto('/');
		await openMenu(page);
		await sheet(page).getByRole('link', { name: 'Contact', exact: true }).click();
		await expect(sheet(page)).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
		expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
	});

	test('browser back closes the sheet', async ({ page }) => {
		await page.goto('/');
		await page.locator('.footer-section a[href="/recipes"]').click();
		await page.waitForURL('**/recipes');
		await openMenu(page);
		await page.goBack();
		await page.waitForURL((u) => u.pathname === '/');
		await expect(sheet(page)).toHaveCount(0);
	});

	test('backdrop click closes', async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 900 }); // sheet 380px, backdrop visible
		await page.goto('/');
		await openMenu(page);
		await page.mouse.click(100, 400);
		await expect(sheet(page)).toHaveCount(0);
		await expect(burger(page)).toBeFocused();
	});

	test('bag shows the item count', async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ cornflakes: 2, muesli: 1 })));
		await page.goto('/');
		await openMenu(page);
		const bag = sheet(page).getByRole('link', { name: 'Bag, 3 items' });
		await expect(bag).toBeVisible();
		await expect(bag.locator('.wf-mnav-count')).toHaveText('3');
	});

	test('empty bag shows no count', async ({ page }) => {
		await page.goto('/');
		await openMenu(page);
		await expect(sheet(page).getByRole('link', { name: 'Bag', exact: true })).toBeVisible();
		await expect(sheet(page).locator('.wf-mnav-count')).toHaveCount(0);
	});

	test('growing past 991px closes it', async ({ page }) => {
		await page.goto('/');
		await openMenu(page);
		await page.setViewportSize({ width: 1200, height: 844 });
		await expect(sheet(page)).toHaveCount(0);
		expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
	});

	test('slides in with motion', async ({ page }) => {
		await page.goto('/');
		await expect(burger(page)).toBeVisible();
		await hydrated(page);
		const intro = await clickAndInspectIntro(page);
		expect(intro.present).toBe(true);
		expect(intro.running).toBeGreaterThan(0); // mid-slide
		expect(intro.duration).toBe(200); // bublr panel timing
		await expect.poll(() => page.locator('.wf-mnav').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
	});

	test('no slide with ?nofx=1', async ({ page }) => {
		await page.goto('/?nofx=1');
		await expect(burger(page)).toBeVisible();
		await hydrated(page);
		const intro = await clickAndInspectIntro(page);
		expect(intro).toEqual({ present: true, running: 0, duration: 0 });
		expect(await page.locator('.wf-mnav').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toHaveCount(0); // closes instantly too
	});

	test('works when localStorage throws', async ({ page }) => {
		await page.addInitScript(blockStorage);
		const errors = collectErrors(page);
		await page.goto('/');
		await openMenu(page);
		await expect(sheet(page).locator('.wf-mnav-count')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toHaveCount(0);
		expect(errors).toEqual([]);
	});
});

test.describe('phone, reduced motion', () => {
	test.use({ viewport: { width: 390, height: 844 }, contextOptions: { reducedMotion: 'reduce' } });

	test('appears without sliding', async ({ page }) => {
		await page.goto('/');
		expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
		await expect(burger(page)).toBeVisible();
		await hydrated(page);
		const intro = await clickAndInspectIntro(page);
		expect(intro).toEqual({ present: true, running: 0, duration: 0 });
		expect(await page.locator('.wf-mnav').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
		await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
	});
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });

	test('no dead hamburger; the footer still carries every link', async ({ page }) => {
		await page.goto('/');
		await expect(burger(page)).toBeHidden();
		for (const href of ['/shop', '/recipes', '/cart', '/login', '/#about', '/#contact']) {
			await expect(page.locator(`.footer-section a[href="${href}"]`)).toHaveCount(1);
		}
	});
});
