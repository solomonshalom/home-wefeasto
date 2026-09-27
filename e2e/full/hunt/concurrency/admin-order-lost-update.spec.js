/*
 * HUNT-CONC-2 (cms-checkout, src/collections/Orders.ts + src/commerce/checkout/orderHooks.ts): an admin
 * status edit (REST PATCH /api/orders/:id, i.e. the admin UI "Save") is not serialised with the checkout
 * code. markPaid / expireOrder / retry take `SELECT … FOR UPDATE` on the order row, but the admin update
 * reads the order without that lock, checks the transition against that stale copy, writes the WHOLE stale
 * document back once the checkout transaction commits, and its afterChange hook then acts on the stale
 * stockState. Results seen:
 *   - cancel racing the reservation expiry → the stock is released twice (one phantom unit per order);
 *   - cancel racing payment verification → verify answers "paid", then the order ends `cancelled` with its
 *     captured payment id, payment log and attempt status erased and no refund queued;
 *   - two cancels of one COD order at once (double-clicked Save, two admins) → both answer 200 and both
 *     release the stock (the afterChange hook sees cod_pending → cancelled + committed stock twice);
 *   - "packed" racing a chargeback webhook (payment.dispute.created → needs_review hold) → the webhook answers
 *     dispute_flagged, then the order is back to `paid` with the dispute, the review reason and the hold gone.
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';
import { cmsCall, mockPay, orderState, placeOrder, sleep, signedWebhook } from './helpers.js';

const cancel = (adminSession, id) => adminSession.request('PATCH', `orders/${id}?depth=0`, { body: { status: 'cancelled' } });

test('admin cancel racing the reservation expiry releases the stock exactly once', async ({ stack, db, cron, adminSession, unique }) => {
	await adminSession.login();
	for (const offsetMs of [3, 6, 9]) {
		const before = await db.stock('steel-cut-oats');
		const o = await placeOrder(stack, db, { slug: 'steel-cut-oats', email: unique.email('hunt-adm') });
		await db.expireReservation(o.number, { minutesAgo: 5 });

		const [rec, adm] = await Promise.all([cron.runReconcile({ order: o.number }), sleep(offsetMs).then(() => cancel(adminSession, o.id))]);
		expect(rec.status).toBe(200);
		expect([200, 400]).toContain(adm.status); // expired → cancelled is allowed either way

		expect(await orderState(db, o.number), `offset ${offsetMs} ms`).toMatchObject({ stockState: 'released' });
		expect(await db.stock('steel-cut-oats'), `offset ${offsetMs} ms: one unit taken, one given back`).toBe(before);
	}
});

test('two simultaneous admin cancels of a COD order release its stock once', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	for (let i = 0; i < 3; i++) {
		const before = await db.stock('steel-cut-oats');
		const o = await placeOrder(stack, db, { slug: 'steel-cut-oats', method: 'cod', email: unique.email('hunt-adm') });
		expect(await db.stock('steel-cut-oats')).toBe(before - 1);

		const rs = await Promise.all([cancel(adminSession, o.id), cancel(adminSession, o.id)]);
		expect(rs.map((r) => r.status)).toContain(200);
		await sleep(300);

		expect(await orderState(db, o.number)).toMatchObject({ status: 'cancelled', stockState: 'released' });
		expect(await db.stock('steel-cut-oats'), `round ${i}: one unit committed, one given back`).toBe(before);
	}
});

test('admin cancel racing payment verification never loses the captured payment', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	for (const offsetMs of [4, 8, 12]) {
		const o = await placeOrder(stack, db, { slug: 'steel-cut-oats', email: unique.email('hunt-adm') });
		const paid = await mockPay(stack, o.razorpayOrderId, 'success', { webhook: false });

		const [v] = await Promise.all([
			cmsCall(stack, 'POST', 'store/checkout/verify', { body: { number: o.number, token: o.token, ...paid.response } }),
			sleep(offsetMs).then(() => cancel(adminSession, o.id))
		]);
		expect(v.status).toBe(200);
		await sleep(1500); // queued refunds are issued after the response

		// Either the payment won (paid; the cancel is refused) or the cancel won and the money is refunded.
		// In both cases the order must still know the captured payment.
		const s = await orderState(db, o.number);
		expect(s.paymentId, `offset ${offsetMs} ms: ${JSON.stringify(s)}`).toBe(paid.paymentId);
		if (s.status !== 'paid') expect(s.refundedPayments, `offset ${offsetMs} ms: ${s.status} order keeps the money`).toContain(paid.paymentId);
	}
});

test('admin packing racing a chargeback webhook keeps the dispute hold', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	for (let offsetMs = 0; offsetMs < 12; offsetMs++) {
		const o = await placeOrder(stack, db, { slug: 'steel-cut-oats', email: unique.email('hunt-adm') });
		const paid = await mockPay(stack, o.razorpayOrderId, 'success', { webhook: false });
		expect((await cmsCall(stack, 'POST', 'store/checkout/verify', { body: { number: o.number, token: o.token, ...paid.response } })).json.order.status).toBe('paid');
		await sleep(300); // the confirmation effects settle

		const disputeId = `disp_Hunt${crypto.randomBytes(5).toString('hex')}`;
		const dispute = { id: disputeId, entity: 'dispute', payment_id: paid.paymentId, amount: o.totalPaise, currency: 'INR', reason_code: 'fraud', status: 'open', phase: 'chargeback', created_at: Math.floor(Date.now() / 1000) };
		const [wh, adm] = await Promise.all([
			signedWebhook(stack, 'payment.dispute.created', { dispute }),
			sleep(offsetMs).then(() => adminSession.request('PATCH', `orders/${o.id}?depth=0`, { body: { fulfilmentStatus: 'packed' } }))
		]);
		expect(wh.status).toBe(200);
		expect(wh.json.outcome).toBe('dispute_flagged');
		expect([200, 400]).toContain(adm.status); // packed first, or refused because the order is on hold

		const [row] = await db.query('select status, dispute_dispute_id, review_reason from orders where id = $1', [o.id]);
		expect({ status: row.status, dispute: row.dispute_dispute_id, flagged: /Chargeback/.test(row.review_reason ?? '') }, `offset ${offsetMs} ms`).toEqual({
			status: 'needs_review',
			dispute: disputeId,
			flagged: true
		});
	}
});
