/*
 * Wave 2 polish, in the browser:
 * - MiniProductCard adds carry where they came from (wf:cart-add `source`);
 * - the PDP "Product facts" disclosure shows a caret (W1R3-02);
 * - the recipe rail's add button is not clipped at 992-1099px (W1R3-03);
 * - on phones the colour-mix pill steps aside while the toast is up (W1R3-04);
 * - /recipes (the list) no longer downloads the recipe bodies.
 * /api is stubbed by the helper `test` (404: the snapshot stays in charge).
 */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test, collectErrors, expectNoHorizontalOverflow } from './helpers.js';

const snapshot = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

/** The layout has mounted (the nav badge gets its class or count only then), so clicks reach their handlers. */
const hydrated = (page) =>
	page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});

async function open(page, path) {
	const res = await page.goto(path);
	await hydrated(page);
	return res;
}

/** Record every wf:cart-add detail in window.__adds. */
function recordAdds() {
	window.__adds = [];
	window.addEventListener('wf:cart-add', (e) => window.__adds.push(e.detail));
}
const adds = (page) => page.evaluate(() => window.__adds);

/** Scroll a (possibly not yet revealed .wf-reveal) element into view and wait until it shows. */
async function bringIntoView(locator) {
	await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await expect(locator).toBeVisible();
}

/* ---------------------------------------------------------------- sources */

test.describe('add-to-cart source of the mini product cards', () => {
	test.beforeEach(async ({ page }) => page.addInitScript(recordAdds));

	test('PDP "Goes well with" → goes-with (the main button stays pdp)', async ({ page }) => {
		await open(page, '/products/cornflakes?nofx=1');
		const card = page.locator('.grid-6._2 [data-wf-add]').first();
		const slug = await card.getAttribute('data-wf-add');
		expect(snapshot.products.find((p) => p.slug === 'cornflakes').goesWith).toContain(slug);
		await bringIntoView(card);
		await card.click();
		await expect.poll(() => adds(page)).toEqual([expect.objectContaining({ slug, qty: 1, source: 'goes-with' })]);
		await page.locator('[data-wf-add="cornflakes"][data-wf-qty-input]').click();
		await expect.poll(async () => (await adds(page)).map((d) => d.source)).toEqual(['goes-with', 'pdp']);
	});

	test('recipe "Shop the Ingredients" → recipe-ingredients (the rail stays recipe)', async ({ page }) => {
		await open(page, '/recipes/wf-muesli-yogurt-parfait?nofx=1');
		await page.locator('.grid-42 .wf-rail-add').click();
		const card = page.locator('.section .grid-6 [data-wf-add="muesli"]');
		await bringIntoView(card);
		await card.click();
		await expect.poll(async () => (await adds(page)).map((d) => [d.slug, d.source])).toEqual([
			['muesli', 'recipe'],
			['muesli', 'recipe-ingredients']
		]);
	});

	test('404 page bestsellers (server-rendered error page) → not-found', async ({ page }) => {
		const res = await open(page, '/nope?nofx=1');
		expect(res.status()).toBe(404);
		const card = page.locator('.page-wrapper .grid-6 [data-wf-add]').first();
		const slug = await card.getAttribute('data-wf-add');
		await bringIntoView(card);
		await card.click();
		await expect.poll(() => adds(page)).toEqual([expect.objectContaining({ slug, qty: 1, source: 'not-found' })]);
	});

	test('404 rendered client-side (missing product) → not-found', async ({ page }) => {
		await open(page, '/shop?nofx=1');
		await page.evaluate(() => {
			const a = document.createElement('a');
			a.href = '/products/not-a-cereal';
			a.textContent = 'x';
			document.querySelector('.page-wrapper').appendChild(a);
			a.click();
		});
		await expect(page.getByRole('heading', { level: 1, name: 'This page wandered off.' })).toBeVisible();
		const card = page.locator('.page-wrapper .grid-6 [data-wf-add]').first();
		await bringIntoView(card);
		await card.click();
		await expect.poll(async () => (await adds(page)).map((d) => d.source)).toEqual(['not-found']);
	});

	test('the /shop grid is unchanged: card', async ({ page }) => {
		await open(page, '/shop?nofx=1');
		await page.locator('.wf-shop-add[data-wf-add="rolled-oats"]').click();
		await expect.poll(async () => (await adds(page)).map((d) => d.source)).toEqual(['card']);
	});
});

/* ---------------------------------------------------- product facts caret */

const summary = (page) => page.locator('.wf-facts-summary');
const caret = (page) =>
	summary(page).evaluate((el) => {
		const a = getComputedStyle(el, '::after');
		return { content: a.content, transform: a.transform, display: a.display, duration: a.transitionDuration };
	});
const FLIPPED = 'matrix(-1, 0, 0, -1, 0, 0)'; // rotate(180deg)

