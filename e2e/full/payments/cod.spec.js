/*
 * Cash on Delivery limits (razorpay.md §13 H.62; checkout-backend.md §1.2 COD): the ₹2,000 cap
 * (inclusive), COD-blocked PIN prefixes (server-only setting) and the open-COD-orders-per-phone cap.
 * The page turns the COD pill off with the reason; the server refuses a hand-made COD request too.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/cod.spec.js
 */
import { test, expect } from '../fixtures.js';
import { COPY, orderPage, quoteSettled, recordCheckoutCalls, serverTotal } from './helpers.js';

const codPill = (page) => page.locator('input[name="wf-pay"][value="cod"]');

/** A COD checkout body for `items` straight to the API (a hand-made request). */
async function codRequest(api, unique, items, form = {}) {
	const f = unique.form({ method: 'cod', ...form });
	const lines = Object.entries(items).map(([slug, qty]) => ({ slug, qty }));
	const q = await api.quote({ items: lines, pin: f.pin, method: 'cod' });
	return api.checkout({
		items: lines,
		contact: { name: f.name, email: f.email, phone: `+91${f.phone}` },
		address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
		method: 'cod',
		expectedTotalPaise: q.json.quote.totalPaise,
		consent: { marketing: false },
		source: 'web'
	});
}

test.describe('COD caps', () => {
	test('above ₹2,000 → COD pill off with the reason; a hand-made COD request is refused (ABOVE_MAX)', async ({ page, shop, api, unique }) => {
		const items = { 'health-mix': 8 };
		expect((await serverTotal(api, items)).totalPaise).toBe(216_000);
		await shop.setCart(items);
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await expect(codPill(page)).toBeDisabled();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveText(COPY.codAboveMax);
		await expect(codPill(page)).toHaveAttribute('aria-describedby', 'wf-co-cod-reason');
		await expect(page.locator('#wf-place-order')).toContainText('Pay ₹2,160 securely');

		const r = await codRequest(api, unique, items);
		expect(r.status).toBe(422);
		expect(r.json.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'ABOVE_MAX' } });
	});

	test('exactly ₹2,000 → COD allowed → cod_pending order of ₹2,000', async ({ page, shop, api, admin }) => {
		const items = { muesli: 8 };
		expect((await serverTotal(api, items, { method: 'cod' })).totalPaise).toBe(200_000);
		const { number, view } = await shop.placeCodOrder({ items });
		expect(view).toBe('confirmed');
		expect(await admin.findOrder(number)).toMatchObject({ status: 'cod_pending', totalPaise: 200_000, paymentMethod: 'cod' });
	});

	test('COD-blocked PIN prefix (admin) → pill off for 560001, back on for 110001 → COD order; the API refuses PIN_BLOCKED @stateful', async ({
		page,
		shop,
		admin,
		api,
		unique
	}) => {
		await admin.updateSettings({ codBlockedPinPrefixes: ['560'] });
		await shop.setCart({ cornflakes: 1 });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await quoteSettled(page);
		await expect(codPill(page)).toBeDisabled();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveText(COPY.codPinBlocked);

		await page.fill('#wf-co-pin', '110001');
		await page.fill('#wf-co-city', 'New Delhi');
		await page.selectOption('#wf-co-state', 'Delhi');
		await quoteSettled(page);
		await expect(codPill(page)).toBeEnabled();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveCount(0);
		await page.locator('label.wf-pay-pill:has(input[value="cod"])').click();
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect(await admin.findOrder(number)).toMatchObject({ status: 'cod_pending', shippingAddress: { pin: '110001' } });

		const r = await codRequest(api, unique, { cornflakes: 1 });
		expect(r.status).toBe(422);
		expect(r.json.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'PIN_BLOCKED' } });
	});

	test('a COD fee (admin) is its own row, charged on COD only, and counts toward the ₹2,000 cap @stateful', async ({ page, shop, admin }) => {
		await admin.updateSettings({ codFeePaise: 2_500 });
		await shop.setCart({ muesli: 1 });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'cod' });
		await expect(page.locator('[data-wf-cod-fee]')).toHaveText('₹25');
		await expect(page.locator('[data-wf-total]')).toHaveText('₹324');
		await expect(page.locator('#wf-place-order')).toContainText('Place order · Pay ₹324 on delivery');
		await page.locator('label.wf-pay-pill:has(input[value="upi"])').click();
		await quoteSettled(page);
		await expect(page.locator('[data-wf-cod-fee]')).toHaveCount(0);
		await expect(page.locator('[data-wf-total]')).toHaveText('₹299');
		await page.locator('label.wf-pay-pill:has(input[value="cod"])').click();
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect(await admin.findOrder(number)).toMatchObject({ status: 'cod_pending', totalPaise: 32_400, codFeePaise: 2_500 });

		// ₹2,000 of muesli + the ₹25 fee is over the cap.
		await shop.setCart({ muesli: 8 });
		await shop.gotoCheckout();
		await quoteSettled(page);
		await expect(codPill(page)).toBeDisabled();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveText(COPY.codAboveMax);
	});

	test('two open COD orders on this phone → the third COD tap is refused (TOO_MANY_OPEN): pill off, UPI picked, paying online works', async ({
		page,
		shop,
		api,
		admin,
		mock,
		unique
	}) => {
		const phone = unique.phone();
		await api.placeOrder({ items: { 'rolled-oats': 1 }, method: 'cod', form: { phone } });
		await api.placeOrder({ items: { 'steel-cut-oats': 1 }, method: 'cod', form: { phone } });
		await shop.setCart({ 'choco-flakes': 1 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'cod', phone });
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		await expect.poll(() => calls[0]?.status).toBe(422);
		expect(calls[0].json.error.details.reason).toBe('TOO_MANY_OPEN');
		await expect(page.locator('[data-wf-cod-reason]')).toHaveText(COPY.codTooManyOpen);
		await expect(codPill(page)).toBeDisabled();
		await expect(page.locator('input[name="wf-pay"][value="upi"]')).toBeChecked();
		expect(await admin.ordersByEmail(form.email)).toHaveLength(0);

		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect(await admin.findOrder(number)).toMatchObject({ status: 'paid', requestedMethod: 'upi' });
	});
});
