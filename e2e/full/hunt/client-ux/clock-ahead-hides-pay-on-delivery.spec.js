/*
 * Hunt (client-ux): canSwitchToCod (src/lib/checkout/order.js) compares the SERVER's
 * dto.createdAt with the DEVICE clock (Date.now()). A phone whose clock runs ≥ 25 minutes
 * ahead (a hand-set clock, or a UTC time zone with the time adjusted to IST = +5 h 30) never
 * gets "Pay on delivery instead" on /order's failed view or the pending banner — even for an
 * order placed seconds ago — while /checkout's own note (no age check) offers it.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/clock-ahead-hides-pay-on-delivery.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { skewClock } from './helpers.js';

const AHEAD_MS = 2 * 60 * 60 * 1000;

test('device clock 2 h ahead: a seconds-old dismissed order still offers "Pay on delivery instead" on /order and the banner', async ({ page, shop }) => {
	await skewClock(page, AHEAD_MS);
	await shop.placeOnlineOrder({ items: { cornflakes: 1 }, auto: 'dismiss', expect: null });
	const note = page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]');
	await expect(note).toBeVisible({ timeout: 20_000 });
	await expect(note.locator('[data-wf-action="pay-on-delivery"]'), '/checkout offers it (control)').toBeVisible();
	const p = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_pending')));

	await shop.visit(`/order?no=${p.no}&t=${p.t}&payment=failed&reason=payment_cancelled`);
	await shop.waitOrderView(['failed']);
	await expect(page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]'), '/order failed view').toBeVisible({ timeout: 15_000 });

	await shop.visit('/cart');
	const banner = page.locator(`[data-wf-pending="${p.no}"]`);
	await banner.locator('[data-wf-pending-check]').click();
	await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck', { timeout: 30_000 });
	await expect(banner.locator('[data-wf-action="pay-on-delivery"]'), 'pending banner').toBeVisible({ timeout: 15_000 });
});
