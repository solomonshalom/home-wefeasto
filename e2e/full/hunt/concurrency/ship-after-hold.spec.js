/*
 * HUNT-CONC-R3-3 (cms-checkout: src/collections/Orders.ts guardAdminTransitions): the "may this order be
 * packed/shipped?" rule ($shared canFulfil: paid, cod_confirmed, partially_refunded) is only enforced when
 * fulfilment LEAVES `unfulfilled`. An order that was packed before something else happened to it can still be
 * moved packed → shipped (→ delivered) whatever its status is now:
 *   - a chargeback arrives after packing (payment.dispute.created → needs_review, "hold fulfilment"): the hold
 *     does not hold, the goods ship;
 *   - the payment is refunded in full after packing (refund.processed → refunded): a refunded order ships;
 *   - a packed COD order is cancelled (its stock is given back, stockState released): it can still be shipped,
 *     so the same units are both on the shelf count and on the truck (stock conservation broken → oversell).
 * Packing runs in batches ahead of shipping, so every webhook / cancel that lands between the two steps hits
 * this. Expected: packed → shipped/delivered is refused (400) unless canFulfil(status), like unfulfilled → packed.
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';
import { cmsCall, mockPay, placeOrder, signedWebhook } from './helpers.js';

const patch = (adminSession, id, data) => adminSession.request('PATCH', `orders/${id}?depth=0`, { body: data });

async function paidAndPacked(stack, db, adminSession, email) {
	const o = await placeOrder(stack, db, { slug: 'health-mix', email });
	const paid = await mockPay(stack, o.razorpayOrderId, 'success', { webhook: false });
	const v = await cmsCall(stack, 'POST', 'store/checkout/verify', { body: { number: o.number, token: o.token, ...paid.response } });
	expect(v.json.order.status).toBe('paid');
	expect((await patch(adminSession, o.id, { fulfilmentStatus: 'packed' })).status).toBe(200);
	return { ...o, paymentId: paid.paymentId };
}

test('a chargeback hold stops a packed order from shipping', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	const o = await paidAndPacked(stack, db, adminSession, unique.email('hunt-hold'));
	const dispute = { id: `disp_Hunt${crypto.randomBytes(5).toString('hex')}`, entity: 'dispute', payment_id: o.paymentId, amount: o.totalPaise, currency: 'INR', reason_code: 'fraud', status: 'open', phase: 'chargeback', created_at: Math.floor(Date.now() / 1000) };
	const wh = await signedWebhook(stack, 'payment.dispute.created', { dispute });
	expect(wh.json.outcome).toBe('dispute_flagged');
	expect((await db.order(o.number)).status).toBe('needs_review');

	const ship = await patch(adminSession, o.id, { fulfilmentStatus: 'shipped' });
	const [row] = await db.query('select status, fulfilment_status from orders where id = $1', [o.id]);
	expect({ http: ship.status, ...row }, 'needs_review is a hold: nothing ships until a human resolves it').toEqual({ http: 400, status: 'needs_review', fulfilment_status: 'packed' });
});

test('a fully refunded packed order cannot be shipped', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	const o = await paidAndPacked(stack, db, adminSession, unique.email('hunt-refunded'));
	const refund = { id: `rfnd_Hunt${crypto.randomBytes(6).toString('hex')}`, entity: 'refund', amount: o.totalPaise, currency: 'INR', payment_id: o.paymentId, notes: [], receipt: null, status: 'processed', created_at: Math.floor(Date.now() / 1000) };
	const wh = await signedWebhook(stack, 'refund.processed', { refund });
	expect(wh.json.outcome).toBe('refund_recorded');
	expect((await db.order(o.number)).status).toBe('refunded');

	const ship = await patch(adminSession, o.id, { fulfilmentStatus: 'shipped' });
	const [row] = await db.query('select status, fulfilment_status from orders where id = $1', [o.id]);
	expect({ http: ship.status, ...row }, 'the money went back: the goods must not ship').toEqual({ http: 400, status: 'refunded', fulfilment_status: 'packed' });
});

test('a cancelled packed COD order cannot be shipped (its stock was given back)', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	const before = await db.stock('health-mix');
	const o = await placeOrder(stack, db, { slug: 'health-mix', email: unique.email('hunt-cxl'), method: 'cod' });
	expect((await patch(adminSession, o.id, { status: 'cod_confirmed' })).status).toBe(200);
	expect((await patch(adminSession, o.id, { fulfilmentStatus: 'packed' })).status).toBe(200);
	expect((await patch(adminSession, o.id, { status: 'cancelled' })).status).toBe(200);
	expect(await db.stock('health-mix'), 'cancel gave the unit back').toBe(before);

	const ship = await patch(adminSession, o.id, { fulfilmentStatus: 'shipped' });
	const [row] = await db.query('select status, fulfilment_status, stock_state from orders where id = $1', [o.id]);
	expect({ http: ship.status, ...row }, 'a unit back on the shelf must not also leave on the truck').toEqual({ http: 400, status: 'cancelled', fulfilment_status: 'packed', stock_state: 'released' });
});
