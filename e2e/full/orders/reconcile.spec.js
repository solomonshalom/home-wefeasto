/*
 * The money side of the order lifecycle (razorpay.md §13 E/F/G, checkout-backend.md §3/§6) on the
 * real stack: the reconcile cron (GET /api/payments/reconcile, Bearer CRON_SECRET) with DB time
 * travel, reservation expiry and exact stock numbers, late authorisations after expiry (honoured
 * when stock allows, refunded when it doesn't), two paid attempts (the second refunded), and admin
 * cancellations (stock + coupon given back; late money on a cancelled order refunded).
 *
 * Every test pins the stock of the product it uses with admin.setStock (restored afterwards) and
 * reconciles only its own order (?order=), so numbers are exact whatever ran before.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/orders/reconcile.spec.js
 */
import { test, expect, waitOrderView } from '../fixtures.js';
import { apiOnlineOrder, apiCodOrder, mockPay, waitOrder, historyOf, redemptionOf, SUBJECT, subjectsTo, squash, formatPaise } from './helpers.js';

test.describe('reconcile cron', { tag: ['@orders', '@reconcile', '@stateful'] }, () => {
	test('a payment whose webhook never came: the sweep after the reservation passed marks it paid (not expired) and sends one confirmation', async ({
		api,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		await admin.setStock('cornflakes', 20);
		const o = await apiOnlineOrder(api, { items: { cornflakes: 2 } });
		expect(await db.stock('cornflakes'), 'reserved at checkout').toBe(18);
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: false });
		expect((await admin.findOrder(o.number)).status, 'nobody told us yet').toBe('pending_payment');

		await db.expireReservation(o.number, { minutesAgo: 1 });
		const r = await cron.runReconcile({ order: o.number });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, checked: 1, paid: 1, expired: 0, gatewayErrors: 0 });

		const doc = await waitOrder(admin, o.number, { status: 'paid', paymentStatus: 'captured', paidVia: 'reconcile', stockState: 'committed' });
		expect(historyOf(doc)).toEqual(['pending_payment', 'paid']);
		expect(await db.stock('cornflakes'), 'committed, not taken twice').toBe(18);
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });

		// Idempotent: another sweep changes nothing and sends nothing.
		const again = await cron.runReconcile({ order: o.number });
		expect(again.json).toMatchObject({ ok: true, paid: 0, expired: 0 });
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number)]);
	});

	test('the plain 5-minute sweep (no ?order=): pays an old order the webhook missed, expires a lapsed one, leaves a fresh one to the status pull', async ({
		api,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		// A: paid at Razorpay 11 minutes ago, webhook lost, reservation still running.
		const a = await apiOnlineOrder(api, { items: { 'steel-cut-oats': 1 } });
		await mockPay(mock, a.rzpOrderId, 'success', { webhook: false });
		await db.backdateOrder(a.number, { minutes: 11 });
		// B: never paid, reservation lapsed.
		const b = await apiOnlineOrder(api, { items: { 'choco-flakes': 1 } });
		await db.expireReservation(b.number, { minutesAgo: 1 });
		// C: paid at Razorpay a moment ago: too fresh for the sweep (the /order status pull covers it).
		const c = await apiOnlineOrder(api, { items: { cornflakes: 1 } });
		await mockPay(mock, c.rzpOrderId, 'success', { webhook: false });

		const r = await cron.runReconcile();
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(true);
		expect(r.json.checked).toBeGreaterThanOrEqual(2);
		expect(r.json.paid).toBeGreaterThanOrEqual(1);
		expect(r.json.expired).toBeGreaterThanOrEqual(1);

		await waitOrder(admin, a.number, { status: 'paid', paidVia: 'reconcile' });
		await waitOrder(admin, b.number, { status: 'expired', stockState: 'released' });
		const fresh = await admin.findOrder(c.number);
		expect(fresh).toMatchObject({ status: 'pending_payment', reconciledAt: null });
		await mailpit.waitForMessage({ to: a.form.email, subjectIncludes: SUBJECT.confirmed(a.number) });

		// Settle C the way a customer watching /order would (status pull), so nothing is left behind.
		expect((await cron.runReconcile({ order: c.number })).json).toMatchObject({ paid: 1 });
		await mailpit.waitForMessage({ to: c.form.email, subjectIncludes: SUBJECT.confirmed(c.number) });
	});

	test('the cron endpoint refuses callers without the secret', async ({ stack }) => {
		for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
			const res = await fetch(`${stack.cmsUrl}/api/payments/reconcile`, { headers });
			expect(res.status).toBe(401);
			const jobs = await fetch(`${stack.cmsUrl}/api/payload-jobs/run?queue=default`, { headers });
			expect(jobs.status).toBe(401);
		}
	});

	test('unpaid past the reservation → expired: exact stock and the single-use coupon come back, no email, /order says the window closed', async ({
		page,
		shop,
		api,
		admin,
		db,
		cron,
		mailpit
	}) => {
		await admin.setStock('rolled-oats', 30);
		const coupon = await admin.createCoupon({ type: 'percent', value: 10, usageLimit: 1 });
		const o = await apiOnlineOrder(api, { items: { 'rolled-oats': 3 }, couponCode: coupon.code });
		expect(await db.stock('rolled-oats')).toBe(27);
		const order = await admin.findOrder(o.number);
		expect(order).toMatchObject({ stockState: 'reserved', coupon: { code: coupon.code } });
		expect((await redemptionOf(admin, order.id))?.status).toBe('reserved');
		const quoteWith = async () => (await api.quote({ items: [{ slug: 'rolled-oats', qty: 1 }], couponCode: coupon.code })).json.quote;
		expect((await quoteWith()).couponError?.reason, 'held by the pending order').toBe('USAGE_LIMIT');

		// Not yet past the reservation: a sweep must not expire it.
		const early = await cron.runReconcile({ order: o.number });
		expect(early.json).toMatchObject({ ok: true, expired: 0, paid: 0 });
		expect((await admin.findOrder(o.number)).status).toBe('pending_payment');

		await db.expireReservation(o.number, { minutesAgo: 5 });
		const r = await cron.runReconcile({ order: o.number });
		expect(r.json).toMatchObject({ ok: true, checked: 1, expired: 1, paid: 0 });

		const doc = await waitOrder(admin, o.number, { status: 'expired', stockState: 'released' });
		expect(historyOf(doc)).toEqual(['pending_payment', 'expired']);
		expect(await db.stock('rolled-oats'), 'every reserved pack is back').toBe(30);
		expect((await redemptionOf(admin, doc.id))?.status).toBe('released');
		expect((await quoteWith()).coupon?.code, 'the code is usable again').toBe(coupon.code);
		expect((await admin.getCoupon(coupon.code)).usedCount).toBe(0);

		await shop.visit(`/order?no=${o.number}&t=${o.token}`);
		expect(await waitOrderView(page, ['failed'])).toBe('failed');
		await expect(page.locator('[data-wf-failed]')).toContainText('The payment window for this order closed');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveAttribute('data-wf-fail-copy', 'certain');
		expect(await subjectsTo(mailpit, o.form.email, { quietMs: 2000 })).toEqual([]);
	});
});