test.describe('PDP "Product facts" disclosure caret', () => {
	for (const q of ['', '?nofx=1']) {
		test(`shows a ▾ that flips when open${q ? ' (' + q + ')' : ''}`, async ({ page }) => {
			await open(page, '/products/muesli' + q);
			await bringIntoView(summary(page));
			const closed = await caret(page);
			expect(closed.content).toMatch(/^"▾"/);
			expect(closed.display).toBe('inline-block');
			expect(closed.transform).toBe('none');
			expect(await summary(page).evaluate((el) => getComputedStyle(el).listStyleType)).toBe('none'); // no second (native) marker
			await summary(page).click();
			await expect(page.locator('details.wf-facts')).toHaveAttribute('open', '');
			await expect(page.locator('.wf-facts-list')).toBeVisible();
			await expect.poll(async () => (await caret(page)).transform).toBe(FLIPPED);
			await summary(page).click();
			await expect(page.locator('details.wf-facts')).not.toHaveAttribute('open', '');
			await expect.poll(async () => (await caret(page)).transform).toBe('none');
		});
	}

	test('keyboard: the summary is focusable and Enter toggles it', async ({ page }) => {
		await open(page, '/products/cornflakes?nofx=1');
		await summary(page).focus();
		await expect(summary(page)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.locator('details.wf-facts')).toHaveAttribute('open', '');
		await expect.poll(async () => (await caret(page)).transform).toBe(FLIPPED);
	});

	test('the caret is not read out (alt text "") and the summary text is unchanged', async ({ page }) => {
		await open(page, '/products/muesli?nofx=1');
		expect((await caret(page)).content).toBe('"▾" / ""');
		await expect(summary(page)).toHaveText(/^Product facts: /);
		await expect(summary(page)).toHaveAccessibleName(/^Product facts: [a-z ,]+$/);
	});

	test.describe('reduced motion', () => {
		test.use({ contextOptions: { reducedMotion: 'reduce' } });
		test('the flip is instant', async ({ page }) => {
			await open(page, '/products/muesli');
			expect((await caret(page)).duration).toBe('0s');
		});
	});
});

/* ------------------------------------------------- recipe rail 992-1099px */

const RECIPE = '/recipes/wf-berry-overnight-steel-cut-oats?nofx=1';
/** The rail button, the hero image and the grid's columns. */
const railLayout = (page) =>
	page.evaluate(() => {
		const box = (el) => {
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		};
		const add = document.querySelector('.grid-42 .wf-rail-add');
		const r = box(add);
		// hit-test a few points just inside the button's edges: nothing may cover or clip it
		const pts = [
			[r.left + 3, (r.top + r.bottom) / 2],
			[(r.left + r.right) / 2, (r.top + r.bottom) / 2],
			[r.right - 3, (r.top + r.bottom) / 2]
		];
		const hits = pts.map(([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return !!el && add.contains(el);
		});
		return {
			add: r,
			hits,
			hero: box(document.querySelector('.image-41')),
			columns: getComputedStyle(document.querySelector('.grid-38')).gridTemplateColumns
		};
	});

test.describe('recipe rail add button between 992 and 1099px', () => {
	for (const width of [992, 1024, 1060, 1099]) {
		test(`${width}px: not clipped, no sideways scroll, hero where it was`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await open(page, RECIPE);
			await expectNoHorizontalOverflow(page);
			const now = await railLayout(page);
			expect(now.columns).toBe(`200px ${width - 200}px`);
			expect(now.add.left).toBeGreaterThanOrEqual(0);
			expect(now.add.right).toBeLessThanOrEqual(200);
			expect(now.hits).toEqual([true, true, true]);
			await expect(page.locator('.grid-42 .wf-rail-add')).toHaveText(/^Add .+ · ₹[\d,]+$/);
			expect(now.hero.left).toBeGreaterThan(now.add.right);
			expect(now.hero.right).toBeLessThanOrEqual(width);
			// Webflow's own 200px + 900px columns (what shipped before): the page scrolled
			// sideways (the control), and the hero sat exactly where it sits now
			await page.addStyleTag({ content: '.grid-38 { grid-template-columns: 200px 900px !important; }' });
			const before = await railLayout(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeGreaterThan(width);
			expect(now.hero).toEqual(before.hero);
		});
	}

	for (const width of [991, 1100, 1280]) {
		test(`${width}px: untouched (Webflow's layout)`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await open(page, RECIPE);
			await expectNoHorizontalOverflow(page);
			const { columns, hits } = await railLayout(page);
			if (width <= 991) expect(columns.split(' '), 'stacked: one column').toHaveLength(1);
			else expect(columns).toBe('200px 900px');
			expect(hits).toEqual([true, true, true]);
		});
	}

	test('1024px: adding from the rail still works', async ({ page }) => {
		await page.addInitScript(recordAdds);
		await page.setViewportSize({ width: 1024, height: 800 });
		await open(page, RECIPE);
		await page.locator('.grid-42 .wf-rail-add').click();
		await expect.poll(async () => (await adds(page)).map((d) => [d.slug, d.source])).toEqual([['steel-cut-oats', 'recipe']]);
	});
});

