/*
 * HUNT-CONC-6 (cms-checkout, src/commerce/checkout/checkout.ts + supersede.ts): "Pay on delivery instead"
 * places a COD order that carries `supersede: {number, token}` for the online order it replaces. If the
 * online payment lands first (UPI app / lost handler: only the webhook confirms it, after the page's single
 * status check and before the customer's tap), stillSupersedable() rightly keeps the paid order — but the
 * checkout then goes on and creates the COD order anyway. The customer, who asked for ONE order paid on
 * delivery instead, now has the online order paid and a second COD order for the same bag (two confirmation
 * emails, two shipments, paid twice). The server knows: the ref names an order that is now paid.
 *
 * Expected: a checkout whose verified supersede ref names an order that has meanwhile been paid places
 * nothing and answers 409 ALREADY_PAID with that order (like /checkout/retry does), so the page can show it.
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';
import { cmsCall, mockPay } from './helpers.js';

test('"Pay on delivery instead" after the online payment landed does not place a second order', async ({ stack, db, admin, unique }) => {
	const items = [{ slug: 'choco-flakes', qty: 1 }];
	const base = {
		items,
		contact: { name: 'Hunt Supersede', email: unique.email('hunt-sup'), phone: unique.phone({ e164: true }) },
		address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
		consent: { marketing: false },
		source: 'web'
	};
	const q1 = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method: 'upi' } });
	const online = await cmsCall(stack, 'POST', 'store/checkout', { body: { ...base, method: 'upi', expectedTotalPaise: q1.json.quote.totalPaise }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
	expect(online.status).toBe(201);
	const ref = { number: online.json.order.number, token: online.json.order.token };

	// The customer pays in their UPI app; the modal closes without a handler, the webhook confirms it.
	await mockPay(stack, online.json.payment.razorpayOrderId, 'success', { webhook: true });
	await expect.poll(async () => (await db.order(ref.number)).status, { timeout: 10_000 }).toBe('paid');

	// …meanwhile the page still offers "Pay on delivery instead" and the customer taps it.
	const q2 = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method: 'cod', supersede: ref } });
	const cod = await cmsCall(stack, 'POST', 'store/checkout', {
		body: { ...base, method: 'cod', expectedTotalPaise: q2.json.quote.totalPaise, supersede: ref },
		headers: { 'Idempotency-Key': crypto.randomUUID() }
	});
	const orders = await db.query('select number, status from orders where contact_phone = $1 order by id', [base.contact.phone]);
	try {
		expect(orders, 'one order for this bag: the one that was paid').toEqual([{ number: ref.number, status: 'paid' }]);
		expect(cod.status).toBe(409);
		expect(cod.json.error).toMatchObject({ code: 'ALREADY_PAID', details: { order: { number: ref.number, status: 'paid' } } });
	} finally {
		if (cod.status === 201) await admin.cancelOrder(cod.json.order.number); // give the extra order's stock back
	}
});
