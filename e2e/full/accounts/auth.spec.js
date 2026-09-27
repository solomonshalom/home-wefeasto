/*
 * Accounts (roadmap S3) end to end: sign up → verification email → /login?verify= →
 * log in → /account; unverified login + "Send the link again"; wrong password; Payload's
 * lockout after 5 bad passwords; the password rule on both sides; logout.
 * Real CMS (production build) behind the storefront proxy, real emails in Mailpit.
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/accounts
 */
import { test, expect } from '../fixtures.js';
import {
	COPY,
	PASSWORD,
	SUBJECT,
	apiLogin,
	createCustomer,
	customerId,
	footerAccount,
	logInUI,
	me,
	navAccount,
	notice,
	openLogin,
	sfApi,
	signUpUI,
	verifyLink,
	waitAccountReady
} from './helpers.js';

test.describe('accounts: sign up, verify, log in', () => {
	test('sign up → verification email → /login?verify= → "Email verified" → log in → /account', async ({ page, shop, mailpit, admin, unique }) => {
		const email = unique.email('signup');
		await openLogin(page, shop);
		await signUpUI(page, { name: 'Meera Nair', email });
		await expect(notice(page)).toHaveText(COPY.signupSent(email));
		await expect(page.locator('#wf-panel-login')).toBeVisible(); // back on Log In …
		await expect(page.locator('#wf-login-email')).toHaveValue(email); // … with the address filled

		const customer = await admin.findCustomer(email);
		expect(customer).toMatchObject({ email, name: 'Meera Nair', _verified: false });

		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.VERIFY });
		const link = verifyLink(mailpit, msg);
		expect(new URL(link).origin).toBe(new URL(page.url()).origin); // the storefront, never the CMS
		await page.goto(link);
		await expect(notice(page)).toHaveText(COPY.VERIFIED);
		await expect.poll(() => new URL(page.url()).searchParams.has('verify'), { message: 'token stripped from the address bar' }).toBe(false);
		expect((await admin.findCustomer(email))._verified).toBe(true);

		// The same link again: already used.
		await page.goto(link);
		await expect(notice(page)).toHaveText(COPY.VERIFY_INVALID);

		await logInUI(page, email);
		await waitAccountReady(page);
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Meera.');
		await expect(page.locator('#wf-acct-email')).toHaveValue(email);
		await expect(page.locator('[data-wf-orders-empty]')).toBeVisible();
		await expect(navAccount(page)).toHaveAttribute('href', '/account');
		await expect(navAccount(page)).toHaveAttribute('aria-label', 'Your account');
		await expect(footerAccount(page)).toHaveAttribute('href', '/account');
		await expect(footerAccount(page)).toHaveText('Account');
		expect((await me(page))?.email).toBe(email);
		// Exactly one account email so far (no duplicate verification mails).
		const all = await mailpit.settle(email, { quietMs: 1500 });
		expect(all.map((m) => m.Subject)).toEqual([SUBJECT.VERIFY]);
	});

	test('unverified login → "Send the link again" → a new email whose link verifies → log in works', async ({ page, shop, mailpit, stack, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { verify: false, tag: 'unverified' });
		await openLogin(page, shop);
		const res = await logInUI(page, email);
		expect(res.status()).toBe(403);
		await expect(notice(page)).toHaveText(COPY.UNVERIFIED);
		await expect(page.locator('[data-wf-resend-verification]')).toHaveText('Send the link again');
		await page.locator('[data-wf-resend-verification]').click();
		await expect(notice(page)).toHaveText(COPY.RESEND_SENT);
		await expect(page.locator('[data-wf-resend-verification]')).toHaveCount(0);
		await expect(page.locator('#wf-login-password')).toBeFocused();

		const both = await mailpit.waitForMessages({ to: email, subjectIncludes: SUBJECT.VERIFY, count: 2 });
		const newest = both[both.length - 1];
		await page.goto(verifyLink(mailpit, newest));
		await expect(notice(page)).toHaveText(COPY.VERIFIED);
		const ok = await logInUI(page, email);
		expect(ok.status()).toBe(200);
		await waitAccountReady(page);
	});

	test('sign up with an address that already has an account → "log in instead"', async ({ page, shop, mailpit, stack, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'taken' });
		await openLogin(page, shop);
		await signUpUI(page, { email: email.toUpperCase() }); // same address, other case
		await expect(notice(page)).toHaveText(COPY.EMAIL_TAKEN);
		await expect(page.locator('#wf-signup-email')).toHaveAttribute('aria-invalid', 'true');
	});
});

