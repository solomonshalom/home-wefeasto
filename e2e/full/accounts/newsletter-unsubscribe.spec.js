/*
 * Leaving and re-joining the list (roadmap M6; retention-backend.md §1, §5): the emailed
 * unsubscribe link (GET → /?unsubscribed=1), the RFC 8058 one-click POST from the
 * List-Unsubscribe header, bad links, re-subscribing (pending again, a fresh confirmation,
 * no second welcome), and the checkout consent box. Consent must come from the address owner
 * (retention-backend.md, order.confirmed → retention:checkout-consent): a guest's ticked box makes a
 * PENDING subscriber (source 'checkout') and sends the double-opt-in confirmation email; it never turns
 * an unsubscribe into a subscription (the owner has to click a link). Only an order placed signed in, by
 * a verified account with that email, subscribes at once. No box → no subscriber.
 */
import { test, expect } from '../fixtures.js';
import {
	COPY,
	SUBJECT,
	apiLogin,
	confirmLink,
	createCustomer,
	expectHomeNotice,
	header,
	placeOrderAs,
	subscribeAndConfirm,
	unsubscribeLink
} from './helpers.js';

/** The URL inside the List-Unsubscribe header (<https://…>). */
async function oneClickUrl(mailpit, msg) {
	const [lu] = header(await mailpit.headers(msg.ID), 'List-Unsubscribe');
	const m = String(lu).match(/<(https?:\/\/[^>]+)>/);
	expect(m, `List-Unsubscribe: ${lu}`).toBeTruthy();
	return m[1];
}

/** POST it the way mail providers do (RFC 8058). */
const oneClick = (url) =>
	fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', redirect: 'manual' });

test.describe('newsletter: unsubscribe', () => {
	test('the unsubscribe link in the welcome email → /?unsubscribed=1 (form kept) → row unsubscribed; clicking again is fine', async ({ page, shop, admin, api, mailpit, unique }) => {
		const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'nl-unsub' });
		const link = unsubscribeLink(mailpit, welcome);
		await page.goto(link);
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_UNSUBSCRIBED, formHidden: false });
		const row = await admin.findSubscriber(email);
		expect(row.status).toBe('unsubscribed');
		expect(row.unsubscribedAt).toBeTruthy();

		await page.goto(link);
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_UNSUBSCRIBED, formHidden: false });
	});

	test('unknown or missing unsubscribe token → /?unsubscribed=invalid', async ({ page, shop, stack }) => {
		for (const q of ['?t=bm90LWEtcmVhbC10b2tlbg', '']) {
			await page.goto(`${stack.cmsUrl}/api/store/newsletter/unsubscribe${q}`);
			await expectHomeNotice(page, shop, { tone: 'fail', text: COPY.NL_UNSUB_INVALID });
		}
	});

	test('RFC 8058 one-click POST to the List-Unsubscribe URL → 200 {ok:true}, idempotent; unknown → 404, no token → 400', async ({ stack, admin, api, mailpit, unique }) => {
		const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'nl-oneclick' });
		const url = await oneClickUrl(mailpit, welcome);
		expect(url).toBe(unsubscribeLink(mailpit, welcome)); // the same token as the body link

		const r1 = await oneClick(url);
		expect(r1.status).toBe(200);
		expect(await r1.json()).toEqual({ ok: true });
		expect((await admin.findSubscriber(email)).status).toBe('unsubscribed');
		const r2 = await oneClick(url);
		expect(r2.status).toBe(200);

		const unknown = await oneClick(`${stack.cmsUrl}/api/store/newsletter/unsubscribe?t=bm90LWEtcmVhbC10b2tlbg`);
		expect(unknown.status).toBe(404);
		const none = await oneClick(`${stack.cmsUrl}/api/store/newsletter/unsubscribe`);
		expect(none.status).toBe(400);
	});

	test('re-subscribing after unsubscribing: pending again, a new confirmation at once, the old link stays dead, no second welcome', async ({ page, shop, admin, api, mailpit, unique }) => {
		const { email, welcome, confirmUrl, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'nl-resub' });
		expect(code).toMatch(/^HELLO-/);
		expect((await oneClick(await oneClickUrl(mailpit, welcome))).status).toBe(200);

		// The confirm link from before can't re-subscribe anyone.
		await page.goto(confirmUrl);
		await expectHomeNotice(page, shop, { tone: 'fail', text: COPY.NL_EXPIRED });
		expect((await admin.findSubscriber(email)).status).toBe('unsubscribed');

		await shop.visit('/');
		const form = page.locator('#email-form-2');
		await form.locator('input[name="email"]').fill(email);
		await form.locator('input[type="submit"]').click();
		await expect(form).toHaveAttribute('data-wf-nl-state', 'success');
		await expect.poll(async () => (await admin.findSubscriber(email))?.status).toBe('pending');
		const confirms = await mailpit.waitForMessages({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM, count: 2 });
		const fresh = confirmLink(mailpit, confirms[confirms.length - 1]);
		expect(fresh).not.toBe(confirmUrl);

		await page.goto(fresh);
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		await expect.poll(async () => (await admin.findSubscriber(email))?.status).toBe('confirmed');
		const all = await mailpit.settle(email, { quietMs: 2500 });
		expect(all.filter((m) => m.Subject.startsWith("You're in")), 'the welcome (and its code) is once per address, ever').toHaveLength(1);
	});
});

