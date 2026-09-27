/*
 * Hunt (client-ux): /order falls back to the "confirming" view whenever its first status look
 * gets no answer (CMS down, 5xx, flaky data): "Confirming your payment — Confirming with your
 * bank… please don't pay again", and after 2 minutes "Still confirming — we'll email you the
 * moment it lands". The page knows nothing about the order at that point: it says this for a
 * cash-on-delivery order, an already-confirmed one, a cancelled one, even a mistyped link.
 * It should say it can't reach us yet (and keep trying), not invent a bank confirmation.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/order-outage-claims-confirming-payment.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('COD order link opened while the status API is down: no "Confirming with your bank" claim; confirmed once it answers', async ({ page, shop, api, consoleErrors }) => {
	consoleErrors.allow(/status of 503/);
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	expect(o.status).toBe('cod_pending');
	let down = true;
	await page.route('**/api/store/orders/status**', (r) => (down ? r.fulfill({ status: 503, contentType: 'text/html', body: '<h1>503</h1>' }) : r.continue()));
	await page.goto(`/order?no=${o.number}&t=${o.token}`);
	await page.waitForFunction(() => document.querySelector('[data-wf-order-view]')?.getAttribute('data-wf-order-view') !== 'loading', null, { timeout: 15_000 }).catch(() => {});
	await page.waitForTimeout(2500); // a couple of failed looks
	const order = page.locator('.wf-order');
	await expect(order, 'no payment/bank claim for an order the page knows nothing about').not.toContainText(/Confirming (your payment|with your bank)/);

	down = false;
	await shop.waitOrderView(['confirmed'], { timeout: 20_000 });
});
