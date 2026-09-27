/*
 * Refill reminders (roadmap S2, retention-backend.md §5–§6) on the real stack: the /order
 * "Breakfast for how many?" answer → POST /api/store/orders/household → a refillReminder job timed
 * for that household → DB time travel + the jobs cron → exactly one "Running low" email with a
 * /cart?add=…&src=refill link and a working one-click unsubscribe. Also: a re-emitted
 * order.confirmed (the reconcile confirmation retry) never queues a second reminder, no consent
 * means no reminder, and a reorder before the reminder cancels it.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/orders/refill.spec.js
 */
import crypto from 'node:crypto';
import { test, expect, waitHydrated } from '../fixtures.js';
import { PAYLOAD_SECRET } from '../../../scripts/e2e/config.mjs';
import {
	apiOnlineOrder,
	apiCodOrder,
	mockPay,
	waitOrder,
	SUBJECT,
	subjectsTo,
	cartLinkIn,
	refillJobs,
	logKeys,
	bagOf,
	squash,
	staysEqual,
	paymentEntity,
	deliverWebhook,
	eventId,
	confirmOptIn,
	sortedSubjects
} from './helpers.js';

const DAY = 86_400_000;
const IST = 330 * 60_000;

/**
 * The documented plan (roadmap S2), computed independently of the CMS code:
 * runOut = clamp(min(qty × daysPerPack) / eaters, 7, 45); remind on the IST day of `paidAt`
 * + round(runOut × 0.75) − 2 days, at 10:00 IST (04:30 UTC).
 */
function expectedRemindAt(paidAt, lines, eaters) {
	const runOut = Math.min(45, Math.max(7, Math.min(...lines.map((l) => (l.qty * l.daysPerPack) / eaters))));
	const offset = Math.round(runOut * 0.75) - 2;
	const d = new Date(Date.parse(paidAt) + IST);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset, 4, 30)).toISOString();
}

const stamps = async (db, number) => (await refillJobs(db, number)).filter((j) => !j.completed_at).map((j) => j.input.stamp);

