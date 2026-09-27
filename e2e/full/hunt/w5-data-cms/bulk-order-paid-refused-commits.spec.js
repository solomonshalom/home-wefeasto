/*
 * HUNT data-cms (wave 5): the Orders list "Edit" (bulk edit, PATCH /api/orders?where=…) commits an
 * admin "→ paid" that the CMS refuses.
 *
 * An admin moving an order to "paid" by hand (needs_review → paid) must re-take its stock when it had been
 * released, and is refused ("… is out of stock — restock it first, or refund the order instead.") when the
 * stock is gone (src/commerce/checkout/orderHooks.ts settlePaidByAdmin). That refusal is thrown from the
 * Orders afterChange hook, i.e. AFTER the order row was written. For a single-document save the throw rolls
 * the whole transaction back. Payload's bulk update (the admin list's "Edit" drawer) runs every selected
 * document in ONE shared transaction, catches each document's error, reports it (400 "Unable to update 1
 * out of 1 Orders") and then COMMITS the transaction: the order row is left "paid" with its stock never
 * taken (stockState 'released', no paidAt, no confirmation) — an order that can be packed and shipped with
 * goods the shop no longer has. The next reconcile sweep then finds a "paid" order without a confirmation and
 * emails the customer "Order WF-… confirmed — thank you!" (and emits order.confirmed).
 *
 * Correct behaviour: a refused bulk edit leaves the order exactly as it was (needs_review), like the
 * single-document save does.
 */
import { test, expect } from '../../fixtures.js';

const SLUG = 'rolled-oats';

async function needsReviewWithReleasedStock({ api, db, cron, admin }) {
	const o = await api.placeOrder({ items: { [SLUG]: 1 }, method: 'upi' });
	await db.expireReservation(o.number, { minutesAgo: 5 });
	const rec = await cron.runReconcile({ order: o.number });
	expect(rec.status, rec.text).toBe(200);
	await expect.poll(async () => (await admin.findOrder(o.number))?.status, { timeout: 15_000 }).toBe('expired');
	expect((await admin.findOrder(o.number)).stockState).toBe('released');
	const r = await admin.updateOrder(o.number, { status: 'needs_review' });
	expect(r.status, JSON.stringify(r.error)).toBe(200);
	return o;
}

test('control: a single-order save to "paid" with the stock gone is refused and changes nothing', async ({ api, db, cron, admin }) => {
	const o = await needsReviewWithReleasedStock({ api, db, cron, admin });
	await admin.setStock(SLUG, 0);
	const r = await admin.updateOrder(o.number, { status: 'paid' });
	expect(r.status).toBe(400);
	expect(JSON.stringify(r.error)).toMatch(/out of stock/);
	const after = await admin.findOrder(o.number);
	expect(after.status).toBe('needs_review');
});

test('bulk edit (Orders list → Edit → Status "paid") with the stock gone is refused and leaves the order as it was', async ({ api, db, cron, admin, adminSession }) => {
	test.setTimeout(60_000);
	const o = await needsReviewWithReleasedStock({ api, db, cron, admin });
	await admin.setStock(SLUG, 0);
	const r = await adminSession.request('PATCH', `orders?where[number][equals]=${o.number}&depth=0`, { body: { status: 'paid' } });
	expect(r.status, r.text.slice(0, 300)).toBe(400);
	expect(r.text).toMatch(/invalid: status|out of stock/);
	// The next reconcile sweep (section C: confirmed orders without a confirmation) acts on what was committed.
	const rec = await cron.runReconcile({ order: o.number });
	expect(rec.status, rec.text).toBe(200);
	const after = await admin.findOrder(o.number);
	expect(await db.stock(SLUG)).toBe(0);
	const confirmations = (await admin.messageLog({ order: o.number, keyPrefix: 'confirm:' })).map((m) => m.subject);
	expect(
		{ status: after.status, stockState: after.stockState, paidVia: after.paidVia ?? null, confirmations },
		'the refused bulk edit must not leave the order "paid" without its stock (nor tell the customer it is confirmed)'
	).toEqual({ status: 'needs_review', stockState: 'released', paidVia: null, confirmations: [] });
});
