/*
 * Payments can't start (razorpay.md §13 C.24–C.28; roadmap M2 edge cases): checkout.js blocked (ad
 * blocker / offline) and the gateway down at createOrder (503 PAYMENTS_UNAVAILABLE, the order kept
 * with its stock held). Both must leave a clear note with a way forward: Try again, or Pay on delivery
 * instead (a COD order that supersedes the kept online one).
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/gateway-outages.spec.js
 */
import { test, expect } from '../fixtures.js';
import { COPY, coNote, action, pendingOrder, recordCheckoutCalls, orderPage, waitOrderStatus, answered } from './helpers.js';

const SCRIPT = '**/api/payments/mock/checkout.js';

test.describe('checkout.js blocked', () => {
	test('route aborted → "Couldn’t load payments" + Pay on delivery instead → COD order supersedes the online one', async ({
		page,
		shop,
		admin,
		consoleErrors
	}) => {
		consoleErrors.allow(/Failed to load resource.*(ERR_BLOCKED_BY_CLIENT|ERR_FAILED)/);
		await page.route(SCRIPT, (r) => r.abort('blockedbyclient'));
		const { form } = await shop.placeOnlineOrder({ items: { 'health-mix': 1, cornflakes: 1 }, auto: 'success', expect: null });
		const note = coNote(page, 'SCRIPT_LOAD');
		await expect(note).toBeVisible({ timeout: 25_000 });
		await expect(note).toContainText(COPY.scriptFailed);
		await expect(action(note, 'try-again')).toBeVisible();
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready');
		const online = await pendingOrder(page);
		expect((await admin.findOrder(online.number)).status).toBe('pending_payment');

		await action(note, 'pay-on-delivery').click();
		await expect(page.locator('input[name="wf-pay"][value="cod"]')).toBeChecked();
		await page.locator('#wf-place-order').click();
		const cod = await orderPage(page);
		expect(cod.number).not.toBe(online.number);
		expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending', paymentMethod: 'cod' });
		expect((await admin.findOrder(cod.number)).contact.phone).toBe(`+91${form.phone}`);
		await waitOrderStatus(admin, online.number, 'cancelled');
	});

	test('blocked, then unblocked → Try again loads the script and pays the same order', async ({ page, shop, admin, mock, consoleErrors }) => {
		consoleErrors.allow(/Failed to load resource.*(ERR_BLOCKED_BY_CLIENT|ERR_FAILED)/);
		await page.route(SCRIPT, (r) => r.abort('blockedbyclient'));
		await shop.placeOnlineOrder({ items: { muesli: 2 }, auto: 'success', expect: null });
		const note = coNote(page, 'SCRIPT_LOAD');
		await expect(note).toBeVisible({ timeout: 25_000 });
		const { number } = await pendingOrder(page);
		await page.unroute(SCRIPT);
		await mock.setAuto(page, { auto: 'success' });
		await action(note, 'try-again').click();
		expect((await orderPage(page)).number).toBe(number);
		expect((await admin.findOrder(number)).status).toBe('paid');
	});
});

test.describe('gateway down at createOrder → 503 PAYMENTS_UNAVAILABLE', () => {
	test('fault injected in the running CMS → note + Pay on delivery instead supersedes the kept order', async ({ page, shop, mock, admin }) => {
		test.skip(!(await mock.faultsAvailable()), 'no fault-injection hook in the running CMS (POST /api/payments/mock/fault) — see the network-level test below');
		await mock.failNext('createOrder', 'server');
		const { form } = await shop.placeOnlineOrder({ items: { 'rolled-oats': 1 }, auto: 'success', expect: null });
		const note = coNote(page, 'PAYMENTS_UNAVAILABLE');
		await expect(note).toContainText(COPY.paymentsUnavailable);
		await action(note, 'pay-on-delivery').click();
		await page.locator('#wf-place-order').click();
		const cod = await orderPage(page);
		const orders = await admin.ordersByEmail(form.email);
		expect(orders.map((o) => [o.number === cod.number ? 'cod' : 'kept', o.status]).sort()).toEqual([['cod', 'cod_pending'], ['kept', 'cancelled']]);
	});

	/**
	 * No fault hook exists, so the 503 is produced at the network layer: the real checkout runs (the
	 * order is kept with its stock held, exactly like the backend's 503 path) and its answer is swapped
	 * for the backend's 503 body — then everything after it is real.
	 */
	async function answerFirstCheckoutWith503(page) {
		let n = 0;
		await page.route('**/api/store/checkout', async (route) => {
			if (route.request().method() !== 'POST' || n++ > 0) return route.continue();
			const res = await route.fetch();
			const { order } = await res.json();
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({
					error: { code: 'PAYMENTS_UNAVAILABLE', message: COPY.paymentsUnavailable, details: { order: { number: order.number, token: order.token, status: order.status, totalPaise: order.totalPaise } } }
				})
			});
		});
	}

	test('network-simulated 503 → note → Pay on delivery instead → the kept online order is cancelled', async ({ page, shop, admin }) => {
		await answerFirstCheckoutWith503(page);
		const calls = recordCheckoutCalls(page);
		const { form } = await shop.placeOnlineOrder({ items: { 'steel-cut-oats': 1, muesli: 1 }, auto: 'success', expect: null });
		const note = coNote(page, 'PAYMENTS_UNAVAILABLE');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText(COPY.paymentsUnavailable);
		await expect(note).toBeFocused();
		await expect.poll(() => calls[0]?.status).toBe(503);
		const kept = calls[0].json.error.details.order;

		await action(note, 'pay-on-delivery').click();
		await page.locator('#wf-place-order').click();
		const cod = await orderPage(page);
		expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending' });
		await waitOrderStatus(admin, kept.number, 'cancelled');
		const mine = await admin.ordersByEmail(form.email);
		expect(mine.map((o) => [o.number, o.status]).sort()).toEqual([[cod.number, 'cod_pending'], [kept.number, 'cancelled']].sort());
	});

	test('network-simulated 503 → tap Pay again: same Idempotency-Key replays the kept order with a payment → paid', async ({ page, shop, admin }) => {
		await answerFirstCheckoutWith503(page);
		const calls = recordCheckoutCalls(page);
		const { form } = await shop.placeOnlineOrder({ items: { cornflakes: 3 }, auto: 'success', expect: null });
		await expect(coNote(page, 'PAYMENTS_UNAVAILABLE')).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready');
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		await answered(calls, 2);
		expect(calls.map((c) => c.path)).toEqual(['/api/store/checkout', '/api/store/checkout']);
		expect(calls[1].key, 'the retry replays the same key').toBe(calls[0].key);
		expect(calls[1].status, 'a replay').toBe(200);
		expect(number).toBe(calls[0].json.error.details.order.number);
		const mine = await admin.ordersByEmail(form.email);
		expect(mine.map((o) => o.number)).toEqual([number]);
		expect(mine[0].status).toBe('paid');
	});
});
