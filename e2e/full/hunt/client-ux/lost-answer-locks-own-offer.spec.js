/*
 * Hunt (client-ux, round 3): a first-time customer with a welcome / single-use offer taps
 * "Pay ₹454 securely". The CMS places the order (reserving the offer for it) but the answer
 * never reaches the phone (connection reset — or the customer reloads during a slow "Opening
 * payment…"). The page says "We couldn't reach Wefeasto — check your connection and try again."
 * The customer tweaks the address and taps Pay again: that is a new attempt (new
 * Idempotency-Key), and the device has no ref for the first order (wefeasto_pending is written
 * only once a payment window is about to open), so nothing supersedes it — and the checkout is
 * refused because of the customer's OWN unpaid, unseen order:
 *   - first-order-only offer → "That offer is for your first order only." (to a first-time
 *     customer; the summary above still says "Offer … applied");
 *   - single-use offer (usageLimit 1) → "That offer has been fully claimed."
 * The only way on is "Remove offer" (pay full price) or waiting out the reservation.
 *
 * Correct: the retry goes through with the offer (e.g. the flow replays the unheard tap under its
 * key to learn the order it made, and names it as `supersede`, as it does for a known pending
 * order), and the customer ends up with one order, paid, with the discount.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/lost-answer-locks-own-offer.spec.js
 */
import { test, expect, setMockAuto } from '../../fixtures.js';
import { loseFirstCheckoutAnswer, payReadyAgain } from './helpers.js';

for (const [label, coupon] of [
	['first-order-only welcome offer', { type: 'percent', value: 10, firstOrderOnly: true }],
	['single-use offer', { type: 'percent', value: 10, usageLimit: 1 }]
]) {
	test(`lost answer → tweak the address → Pay again: the ${label} still applies`, async ({ page, shop, admin, consoleErrors }) => {
		consoleErrors.allow(/ERR_CONNECTION_RESET|net::ERR_FAILED/);
		const c = await admin.createCoupon(coupon);
		await shop.setCart({ 'choco-flakes': 1, muesli: 1 });
		await shop.visit('/cart?offer=' + c.code);
		await setMockAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		const f = await shop.fillCheckout({ method: 'upi' });
		await expect(page.locator('[data-wf-offer]')).toHaveAttribute('data-wf-offer-state', 'applied');
		await loseFirstCheckoutAnswer(page);

		await page.locator('#wf-place-order').click();
		await expect(page.locator('.wf-co-note')).toContainText('couldn’t reach Wefeasto', { timeout: 20_000 });

		await page.fill('#wf-co-address', f.address + ', near the park');
		await payReadyAgain(page);
		await page.locator('#wf-place-order').click();

		const outcome = await Promise.race([
			page.waitForURL(/\/order\?/, { timeout: 30_000 }).then(() => 'order'),
			page.locator('.wf-co-note[data-wf-co-note="COUPON_INVALID"]').waitFor({ timeout: 30_000 }).then(async () => 'refused: ' + (await page.locator('.wf-co-note').innerText()))
		]);
		expect(outcome, 'the retry is not refused over the customer’s own unseen order').toBe('order');
		expect(await shop.waitOrderView(['confirmed'])).toBe('confirmed');
		const paid = (await admin.ordersByEmail(f.email)).filter((o) => o.status === 'paid');
		expect(paid, 'one paid order').toHaveLength(1);
		expect(paid[0].coupon?.code, 'with the offer').toBe(c.code);
	});
}

// Same root cause, stock instead of an offer: the unseen order holds the last pack.
test('lost answer → tweak the address → Pay again: the customer’s own held last pack is not "sold out"', async ({ page, shop, admin, consoleErrors }) => {
	consoleErrors.allow(/ERR_CONNECTION_RESET|net::ERR_FAILED/);
	await admin.setStock('health-mix', 1);
	await shop.setCart({ 'health-mix': 1 });
	await setMockAuto(page, { auto: 'success' });
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'upi' });
	await loseFirstCheckoutAnswer(page);

	await page.locator('#wf-place-order').click();
	await expect(page.locator('.wf-co-note')).toContainText('couldn’t reach Wefeasto', { timeout: 20_000 });

	await page.fill('#wf-co-address', f.address + ', near the park');
	await payReadyAgain(page);
	await page.locator('#wf-place-order').click();

	const outcome = await Promise.race([
		page.waitForURL(/\/order\?/, { timeout: 30_000 }).then(() => 'order'),
		page.locator('.wf-co-note[data-wf-co-note="OUT_OF_STOCK"], [data-wf-co-issue]').first().waitFor({ timeout: 30_000 }).then(async () => 'refused: ' + (await page.locator('#wf-co-summary').innerText()).replace(/\s+/g, ' '))
	]);
	expect(outcome, 'the last pack is the customer’s own (held by their unseen order)').toBe('order');
	expect(await shop.waitOrderView(['confirmed'])).toBe('confirmed');
	expect((await admin.ordersByEmail(f.email)).filter((o) => o.status === 'paid'), 'one paid order').toHaveLength(1);
});
