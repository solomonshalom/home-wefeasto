/*
 * HUNT data-cms (wave 5): after an admin corrects a subscriber's email, that person can no longer unsubscribe.
 *
 * Unsubscribe links carry base64url(HMAC(PAYLOAD_SECRET, 'unsubscribe:' + email)) and the endpoint finds the row by
 * the stored `unsubscribeTokenHash` only (src/retention/subscribers.ts unsubscribeByToken). The hash is written when
 * the row is created; nothing recomputes it when the email changes. Customers → Subscribers → edit Email (e.g. the
 * customer asks us to fix a typo) keeps the OLD address's hash, so every later marketing email to the corrected
 * address (refill reminders, with List-Unsubscribe headers) carries a link that answers "That unsubscribe link
 * didn't work" (303 ?unsubscribed=invalid; the RFC 8058 one-click POST gets 404) while the row stays "confirmed".
 *
 * Correct behaviour: the link in any marketing email we send to a subscriber unsubscribes them.
 *
 * (Fix-round correction: the consent on the row was given for the typo address, and only an address's owner puts it
 * on the list — DPDP, double opt-in, retention-backend.md. So the corrected address is emailed a confirmation link and
 * is pending until its owner clicks it; the test now clicks it before ordering. The assertion under test is unchanged.)
 */
import { test, expect } from '../../fixtures.js';
import { confirmLink, subscribeAndConfirm, unsubscribeLink } from '../../accounts/helpers.js';

test('the unsubscribe link still works after the admin corrected the subscriber’s email', async ({ api, admin, adminSession, unique, db, cron, mailpit }) => {
	test.setTimeout(90_000);
	const typo = unique.email('w5typo');
	const fixed = unique.email('w5fixed');
	await subscribeAndConfirm({ api, mailpit, unique }, { email: typo });
	const sub = await admin.findSubscriber(typo);
	expect(sub.status).toBe('confirmed');

	// Customers → Subscribers → the row → Email corrected → Save.
	const edit = await adminSession.request('PATCH', `subscribers/${sub.id}?depth=0`, { body: { email: fixed } });
	expect(edit.status, edit.text.slice(0, 200)).toBe(200);
	expect((await admin.findSubscriber(fixed))?.status).toBe('pending');
	const optIn = await mailpit.waitForMessage({ to: fixed, subjectIncludes: 'Confirm your Wefeasto subscription', timeout: 30_000 });
	expect((await fetch(confirmLink(mailpit, optIn), { redirect: 'manual' })).status).toBe(303);
	await expect.poll(async () => (await admin.findSubscriber(fixed))?.status, { timeout: 15_000 }).toBe('confirmed');

	// They order with the corrected address and tick the box again; the refill reminder goes out later.
	const o = await api.placeOrder({ items: { 'health-mix': 1 }, method: 'cod', consent: true, form: { email: fixed } });
	await expect.poll(async () => (await db.jobs({ orderNumber: o.number, task: 'refillReminder' })).length, { timeout: 20_000 }).toBe(1);
	await db.makeJobsDue({ orderNumber: o.number, task: 'refillReminder' });
	expect((await cron.runJobs()).status).toBe(200);
	const refill = await mailpit.waitForMessage({ to: fixed, subjectIncludes: 'Running low', timeout: 30_000 });

	const res = await fetch(unsubscribeLink(mailpit, refill), { redirect: 'manual' });
	expect(res.status).toBe(303);
	const after = await admin.findSubscriber(fixed);
	expect({ location: res.headers.get('location'), status: after?.status }).toEqual({
		location: expect.stringMatching(/\?unsubscribed=1#newsletter$/),
		status: 'unsubscribed'
	});
});
