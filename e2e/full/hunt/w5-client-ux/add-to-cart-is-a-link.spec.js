/*
 * The purchase's first control, "Add to Cart" (PDP, /shop cards, recipe rails: AddToCart.svelte), is
 * <a href="#"> with a click handler and no role: it adds to the bag, it goes nowhere. Screen readers
 * announce "Add to Cart, link" (WCAG 4.1.2 Name, Role, Value), and Space — how keyboard and switch
 * users press a button — does nothing but scroll the page ~700 px away from the product. Only Enter
 * adds (the link activation), so a keyboard user who presses Space loses their place and adds nothing.
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-client-ux/add-to-cart-is-a-link.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('PDP "Add to Cart" is a button: exposed as one, and Space adds a pack without scrolling away', async ({ page, shop }) => {
	await shop.visit('/products/muesli');
	await expect(page.getByRole('button', { name: 'Add to Cart', exact: true }), 'role: it acts, it does not navigate').toHaveCount(1);
	const add = page.locator('[data-wf-add="muesli"][data-wf-qty-input]');
	await add.focus();
	const before = await page.evaluate(() => scrollY);
	await page.keyboard.press(' ');
	await expect.poll(() => shop.cartCount(), { message: 'Space on the focused button adds one pack', timeout: 3_000 }).toBe(1);
	expect(await page.evaluate(() => scrollY)).toBe(before);
});