test.describe('refill reminders', { tag: ['@orders', '@refill', '@stateful'] }, () => {
	test('household answer on /order → re-timed job → time travel + jobs cron → one "Running low" email with refill link and unsubscribe', async ({
		page,
		shop,
		admin,
		db,
		cron,
		mailpit,
		stack,
		api,
		newContext
	}) => {
		const { daysPerPack } = await admin.getProduct('muesli');
		const { number, token, form } = await shop.placeOnlineOrder({ items: { muesli: 2 }, auto: 'success', form: { consent: true } });
		const paid = await waitOrder(admin, number, { status: 'paid', consent: { marketing: true } });
		const lines = [{ qty: 2, daysPerPack }];
		// A guest's ticked box asks the owner to confirm by email; reminders go to confirmed subscribers only.
		await confirmOptIn(mailpit, admin, form.email);

		// order.confirmed queued the default (2 eaters) reminder.
		await expect.poll(() => stamps(db, number), { message: 'h0 job queued on confirmation' }).toEqual(['h0']);
		expect(new Date((await refillJobs(db, number))[0].wait_until).toISOString()).toBe(expectedRemindAt(paid.paidAt, lines, 2));

		// "Breakfast for how many?" → 1: the reminder is re-timed for one eater.
		const saved = page.waitForResponse((r) => r.url().includes('/api/store/orders/household') && r.request().method() === 'POST');
		await page.locator('[data-wf-household="1"]').click();
		expect((await saved).status()).toBe(200);
		await expect(page.locator('[data-wf-household-saved]')).toBeVisible();
		await expect(page.locator('[data-wf-household="1"]')).toHaveAttribute('aria-pressed', 'true');
		await waitOrder(admin, number, { householdSize: 1 });
		await expect.poll(() => stamps(db, number), { message: 'h1 job queued for the answer' }).toEqual(['h0', 'h1']);
		const h1 = (await refillJobs(db, number)).find((j) => j.input.stamp === 'h1');
		expect(new Date(h1.wait_until).toISOString()).toBe(expectedRemindAt(paid.paidAt, lines, 1));

		// The same answer again changes nothing.
		expect((await api.post('store/orders/household', { number, token, size: 1 })).status).toBe(200);
		await staysEqual(() => stamps(db, number), ['h0', 'h1'], { ms: 1500 });

		// Time travel: both jobs due now; the cron runs them. The h0 one is stale and must stay quiet.
		expect(await db.makeJobsDue({ orderNumber: number, task: 'refillReminder' })).toHaveLength(2);
		expect((await cron.runJobs()).status).toBe(200);
		const msg = await mailpit.waitForMessage({ to: form.email, subjectIncludes: SUBJECT.refill });
		expect(msg.Subject).toBe('Running low on Muesli?');
		// "…should last until about <date>": the IST day it was paid + the one-eater run-out (2 × daysPerPack days).
		const paidIst = new Date(Date.parse(paid.paidAt) + IST);
		const runsOut = new Date(Date.UTC(paidIst.getUTCFullYear(), paidIst.getUTCMonth(), paidIst.getUTCDate() + Math.round(Math.min(45, Math.max(7, 2 * daysPerPack))), 4, 30));
		const until = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(runsOut);
		expect(squash(msg.Text)).toContain(`Your order ${number} (Muesli × 2) should last until about ${until}.`);
		const recipes = mailpit.extractLinks(msg).filter((l) => l.startsWith(`${stack.sfUrl}/recipes/`));
		expect(recipes.length, 'one recipe for the SKU').toBeGreaterThan(0);
		for (const r of new Set(recipes)) expect((await fetch(r)).status, `${r} exists on the storefront`).toBe(200);

		// One-tap refill link → the bag, attributed to the reminder.
		const refill = cartLinkIn(mailpit, msg, stack.sfUrl, 'refill');
		expect(new URL(refill).searchParams.get('add')).toBe('muesli:2');
		const ctx = await newContext();
		const p = await ctx.newPage();
		await p.goto(refill);
		await waitHydrated(p);
		await expect.poll(() => bagOf(p)).toEqual({ muesli: 2 });
		expect(await p.evaluate(() => JSON.parse(sessionStorage.getItem('wefeasto_src'))?.src)).toBe('refill');

		// One-click unsubscribe (link + RFC 8058 headers).
		const unsub = mailpit.extractLinks(msg).find((l) => l.startsWith(`${stack.cmsUrl}/api/store/newsletter/unsubscribe?t=`));
		expect(unsub, 'unsubscribe link in the reminder').toBeTruthy();
		const headers = await mailpit.headers(msg.ID);
		expect(headers['List-Unsubscribe']?.[0]).toContain(unsub);
		expect(headers['List-Unsubscribe-Post']?.[0]).toBe('List-Unsubscribe=One-Click');

		// A second cron run, and the jobs are gone: still exactly one reminder.
		expect((await cron.runJobs()).status).toBe(200);
		expect(await sortedSubjects(mailpit, form.email)).toEqual([SUBJECT.optIn, SUBJECT.confirmed(number), 'Running low on Muesli?', SUBJECT.welcome].sort());
		expect(await stamps(db, number)).toEqual([]);
		expect(await logKeys(admin, number)).toEqual(expect.arrayContaining([`refill:${number}:1`, `refill-queue:${number}:1:h0`, `refill-queue:${number}:1:h1`]));

		const res = await fetch(unsub, { redirect: 'manual' });
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(`${stack.sfUrl}/?unsubscribed=1#newsletter`);
		await expect.poll(async () => (await admin.findSubscriber(form.email))?.status).toBe('unsubscribed');
	});

	test('a re-emitted order.confirmed (reconcile confirmation retry) queues no second job; still exactly one reminder', async ({
		api,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		const o = await apiOnlineOrder(api, { items: { cornflakes: 1 }, consent: true });
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await waitOrder(admin, o.number, (d) => d.status === 'paid' && !!d.confirmationSentAt);
		await expect.poll(() => stamps(db, o.number)).toEqual(['h0']);
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		await confirmOptIn(mailpit, admin, o.form.email);

		// As if the first SMTP send had failed (sendOnce leaves the row 'failed', confirmationSentAt unset, the
		// message never arrives): reconcile section C sends it again and re-emits order.confirmed.
		expect(await mailpit.cleanup(o.form.email)).toBe(3); // the confirmation, the opt-in and the welcome
		const failed = await db.query("update message_log set status = 'failed' where key = $1 returning id", [`confirm:${o.number}`]);
		expect(failed).toHaveLength(1);
		await db.query('update orders set confirmation_sent_at = null where number = $1', [o.number]);
		const r = await cron.runReconcile({ order: o.number });
		expect(r.json).toMatchObject({ ok: true, confirmationsRetried: 1 });
		await waitOrder(admin, o.number, (d) => !!d.confirmationSentAt, { message: 're-stamped by the retry' });
		await staysEqual(() => stamps(db, o.number), ['h0'], { message: 'no second refill job' });
		expect(await subjectsTo(mailpit, o.form.email), 'the retried confirmation, once').toEqual([SUBJECT.confirmed(o.number)]);
		expect((await cron.runReconcile({ order: o.number })).json, 'nothing left to retry').toMatchObject({ confirmationsRetried: 0 });

		expect(await db.makeJobsDue({ orderNumber: o.number, task: 'refillReminder' })).toHaveLength(1);
		expect((await cron.runJobs()).status).toBe(200);
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.refill });
		expect((await cron.runJobs()).status).toBe(200);
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number), 'Running low on Cornflakes?']);
	});

	test('no marketing consent → no reminder is queued, even after a household answer', async ({ api, mock, admin, db, mailpit }) => {
		const o = await apiOnlineOrder(api, { items: { 'rolled-oats': 1 }, consent: false });
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		expect((await api.post('store/orders/household', { number: o.number, token: o.token, size: 2 })).status).toBe(200);
		await waitOrder(admin, o.number, { householdSize: 2, consent: { marketing: false } });
		await staysEqual(() => refillJobs(db, o.number), [], { message: 'no refill job without consent' });
		expect((await logKeys(admin, o.number)).filter((k) => k.startsWith('refill'))).toEqual([]);
	});

	test('the customer reorders before the reminder is due → that reminder is skipped', async ({ api, mock, admin, db, cron, mailpit }) => {
		const first = await apiOnlineOrder(api, { items: { 'choco-flakes': 1 }, consent: true });
		await mockPay(mock, first.rzpOrderId, 'success', { webhook: true });
		await mailpit.waitForMessage({ to: first.form.email, subjectIncludes: SUBJECT.confirmed(first.number) });
		await expect.poll(() => stamps(db, first.number)).toEqual(['h0']);
		await confirmOptIn(mailpit, admin, first.form.email); // so only the reorder can stop the reminder

		// Same person (email + phone) orders again, cash on delivery, without marketing consent.
		const second = await apiCodOrder(api, { items: { muesli: 1 }, consent: false, form: { email: first.form.email, phone: first.form.phone } });
		await mailpit.waitForMessage({ to: first.form.email, subjectIncludes: SUBJECT.codPlaced(second.number) });

		expect(await db.makeJobsDue({ orderNumber: first.number, task: 'refillReminder' })).toHaveLength(1);
		expect((await cron.runJobs()).status).toBe(200);
		await expect.poll(() => stamps(db, first.number), { message: 'the job ran' }).toEqual([]);
		expect(await sortedSubjects(mailpit, first.form.email)).toEqual(
			[SUBJECT.confirmed(first.number), SUBJECT.optIn, SUBJECT.welcome, SUBJECT.codPlaced(second.number)].sort()
		);
		expect(await logKeys(admin, first.number)).not.toContain(`refill:${first.number}:1`);
	});

	test('COD with consent: queued when placed (timed from the order date); returned to sender (RTO) or cancelled → no reminder', async ({
		api,
		admin,
		db,
		cron,
		mailpit
	}) => {
		const { daysPerPack } = await admin.getProduct('rolled-oats');
		const rto = await apiCodOrder(api, { items: { 'rolled-oats': 2 }, consent: true });
		const cancelled = await apiCodOrder(api, { items: { 'steel-cut-oats': 1 }, consent: true });
		for (const o of [rto, cancelled]) await expect.poll(() => stamps(db, o.number), { message: `${o.number} queued at cod_pending` }).toEqual(['h0']);
		const placed = await admin.findOrder(rto.number);
		expect(new Date((await refillJobs(db, rto.number))[0].wait_until).toISOString()).toBe(expectedRemindAt(placed.createdAt, [{ qty: 2, daysPerPack }], 2));

		// One comes back undelivered, the other is cancelled before it ships.
		await admin.shipOrder(rto.number);
		expect((await admin.updateOrder(rto.number, { fulfilmentStatus: 'rto' })).status).toBe(200);
		expect((await admin.cancelOrder(cancelled.number)).status).toBe(200);

		for (const o of [rto, cancelled]) expect(await db.makeJobsDue({ orderNumber: o.number, task: 'refillReminder' })).toHaveLength(1);
		expect((await cron.runJobs()).status).toBe(200);
		for (const o of [rto, cancelled]) await expect.poll(() => stamps(db, o.number), { message: `${o.number} job ran` }).toEqual([]);

		// (Each ticked box also emailed the opt-in link; nobody clicked it, and the orders stopped first anyway.)
		expect(await sortedSubjects(mailpit, rto.form.email)).toEqual([SUBJECT.codPlaced(rto.number), SUBJECT.optIn, SUBJECT.shipped(rto.number)].sort());
		expect(await sortedSubjects(mailpit, cancelled.form.email, { quietMs: 1000 })).toEqual([SUBJECT.codPlaced(cancelled.number), SUBJECT.optIn].sort());
		for (const o of [rto, cancelled]) expect(await logKeys(admin, o.number)).not.toContain(`refill:${o.number}:1`);
	});

	test('a paid order refunded in full from the Razorpay Dashboard → its reminder is skipped', async ({ stack, api, mock, admin, db, cron, mailpit }) => {
		const o = await apiOnlineOrder(api, { items: { 'steel-cut-oats': 1 }, consent: true });
		const paid = await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		await expect.poll(() => stamps(db, o.number)).toEqual(['h0']);

		const refundId = `rfnd_E2E${Math.random().toString(36).slice(2, 13).padEnd(11, '0')}`;
		const r = await deliverWebhook(stack, {
			event: 'refund.processed',
			payload: {
				refund: { id: refundId, entity: 'refund', amount: o.totalPaise, currency: 'INR', payment_id: paid.paymentId, notes: [], receipt: null, status: 'processed', speed_processed: 'normal', created_at: Math.floor(Date.now() / 1000) },
				payment: paymentEntity({ paymentId: paid.paymentId, rzpOrderId: o.rzpOrderId, amount: o.totalPaise, number: o.number, status: 'refunded', amountRefunded: o.totalPaise })
			},
			eventId: eventId('rfnd')
		});
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		await waitOrder(admin, o.number, { status: 'refunded', paymentStatus: 'refunded' });

		expect(await db.makeJobsDue({ orderNumber: o.number, task: 'refillReminder' })).toHaveLength(1);
		expect((await cron.runJobs()).status).toBe(200);
		await expect.poll(() => stamps(db, o.number), { message: 'the job ran' }).toEqual([]);
		expect((await subjectsTo(mailpit, o.form.email)).filter((x) => SUBJECT.refill.test(x))).toEqual([]);
		expect(await logKeys(admin, o.number)).not.toContain(`refill:${o.number}:1`);
	});

	test('unsubscribed after ordering → the reminder is skipped, and a late re-emit of order.confirmed never re-subscribes', async ({
		stack,
		api,
		mock,
		admin,
		db,
		cron,
		mailpit
	}) => {
		const o = await apiOnlineOrder(api, { items: { muesli: 1 }, consent: true });
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		await confirmOptIn(mailpit, admin, o.form.email); // checkout consent → the owner confirms → subscriber
		await expect.poll(() => stamps(db, o.number)).toEqual(['h0']);

		// One-click unsubscribe (RFC 8058 POST) with the address's documented token (retention-backend.md §4).
		const t = crypto.createHmac('sha256', PAYLOAD_SECRET).update(`unsubscribe:${o.form.email.toLowerCase()}`).digest('base64url');
		const un = await fetch(`${stack.cmsUrl}/api/store/newsletter/unsubscribe?t=${t}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
		expect(un.status).toBe(200);
		await expect.poll(async () => (await admin.findSubscriber(o.form.email))?.status).toBe('unsubscribed');

		// order.confirmed re-emitted by the reconcile confirmation retry (first send "failed").
		await mailpit.cleanup(o.form.email);
		await db.query("update message_log set status = 'failed' where key = $1", [`confirm:${o.number}`]);
		await db.query('update orders set confirmation_sent_at = null where number = $1', [o.number]);
		expect((await cron.runReconcile({ order: o.number })).json).toMatchObject({ confirmationsRetried: 1 });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		await staysEqual(async () => (await admin.findSubscriber(o.form.email))?.status, 'unsubscribed', { message: 'never re-subscribed by an old consent' });

		expect(await db.makeJobsDue({ orderNumber: o.number, task: 'refillReminder' })).toHaveLength(1);
		expect((await cron.runJobs()).status).toBe(200);
		await expect.poll(() => stamps(db, o.number), { message: 'the job ran' }).toEqual([]);
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number)]);
	});
});

