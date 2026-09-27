/*
 * HUNT a11y-motion (sf-core): bag controls that remove or disable themselves drop keyboard
 * focus to <body> (WCAG 2.4.3 Focus Order / 2.1.1). A keyboard or screen-reader user who
 * presses one of these is left nowhere: the next Tab starts from the removed node's
 * position at best, and screen readers announce nothing / jump to the top.
 *
 *   - /cart undo row expires (6 s) while its Undo button has focus (focus was put there
 *     on purpose by removeRow()).
 *   - /cart "+" reaches the per-order cap and turns `disabled` while focused.
 *   - TopUp "+ Add" (cart summary and toast) crosses free delivery → the suggestion row
 *     unmounts with the focused button; "×" on the last suggestion does the same.
 *   - /cart offer chip "×" (Remove offer) unmounts the chip with the focused button.
 *   - "Your usual" (/shop): "Add all" and "×" unmount the card with the focused button.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/bag-focus.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { seedBag, toast } from '../../experience/helpers.js';
import { expectFocusKept, keyboardActivate, seedStorage } from './helpers.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } }); // no row-collapse tween: deterministic timing

test('/cart: the undo row expiring under the keyboard keeps focus on the page', async ({ page, shop }) => {
	await seedBag(page, { muesli: 1, cornflakes: 1 });
	await shop.visit('/cart');
	await keyboardActivate(page.locator('[data-wf-row="muesli"] .wf-cart-remove'));
	const undo = page.locator('[data-wf-undo="muesli"] button');
	await expect(undo).toBeFocused(); // contract: focus lands on Undo
	await expect(page.locator('[data-wf-undo="muesli"]')).toHaveCount(0, { timeout: 10_000 }); // 6 s later
	await expectFocusKept(page, 'undo row expired');
});

test('/cart: "+" reaching the per-order cap keeps focus', async ({ page, shop, api }) => {
	const { products } = (await api.get('store/catalog')).json;
	const max = Math.min(products.find((p) => p.slug === 'muesli').maxPerOrder || 10, 20);
	await seedBag(page, { muesli: max - 1 });
	await shop.visit('/cart');
	const plus = page.locator('[data-wf-row="muesli"] [data-wf-qty-plus]');
	await keyboardActivate(plus);
	await expect(plus).toBeDisabled();
	await expectFocusKept(page, '"+" disabled at the cap');
});

test('/cart: top-up "+ Add" that unlocks free delivery keeps focus', async ({ page, shop }) => {
	await seedBag(page, { cornflakes: 1 }); // ₹175 of ₹499
	await shop.visit('/cart');
	const row = page.locator('#wf-cart-summary .wf-topup');
	await expect(row).toBeVisible();
	for (let i = 0; i < 6 && (await row.count()); i++) {
		await keyboardActivate(row.locator('.wf-topup-add'));
		await page.waitForTimeout(300);
	}
	await expect(row).toHaveCount(0); // free delivery reached: no more suggestion
	await expectFocusKept(page, 'top-up row unmounted after + Add');
});

test('/cart: "×" on the last top-up suggestion keeps focus', async ({ page, shop }) => {
	await seedBag(page, { cornflakes: 1 });
	await shop.visit('/cart');
	const row = page.locator('#wf-cart-summary .wf-topup');
	await expect(row).toBeVisible();
	for (let i = 0; i < 8 && (await row.count()); i++) {
		await keyboardActivate(row.locator('.wf-topup-skip'));
		await page.waitForTimeout(200);
	}
	await expect(row).toHaveCount(0);
	await expectFocusKept(page, 'last top-up suggestion skipped');
});

test('toast: top-up "+ Add" that unlocks free delivery keeps focus inside the toast', async ({ page, shop }) => {
	await shop.visit('/products/cornflakes');
	await page.locator('[data-wf-add="cornflakes"][data-wf-qty-input]').click();
	const row = toast(page).locator('.wf-topup');
	await expect(row).toBeVisible();
	for (let i = 0; i < 6 && (await row.count()); i++) {
		await keyboardActivate(row.locator('.wf-topup-add'));
		await page.waitForTimeout(300);
	}
	await expect(row).toHaveCount(0);
	await expectFocusKept(page, 'toast top-up row unmounted after + Add');
});

test('/cart: "×" on the offer chip keeps focus', async ({ page, shop, admin }) => {
	const c = await admin.createCoupon({ type: 'fixed', value: 5000 });
	await shop.visit(`/cart?add=muesli:1&offer=${c.code}`);
	const chip = page.locator(`[data-wf-offer="${c.code}"]`);
	await expect(chip).toBeVisible();
	await keyboardActivate(chip.locator('.wf-offer-remove'));
	await expect(chip).toHaveCount(0);
	await expectFocusKept(page, 'offer chip removed');
});

test.describe('/shop "Your usual"', () => {
	test.beforeEach(async ({ page }) => {
		await seedStorage(page, { wefeasto_last_order: { no: 'WF-10001', t: 'x', items: { muesli: 1, cornflakes: 1 }, at: Date.now() - 86_400_000 } });
	});

	test('"Add all" keeps focus', async ({ page, shop }) => {
		await shop.visit('/shop');
		await keyboardActivate(page.locator('[data-wf-usual-add]'));
		await expect(page.locator('[data-wf-usual]')).toHaveCount(0); // everything is in the bag now
		await expectFocusKept(page, '"Your usual" unmounted after Add all');
	});

	test('"×" (hide for two weeks) keeps focus', async ({ page, shop }) => {
		await shop.visit('/shop');
		await keyboardActivate(page.locator('.wf-usual-dismiss'));
		await expect(page.locator('[data-wf-usual]')).toHaveCount(0);
		await expectFocusKept(page, '"Your usual" dismissed');
	});
});
