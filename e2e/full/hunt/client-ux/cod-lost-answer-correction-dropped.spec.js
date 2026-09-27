/*
 * Hunt (client-ux, round 3): a COD "Place order" whose answer is lost (the CMS placed the order,
 * the connection dropped on the way back) shows "We couldn't reach Wefeasto — check your
 * connection and try again." The customer spots a typo in the address ("MG Raod, Ashok Nagr"),
 * corrects it and taps "Place order" again. flow.js place() sends the corrected body under the
 * unheard tap's Idempotency-Key, gets IDEMPOTENCY_MISMATCH and silently replays the OLD body: the
 * page lands on "Order confirmed" for the order with the typo'd address. Nothing on /checkout or
 * /order says the correction was not taken (/order doesn't show the address at all), so the
 * customer believes the corrected address went in. Same with a corrected phone (the courier's
 * number) — and a switch to UPI ("Pay ₹249 securely") silently lands on the COD order instead.
 *
 * Correct: the correction is not lost silently — either the order carries the corrected details,
 * or the customer is shown what was actually placed (e.g. "Your first tap already placed order
 * WF-… — delivering to <address>. Need a change? Message us.").
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/cod-lost-answer-correction-dropped.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { loseFirstCheckoutAnswer, payReadyAgain } from './helpers.js';

const TYPO = 'Flat 4B, 12 MG Raod, Ashok Nagr';
const FIXED = 'Flat 4B, 12 MG Road, Ashok Nagar';

test('lost COD answer → corrected address → Place order: the correction is applied or the customer is told', async ({ page, shop, admin, consoleErrors }) => {
	consoleErrors.allow(/ERR_CONNECTION_RESET|net::ERR_FAILED/);
	await shop.setCart({ 'choco-flakes': 1 });
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'cod', address: TYPO });
	await loseFirstCheckoutAnswer(page);

	await page.locator('#wf-place-order').click();
	await expect(page.locator('.wf-co-note')).toContainText('couldn’t reach Wefeasto', { timeout: 20_000 });

	await page.fill('#wf-co-address', FIXED);
	await payReadyAgain(page);
	await page.locator('#wf-place-order').click();
	await page.waitForURL(/\/order\?/, { timeout: 20_000 });
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible({ timeout: 20_000 });

	const orders = (await admin.ordersByEmail(f.email)).filter((o) => !['cancelled', 'expired'].includes(o.status));
	expect(orders, 'one live order').toHaveLength(1);
	const shipsTo = orders[0].shippingAddress?.line1;
	if (shipsTo === FIXED) return; // the correction went in
	// Kept the earlier order: then the customer must be able to see where it is going.
	await expect(page.getByText(shipsTo, { exact: false }).first(), `the order ships to "${shipsTo}" — the page must say so`).toBeVisible();
});