test.describe('newsletter: checkout consent', () => {
	test('guest box ticked → PENDING subscriber (source checkout) + the confirmation email; its link subscribes (no welcome code: they ordered)', async ({ page, shop, admin, mailpit }) => {
		const { number, form } = await shop.placeCodOrder({ items: { cornflakes: 1 }, form: { consent: true } });
		await mailpit.waitForMessage({ to: form.email, subjectIncludes: `Order ${number} placed` });
		const confirm = await mailpit.waitForMessage({ to: form.email, subjectIncludes: SUBJECT.NL_CONFIRM });
		const row = await admin.findSubscriber(form.email);
		expect(row).toMatchObject({ status: 'pending', source: 'checkout', email: form.email.toLowerCase() });
		expect(row.consentText).toBeTruthy();
		expect((await admin.findOrder(number)).consent?.marketing).toBe(true);

		await page.goto(confirmLink(mailpit, confirm));
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		expect((await admin.findSubscriber(form.email)).status).toBe('confirmed');
		const subjects = (await mailpit.settle(form.email, { quietMs: 2500 })).map((m) => m.Subject);
		expect(subjects.filter((s) => s.includes(SUBJECT.NL_CONFIRM))).toHaveLength(1);
		expect(subjects.filter((s) => s.startsWith("You're in") && /% off/.test(s)), 'no first-order code for someone who ordered').toEqual([]);
	});

	test('consent box left unticked → no subscriber row', async ({ page, shop, admin, mailpit }) => {
		await shop.setCart({ 'steel-cut-oats': 1 });
		await shop.gotoCheckout();
		await expect(page.locator('#wf-co-consent')).not.toBeChecked(); // opt-in, never pre-ticked
		const form = await shop.fillCheckout({ method: 'cod' });
		await page.locator('#wf-place-order').click();
		await shop.waitOrderView(['confirmed']);
		const { number } = shop.orderFromUrl();
		await mailpit.waitForMessage({ to: form.email, subjectIncludes: `Order ${number} placed` });
		await mailpit.settle(form.email, { quietMs: 2500 }); // the order event has run (the email is sent from it)
		expect(await admin.findSubscriber(form.email)).toBeNull();
		expect((await admin.findOrder(number)).consent?.marketing).toBe(false);
	});

	test('signed in with a verified account, same email: subscribed at once, no confirmation email', async ({ page, shop, stack, admin, mailpit, unique }) => {
		const acct = await createCustomer({ stack, mailpit, unique }, { tag: 'nl-acct-consent' });
		await apiLogin(page, shop, acct.email);
		const o = await placeOrderAs(page, shop, unique, { items: { cornflakes: 1 }, method: 'cod', consent: true, form: { email: acct.email } });
		await mailpit.waitForMessage({ to: acct.email, subjectIncludes: `Order ${o.number} placed` });
		await expect.poll(async () => (await admin.findSubscriber(acct.email))?.status).toBe('confirmed');
		expect((await admin.findSubscriber(acct.email)).source).toBe('checkout');
		const subjects = (await mailpit.settle(acct.email, { quietMs: 2000 })).map((m) => m.Subject);
		expect(subjects.filter((s) => s.includes(SUBJECT.NL_CONFIRM))).toEqual([]);
	});
});

