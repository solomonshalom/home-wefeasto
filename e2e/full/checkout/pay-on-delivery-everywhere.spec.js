/*
 * "Pay on delivery instead" from the pending banner (/cart) and /order's failed view, end to
 * end (storefront-fixes; checkout-backend.md §1.2 supersede): a dismissed online payment, then
 * the normal COD checkout prefilled with the same details in this tab → the CMS cancels the
 * unpaid online order. Plus: COD switched off in the store settings → not offered.
 * Run: E2E_SLOT=4 npx playwright test --project=full e2e/full/checkout/pay-on-delivery-everywhere.spec.js
 */
import { test, expect, waitOrderView, orderFromUrl } from '../fixtures.js';

/** Online order for `items` in this tab, payment dismissed → { number, token, form } (the order stays unpaid). */
async function dismissedOnlineOrder(page, shop, items) {
	const r = await shop.placeOnlineOrder({ items, auto: 'dismiss', expect: null });
	await expect(page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });
	const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_pending')));
	expect(pending?.no).toMatch(/^WF-\d+$/);
	return { number: pending.no, token: pending.t, form: r.form };
}

/** /checkout?pay=cod: COD picked, the pending order's details filled in, the note says what happens. */
async function expectPrefilled(page, online) {
	await page.waitForURL(/\/checkout\?pay=cod$/);
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready', null, { timeout: 20_000 });
	await expect(page.locator('input[name="wf-pay"][value="cod"]')).toBeChecked();
	await expect(page.locator('#wf-co-phone')).toHaveValue(online.form.phone);
	await expect(page.locator('#wf-co-email')).toHaveValue(online.form.email);
	await expect(page.locator('.wf-co-note[data-wf-co-note="COD_SWITCH"]')).toContainText(`It replaces your unpaid order ${online.number}`);
}

async function placeAndExpectSuperseded(page, admin, online) {
	await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.classList.contains('wf-loading'));
	await page.locator('#wf-place-order').click();
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
	const cod = orderFromUrl(page.url());
	expect(cod.number).not.toBe(online.number);
	expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending', paymentMethod: 'cod' });
	await expect.poll(async () => (await admin.findOrder(online.number))?.status).toBe('cancelled');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_pending'))).toBeNull();
	return cod;
}

test.describe('pay on delivery instead → supersede', () => {
	test('from /order’s failed view', async ({ page, shop, admin }) => {
		const online = await dismissedOnlineOrder(page, shop, { muesli: 1 });
		// The customer comes back to the order link; the payment is still unpaid (dismissed).
		await shop.visit(`/order?no=${online.number}&t=${online.token}&payment=failed&reason=payment_cancelled`);
		expect(await waitOrderView(page, ['failed'])).toBe('failed');
		const cod = page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]');
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod');
		await cod.click();
		await expectPrefilled(page, online);
		await placeAndExpectSuperseded(page, admin, online);
	});

	test('from the pending banner on /cart', async ({ page, shop, admin }) => {
		const online = await dismissedOnlineOrder(page, shop, { cornflakes: 1 });
		await shop.visit('/cart');
		const banner = page.locator(`[data-wf-pending="${online.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck', { timeout: 30_000 });
		const cod = banner.locator('[data-wf-action="pay-on-delivery"]');
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod');
		await cod.click();
		await expectPrefilled(page, online);
		await placeAndExpectSuperseded(page, admin, online);
	});

	test('COD off in the store settings → not offered on /order', async ({ page, shop, admin }) => {
		const online = await dismissedOnlineOrder(page, shop, { 'health-mix': 1 });
		await admin.updateSettings({ codEnabled: false });
		// The page asks the server quote (method cod) before offering the switch: wait for that answer.
		const codQuote = page.waitForResponse((r) => r.url().endsWith('/api/store/quote') && r.request().postDataJSON()?.method === 'cod', { timeout: 30_000 });
		await shop.visit(`/order?no=${online.number}&t=${online.token}&payment=failed&reason=payment_cancelled`);
		expect(await waitOrderView(page, ['failed'])).toBe('failed');
		const answer = await (await codQuote).json();
		expect(answer.quote).toMatchObject({ codAvailable: false, codUnavailableReason: 'DISABLED' });
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		await expect(page.locator('[data-wf-failed] [data-wf-action="try-again"]')).toBeVisible();
		await expect(page.locator('[data-wf-action="pay-on-delivery"]')).toHaveCount(0);
	});
});
