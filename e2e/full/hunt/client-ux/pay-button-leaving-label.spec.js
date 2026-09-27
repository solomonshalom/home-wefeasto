/*
 * Hunt (client-ux): after the payment succeeded and verify answered, the flow is 'leaving'
 * (goto /order). On a slow network that takes seconds, and the Pay button's busy label falls
 * back to "Opening payment…" — telling a customer who has just paid that a payment window is
 * opening. It should keep saying the payment is being confirmed (or that we're taking them to
 * their order), never "Opening payment…".
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/pay-button-leaving-label.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { recordPayLabels, payLabels, slowOrderRoute } from './helpers.js';

test('after paying, the busy Pay button never goes back to "Opening payment…" while /order loads', async ({ page, shop, mock }) => {
	await shop.setCart({ muesli: 1 });
	await mock.setAuto(page, { auto: 'success' });
	await shop.gotoCheckout();
	await shop.fillCheckout({ method: 'upi' });
	await slowOrderRoute(page, 3000);
	await recordPayLabels(page);
	await page.locator('#wf-place-order').click();
	await shop.waitOrderView(['confirmed'], { timeout: 30_000 });
	const labels = await payLabels(page);
	const confirming = labels.indexOf('Confirming your payment…');
	expect(confirming, `labels seen: ${JSON.stringify(labels)}`).toBeGreaterThan(-1);
	expect(labels.slice(confirming), 'labels after the payment was confirmed').not.toContain('Opening payment…');
});
