/*
 * Forgot / reset password (roadmap S3 edge case "password reset token reuse";
 * storefront-account.md §2 /reset-password; cms-hardening.md §2): the emailed link,
 * the old password stops working, the token works once, the newest link replaces older
 * ones, the 8-character rule on both sides (a refused short password keeps the token).
 */
import { test, expect } from '../fixtures.js';
import { COPY, NEW_PASSWORD, PASSWORD, SUBJECT, createCustomer, logInUI, me, notice, openLogin, resetLink, sfApi, waitAccountReady } from './helpers.js';

/** /login → Forgot password? → send the link for `email`; resolves once the notice shows. */
async function requestReset(page, shop, email) {
	await openLogin(page, shop);
	await page.locator('[data-wf-forgot]').click();
	await expect(page.locator('#wf-panel-forgot')).toBeVisible();
	await page.fill('#wf-forgot-email', email);
	await page.click('#wf-forgot-form button[type="submit"]');
	await expect(notice(page)).toHaveText(COPY.forgotSent(email));
}

/** Open a reset link and submit `password` twice (or `confirm`). */
async function submitReset(page, link, password, confirm = password) {
	await page.goto(link);
	await expect(page.locator('#wf-reset-form')).toBeVisible();
	await expect.poll(() => new URL(page.url()).searchParams.has('token'), { message: 'token stripped' }).toBe(false);
	await page.fill('#wf-reset-password', password);
	await page.fill('#wf-reset-confirm', confirm);
	await page.click('#wf-reset-form button[type="submit"]');
}

