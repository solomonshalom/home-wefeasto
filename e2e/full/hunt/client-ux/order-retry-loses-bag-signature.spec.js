/*
 * Hunt (client-ux): /order's "Try again" adopts the order with no cart signature
 * (flow.adopt({number, token}, method) — the banner passes pending.cartSig, /order passes
 * nothing), and flow.pay() then rewrites wefeasto_pending as {…, cartSig: ''}. From then on the
 * device no longer knows which bag that unpaid order holds:
 * - /checkout?pay=cod (the failed view's own "Pay on delivery instead") no longer says it
 *   replaces the unpaid order, and its quote no longer names the order (`supersede`), so the
 *   last pack that order holds reads as SOLD OUT and Pay is blocked (PI-SF-1 regresses);
 * - after a COD order does supersede it, its wefeasto_pending entry is never dropped.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/order-retry-loses-bag-signature.spec.js
 */
import { test, expect, waitOrderView, orderFromUrl, setMockAuto } from '../../fixtures.js';

const SLUG = 'health-mix';

test('last pack: /order failed view → Try again (dismissed) → Pay on delivery instead still replaces the online order', { tag: '@stateful' }, async ({ page, shop, admin }) => {
	await admin.setStock(SLUG, 1);
	const r = await shop.placeOnlineOrder({ items: { [SLUG]: 1 }, auto: 'dismiss', expect: null });
	await expect(page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });
	const before = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_pending')));
	expect(before.cartSig, 'checkout wrote the bag signature').toBeTruthy();
	const online = { number: before.no, token: before.t, form: r.form };

	// Back on the order link (e.g. from the email), the customer tries once more and closes the window again.
	await shop.visit(`/order?no=${online.number}&t=${online.token}&payment=failed&reason=payment_cancelled`);
	expect(await waitOrderView(page, ['failed'])).toBe('failed');
	await setMockAuto(page, { auto: 'dismiss' });
	await page.locator('[data-wf-failed] [data-wf-action="try-again"]').click();
	await expect(page.locator('[data-wf-failed] .wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });

	// (Root cause: wefeasto_pending is now {no, t, cartSig: ''} — before.cartSig was 'health-mix:1'.)
	const after = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_pending')));
	expect(after?.no).toBe(online.number);

	// "Pay on delivery instead" → the COD checkout knows it replaces the unpaid order, and the last pack is its own.
	await page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]').click();
	await page.waitForURL(/\/checkout\?pay=cod$/);
	await expect(page.locator('.wf-co-note[data-wf-co-note="COD_SWITCH"]')).toContainText(`It replaces your unpaid order ${online.number}`);
	await expect(page.locator(`[data-wf-co-issue][data-wf-co-line="${SLUG}"]`), 'the held last pack is not "sold out"').toHaveCount(0, { timeout: 15_000 });
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready', null, { timeout: 20_000 });
	await page.locator('#wf-place-order').click();
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
	const cod = orderFromUrl(page.url());
	expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending' });
	await expect.poll(async () => (await admin.findOrder(online.number))?.status).toBe('cancelled');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_pending')), { message: 'the superseded order is forgotten' }).toBeNull();
});
