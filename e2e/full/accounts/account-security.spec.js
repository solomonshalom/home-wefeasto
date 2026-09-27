/*
 * Account security edges (roadmap S3 "Access" + edge cases; cms-hardening.md §1–2;
 * cms-foundation customers access): the session is only an HttpOnly first-party cookie,
 * customers see only themselves and their own orders (REST `where` tricks included), a
 * customer can't verify itself or change its login email, the password rule applies to
 * a change too, a password reset ends every other session and lifts a lockout, logging
 * out closes orders/mine.
 */
import { test, expect } from '../fixtures.js';
import { COPY, NEW_PASSWORD, SUBJECT, apiLogin, createCustomer, logInUI, me, notice, openLogin, pageFetch, placeOrderAs, resetLink, sfApi, waitAccountReady } from './helpers.js';

test.describe('account security', () => {
	test('the session is an HttpOnly, Secure, SameSite=Lax cookie on the storefront host; never in JS or a JSON body', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'cookie' });
		await openLogin(page, shop);
		const res = await logInUI(page, email.toUpperCase()); // the login email is case-insensitive
		expect(res.status()).toBe(200);
		expect((await res.json()).token).toBeUndefined();
		await waitAccountReady(page);
		const cookies = (await page.context().cookies()).filter((c) => c.name === 'payload-token');
		expect(cookies).toHaveLength(1);
		expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', domain: new URL(stack.sfUrl).hostname });
		expect(await page.evaluate(() => document.cookie)).not.toContain('payload-token');
		const meBody = await pageFetch(page, 'GET', '/api/customers/me');
		expect(meBody.json.user.email).toBe(email);
		expect(meBody.json.token).toBeUndefined();
	});

	test("customer A can't read or change customer B, nor any order through REST (where tricks included)", async ({ page, shop, stack, mailpit, unique, admin, newContext }) => {
		const a = await createCustomer({ stack, mailpit, unique }, { tag: 'sec-a' });
		const b = await createCustomer({ stack, mailpit, unique }, { tag: 'sec-b', name: 'Bee' });
		const ctxB = await newContext();
		const pageB = await ctxB.newPage();
		await pageB.goto('/shop');
		await apiLogin(pageB, null, b.email);
		const bOrder = await placeOrderAs(pageB, null, unique, { items: { cornflakes: 1 }, form: { email: b.email } });
		const bId = (await admin.findCustomer(b.email)).id;

		await apiLogin(page, shop, a.email);
		const list = await pageFetch(page, 'GET', '/api/customers?limit=100&depth=0');
		expect(list.status).toBe(200);
		expect(list.json.docs.map((d) => d.email)).toEqual([a.email]);
		const byWhere = await pageFetch(page, 'GET', `/api/customers?where[email][equals]=${encodeURIComponent(b.email)}`);
		expect(byWhere.json?.docs ?? []).toEqual([]);
		expect([403, 404]).toContain((await pageFetch(page, 'GET', `/api/customers/${bId}`)).status);
		expect([403, 404]).toContain((await pageFetch(page, 'PATCH', `/api/customers/${bId}`, { name: 'Hacked' })).status);
		expect((await admin.findCustomer(b.email)).name).toBe('Bee');

		for (const q of ['', `?where[number][equals]=${bOrder.number}`, `?where[customer][equals]=${bId}`, `?where[contact.email][equals]=${encodeURIComponent(b.email)}`]) {
			const r = await pageFetch(page, 'GET', `/api/orders${q}`);
			expect(r.status === 403 || (r.status === 200 && r.json.docs.length === 0), `GET /api/orders${q} → ${r.status} ${r.text.slice(0, 120)}`).toBe(true);
		}
		const mine = await pageFetch(page, 'GET', '/api/store/orders/mine');
		expect(mine.status).toBe(200);
		expect(mine.json.orders).toEqual([]);
	});

	test("a customer can't mark itself verified, change its login email, or set a short password", async ({ page, shop, stack, mailpit, unique, admin }) => {
		const email = unique.email('sec-self');
		const r = await sfApi(stack, 'POST', 'customers', { name: 'Asha', email, password: 'breakfast-club-2026', _verified: true });
		expect(r.status).toBe(201);
		expect((await admin.findCustomer(email))._verified).toBe(false);
		await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.VERIFY });
		const denied = await sfApi(stack, 'POST', 'customers/login', { email, password: 'breakfast-club-2026' });
		expect(denied.status).toBe(403);

		const { email: other } = await createCustomer({ stack, mailpit, unique }, { tag: 'sec-self2' });
		await apiLogin(page, shop, other);
		const id = (await admin.findCustomer(other)).id;
		const change = await pageFetch(page, 'PATCH', `/api/customers/${id}`, { email: unique.email('sec-new') });
		expect(change.status).toBe(400);
		expect((await admin.findCustomer(other)).email).toBe(other);
		const weak = await pageFetch(page, 'PATCH', `/api/customers/${id}`, { password: 'short77' });
		expect(weak.status).toBe(400);
		expect(weak.json.errors.flatMap((e) => e.data?.errors ?? []).find((e) => e.path === 'password')?.message).toMatch(/at least 8/);
		const badPhone = await pageFetch(page, 'PATCH', `/api/customers/${id}`, { phone: '98452' });
		expect(badPhone.status).toBe(400);
		expect(await me(page)).toMatchObject({ email: other });
	});

	test('a password reset signs out every other device and lifts a lockout', async ({ page, shop, stack, mailpit, unique, newContext }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'sec-reset' });
		const ctxA = await newContext();
		const deviceA = await ctxA.newPage();
		await deviceA.goto('/shop');
		await apiLogin(deviceA, null, email);
		expect(await me(deviceA)).toMatchObject({ email });

		// Locked out on this device …
		await openLogin(page, shop);
		for (let i = 0; i < 5; i++) await logInUI(page, email, `nope-${i}-password`);
		await logInUI(page, email);
		await expect(notice(page)).toHaveText(COPY.LOCKED);
		// … so reset the password.
		await page.locator('[data-wf-forgot]').click();
		await page.fill('#wf-forgot-email', email);
		await page.click('#wf-forgot-form button[type="submit"]');
		const link = resetLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.RESET }));
		await page.goto(link);
		await page.fill('#wf-reset-password', NEW_PASSWORD);
		await page.fill('#wf-reset-confirm', NEW_PASSWORD);
		await page.click('#wf-reset-form button[type="submit"]');
		await page.waitForURL((u) => u.pathname === '/login');
		expect((await logInUI(page, email, NEW_PASSWORD)).status(), 'the lockout is lifted by the reset').toBe(200);
		await waitAccountReady(page);

		expect(await me(deviceA), 'the other device was signed out').toBeNull();
	});

	test('after logout, orders/mine answers 401 and the verification resend stays silent for a verified account', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'sec-logout' });
		await apiLogin(page, shop, email);
		expect((await pageFetch(page, 'GET', '/api/store/orders/mine')).status).toBe(200);
		expect((await pageFetch(page, 'POST', '/api/customers/logout')).status).toBe(200);
		expect((await pageFetch(page, 'GET', '/api/store/orders/mine')).status).toBe(401);

		const r = await sfApi(stack, 'POST', 'store/account/resend-verification', { email });
		expect(r).toMatchObject({ status: 200, text: '{"ok":true}' });
		const subjects = (await mailpit.settle(email, { quietMs: 2500 })).map((m) => m.Subject);
		expect(subjects, 'only the original verification email').toEqual([SUBJECT.VERIFY]);
	});
});
