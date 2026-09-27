/*
 * Accounts, newsletter and the welcome offer when the browser's storage is unusable
 * (a full quota: every Storage method throws; Safari "block all cookies": the
 * localStorage getter throws). The session is a cookie, so signing in must still work;
 * the nav hint can't be kept, so the nav asks /me instead. The welcome offer lives in
 * memory for the visit (client-side navigation only, as a real visitor would click).
 */
import { test, expect } from '../fixtures.js';
import { COPY, SUBJECT, confirmLink, createCustomer, expectHomeNotice, logInUI, navAccount, notice, subscribeAndConfirm } from './helpers.js';

test.describe('storage throws (quota)', () => {
	test.use({ variant: 'storage-throws' });

	test('log in → /account → the nav knows (asks /me) → log out', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'st-login', name: 'Tara Sen' });
		await page.goto('/login');
		await shop.waitHydrated();
		await expect(page.locator('#wf-login-form')).toBeVisible();
		expect((await logInUI(page, email)).status()).toBe(200);
		await page.waitForURL((u) => u.pathname === '/account');
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Tara.');
		await shop.clientNav('/shop');
		await expect(navAccount(page)).toHaveAttribute('href', '/account');
		await shop.clientNav('/account');
		await page.locator('[data-wf-logout]').click();
		await page.waitForURL((u) => u.pathname === '/');
		await expect(navAccount(page)).toHaveAttribute('href', '/login');
	});

	test('the welcome offer from the email link applies at checkout within the visit', async ({ page, shop, stack, api, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'st-offer' });
		await page.goto(`${stack.sfUrl}/cart?offer=${code}`);
		await shop.waitHydrated();
		await shop.addToCart('muesli', 1); // client-side: the in-memory bag and offer survive
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'cod', email });
		await expect(page.locator(`[data-wf-offer="${code}"]`)).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹25');
	});
});

test.describe('storage blocked (Safari "block all cookies")', () => {
	test.use({ variant: 'storage-blocked' });

	test('newsletter: subscribe on / → confirm link → /?subscribed=1 notice', async ({ page, shop, admin, mailpit, unique }) => {
		const email = unique.email('sb-nl');
		await page.goto('/');
		await shop.waitHydrated();
		const form = page.locator('#email-form-2');
		await form.locator('input[name="email"]').fill(email);
		await form.locator('input[type="submit"]').click();
		await expect(form).toHaveAttribute('data-wf-nl-state', 'success');
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM });
		await page.goto(confirmLink(mailpit, msg));
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		await expect.poll(async () => (await admin.findSubscriber(email))?.status).toBe('confirmed');
	});

	test('/login?verify= and logging in still work', async ({ page, shop, stack, mailpit, unique }) => {
		const { email, verifyUrl } = await createCustomer({ stack, mailpit, unique }, { tag: 'sb-verify', verify: false });
		await page.goto(verifyUrl);
		await shop.waitHydrated();
		await expect(notice(page)).toHaveText(COPY.VERIFIED);
		expect((await logInUI(page, email)).status()).toBe(200);
		await page.waitForURL((u) => u.pathname === '/account');
		await expect(page.locator('[data-wf-hello]')).toBeVisible();
	});
});
