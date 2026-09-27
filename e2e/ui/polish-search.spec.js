/*
 * Search overlay focus (Wave 2 polish): focus lands in the query field with
 * motion (as soon as the panel's tween makes it visible), under ?nofx=1 and
 * under reduced motion (once Svelte has removed `hidden`); Tab and Shift+Tab
 * stay inside the aria-modal dialog; closing hands focus back to whatever
 * opened it; a route change does not.
 */
import { expect } from '@playwright/test';
import { test, blockStorage, collectErrors } from './helpers.js';

const overlay = (page) => page.locator('#wf-search-overlay');
const field = (page) => page.locator('.wf-search-input');
const cards = (page) => page.locator('.wf-search-card');
const navSearch = (page) => page.locator('.navbar .wf-search-open');

/** The layout has mounted (the nav badge gets its class or count only then), so clicks reach their handlers. */
const hydrated = (page) =>
	page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});

async function open(page, path) {
	await page.goto(path);
	await hydrated(page);
}

/** A short description of the focused element: class + href, or '(outside)' when it is not in the overlay. */
const focused = (page) =>
	page.evaluate(() => {
		const a = document.activeElement;
		if (!a || !document.getElementById('wf-search-overlay').contains(a)) return `(outside) ${a ? a.tagName + '.' + a.className : ''}`;
		return a.className.split(' ')[0] + (a.getAttribute('href') ? ' ' + a.getAttribute('href') : '');
	});

/**
 * Wait for the results of what was just typed: with motion the search runs
 * 120ms after the last key (until then the previous list is still up) and
 * the cards fade in staggered. Settled = the same non-empty list for 400ms,
 * every card fully visible.
 */
async function settledResults(page) {
	let last = null;
	let since = 0;
	await expect
		.poll(
			async () => {
				const state = await cards(page).evaluateAll((els) => ({
					hrefs: els.map((el) => el.getAttribute('href')).join(' '),
					shown: els.length > 0 && els.every((el) => getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity === '1')
				}));
				if (state.hrefs !== last) {
					last = state.hrefs;
					since = Date.now();
					return false;
				}
				return state.shown && Date.now() - since >= 400;
			},
			{ intervals: [100], timeout: 10_000 }
		)
		.toBe(true);
	return cards(page).count();
}

/** Click a link to `href` from inside the page, so SvelteKit navigates client-side. */
const clientNav = (page, href) =>
	page.evaluate((h) => {
		const a = document.createElement('a');
		a.href = h;
		a.textContent = 'x';
		document.querySelector('.page-wrapper').appendChild(a);
		a.click();
	}, href);

const VARIANTS = [
	{ name: 'motion', q: '' },
	{ name: 'nofx', q: '?nofx=1' },
	{ name: 'reduced motion', q: '', reduced: true }
];

