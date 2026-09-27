/*
 * /login "Send the link again" end to end (storefront-fixes; cms-hardening.md §4): the real
 * POST /api/store/account/resend-verification behind the storefront proxy, Payload's
 * verification email in Mailpit, and the rule that a new link replaces the old one.
 * Also /account → View for real orders (orders/mine carries the guest token).
 * Run: E2E_SLOT=4 npx playwright test --project=full e2e/full/account
 */
import { test, expect, waitOrderView } from '../fixtures.js';

const SENT = 'If that email needs verifying, a new link is on its way.';
const PASSWORD = 'breakfast-club-2026';

/** The storefront /login?verify=<token> link of a verification email. */
function verifyLink(mailpit, msg) {
	const link = mailpit.extractLinks(msg).find((l) => /\/login\?verify=[A-Za-z0-9_-]+/.test(l));
	expect(link, `a /login?verify= link in "${msg.Subject}"`).toBeTruthy();
	return link;
}

async function signUp(page, shop, email) {
	await shop.visit('/login');
	await page.click('#wf-tab-signup');
	await page.fill('#wf-signup-name', 'Asha Kumar');
	await page.fill('#wf-signup-email', email);
	await page.fill('#wf-signup-password', PASSWORD);
	await page.click('#wf-signup-form button[type="submit"]');
	await expect(page.locator('#wf-auth-notice')).toContainText(`we sent a link to ${email}`);
}

async function logIn(page, email) {
	await page.fill('#wf-login-email', email);
	await page.fill('#wf-login-password', PASSWORD);
	await page.click('#wf-login-form button[type="submit"]');
}

test.describe('account: resend verification', () => {
	test('sign up → Send the link again → a second email whose link verifies; the first link no longer works', async ({ page, shop, mailpit, unique }) => {
		const email = unique.email('resend');
		await signUp(page, shop, email);
		const first = await mailpit.waitForMessage({ to: email, subjectIncludes: 'Confirm your Wefeasto account' });
		const oldLink = verifyLink(mailpit, first);

		// From the signup notice.
		await page.locator('[data-wf-resend-verification]').click();
		await expect(page.locator('#wf-auth-notice')).toHaveText(SENT);
		await mailpit.waitForMessages({ to: email, count: 2 });

		// Still unverified: logging in offers the action again. (In production a repeat within 10 min
		// is silent; the e2e stack runs with rate limits off, so it may send one more — either is fine.)
		await logIn(page, email);
		await expect(page.locator('#wf-auth-notice')).toHaveText('Please verify your email — we sent you a link');
		await expect(page.locator('[data-wf-resend-verification]')).toBeVisible();
		await page.locator('[data-wf-resend-verification]').click();
		await expect(page.locator('#wf-auth-notice')).toHaveText(SENT);

		// Only the newest link works: every resend replaces the token.
		const summaries = await mailpit.settle(email, { quietMs: 3000 });
		expect(summaries.length).toBeGreaterThanOrEqual(2);
		const newest = await mailpit.message(summaries[summaries.length - 1].ID); // oldest first
		const newLink = verifyLink(mailpit, newest);
		expect(newLink).not.toBe(oldLink);
		await page.goto(oldLink);
		await expect(page.locator('#wf-auth-notice')).toContainText('This link has expired or was already used');
		await page.goto(newLink);
		await expect(page.locator('#wf-auth-notice')).toHaveText('Email verified — log in');
		await logIn(page, email);
		await page.waitForURL((u) => u.pathname === '/account');
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Asha.');
	});

	test('an unknown address gets the same neutral answer (no account probing)', async ({ page, shop, unique }) => {
		const email = unique.email('nobody');
		await shop.visit('/login');
		await logIn(page, email); // unknown: 401 → wrong-credentials copy, no resend action
		await expect(page.locator('#wf-auth-notice')).toContainText('don’t match');
		await expect(page.locator('[data-wf-resend-verification]')).toHaveCount(0);
		const r = await page.evaluate(async (e) => {
			const res = await fetch('/api/store/account/resend-verification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e }) });
			return { status: res.status, body: await res.text() };
		}, email);
		expect(r).toEqual({ status: 200, body: '{"ok":true}' });
	});
});

test.describe('account: orders → View', () => {
	test('every order on /account links to /order, which shows it', async ({ page, shop, mailpit, unique, admin }) => {
		const email = unique.email('acct-orders');
		await signUp(page, shop, email);
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: 'Confirm your Wefeasto account' });
		await page.goto(verifyLink(mailpit, msg));
		await expect(page.locator('#wf-auth-notice')).toHaveText('Email verified — log in');
		await logIn(page, email);
		await page.waitForURL((u) => u.pathname === '/account');

		// Signed in: these orders are linked to the customer.
		const cod = await shop.placeCodOrder({ items: { cornflakes: 1 }, form: { email } });
		const paid = await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'success', form: { email } });
		const numbers = [cod.number, paid.number];
		for (const n of numbers) expect((await admin.findOrder(n)).customer).toBeTruthy();

		const want = { [cod.number]: 'confirmed', [paid.number]: 'confirmed' };
		for (const n of numbers) {
			await shop.visit('/account');
			const view = page.locator(`.wf-order-row[data-wf-order="${n}"] [data-wf-view-order]`);
			await expect(view).toHaveAttribute('href', new RegExp(`^/order\\?no=${n}&t=[A-Za-z0-9_-]{43}$`));
			await view.click();
			expect(await waitOrderView(page, [want[n]])).toBe(want[n]);
			await expect(page.locator('#wf-co-order-no')).toHaveText(`Order ${n}`);
		}
	});
});