/* ------------------------------------------ colour-mix pill vs the toast */

const pill = (page) => page.locator('.wf-colormix');
const toast = (page) => page.locator('[data-wf-toast]');

for (const width of [360, 390, 479, 767]) {
	test.describe(`colour-mix pill at ${width}px`, () => {
		test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

		for (const q of ['', '?nofx=1']) {
			test(`hidden while the toast is up, back after${q ? ' (' + q + ')' : ''}`, async ({ page }) => {
				await open(page, '/products/muesli' + q);
				await expect(pill(page)).toBeVisible();
				await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').tap();
				await expect(toast(page)).toBeVisible();
				await expect(pill(page)).toBeHidden();
				expect(await pill(page).evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
				await expect(pill(page)).toHaveCount(1); // still mounted: an active mix stays applied
				await toast(page).locator('.wf-toast-close').tap();
				await expect(toast(page)).toHaveCount(0);
				await expect(pill(page)).toBeVisible();
			});
		}
	});
}

for (const width of [768, 1280]) {
	test(`colour-mix pill at ${width}px stays visible beside the toast`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 });
		await open(page, '/products/muesli?nofx=1');
		await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
		await expect(toast(page)).toBeVisible();
		await expect(pill(page)).toBeVisible();
		const p = await pill(page).boundingBox();
		const t = await toast(page).boundingBox();
		expect(p.x + p.width).toBeLessThan(t.x); // side by side, no overlap
	});
}

/* -------------------------------------------- /recipes without the bodies */

/**
 * 40 characters of plain text from each recipe's "Why it works" body (inside
 * one text node: no tags, entities or quotes), which only ships in the
 * recipe-bodies module.
 */
const bodyCanaries = snapshot.recipes.map((r) => {
	const run = r.whyHtml.match(/[A-Za-z][A-Za-z ,]{39,}/);
	return { slug: r.slug, canary: run[0].slice(0, 40) };
});

/** Every JS file the page downloads, with its text. */
function scriptsOf(page) {
	const files = new Map();
	page.on('response', async (r) => {
		if (!/\.js(\?|$)/.test(r.url()) || !r.ok()) return;
		try {
			files.set(r.url(), await r.text());
		} catch {
			/* navigated away */
		}
	});
	return files;
}

test.describe('/recipes (the list page)', () => {
	test('downloads no recipe body; a recipe page does', async ({ page }) => {
		expect(bodyCanaries).toHaveLength(12);
		const js = scriptsOf(page);
		const errors = collectErrors(page);
		await open(page, '/recipes?nofx=1');
		await page.waitForLoadState('networkidle');
		expect(js.size).toBeGreaterThan(5);
		const all = [...js.values()].join('\n');
		for (const { slug, canary } of bodyCanaries) expect(all.includes(canary), `${slug} body shipped to /recipes`).toBe(false);
		// control: open a recipe from the grid (client-side) and its body arrives
		await page.locator('.wf-recipe-item a.wf-card-cover').first().click();
		await page.waitForURL(`**/recipes/${snapshot.recipes[0].slug}`);
		await expect(page.locator('#History .rich-text-block')).toContainText(bodyCanaries[0].canary.trim());
		await expect.poll(() => bodyCanaries.filter(({ canary }) => [...js.values()].some((text) => text.includes(canary))).length).toBe(bodyCanaries.length);
		expect(errors).toEqual([]);
	});

	test('twelve cards in catalog order, with their links, and the filter still works', async ({ page }) => {
		await open(page, '/recipes?nofx=1');
		const items = page.locator('#wf-recipe-grid .wf-recipe-item');
		await expect(items).toHaveCount(snapshot.recipes.length);
		const got = await items.evaluateAll((els) =>
			els.map((el) => ({ href: el.querySelector('a.wf-card-cover').getAttribute('href'), cat: el.getAttribute('data-wf-category'), title: el.querySelector('.heading-11').textContent }))
		);
		expect(got).toEqual(snapshot.recipes.map((r) => ({ href: `/recipes/${r.slug}`, cat: r.category, title: r.title })));
		await page.locator('[data-wf-filter="Kids"]').click();
		const kids = snapshot.recipes.filter((r) => r.category === 'Kids').length;
		await expect(page.locator('#wf-recipe-grid .wf-recipe-item:visible')).toHaveCount(kids);
		await page.locator('[data-wf-filter="All"]').click();
		await expect(page.locator('#wf-recipe-grid .wf-recipe-item:visible')).toHaveCount(snapshot.recipes.length);
	});
});
