/*
 * Hunt (payments-security) — anyone who knows a shopper's phone number can cancel their unpaid online order.
 *
 * placeOrder (checkout.ts step 3, supersede.ts findSupersedeTargets) cancels every still-unpaid ONLINE order
 * placed in the last 30 minutes with the SAME PHONE and the SAME BAG, with no proof that the new checkout
 * comes from that order's owner (no guest token, no session, no email match). A phone number is not a
 * secret, and a one-item bag is easy to guess. A stranger who places a checkout with the victim's phone —
 * any name, email and address, method upi (free: it just expires) or cod — cancels the victim's order while
 * the victim is in the Razorpay window. The victim's payment then lands on a cancelled order: markPaid parks
 * it in needs_review and queues an automatic refund ("arrived after the order was cancelled"), so the
 * victim pays, gets no order, and waits 5–7 days for the money.
 *
 * Correct behaviour: a checkout may only replace an order it proves it owns (the verified `supersede`
 * {number, token} ref, or at least a match on more than the phone); the stranger's checkout leaves the
 * victim's order pending, and the victim's payment confirms it.
 */
import { test, expect } from '../../fixtures.js';
import { payAndVerify, tryCheckout } from './helpers.js';

test('a checkout that only shares a shopper’s phone and bag cannot cancel their order in the payment window', async ({ api, mock, unique }) => {
	const phone = unique.phone();

	const victim = await tryCheckout(api, { items: { muesli: 1 }, method: 'upi', form: { phone } });
	expect(victim.status, victim.text).toBe(201);
	const { number, token } = victim.json.order;

	// A stranger: different name, email and address; same phone and bag; no supersede ref.
	const stranger = await tryCheckout(api, {
		items: { muesli: 1 },
		method: 'upi',
		form: { phone, name: 'Mallory Stranger', address: '99 Elsewhere Lane, Indiranagar' }
	});
	expect(stranger.status, stranger.text).toBe(201);

	const after = await api.status(number, token);
	expect(after.json?.status, "the stranger's checkout must not touch the victim's order").toBe('pending_payment');

	// The victim finishes paying in the window they already had open.
	const paid = await payAndVerify(api, mock, { number, token, razorpayOrderId: victim.json.payment.razorpayOrderId });
	expect(paid.order?.status).toBe('paid');
});
