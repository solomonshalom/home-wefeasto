/*
 * What Try again / the failure note do in the less common outcomes (storefront-checkout.md §4;
 * checkout-backend.md §1.3; razorpay.md §13 D.30–D.32, F.53):
 * - a "pending" reason (the bank is still processing) → don't-pay-twice note with Check status, no retry;
 * - order_already_paid (paid from another tab / the UPI app while this modal was open) → /order confirmed;
 * - Try again after the reservation expired → stock re-reserved, paid; with the stock gone → sold-out note;
 * - /order's failed view → Try again in place → confirmed; a wrong token → "couldn't find that order".
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/retry-outcomes.spec.js
 */
import { test, expect } from '../fixtures.js';
import { coNote, action, modal, pendingOrder, orderPage, latestAttempt, waitOrderStatus, recordCheckoutCalls } from './helpers.js';

/**
 * Online order whose payment was dismissed; resolves {number, token, form}. Waits for the page's own re-quote
 * after the dismissal (it names the unpaid order in `supersede`, 250ms after the last change) so the page holds
 * a settled quote, as it would after the real 30-minute wait: a re-quote landing after the test changed the
 * stock would otherwise race the Try again click and turn it into a new submit instead of /checkout/retry.
 */
async function dismissed(page, shop, items) {
	const requoted = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/store/quote' && !!r.request().postDataJSON()?.supersede, {
		timeout: 20_000
	});
	const { form } = await shop.placeOnlineOrder({ items, auto: 'dismiss', expect: null });
	await expect(coNote(page, 'DISMISSED')).toBeVisible({ timeout: 20_000 });
	await requoted;
	await expect(page.locator('#wf-co-summary')).not.toHaveClass(/\bwf-loading\b/);
	return { ...(await pendingOrder(page)), form };
}

