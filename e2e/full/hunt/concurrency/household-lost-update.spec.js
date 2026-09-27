/*
 * HUNT-CONC-1 (cms-platform, src/retention/household.ts): POST /api/store/orders/household saves
 * `householdSize` with a plain payload.update() — no order row lock, no transaction shared with the other
 * order writers. Payload reads the whole order first and writes the whole document back, so any change that
 * commits in between (admin cancel / confirm / ship, reservation expiry, markPaid, refunds, disputes…) is
 * silently reverted: status, fulfilmentStatus, stockState, razorpay.*, refunds[] and statusHistory come back
 * as they were — while the side effects of the lost change (stock released, emails, events) stay done.
 *
 * The /order confirmed view shows "Breakfast for how many?" right after a COD order is placed, i.e. exactly
 * while the shop is confirming / cancelling / shipping it. Found by the seeded fuzzer
 * (e2e/full/hunt/concurrency/lib, stock-conservation + status-history invariants). Each race runs with a few
 * start offsets; today every run loses the other writer's change.
 */
import { test, expect } from '../../fixtures.js';
import { cmsCall, orderState, placeOrder, sleep } from './helpers.js';

const SLUG = 'health-mix';
const household = (stack, o, size) => cmsCall(stack, 'POST', 'store/orders/household', { body: { number: o.number, token: o.token, size } });
const patch = (adminSession, o, body) => adminSession.request('PATCH', `orders/${o.id}?depth=0`, { body });

test('a household answer racing an admin cancel of a COD order: stays cancelled, stock released once', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	for (const offsetMs of [0, 4, 8]) {
		const before = await db.stock(SLUG);
		const o = await placeOrder(stack, db, { slug: SLUG, method: 'cod', email: unique.email('hunt-hh') });
		expect(o.status).toBe('cod_pending');

		const [adm, hh] = await Promise.all([patch(adminSession, o, { status: 'cancelled' }), sleep(offsetMs).then(() => household(stack, o, 2))]);
		expect(adm.status, 'the admin was told the cancel worked').toBe(200);
		expect(hh.status).toBe(200);

		expect(await orderState(db, o.number), `offset ${offsetMs} ms`).toMatchObject({ status: 'cancelled', stockState: 'released', householdSize: 2 });
		expect(await db.stock(SLUG), `offset ${offsetMs} ms: the cancelled order must not still hold the unit it gave back`).toBe(before);
	}
});

test('a household answer racing an admin "shipped" keeps the order shipped', async ({ stack, db, adminSession, unique }) => {
	await adminSession.login();
	for (const offsetMs of [0, 4, 8]) {
		const o = await placeOrder(stack, db, { slug: SLUG, method: 'cod', email: unique.email('hunt-hh') });
		expect((await patch(adminSession, o, { status: 'cod_confirmed' })).status).toBe(200);

		const [adm, hh] = await Promise.all([patch(adminSession, o, { fulfilmentStatus: 'shipped' }), sleep(offsetMs).then(() => household(stack, o, 3))]);
		expect(adm.status).toBe(200);
		expect(hh.status).toBe(200);

		expect(await orderState(db, o.number), `offset ${offsetMs} ms`).toMatchObject({ status: 'cod_confirmed', fulfilmentStatus: 'shipped', householdSize: 3 });
	}
});

test('a household answer racing the reservation expiry keeps the order expired (no phantom stock)', async ({ stack, db, cron, unique }) => {
	for (const offsetMs of [0, 4, 8]) {
		const before = await db.stock(SLUG);
		const o = await placeOrder(stack, db, { slug: SLUG, email: unique.email('hunt-hh') });
		await db.expireReservation(o.number, { minutesAgo: 5 });

		const [rec, hh] = await Promise.all([cron.runReconcile({ order: o.number }), sleep(offsetMs).then(() => household(stack, o, 2))]);
		expect(rec.status).toBe(200);
		expect(rec.json.expired, 'reconcile expired the order').toBe(1);
		expect(hh.status).toBe(200);

		expect(await orderState(db, o.number), `offset ${offsetMs} ms`).toMatchObject({ status: 'expired', stockState: 'released', householdSize: 2 });
		expect(await db.stock(SLUG), 'stock + units still held by the order').toBe(before);
	}
});
