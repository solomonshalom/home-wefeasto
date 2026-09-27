/*
 * Product and recipe pages on the real stack:
 * - M7 "Product facts" <details> (after the partners dropdown, closed, only the facts that
 *   exist, ▾ caret that flips, works without JS) for every product the CMS sells;
 * - S7 "Buying here" perks line directly above the partners dropdown, whose threshold and
 *   COD claim agree with the live server settings;
 * - S10 recipe rail "Add Muesli · ₹250" at 992 / 1024 / 1280 px (and a phone): fully
 *   visible, no sideways scroll, and a click adds with source 'recipe'.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/pdp-recipe.spec.js
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '../fixtures.js';
import { adds, expectNoHorizontalOverflow, formatPaise, liveCatalog, recordAdds, toast, toastTitle } from './helpers.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));
const LABELS = [
	['netQuantity', 'Net quantity', 'net quantity'],
	['ingredients', 'Ingredients', 'ingredients'],
	['allergens', 'Allergens', 'allergens'],
	['bestBefore', 'Best before', 'best before'],
	['manufacturer', 'Manufacturer / packer', 'manufacturer'],
	['countryOfOrigin', 'Country of origin', 'country of origin']
];
/** [label, short, value] for every fact the build snapshot fills in, in display order. */
const factsOf = (slug) => {
	const f = SNAPSHOT.products.find((p) => p.slug === slug)?.facts || {};
	const val = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).join(', ') : typeof v === 'string' ? v.trim() : '');
	return LABELS.map(([k, label, short]) => [label, short, val(f[k])]).filter(([, , v]) => v);
};
const RECIPE = '/recipes/wf-muesli-yogurt-parfait';

test.describe('PDP product facts (M7)', () => {
	test('every product the CMS sells: a closed <details> after the partners dropdown with exactly its facts', async ({ page, api, shop }) => {
		const live = await liveCatalog(api);
		expect(live.products.length).toBeGreaterThan(0);
		for (const { slug } of live.products) {
			await shop.visit(`/products/${slug}`);
			const facts = factsOf(slug);
			const details = page.locator('details.wf-facts');
			if (!facts.length) {
				await expect(details, `${slug}: no facts → no element`).toHaveCount(0);
				continue;
			}
			await expect(details).toHaveCount(1);
			expect(await details.evaluate((el) => el.open)).toBe(false);
			// Right after the partners dropdown, so the Add row does not move.
			expect(await details.evaluate((el) => el.previousElementSibling?.classList.contains('wf-partners'))).toBe(true);
			await expect(details.locator('summary')).toHaveText(`Product facts: ${facts.map(([, s]) => s).join(', ')}`);
			const rows = await details.locator('.wf-facts-row').evaluateAll((els) => els.map((e) => [e.querySelector('dt').textContent.trim(), e.querySelector('dd').textContent.trim()]));
			expect(rows, slug).toEqual(facts.map(([l, , v]) => [l, v]));
		}
	});

	for (const q of ['', '?nofx=1']) {
		test(`the ▾ caret is silent for screen readers and flips when opened; Enter toggles it${q ? ' (' + q + ')' : ''}`, async ({ page, shop }) => {
			await shop.visit('/products/muesli' + q);
			const summary = page.locator('details.wf-facts > summary');
			const caret = () => summary.evaluate((el) => {
				const s = getComputedStyle(el, '::after');
				return { content: s.content, transform: s.transform };
			});
			const closed = await caret();
			expect(closed.content).toMatch(/^"▾"\s*\/\s*""$/);
			expect(closed.transform === 'none' || closed.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
			await summary.focus();
			await page.keyboard.press('Enter');
			await expect(page.locator('details.wf-facts')).toHaveAttribute('open', '');
			await expect(page.locator('details.wf-facts dl')).toBeVisible();
			await expect.poll(async () => (await caret()).transform).toBe('matrix(-1, 0, 0, -1, 0, 0)');
			await page.keyboard.press('Enter');
			await expect(page.locator('details.wf-facts')).not.toHaveAttribute('open', '');
		});
	}

	test('opens without JavaScript (native <details>)', async ({ newContext, stack }) => {
		const ctx = await newContext({ javaScriptEnabled: false });
		const p = await ctx.newPage();
		await p.goto(stack.sfUrl + '/products/muesli');
		await p.locator('details.wf-facts > summary').click();
		await expect(p.locator('details.wf-facts dl')).toBeVisible();
		await expect(p.locator('details.wf-facts dd').first()).toHaveText('400 g');
	});
});

test.describe('PDP perks line (S7)', () => {
	test('directly above the partners dropdown on every PDP; threshold and COD agree with the live settings', async ({ page, api, shop }) => {
		const live = await liveCatalog(api);
		for (const p of live.products) {
			await shop.visit(`/products/${p.slug}`);
			const perks = page.locator('p.wf-perks[data-wf-perks]');
			await expect(perks).toHaveCount(1);
			expect(await perks.evaluate((el) => el.nextElementSibling?.classList.contains('wf-partners'))).toBe(true);
			const parts = [
				live.settings.deliveryFeePaise === 0 ? 'free delivery' : `free delivery over ${formatPaise(live.settings.freeDeliveryThresholdPaise)}`,
				...(live.settings.codEnabled && p.codAllowed ? ['COD available'] : []),
				'fresh from our kitchen'
			];
			await expect(perks, p.slug).toHaveText(`Buying here: ${parts.join(' · ')}`);
		}
	});
});

test.describe('recipe rail "Add" (S10)', () => {
	for (const width of [992, 1024, 1280]) {
		test(`${width}px: fully visible, no sideways scroll, adds Muesli with source 'recipe'`, async ({ page, shop }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.addInitScript(recordAdds);
			await shop.visit(RECIPE);
			const rail = page.locator('.grid-42 .wf-rail-add');
			await expect(rail).toHaveText('Add Muesli · ₹250');
			await rail.scrollIntoViewIfNeeded();
			const box = await rail.boundingBox();
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(width);
			// Not clipped by an ancestor: the centre of the button is the button.
			expect(await rail.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return !!hit && (hit === el || el.contains(hit));
			})).toBe(true);
			await expectNoHorizontalOverflow(page);
			await rail.click();
			await expect(toastTitle(page)).toHaveText('Muesli ×1 added to your bag');
			expect(await adds(page)).toEqual([expect.objectContaining({ slug: 'muesli', qty: 1, source: 'recipe' })]);
			await expectNoHorizontalOverflow(page);
		});
	}

	test('phone (390px): static, first thing under the rail links, no sideways scroll', async ({ page, shop }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await shop.visit(RECIPE);
		const rail = page.locator('.grid-42 .wf-rail-add');
		await expect(rail).toBeAttached();
		expect(await rail.evaluate((el) => getComputedStyle(el.closest('.div-block-183') || el).position)).not.toBe('sticky');
		await expectNoHorizontalOverflow(page);
		await expect(toast(page)).toHaveCount(0);
	});
});
