/*
 * HUNT a11y-motion (sf-checkout): on /checkout, the controls that fix the order remove
 * themselves and drop keyboard focus to <body> (WCAG 2.4.3 Focus Order).
 *
 *   - a line the server refuses (QTY_LIMIT / OUT_OF_STOCK) shows "Reduce to N" and
 *     "Remove" in the summary; either one makes the issue (and the button) disappear;
 *   - the offer chip's "×" (Remove offer) unmounts the chip with the focused button.
 *
 * After each, document.activeElement is <body>: a keyboard user's next Tab starts again
 * from the site logo, a screen-reader user hears nothing, and the Pay button that just
 * became usable is 40+ Tab stops away. The same controls on /cart were fixed for the
 * round-2 bag-focus finding ($lib/focus.js keepFocus); /checkout never got it, and its
 * own "Not you? Forget me" already does the right thing (focus → Full Name).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/checkout-fix-focus.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { expectFocusKept, keyboardActivate } from './helpers.js';

/** A bag whose cornflakes line is over a per-order limit lowered in the CMS. */
async function checkoutWithQtyIssue(page, shop, admin) {
	await admin.updateProduct('cornflakes', { maxPerOrder: 2 });
	await shop.setCart({ cornflakes: 3, muesli: 1 });
	await shop.gotoCheckout();
	const issue = page.locator('[data-wf-co-issue="QTY_LIMIT"][data-wf-co-line="cornflakes"]');
	await expect(issue).toBeVisible({ timeout: 15_000 });
	return issue;
}

test('/checkout "Reduce to 2" keeps keyboard focus on the page', async ({ page, shop, admin }) => {
	const issue = await checkoutWithQtyIssue(page, shop, admin);
	await keyboardActivate(issue.locator('[data-wf-reduce="cornflakes"]'));
	await expect(issue).toHaveCount(0, { timeout: 15_000 });
	await expectFocusKept(page, 'Reduce to 2', { ms: 500 });
});

test('/checkout "Remove" on a refused line keeps keyboard focus on the page', async ({ page, shop, admin }) => {
	const issue = await checkoutWithQtyIssue(page, shop, admin);
	await keyboardActivate(issue.locator('[data-wf-remove="cornflakes"]'));
	await expect(issue).toHaveCount(0, { timeout: 15_000 });
	await expectFocusKept(page, 'Remove refused line', { ms: 500 });
});

test('/checkout offer chip "×" keeps keyboard focus on the page', async ({ page, shop, admin }) => {
	const c = await admin.createCoupon({ type: 'percent', value: 10 });
	await shop.visit(`/cart?add=muesli:1&offer=${c.code}`);
	await expect(page.locator(`[data-wf-offer="${c.code}"]`)).toBeVisible();
	await shop.gotoCheckout();
	const x = page.locator('#wf-co-summary .wf-offer-remove');
	await expect(x).toBeVisible({ timeout: 15_000 });
	await keyboardActivate(x);
	await expect(page.locator('#wf-co-summary [data-wf-offer]')).toHaveCount(0);
	await expectFocusKept(page, 'offer removed on /checkout', { ms: 500 });
});