test.describe('newsletter: checkout consent edges', () => {
	/** A consent order for a fresh address; resolves once its subscriber row exists (order events after it have run). */
	async function control(api, admin) {
		const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', consent: true });
		await expect.poll(async () => (await admin.findSubscriber(o.form.email))?.status, { message: 'control subscriber' }).toBe('pending');
	}

	test('online order with the box ticked: no subscriber until it is paid, then pending + the confirmation email', async ({ api, admin, mock, mailpit }) => {
		const o = await api.placeOrder({ items: { 'rolled-oats': 1 }, method: 'upi', consent: true });
		expect(o.status).toBe('pending_payment');
		await control(api, admin);
		expect(await admin.findSubscriber(o.form.email), 'an unpaid order asks nothing').toBeNull();

		expect((await mock.pay(o.payment.razorpayOrderId, 'success', { method: 'upi' })).status).toBe(200);
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: `Order ${o.number} confirmed` });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.NL_CONFIRM });
		expect(await admin.findSubscriber(o.form.email)).toMatchObject({ status: 'pending', source: 'checkout' });
	});

	test('signed up (pending), then ordered with the box ticked: still pending, no second email; the first link still subscribes', async ({ page, shop, api, admin, mailpit, unique }) => {
		const email = unique.email('nl-pending-order');
		expect((await api.newsletter(email)).status).toBe(200);
		const link = confirmLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM }));
		const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', consent: true, form: { email } });
		await mailpit.waitForMessage({ to: email, subjectIncludes: `Order ${o.number} placed` });
		expect((await admin.findSubscriber(email)).status).toBe('pending');

		await page.goto(link);
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		expect((await admin.findSubscriber(email)).status).toBe('confirmed');
		const all = await mailpit.settle(email, { quietMs: 2500 });
		expect(all.filter((m) => m.Subject.includes(SUBJECT.NL_CONFIRM))).toHaveLength(1);
		// They have an order now: a welcome without a code, if any.
		expect(all.map((m) => m.Subject).filter((s) => s.startsWith("You're in") && /% off/.test(s))).toEqual([]);
	});

	test('unsubscribed: a ticked box never re-subscribes by itself; it emails a link, and only the owner’s click does', async ({ page, shop, api, admin, db, mailpit, unique, mock }) => {
		const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'nl-consent-unsub' });
		const phone = unique.phone();
		expect((await oneClick(await oneClickUrl(mailpit, welcome))).status).toBe(200);
		expect((await admin.findSubscriber(email)).status).toBe('unsubscribed');

		// Minutes after the sign-up (confirmation cooldown): a ticked COD order sends nothing and changes nothing.
		const cod = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', consent: true, form: { email, phone } });
		await mailpit.waitForMessage({ to: email, subjectIncludes: `Order ${cod.number} placed` });
		await control(api, admin);
		expect((await admin.findSubscriber(email)).status).toBe('unsubscribed');

		// Later (the sign-up was long ago): a ticked, paid order emails a confirmation link; still unsubscribed.
		expect(await db.query("update subscribers set last_confirm_sent_at = now() - interval '1 hour' where email = $1 returning id", [email])).toHaveLength(1);
		const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'upi', consent: true, form: { email, phone } });
		expect((await mock.pay(o.payment.razorpayOrderId, 'success', { method: 'upi' })).status).toBe(200);
		await mailpit.waitForMessage({ to: email, subjectIncludes: `Order ${o.number} confirmed` });
		const confirms = await mailpit.waitForMessages({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM, count: 2 });
		expect((await admin.findSubscriber(email)).status).toBe('unsubscribed');

		await page.goto(confirmLink(mailpit, confirms.at(-1)));
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		expect((await admin.findSubscriber(email)).status).toBe('confirmed');
		const subjects = (await mailpit.settle(email, { quietMs: 2000 })).map((m) => m.Subject);
		expect(subjects.filter((s) => s.startsWith("You're in")), 'no second welcome').toHaveLength(1);
	});
});