test.describe('late payments after expiry', { tag: ['@orders', '@reconcile', '@stateful'] }, () => {
	test('stock still there → paid, stock taken again, one "your payment went through" email (not the plain confirmation)', async ({
		page,
		shop,
		api,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		await admin.setStock('choco-flakes', 10);
		const o = await apiOnlineOrder(api, { items: { 'choco-flakes': 2 } });
		await db.expireReservation(o.number, { minutesAgo: 5 });
		expect((await cron.runReconcile({ order: o.number })).json).toMatchObject({ expired: 1 });
		await waitOrder(admin, o.number, { status: 'expired', stockState: 'released' });
		expect(await db.stock('choco-flakes')).toBe(10);

		// The bank authorises it after all (a stale tab, or a slow UPI app); the webhook reports it.
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		const doc = await waitOrder(admin, o.number, { status: 'paid', stockState: 'committed', paymentStatus: 'captured' });
		expect(historyOf(doc)).toEqual(['pending_payment', 'expired', 'paid']);
		expect(await db.stock('choco-flakes')).toBe(8);

		const msg = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.late(o.number) });
		expect(squash(msg.Text)).toContain(`Your bank confirmed the payment for order ${o.number} after the payment window had closed.`);
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.late(o.number)]);

		await shop.visit(`/order?no=${o.number}&t=${o.token}`);
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
	});

	test('stock gone → needs_review, automatic full refund, one refund email; stock never goes below zero', async ({
		page,
		shop,
		api,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		await admin.setStock('health-mix', 2);
		const o = await apiOnlineOrder(api, { items: { 'health-mix': 2 } });
		expect(await db.stock('health-mix')).toBe(0);
		await db.expireReservation(o.number, { minutesAgo: 5 });
		expect((await cron.runReconcile({ order: o.number })).json).toMatchObject({ expired: 1 });
		expect(await db.stock('health-mix')).toBe(2);

		// Someone else buys the last two packs.
		const other = await apiCodOrder(api, { items: { 'health-mix': 2 } });
		expect(await db.stock('health-mix')).toBe(0);

		// The late authorisation is found by the sweep (its webhook was lost).
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: false });
		const r = await cron.runReconcile({ order: o.number });
		expect(r.json).toMatchObject({ ok: true, lateChecked: 1 });

		const doc = await waitOrder(admin, o.number, (d) => d.refunds?.[0]?.status === 'processed' && d.status === 'refunded', {
			message: `${o.number}: needs_review → refunded with a processed refund`
		});
		expect(historyOf(doc)).toEqual(['pending_payment', 'expired', 'needs_review', 'refunded']);
		expect(doc.refunds).toHaveLength(1);
		expect(doc.refunds[0]).toMatchObject({ reason: 'out_of_stock', amountPaise: doc.totalPaise, paymentId: doc.razorpay.paymentId });
		expect(doc.refunds[0].receipt).toMatch(new RegExp(`^${o.number}-oos-`));
		expect(doc.stockState, 'nothing taken for it').not.toBe('committed');
		expect(await db.stock('health-mix')).toBe(0);
		expect((await admin.findOrder(other.number)).status, 'the other buyer keeps their order').toBe('cod_pending');

		const refund = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.refund(o.number, doc.totalPaise) });
		expect(squash(refund.Text)).toContain('by then the items had sold out');
		expect(await subjectsTo(mailpit, o.form.email), 'no confirmation of any kind, one refund notice').toEqual([SUBJECT.refund(o.number, doc.totalPaise)]);

		await shop.visit(`/order?no=${o.number}&t=${o.token}`);
		expect(await waitOrderView(page, ['refunded'])).toBe('refunded');
		await expect(page.locator('[data-wf-order-view]')).toContainText('This order was refunded');
		expect(formatPaise(doc.totalPaise)).toBe('₹540');
	});
});

