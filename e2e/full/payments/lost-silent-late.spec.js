/*
 * When the browser never hears back (razorpay.md §13 C.29, D.33, E.44, F.54; roadmap M2 "un-losable"):
 * - lost:   the payment succeeded but Checkout never called the handler → the webhook (or, with no
 *           webhook either, the status endpoint's pull-reconcile) confirms it and /order shows it;
 * - silent: open() rendered nothing → the 15 s watchdog note, Try again works;
 * - late:   a timed-out UPI payment is authorised later → /order's failed view turns confirmed by itself;
 * - late after expiry: the order had expired (stock released) → honoured, the "went through" email.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/lost-silent-late.spec.js
 */
import { test, expect } from '../fixtures.js';
import { COPY, coNote, action, pendingOrder, orderPage, expectOnlyEmails, latestAttempt, waitOrderStatus } from './helpers.js';

/** Count POST /api/store/checkout/verify calls. */
function countVerify(page) {
	const seen = { n: 0 };
	page.on('request', (r) => {
		if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/store/checkout/verify') seen.n++;
	});
	return seen;
}

test.describe('the handler never fires', () => {
	test('lost: no handler, no verify — the webhook pays it and the page lands on /order confirmed', async ({ page, shop, mock, admin, mailpit }) => {
		const verify = countVerify(page);
		const { form } = await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'lost', expect: null });
		const inst = await mock.waitForEvent(page, 'lost');
		expect(inst.events).not.toContain('handler');
		const { number } = await pendingOrder(page);
		const { view } = await orderPage(page, ['confirmed'], { timeout: 30_000 });
		expect(view).toBe('confirmed');
		expect(verify.n, 'the client never verified').toBe(0);
		const order = await admin.findOrder(number);
		expect(order).toMatchObject({ status: 'paid', paidVia: 'webhook' });
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
	});

	test('lost with the webhook lost too: CLOSED note (don’t pay twice) → Check status → /order confirms via the status pull @slow', async ({
		page,
		shop,
		admin
	}) => {
		test.slow();
		await shop.placeOnlineOrder({ items: { 'health-mix': 1 }, auto: 'lost', webhook: false, expect: null });
		const note = coNote(page, 'CLOSED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText(COPY.closedUnheard);
		await expect(note).toContainText('please don’t pay twice');
		await expect(action(note, 'try-again'), 'no second payment offered while it may be paid').toHaveCount(0);
		const { number } = await pendingOrder(page);
		expect((await admin.findOrder(number)).status).toBe('pending_payment');

		await action(note, 'check-status').click();
		await page.waitForURL(/\/order\?/);
		const { view } = await orderPage(page, ['confirmed'], { timeout: 60_000 });
		expect(view).toBe('confirmed');
		const order = await admin.findOrder(number);
		expect(order.status).toBe('paid');
		expect(order.paidVia).not.toBe('client');
	});

	test('silent: nothing renders → after the 15 s watchdog the OPEN_FAILED note, then Try again → paid @slow', async ({ page, shop, mock, admin }) => {
		test.slow();
		await shop.placeOnlineOrder({ items: { 'rolled-oats': 1 }, auto: 'silent', expect: null });
		await mock.waitForEvent(page, 'open');
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'busy');
		const note = coNote(page, 'OPEN_FAILED');
		await expect(note).toBeVisible({ timeout: 25_000 });
		await expect(note).toContainText(COPY.openFailed);
		await expect(action(note, 'pay-on-delivery')).toBeVisible();
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'ready');
		const { number } = await pendingOrder(page);

		await mock.setAuto(page, { auto: 'success' });
		await action(note, 'try-again').click();
		const r = await orderPage(page);
		expect(r.number).toBe(number);
		expect((await admin.findOrder(number)).status).toBe('paid');
	});
});

