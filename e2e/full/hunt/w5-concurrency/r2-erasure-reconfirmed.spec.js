/*
 * W5-CONC r2: a subscriber the owner DELETED (DPDP erasure) comes back as `confirmed` when an old order of
 * theirs is confirmed a second time. order.confirmed is emitted again whenever an order re-enters a
 * confirmed status (an admin resolving a review → paid, e.g. after a chargeback was sorted out; the
 * reconcile job re-emitting it), and its consent handler (retention/register.ts → upsertCheckoutConsent)
 * finds no subscriber row and re-creates it from the order's old checkbox: confirmed at once for a verified
 * account's order. (The round-1 fix stopped the refill reminder from doing the same; this path remains.)
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/r2-erasure-reconfirmed.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { apiLogin, createCustomer, placeOrderAs } from '../../accounts/helpers.js';
import { hex, mockPay, orderRow, paymentEntity, webhook } from './helpers.js';

test.use({ failOnConsoleErrors: false });

test('an erased subscriber stays erased when their old order is resolved back to paid', async ({ page, shop, stack, db, mailpit, unique, adminSession, admin, cron }) => {
	test.setTimeout(120_000);
	await admin.setStock('muesli', 50);
	const c = await createCustomer({ stack, mailpit, unique }, { tag: 'w5r2-dpdp' });
	await apiLogin(page, shop, c.email, c.password);
	const o = await placeOrderAs(page, shop, unique, { items: { muesli: 1 }, method: 'upi', form: { email: c.email }, consent: true });
	const paid = await mockPay(stack, o.payment.razorpayOrderId, 'success', { webhook: true });
	await expect.poll(async () => (await orderRow(db, o.number)).status, { timeout: 15_000 }).toBe('paid');
	const subOf = async () => (await db.query('select id, status from subscribers where email = $1', [c.email]))[0] ?? null;
	await expect.poll(async () => (await subOf())?.status ?? null, { timeout: 15_000 }).toBe('confirmed');

	// The customer asks for their data to be erased: the owner deletes the subscriber.
	const sub = await subOf();
	expect((await adminSession.request('DELETE', `subscribers/${sub.id}`)).status).toBe(200);
	expect(await subOf()).toBeNull();

	// Weeks later a chargeback puts the order on hold; the owner wins it and resolves the order back to paid.
	const row = await orderRow(db, o.number);
	const pay = paymentEntity({ id: paid.paymentId, orderId: o.payment.razorpayOrderId, amount: o.totalPaise, status: 'captured', wfOrder: o.number });
	const d = { id: `disp_W5R2${hex(4)}`, entity: 'dispute', payment_id: paid.paymentId, amount: o.totalPaise, currency: 'INR', reason_code: 'fraud', status: 'open', phase: 'chargeback', created_at: Math.floor(Date.now() / 1000) };
	expect((await webhook(stack, 'payment.dispute.created', { payment: pay, dispute: d })).json?.outcome).toBe('dispute_flagged');
	await webhook(stack, 'payment.dispute.won', { payment: pay, dispute: { ...d, status: 'won' } });
	const r = await adminSession.request('PATCH', `orders/${row.id}?depth=0`, { body: { status: 'paid' } });
	expect(r.status, r.text).toBe(200);

	// The resolve's order.confirmed handlers run after the response: give them time to act (a row appearing
	// ends the wait early), then the refill reminder queued at the first confirmation comes due (days later).
	await expect.poll(subOf, { timeout: 8_000, intervals: [250] }).not.toBeNull().catch(() => {});
	await db.makeJobsDue({ orderNumber: o.number, task: 'refillReminder' });
	expect((await cron.runJobs()).status).toBe(200);
	await mailpit.settle(c.email, { quietMs: 3000 });
	const marketing = (await mailpit.messages(c.email)).map((m) => m.Subject).filter((s) => /^Running low on /.test(s));
	expect({ subscriber: await subOf(), marketing }, 'after the owner erased them, then resolved their old order back to paid').toEqual({ subscriber: null, marketing: [] });
});