test.describe('duplicate payments', { tag: ['@orders', '@reconcile', '@stateful'] }, () => {
	test('two Razorpay attempts both paid: the first wins, the second is refunded automatically, one refund email', async ({ api, mock, admin, db, mailpit }) => {
		await admin.setStock('muesli', 20);
		const o = await apiOnlineOrder(api, { items: { muesli: 1 } });
		// The customer closed the first window and pressed "Try again": attempt 2.
		const retry = await api.post('store/checkout/retry', { number: o.number, token: o.token });
		expect(retry.status, retry.text).toBe(200);
		const a2 = retry.json.payment.razorpayOrderId;
		expect(a2).toMatch(/^order_/);
		expect(a2).not.toBe(o.rzpOrderId);

		// Both windows get paid (tab A with attempt 1, tab B with attempt 2).
		const p1 = await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await waitOrder(admin, o.number, { status: 'paid', razorpay: { paymentId: p1.paymentId } });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		const p2 = await mockPay(mock, a2, 'success', { webhook: true });

		const doc = await waitOrder(admin, o.number, (d) => d.refunds?.[0]?.status === 'processed', { message: 'the duplicate is refunded' });
		expect(doc).toMatchObject({ status: 'paid', paymentStatus: 'captured', stockState: 'committed', razorpay: { paymentId: p1.paymentId } });
		expect(doc.refunds).toHaveLength(1);
		expect(doc.refunds[0]).toMatchObject({ reason: 'duplicate_payment', paymentId: p2.paymentId, amountPaise: doc.totalPaise });
		expect(doc.refunds[0].receipt).toBe(`${o.number}-dup-${p2.paymentId.slice(-6)}`);
		expect(await db.stock('muesli'), 'stock taken once').toBe(19);

		const refund = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.refund(o.number, doc.totalPaise) });
		expect(squash(refund.Text)).toContain(`Order ${o.number} was paid twice, so we've refunded the extra payment. Your order is still confirmed.`);
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number), SUBJECT.refund(o.number, doc.totalPaise)]);
		expect((await api.status(o.number, o.token)).json).toMatchObject({ status: 'paid', isConfirmed: true });
	});
});