test.describe('accounts: wrong password, lockout, password rule', () => {
	test('wrong password and unknown email get the same copy and byte-identical 401s (no account oracle)', async ({ page, shop, mailpit, stack, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'wrongpw' });
		await openLogin(page, shop);
		const r1 = await logInUI(page, email, 'not-the-password');
		expect(r1.status()).toBe(401);
		await expect(notice(page)).toHaveText(COPY.WRONG_CREDENTIALS);
		const body1 = await r1.text();

		const r2 = await logInUI(page, unique.email('nobody'), 'not-the-password');
		expect(r2.status()).toBe(401);
		await expect(notice(page)).toHaveText(COPY.WRONG_CREDENTIALS);
		expect(await r2.text(), 'no account oracle: identical bodies').toBe(body1);
		expect(await me(page)).toBeNull();
	});

	test('lockout: 5 wrong passwords → even the right one is refused for 10 minutes → works after the lock', { tag: ['@serial', '@slow'] }, async ({ page, shop, mailpit, stack, unique, admin, db }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'lockout' });
		await openLogin(page, shop);
		for (let i = 1; i <= 5; i++) {
			const r = await logInUI(page, email, `wrong-password-${i}`);
			expect(r.status(), `attempt ${i}`).toBe(401);
			await expect(notice(page)).toHaveText(COPY.WRONG_CREDENTIALS);
		}
		const id = await customerId(admin, email);
		const [row] = await db.query('select login_attempts, lock_until from customers where id = $1', [id]);
		expect(row.lock_until, 'locked after the 5th bad password').toBeTruthy();
		const lockMs = new Date(row.lock_until).getTime() - Date.now();
		expect(lockMs).toBeGreaterThan(8 * 60_000);
		expect(lockMs).toBeLessThanOrEqual(10 * 60_000 + 5_000);

		const locked = await logInUI(page, email, PASSWORD);
		expect(locked.status()).toBe(401);
		await expect(notice(page)).toHaveText(COPY.LOCKED);
		expect(await me(page)).toBeNull();

		// Time travel: the lock ran out.
		await db.query("update customers set lock_until = now() - interval '1 minute' where id = $1", [id]);
		const ok = await logInUI(page, email, PASSWORD);
		expect(ok.status()).toBe(200);
		await waitAccountReady(page);
		const [after] = await db.query('select login_attempts from customers where id = $1', [id]);
		expect(Number(after.login_attempts), 'a good login resets the counter').toBe(0);
	});

	test('password rule: < 8 is refused by the page (no request) and by the server (400 on password), > 128 too', async ({ page, shop, stack, unique, admin }) => {
		const email = unique.email('weakpw');
		await openLogin(page, shop);
		let posted = 0;
		page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/customers' && posted++);
		await signUpUI(page, { email, password: 'short77' });
		await expect(notice(page)).toHaveText(COPY.WEAK_PASSWORD);
		await expect(page.locator('#wf-signup-password')).toHaveAttribute('aria-invalid', 'true');
		expect(posted, 'the client rule stops it before any request').toBe(0);

		// The server enforces the same rule (a client that skips the page's check).
		for (const [password, re] of [
			['short77', /at least 8/i],
			['x'.repeat(129), /under 129/i]
		]) {
			const r = await sfApi(stack, 'POST', 'customers', { name: 'Asha', email, password });
			expect(r.status, r.text.slice(0, 200)).toBe(400);
			const fieldErrors = r.json?.errors?.flatMap((e) => e.data?.errors ?? []) ?? [];
			expect(fieldErrors.find((e) => e.path === 'password')?.message).toMatch(re);
		}
		expect(await admin.findCustomer(email), 'no account was created').toBeNull();
		// Exactly 8 is fine.
		const r8 = await sfApi(stack, 'POST', 'customers', { name: 'Asha', email, password: '12345678' });
		expect(r8.status, r8.text.slice(0, 200)).toBe(201);
	});
});
