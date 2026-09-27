/*
 * HUNT data-cms (wave 5): an erased subscriber is re-subscribed and emailed by an already-queued refill job.
 *
 * DPDP erasure / withdrawal: the owner deletes the person's row in Customers → Subscribers (the only way the
 * admin offers to remove a marketing address). A refill reminder for one of their earlier orders is already
 * queued (scheduled at order confirmation for ~weeks later). When it runs, runRefillReminder finds NO
 * subscriber row and treats that as "the consent handler never ran": it calls upsertCheckoutConsent with the
 * order's OLD checkbox consent, which re-creates the row (confirmed at once for a signed-in verified buyer,
 * or pending + a new "confirm your subscription" email for anyone else) and then sends the marketing email.
 *
 * Correct behaviour: once the owner deleted the address from the list, an earlier order's consent is not used
 * to put it back or to email it (no row re-created, no refill email).
 */
import { test, expect } from '../../fixtures.js';
import { checkoutAs, signedInCustomer } from './helpers.js';

test('deleting a subscriber (erasure) is not undone by a refill reminder queued before it', async ({ stack, adminSession, admin, unique, db, cron, mailpit }) => {
	test.setTimeout(90_000);
	const customer = await signedInCustomer({ stack, adminSession, unique });
	const placed = await checkoutAs(stack, customer.headers, { items: { cornflakes: 1 }, method: 'cod', consent: true, form: { email: customer.email } });
	expect(placed.status, placed.text.slice(0, 300)).toBeLessThan(300);
	const number = placed.json.order.number;
	expect((await admin.findOrder(number)).customer).toBe(customer.id);

	// Signed in + verified + consent box: confirmed at once, refill reminder queued for later.
	await expect.poll(async () => (await admin.findSubscriber(customer.email))?.status ?? null, { timeout: 20_000 }).toBe('confirmed');
	await expect.poll(async () => (await db.jobs({ orderNumber: number, task: 'refillReminder' })).length, { timeout: 20_000 }).toBe(1);

	// The owner erases the address (DPDP request): Subscribers → delete.
	const sub = await admin.findSubscriber(customer.email);
	const del = await adminSession.request('DELETE', `subscribers/${sub.id}`);
	expect(del.status, del.text.slice(0, 200)).toBe(200);
	expect(await admin.findSubscriber(customer.email)).toBeNull();

	// Weeks later the queued reminder runs.
	expect((await db.makeJobsDue({ orderNumber: number, task: 'refillReminder' })).length).toBe(1);
	const run = await cron.runJobs();
	expect(run.status, run.text.slice(0, 200)).toBe(200);
	await expect.poll(async () => (await db.jobs({ orderNumber: number, task: 'refillReminder' })).filter((j) => !j.completed_at).length, { timeout: 20_000 }).toBe(0);

	const after = await admin.findSubscriber(customer.email);
	const refill = (await admin.messageLog({ order: number, keyPrefix: 'refill:' })).map((r) => `${r.key} ${r.status}`);
	const subjects = (await mailpit.messages(customer.email)).map((m) => m.Subject);
	expect(
		{ subscriber: after ? `${after.status} (${after.source})` : null, refillEmails: refill },
		`mail to the erased address: ${JSON.stringify(subjects)}`
	).toEqual({ subscriber: null, refillEmails: [] });
});
