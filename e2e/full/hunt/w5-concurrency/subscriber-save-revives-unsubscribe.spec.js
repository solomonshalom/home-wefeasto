/*
 * W5-CONC: an admin Save of a newsletter subscriber writes back the `status` (and `unsubscribedAt`) the page
 * loaded. Subscribers has no row lock and no stale-form check (unlike Orders / Coupons / Products /
 * Customers), and the Payload admin form sends every field. So a subscriber who unsubscribes (the emailed
 * link or the RFC 8058 one-click POST from their mail app) while an admin has their page open is put back on
 * the list as `confirmed` by the admin's Save of an unrelated field: refill reminders and newsletters go out
 * again to someone who withdrew consent (retention/refill.ts only skips `unsubscribed`).
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/subscriber-save-revives-unsubscribe.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { subscribeAndConfirm, unsubscribeLink } from '../../accounts/helpers.js';
import { adminLogin } from './helpers.js';

test.use({ failOnConsoleErrors: false });

const statusOf = async (db, email) => (await db.query('select status, unsubscribed_at from subscribers where email = $1', [email]))[0];

test('REST: saving a subscriber form loaded before they unsubscribed keeps them unsubscribed', async ({ api, mailpit, unique, adminSession, db }) => {
	const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'w5-sub' });
	const sub = (await adminSession.ok('GET', `subscribers?where[email][equals]=${encodeURIComponent(email)}&depth=0`)).docs[0];
	expect(sub.status).toBe('confirmed');

	// They click "unsubscribe" in the welcome email while the admin has their page open.
	const res = await fetch(unsubscribeLink(mailpit, welcome), { redirect: 'manual' });
	expect(res.status).toBe(303);
	expect((await statusOf(db, email)).status).toBe('unsubscribed');

	// The admin saves the page (fixing the consent note): the form as loaded + that one change.
	const { id, createdAt, updatedAt, ...form } = sub;
	const r = await adminSession.request('PATCH', `subscribers/${sub.id}?depth=0`, { body: { ...form, consentText: `${form.consentText ?? ''} (checked)` } });
	const after = await statusOf(db, email);
	if (r.status === 200) expect(after.status, 'status after the admin saved a page loaded before the unsubscribe').toBe('unsubscribed');
	else expect([400, 409]).toContain(r.status);
});

test('consequence: after that Save the unsubscribed customer still gets the refill reminder', async ({ api, admin, mailpit, unique, adminSession, db, cron }) => {
	test.setTimeout(120_000);
	await admin.setStock('rolled-oats', 50);
	const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'w5-sub' });
	const order = await api.placeOrder({ items: { 'rolled-oats': 1 }, method: 'cod', form: { email }, consent: true });
	await expect.poll(async () => (await db.jobs({ orderNumber: order.number, task: 'refillReminder' })).length, { timeout: 15_000 }).toBe(1);
	const sub = (await adminSession.ok('GET', `subscribers?where[email][equals]=${encodeURIComponent(email)}&depth=0`)).docs[0];

	expect((await fetch(unsubscribeLink(mailpit, welcome), { redirect: 'manual' })).status).toBe(303);
	const { id, createdAt, updatedAt, ...form } = sub;
	expect((await adminSession.request('PATCH', `subscribers/${sub.id}?depth=0`, { body: { ...form, source: 'newsletter (market stall)' } })).status).toBe(200);

	await db.makeJobsDue({ orderNumber: order.number, task: 'refillReminder' });
	expect((await cron.runJobs()).status).toBe(200);
	await mailpit.settle(email, { quietMs: 3000 });
	const subjects = (await mailpit.messages(email)).map((m) => m.Subject);
	expect(subjects.filter((s) => /^Running low on /.test(s)), 'marketing email to an address that unsubscribed').toEqual([]);
});

test('admin UI: Save of a subscriber page opened before the one-click unsubscribe keeps them unsubscribed', async ({ page, stack, api, mailpit, unique, db }) => {
	test.setTimeout(120_000);
	const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'w5-sub' });
	const [{ id }] = await db.query('select id from subscribers where email = $1', [email]);
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/subscribers/${id}`);
	const source = page.locator('#field-source');
	await source.waitFor({ timeout: 30_000 });
	// The admin starts editing (Payload's stale-data check runs once, on the first change: nothing moved yet).
	await source.fill('newsletter (stall at Koramangala market)');
	await page.waitForTimeout(1500);

	// The subscriber's mail app sends the RFC 8058 one-click unsubscribe.
	const url = unsubscribeLink(mailpit, welcome);
	const oc = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
	expect(oc.status).toBe(200);
	expect((await statusOf(db, email)).status).toBe('unsubscribed');

	const saved = page.waitForResponse((r) => r.url().includes(`/api/subscribers/${id}`) && r.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	const res = await saved;
	const after = await statusOf(db, email);
	if (res.status() === 200) expect(after, 'the subscriber after the admin Save').toMatchObject({ status: 'unsubscribed' });
	else expect(after.status).toBe('unsubscribed');
});