test.describe('retry outcomes', () => {
	test('a pending reason (payment_pending) → "still processing — don’t pay twice" + Check status, no Try again', async ({ page, shop }) => {
		await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'fail', reason: 'payment_pending', webhook: false, expect: null });
		const note = coNote(page, 'PENDING');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText('Your bank is still processing this payment');
		await expect(note).toContainText('please don’t pay twice');
		await expect(action(note, 'try-again')).toHaveCount(0);
		const { number, token } = await pendingOrder(page);
		await expect(action(note, 'check-status')).toHaveAttribute('href', `/order?no=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`);
	});

	test('paid from elsewhere while this modal is open → the next Pay is declined (order_already_paid) → the page goes to /order confirmed', async ({
		page,
		shop,
		mock,
		admin
	}) => {
		await shop.setCart({ 'rolled-oats': 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();
		const { number } = await pendingOrder(page);
		const elsewhere = await mock.pay((await latestAttempt(admin, number)).orderId, 'success', { method: 'upi' });
		expect(elsewhere.json.ok).toBe(true);
		await waitOrderStatus(admin, number, 'paid');

		await modal.pay(page).click();
		await expect(modal.root(page).getByRole('alert')).toHaveText(/\S/);
		await modal.cancel(page).click();
		await modal.confirmCancel(page).click();
		const r = await orderPage(page);
		expect(r.number).toBe(number);
		const o = await admin.findOrder(number);
		expect(o.status).toBe('paid');
		expect(o.razorpay.paymentId).toBe(elsewhere.json.paymentId);
	});

	test('Try again after the reservation expired → stock re-reserved, a new attempt, paid', async ({ page, shop, mock, admin, db, cron }) => {
		const slug = 'choco-flakes';
		const online = await dismissed(page, shop, { [slug]: 1 });
		const held = await db.stock(slug);
		await db.expireReservation(online.number, { minutesAgo: 5 });
		await cron.runReconcile({ order: online.number });
		await waitOrderStatus(admin, online.number, 'expired');
		expect(await db.stock(slug)).toBe(held + 1);

		await mock.setAuto(page, { auto: 'success' });
		await action(coNote(page, 'DISMISSED'), 'try-again').click();
		expect((await orderPage(page)).number).toBe(online.number);
		const o = await admin.findOrder(online.number);
		expect(o).toMatchObject({ status: 'paid', stockState: 'committed' });
		expect(o.razorpay.attempts).toHaveLength(2);
		expect(await db.stock(slug)).toBe(held);
	});

	test('Try again after expiry with the stock gone → sold-out note, the bag re-quoted (Reduce to 1) → a new order @stateful', async ({
		page,
		shop,
		admin,
		db,
		cron,
		mock
	}) => {
		const slug = 'steel-cut-oats';
		const online = await dismissed(page, shop, { [slug]: 2 });
		await db.expireReservation(online.number, { minutesAgo: 5 });
		await cron.runReconcile({ order: online.number });
		await waitOrderStatus(admin, online.number, 'expired');
		await admin.setStock(slug, 1);

		const calls = recordCheckoutCalls(page);
		await action(coNote(page, 'DISMISSED'), 'try-again').click();
		await expect.poll(() => calls[0]?.status).toBe(409);
		expect(calls[0].json.error.code).toBe('OUT_OF_STOCK');
		const note = coNote(page, 'OUT_OF_STOCK');
		await expect(note).toContainText('Only 1 pack of Steel-Cut Oats left');
		await expect(modal.root(page)).toHaveCount(0);
		// The bag is re-quoted: the line shows the same limit with Reduce to 1 (a new, smaller order).
		await expect(page.locator(`[data-wf-co-issue="OUT_OF_STOCK"][data-wf-co-line="${slug}"] [data-wf-reduce="${slug}"]`)).toHaveText('Reduce to 1');
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'disabled');
		expect((await admin.findOrder(online.number)).status).toBe('expired');

		// Reduce to 1 → a new, smaller order is paid (never a replay of the expired one).
		await mock.setAuto(page, { auto: 'success' });
		await page.locator(`[data-wf-reduce="${slug}"]`).click();
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const paid = await orderPage(page);
		expect(paid.number).not.toBe(online.number);
		expect(await admin.findOrder(paid.number)).toMatchObject({ status: 'paid', items: [expect.objectContaining({ slug, qty: 1 })] });
	});

	test('Try again on an order a newer checkout replaced (same bag, naming it) → "can’t be paid again" note → Pay places a new order', async ({
		page,
		shop,
		api,
		admin,
		mock
	}) => {
		const online = await dismissed(page, shop, { muesli: 1, 'rolled-oats': 1 });
		// Another tab of the same shopper replaces it. That tab names the order (wefeasto_pending is shared), as the
		// storefront does: a shared phone alone replaces nothing (checkout-backend.md §1.2, SUP-OWN-1).
		const items = [{ slug: 'muesli', qty: 1 }, { slug: 'rolled-oats', qty: 1 }];
		const supersede = { number: online.number, token: online.token };
		const f = online.form;
		const q = await api.quote({ items, method: 'upi', supersede });
		const replaced = await api.checkout({
			items,
			contact: { name: f.name, email: f.email, phone: f.phone.startsWith('+') ? f.phone : `+91${f.phone}` },
			address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
			method: 'upi',
			expectedTotalPaise: q.json.quote.totalPaise,
			consent: { marketing: false },
			source: 'web',
			supersede
		});
		expect(replaced.status, JSON.stringify(replaced.json)).toBe(201);
		const newer = replaced.json.order;
		await waitOrderStatus(admin, online.number, 'cancelled');
		const calls = recordCheckoutCalls(page);
		await action(coNote(page, 'DISMISSED'), 'try-again').click();
		const note = coNote(page, 'NOT_RETRYABLE');
		await expect(note).toContainText('This order can’t be paid again. Please place a new order.');
		await expect.poll(() => calls[0]?.status).toBe(409);
		await mock.setAuto(page, { auto: 'success' });
		await page.locator('#wf-place-order').click();
		const paid = await orderPage(page);
		expect([online.number, newer.number]).not.toContain(paid.number);
		expect((await admin.findOrder(paid.number)).status).toBe('paid');
	});

	test('/order failed view → Try again opens the modal on /order → paid → the same page turns confirmed', async ({ page, shop, mock, admin }) => {
		const online = await dismissed(page, shop, { cornflakes: 2 });
		await shop.visit(`/order?no=${online.number}&t=${online.token}&payment=failed&reason=payment_cancelled`);
		expect((await orderPage(page, ['failed'])).view).toBe('failed');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveAttribute('data-wf-fail-copy', 'certain');
		await mock.setAuto(page, { auto: 'success' });
		await page.locator('[data-wf-failed] [data-wf-action="try-again"]').click();
		await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', 'confirmed', { timeout: 30_000 });
		expect((await admin.findOrder(online.number)).status).toBe('paid');
	});

	test('/order with a wrong token (or an unknown order) → "We couldn’t find that order", nothing leaks', async ({ page, shop, api }) => {
		const o = await api.placeOrder({ items: { muesli: 1 }, method: 'cod' });
		const wrong = o.token.slice(0, -2) + (o.token.endsWith('AA') ? 'BB' : 'AA');
		await shop.visit(`/order?no=${o.number}&t=${wrong}`);
		expect((await orderPage(page, ['notfound'])).view).toBe('notfound');
		await expect(page.locator('[data-wf-notfound]')).toContainText('couldn’t find that order');
		await expect(page.locator('body')).not.toContainText(o.form.name);
		const a = await api.status(o.number, wrong);
		const b = await api.status('WF-99999999', o.token);
		expect(a.status).toBe(404);
		expect(a.text, 'byte-identical 404s').toBe(b.text);
	});
});
