/*
 * Hunt (client-ux, sf-checkout): right after a guest order, /order says
 *   "Checking out again soon? Create an account to see your orders in one place and reorder in a tap."
 *   [Create an account]
 * The button opens /login on the *Log In* form (not Sign Up), and an account created with the same
 * email never shows this order: guest orders are never back-linked (SPEC §0, by design), so /account
 * greets the new customer with "No orders yet — your shelf is waiting for its first box." minutes
 * after they ordered. The CTA promises exactly what the design rules out.
 *
 * Correct: the CTA opens Sign Up, and its copy only promises what an account will do (future orders),
 * or the order does appear in /account.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/order-account-cta-false-promise.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { createCustomer, apiLogin } from '../../accounts/helpers.js';

test('guest /order "Create an account" opens Sign Up and does not promise an order list the new account will not have', async ({ page, shop, stack, mailpit, unique }) => {
	const { number, form } = await shop.placeCodOrder({ items: { muesli: 1 } });
	const cta = page.locator('[data-wf-account-cta]');
	await expect(cta).toBeVisible({ timeout: 15_000 });
	const promise = (await cta.innerText()).replace(/\s+/g, ' ');

	await cta.getByRole('link', { name: 'Create an account' }).click();
	await page.waitForURL((u) => u.pathname === '/login');
	await expect.soft(page.locator('#wf-panel-signup'), '"Create an account" lands on the Sign Up form').toBeVisible({ timeout: 10_000 });

	// The guest creates the account with the order's email, verifies it and logs in.
	await createCustomer({ stack, mailpit, unique }, { email: form.email, name: form.name });
	await apiLogin(page, shop, form.email);
	await shop.clientNav('/account');
	const listed = page.locator(`[data-wf-order="${number}"]`);
	await expect(page.locator('[data-wf-orders], [data-wf-orders-empty]').first()).toBeVisible({ timeout: 15_000 });
	if ((await listed.count()) === 0) {
		expect.soft(promise, `/account shows no ${number}, so the CTA must not promise "your orders in one place"`).not.toMatch(/see your orders in one place/i);
	}
});