test.describe('late authorisation', () => {
	test('late: FAILED (money unsure) → /order failed view watches → turns confirmed by itself, no reload @slow', async ({ page, shop, admin, mailpit }) => {
		test.slow();
		const { form } = await shop.placeOnlineOrder({ items: { cornflakes: 2 }, auto: 'late', expect: null });
		const note = coNote(page, 'FAILED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		await expect(note).toContainText(COPY.moneyUnsure);
		const { number, token } = await pendingOrder(page);
		// The payment.failed webhook lands first (the authorisation follows ~10 s after the payment).
		await waitOrderStatus(admin, number, 'payment_failed');

		await shop.visit(`/order?no=${number}&t=${token}`);
		expect((await orderPage(page, ['failed', 'confirmed'])).view, 'still unpaid when /order opens').toBe('failed');
		await page.evaluate(() => (window.__wfNoReload = true));
		// While the order may still settle the failed view says money is unsure and that it is watching.
		await expect(page.locator('[data-wf-fail-copy]')).toHaveAttribute('data-wf-fail-copy', 'unsure');
		await expect(page.locator('[data-wf-late-watch]')).toBeVisible();
		await expect(page.locator('[data-wf-failed] [data-wf-action="try-again"]')).toBeVisible();
		await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', 'confirmed', { timeout: 45_000 });
		expect(await page.evaluate(() => window.__wfNoReload), 'confirmed without a reload').toBe(true);
		const order = await admin.findOrder(number);
		expect(order.status).toBe('paid');
		expect(order.razorpay.payments.map((p) => p.status)).toContain('captured');
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
	});

	test('late, customer still on /checkout: once the money lands, Try again finds it (ALREADY_PAID) → /order confirmed, no new attempt @slow', async ({
		page,
		shop,
		admin
	}) => {
		test.slow();
		await shop.placeOnlineOrder({ items: { 'rolled-oats': 3 }, auto: 'late', expect: null });
		const note = coNote(page, 'FAILED');
		await expect(note).toBeVisible({ timeout: 20_000 });
		const { number } = await pendingOrder(page);
		await waitOrderStatus(admin, number, 'paid', { timeout: 40_000 });
		await action(note, 'try-again').click();
		expect((await orderPage(page)).number).toBe(number);
		const o = await admin.findOrder(number);
		expect(o.razorpay.attempts, 'no second Razorpay order for a paid order').toHaveLength(1);
	});

	test('late after expiry (stock released) → honoured: paid again, stock re-taken, "went through" email, /order confirmed', async ({
		page,
		shop,
		admin,
		db,
		cron,
		mock,
		mailpit
	}) => {
		test.slow();
		const slug = 'steel-cut-oats';
		const { form } = await shop.placeOnlineOrder({ items: { [slug]: 2 }, auto: 'dismiss', expect: null });
		await expect(coNote(page, 'DISMISSED')).toBeVisible({ timeout: 20_000 });
		const { number, token } = await pendingOrder(page);
		const held = await db.stock(slug);
		await db.expireReservation(number, { minutesAgo: 5 });
		const r = await cron.runReconcile({ order: number });
		expect(r.status).toBe(200);
		await waitOrderStatus(admin, number, 'expired');
		expect(await db.stock(slug), 'expiry releases the reservation').toBe(held + 2);

		const attempt = await latestAttempt(admin, number);
		const late = await mock.pay(attempt.orderId, 'late', { method: 'upi', lateAuthDelayMs: 1000 });
		expect(late.status).toBe(200);
		expect(late.json.ok).toBe(false);
		const paid = await waitOrderStatus(admin, number, 'paid');
		expect(paid.stockState).toBe('committed');
		expect(await db.stock(slug), 'the late payment takes the stock again').toBe(held);
		await expectOnlyEmails(mailpit, form.email, [new RegExp(`payment for ${number} went through`)]);

		await shop.visit(`/order?no=${number}&t=${token}`);
		expect((await orderPage(page)).view).toBe('confirmed');
	});
});