for (const v of VARIANTS) {
	test.describe(`search focus [${v.name}]`, () => {
		if (v.reduced) test.use({ contextOptions: { reducedMotion: 'reduce' } });

		test('the nav search button puts focus in the field; typing searches', async ({ page }) => {
			const errors = collectErrors(page);
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(overlay(page)).toBeVisible();
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('muesli');
			await expect(field(page)).toHaveValue('muesli');
			await expect(cards(page).first()).toContainText('Muesli');
			expect(errors).toEqual([]);
		});

		test('Esc closes and gives focus back to the nav search button', async ({ page }) => {
			await open(page, '/shop' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(overlay(page)).toBeHidden();
			await expect(navSearch(page)).toBeFocused();
		});

		test('the close button gives focus back too', async ({ page }) => {
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.locator('.wf-search-close').click();
			await expect(overlay(page)).toBeHidden();
			await expect(navSearch(page)).toBeFocused();
		});

		test('keyboard only: Enter on the nav search opens it, Esc comes back', async ({ page }) => {
			await open(page, '/' + v.q);
			await navSearch(page).focus();
			await page.keyboard.press('Enter');
			await expect(field(page)).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(overlay(page)).toBeHidden();
			await expect(navSearch(page)).toBeFocused();
		});

		test('Tab and Shift+Tab stay inside the dialog: field → close → results → field', async ({ page }) => {
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('oat');
			await expect(field(page)).toHaveValue('oat');
			const n = await settledResults(page);
			expect(n).toBeGreaterThanOrEqual(3);
			for (const name of await page.locator('.wf-search-card-name').allTextContents()) expect(name).toMatch(/oat/i); // the "oat" results, not the previous list
			const hrefs = await cards(page).evaluateAll((els) => els.map((el) => el.getAttribute('href')));
			const seen = [];
			for (let i = 0; i < n + 3; i++) {
				await page.keyboard.press('Tab');
				seen.push(await focused(page));
			}
			expect(seen).toEqual([
				'wf-search-close',
				...hrefs.map((h) => 'wf-search-card ' + h),
				'wf-search-input',
				'wf-search-close'
			]);
			// and backwards: from the field round to the last result
			await field(page).focus();
			await page.keyboard.press('Shift+Tab');
			expect(await focused(page)).toBe('wf-search-card ' + hrefs.at(-1));
			await page.keyboard.press('Shift+Tab');
			expect(await focused(page)).toBe('wf-search-card ' + hrefs.at(-2));
		});

		test('Tab with no results cycles between the field and the close button', async ({ page }) => {
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('zzzzqx');
			await expect(page.locator('.wf-search-empty')).toBeVisible();
			const seen = [];
			for (let i = 0; i < 4; i++) {
				await page.keyboard.press('Tab');
				seen.push(await focused(page));
			}
			expect(seen).toEqual(['wf-search-close', 'wf-search-input', 'wf-search-close', 'wf-search-input']);
			await page.keyboard.press('Shift+Tab');
			expect(await focused(page)).toBe('wf-search-close');
		});

		test('focus moved behind the open overlay by a script comes back into it', async ({ page }) => {
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.evaluate(() => document.querySelector('.nav-menu a[href="/shop"]').focus());
			await expect(field(page)).toBeFocused();
		});

		test('picking a result navigates; focus is not pulled back to the nav button', async ({ page }) => {
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.type('muesli');
			await settledResults(page);
			await cards(page).filter({ hasText: 'Muesli' }).first().click();
			await page.waitForURL(/\/(products|recipes)\//);
			await expect(overlay(page)).toBeHidden();
			await expect(field(page)).toHaveValue(''); // a fresh page: the query is cleared
			await expect(navSearch(page)).not.toBeFocused();
			// and it opens (and focuses) again on the new page
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
		});

		test('the 404 page’s "Search Wefeasto" button gets focus back on close', async ({ page }) => {
			await page.goto('/nope' + v.q);
			await hydrated(page);
			const button = page.getByRole('button', { name: 'Search Wefeasto' });
			await button.click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(overlay(page)).toBeHidden();
			await expect(button).toBeFocused();
		});

		test('works when localStorage throws', async ({ page }) => {
			await page.addInitScript(blockStorage);
			const errors = collectErrors(page);
			await open(page, '/' + v.q);
			await navSearch(page).click();
			await expect(field(page)).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(navSearch(page)).toBeFocused();
			expect(errors).toEqual([]);
		});
	});
}

test.describe('search focus [motion only]', () => {
	test('Esc before the panel shows: nothing steals focus afterwards', async ({ page }) => {
		await open(page, '/');
		await navSearch(page).focus();
		await page.keyboard.press('Enter');
		await page.keyboard.press('Escape'); // well inside the 150ms before the panel's tween starts
		await expect(overlay(page)).toBeHidden();
		await page.waitForTimeout(1000); // longer than the whole open timeline
		await expect(navSearch(page)).toBeFocused();
		await expect(field(page)).not.toBeFocused();
	});

	test('reopening right after closing still focuses the field', async ({ page }) => {
		await open(page, '/');
		await navSearch(page).click();
		await expect(field(page)).toBeFocused();
		await page.keyboard.press('Escape');
		await page.keyboard.press('Enter'); // focus is back on the nav button: reopen at once, mid fade-out
		await expect(overlay(page)).toBeVisible();
		await expect(field(page)).toBeFocused();
		await expect.poll(() => overlay(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
	});

	test('after an animated session, a client navigation to ?nofx=1 still shows the overlay (no leftover opacity)', async ({ page }) => {
		await open(page, '/');
		await navSearch(page).click();
		await expect(field(page)).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(overlay(page)).toBeHidden();
		await clientNav(page, '/shop?nofx=1');
		await page.waitForURL('**/shop?nofx=1');
		await navSearch(page).click();
		await expect(overlay(page)).toBeVisible();
		const style = await overlay(page).evaluate((el) => {
			const inner = el.querySelector('.wf-search-inner');
			return [getComputedStyle(el).opacity, getComputedStyle(el).visibility, getComputedStyle(inner).opacity, getComputedStyle(inner).visibility];
		});
		expect(style).toEqual(['1', 'visible', '1', 'visible']);
		await expect(field(page)).toBeFocused();
	});
});

test.describe('search focus on a phone', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	for (const q of ['', '?nofx=1']) {
		test(`tapping search focuses the field${q ? ' (' + q + ')' : ''}`, async ({ page }) => {
			await open(page, '/' + q);
			await navSearch(page).tap();
			await expect(field(page)).toBeFocused();
			await page.locator('.wf-search-close').tap();
			await expect(overlay(page)).toBeHidden();
		});
	}
});