test.describe('admin cancellation', { tag: ['@orders', '@stateful'] }, () => {
	test('cancelling an unshipped COD order gives back its stock and coupon; the /order page says cancelled', async ({ page, shop, api, admin, db }) => {
		await admin.setStock('steel-cut-oats', 15);
		const coupon = await admin.createCoupon({ type: 'fixed', value: 3000, usageLimit: 1 });
		const o = await apiCodOrder(api, { items: { 'steel-cut-oats': 3 }, couponCode: coupon.code });
		expect(await db.stock('steel-cut-oats')).toBe(12);
		const placed = await admin.findOrder(o.number);
		expect(placed).toMatchObject({ stockState: 'committed', discountPaise: 3000 });
		expect((await redemptionOf(admin, placed.id))?.status).toBe('reserved');

		const r = await admin.cancelOrder(o.number);
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		const doc = await waitOrder(admin, o.number, { status: 'cancelled', stockState: 'released' });
		expect(historyOf(doc)).toEqual(['cod_pending', 'cancelled']);
		expect(await db.stock('steel-cut-oats')).toBe(15);
		expect((await redemptionOf(admin, doc.id))?.status).toBe('released');
		const q = (await api.quote({ items: [{ slug: 'steel-cut-oats', qty: 1 }], couponCode: coupon.code })).json.quote;
		expect(q.coupon?.code, 'the single-use code is free again').toBe(coupon.code);

		// Cancelling again is a no-op (no second release).
		expect((await admin.cancelOrder(o.number)).status).toBe(200);
		expect(await db.stock('steel-cut-oats')).toBe(15);

		await shop.visit(`/order?no=${o.number}&t=${o.token}`);
		expect(await waitOrderView(page, ['cancelled'])).toBe('cancelled');
		await expect(page.locator('[data-wf-order-view]')).toContainText('This order was cancelled');
	});

	test('cancelling a pending online order releases its reservation; money that lands later is refunded automatically', async ({
		api,
		mock,
		admin,
		db,
		mailpit
	}) => {
		await admin.setStock('cornflakes', 12);
		const o = await apiOnlineOrder(api, { items: { cornflakes: 2 } });
		expect(await db.stock('cornflakes')).toBe(10);
		expect((await admin.cancelOrder(o.number)).status).toBe(200);
		await waitOrder(admin, o.number, { status: 'cancelled', stockState: 'released' });
		expect(await db.stock('cornflakes')).toBe(12);

		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		const doc = await waitOrder(admin, o.number, (d) => d.refunds?.[0]?.status === 'processed', { message: 'late money on a cancelled order refunded' });
		expect(doc.refunds[0]).toMatchObject({ reason: 'order_cancelled', amountPaise: doc.totalPaise });
		expect(['needs_review', 'refunded']).toContain(doc.status);
		expect(await db.stock('cornflakes'), 'a cancelled order never takes stock back').toBe(12);
		const refund = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.refund(o.number, doc.totalPaise) });
		expect(squash(refund.Text)).toContain(`A payment for order ${o.number} arrived after the order was cancelled`);
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.refund(o.number, doc.totalPaise)]);
	});

	test('a shipped order cancelled by an admin does not put its packs back on the shelf', async ({ api, admin, db }) => {
		await admin.setStock('rolled-oats', 9);
		const o = await apiCodOrder(api, { items: { 'rolled-oats': 2 } });
		await admin.shipOrder(o.number);
		expect(await db.stock('rolled-oats')).toBe(7);
		const r = await admin.cancelOrder(o.number);
		expect(r.status, JSON.stringify(r.error)).toBe(200);
		await waitOrder(admin, o.number, { status: 'cancelled' });
		expect(await db.stock('rolled-oats'), 'the packs left with the courier').toBe(7);
	});

	test('a paid online order cannot be cancelled (refund it instead): 400, stock and status untouched', async ({ api, mock, admin, db }) => {
		await admin.setStock('choco-flakes', 6);
		const o = await apiOnlineOrder(api, { items: { 'choco-flakes': 1 } });
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await waitOrder(admin, o.number, { status: 'paid', stockState: 'committed' });
		expect(await db.stock('choco-flakes')).toBe(5);
		const r = await admin.cancelOrder(o.number);
		expect(r.status, JSON.stringify(r.error)).toBe(400);
		expect(await admin.findOrder(o.number)).toMatchObject({ status: 'paid', stockState: 'committed' });
		expect(await db.stock('choco-flakes')).toBe(5);
	});
});