test.describe('accounts: forgot / reset password', { tag: '@slow' }, () => {
	test('forgot → email → /reset-password → /login?reset=1 → old password refused, new one works', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'reset', name: 'Kavya Iyer' });
		await requestReset(page, shop, email);
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.RESET });
		const link = resetLink(mailpit, msg);
		expect(new URL(link).origin).toBe(stack.sfUrl);

		const res = page.waitForResponse((r) => r.url().endsWith('/api/customers/reset-password'));
		await submitReset(page, link, NEW_PASSWORD);
		const body = await (await res).json();
		expect(body.token, 'no JWT in the reset body (cms-hardening §1)').toBeUndefined();
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(notice(page)).toHaveText(COPY.RESET_DONE);
		expect(await me(page), 'reset does not leave a session behind').toBeNull();

		const old = await logInUI(page, email, PASSWORD);
		expect(old.status()).toBe(401);
		await expect(notice(page)).toHaveText(COPY.WRONG_CREDENTIALS);
		const ok = await logInUI(page, email, NEW_PASSWORD);
		expect(ok.status()).toBe(200);
		await waitAccountReady(page);
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Kavya.');
	});

	test('a used reset link is refused ("ask for a new one" → forgot panel), and a newer link replaces an older one', async ({ page, shop, stack, mailpit, unique, db }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'reset-reuse' });
		await requestReset(page, shop, email);
		const first = resetLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.RESET }));
		// Payload sends at most one reset email per 15 s per account (forgotPassword.minRequestInterval):
		// move the last request back instead of waiting.
		await db.query("update customers set reset_password_requested_at = now() - interval '1 minute' where email = $1", [email]);
		await requestReset(page, shop, email);
		const msgs = await mailpit.waitForMessages({ to: email, subjectIncludes: SUBJECT.RESET, count: 2 });
		const second = resetLink(mailpit, msgs[msgs.length - 1]);
		expect(second).not.toBe(first);

		// The older link no longer works.
		await submitReset(page, first, NEW_PASSWORD);
		await expect(page.locator('#wf-reset-notice')).toHaveText(COPY.RESET_INVALID);

		// The newest works once …
		await submitReset(page, second, NEW_PASSWORD);
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(notice(page)).toHaveText(COPY.RESET_DONE);
		// … and only once.
		await submitReset(page, second, 'third-password-2026');
		await expect(page.locator('#wf-reset-notice')).toHaveText(COPY.RESET_INVALID);
		const again = page.locator('[data-wf-reset-again]');
		await expect(again).toHaveAttribute('href', '/login?forgot=1');
		await again.click();
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(page.locator('#wf-panel-forgot')).toBeVisible();

		// The password is the one set by the newest link.
		await page.locator('[data-wf-back-to-login]').click();
		expect((await logInUI(page, email, NEW_PASSWORD)).status()).toBe(200);
	});

	test('short and mismatched passwords are refused on the page; the server refuses < 8 and keeps the token usable', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'reset-weak' });
		await requestReset(page, shop, email);
		const link = resetLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.RESET }));
		const token = new URL(link).searchParams.get('token');

		let posted = 0;
		page.on('request', (r) => r.url().endsWith('/api/customers/reset-password') && posted++);
		await submitReset(page, link, 'short77');
		await expect(page.locator('#wf-reset-notice')).toHaveText(COPY.WEAK_PASSWORD);
		await expect(page.locator('#wf-reset-password')).toHaveAttribute('aria-invalid', 'true');
		await page.fill('#wf-reset-password', NEW_PASSWORD);
		await page.fill('#wf-reset-confirm', NEW_PASSWORD + 'x');
		await page.click('#wf-reset-form button[type="submit"]');
		await expect(page.locator('#wf-reset-notice')).toHaveText(COPY.PASSWORD_MISMATCH);
		await expect(page.locator('#wf-reset-confirm')).toHaveAttribute('aria-invalid', 'true');
		expect(posted, 'client rules stop both before any request').toBe(0);

		// Server rule (a client that skips the page's checks): 400 on password, token untouched.
		const weak = await sfApi(stack, 'POST', 'customers/reset-password', { token, password: 'short77' });
		expect(weak.status, weak.text.slice(0, 200)).toBe(400);
		const fieldErrors = weak.json?.errors?.flatMap((e) => e.data?.errors ?? []) ?? [];
		expect(fieldErrors.find((e) => e.path === 'password')?.message).toMatch(/at least 8/i);

		await submitReset(page, link, NEW_PASSWORD);
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(notice(page)).toHaveText(COPY.RESET_DONE);
		expect((await logInUI(page, email, NEW_PASSWORD)).status()).toBe(200);
	});

	test('a reset link older than an hour is refused (the notice promised one hour)', async ({ page, shop, stack, mailpit, unique, db }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'reset-hour' });
		await requestReset(page, shop, email);
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.RESET });
		const [row] = await db.query('select reset_password_expiration from customers where email = $1', [email]);
		const ttl = new Date(row.reset_password_expiration).getTime() - Date.now();
		expect(ttl).toBeGreaterThan(55 * 60_000);
		expect(ttl).toBeLessThanOrEqual(60 * 60_000 + 5_000);
		await db.query("update customers set reset_password_expiration = now() - interval '1 minute' where email = $1", [email]);
		await submitReset(page, resetLink(mailpit, msg), NEW_PASSWORD);
		await expect(page.locator('#wf-reset-notice')).toHaveText(COPY.RESET_INVALID);
		await openLogin(page, shop);
		expect((await logInUI(page, email, PASSWORD)).status(), 'the old password still works').toBe(200);
	});

	test('missing or malformed token → "incomplete" notice + a new-link button; unknown email → same notice, no email', async ({ page, shop, mailpit, unique }) => {
		for (const q of ['', '?token=', '?token=not%20a%20token!']) {
			await shop.visit(`/reset-password${q}`);
			await expect(page.locator('[data-wf-reset-missing]')).toBeVisible();
			await expect(page.locator('#wf-reset-form')).toHaveCount(0);
		}
		const nobody = unique.email('reset-nobody');
		await requestReset(page, shop, nobody);
		expect(await mailpit.settle(nobody, { quietMs: 2500 })).toEqual([]);
	});
});
