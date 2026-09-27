/*
 * Hunt (client-ux, sf-checkout): a signed-in customer closes the payment window without paying.
 * /checkout says "Payment didn't go through — no money was taken." and /account lists the order as
 * "Waiting for payment". Its "View" button opens /order, which says
 *   "Confirming your payment — Confirming with your bank… please don't pay again."
 * with no way to pay, for ~2.5 minutes (then "Still confirming … no need to pay again"). Nothing was
 * ever paid: viewFor() turns every pending_payment answer into 'confirming', whether or not a payment
 * is in flight (the DTO's paymentStatus says there was no attempt).
 *
 * Correct: an unpaid order that nobody is paying reads "waiting for payment" and offers to pay it, as
 * the /account row and the pending banner already do — never "please don't pay again".
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/account-view-unpaid-claims-confirming.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { createCustomer, apiLogin } from '../../accounts/helpers.js';

test('/account → View on an order whose payment window was closed unpaid does not claim a payment is being confirmed', async ({ page, shop, stack, mailpit, unique, api }) => {
	const { email } = await createCustomer({ stack, mailpit, unique });
	await apiLogin(page, shop, email);
	await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'dismiss', expect: null, form: { email } });
	await expect(page.locator('.wf-co-note')).toContainText('no money was taken', { timeout: 20_000 });

	await shop.clientNav('/account');
	const row = page.locator('[data-wf-order]').first();
	await expect(row.locator('[data-wf-status]')).toHaveText('Waiting for payment', { timeout: 15_000 });
	await row.locator('[data-wf-view-order]').click();
	await page.waitForURL(/\/order\?/);
	const u = new URL(page.url());
	const dto = await api.status(u.searchParams.get('no'), u.searchParams.get('t'));
	test.info().annotations.push({ type: 'dto', description: JSON.stringify({ status: dto.json?.order?.status ?? dto.json?.status, paymentStatus: dto.json?.order?.paymentStatus ?? dto.json?.paymentStatus }) });

	const view = page.locator('[data-wf-order-view]');
	await expect(view).not.toHaveAttribute('data-wf-order-view', 'loading', { timeout: 15_000 });
	await page.waitForTimeout(2500); // a few polls
	await expect(view, 'no "confirming with your bank / don’t pay again" for an order nobody paid').not.toContainText(/Confirming with your bank|don’t pay again|Confirming your payment/);
	await expect(view.getByRole('button', { name: /pay|try again/i }).first(), 'a way to pay the unpaid order').toBeVisible();
});
