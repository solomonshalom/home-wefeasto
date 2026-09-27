/*
 * HUNT a11y-motion (sf-account): submit buttons that go `disabled` while busy drop keyboard
 * focus to <body> once the request settles (WCAG 2.4.3). The login form and the forgot /
 * resend flows already move focus deliberately; these two don't:
 *
 *   - /account "Save details" (disabled={saving}) → "Saved — thanks!" → focus on <body>.
 *   - /login "Create Account" (disabled while busy) → "Check your email…" → focus on <body>.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/account-focus.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { signUpAndLogIn, ACCOUNT_PASSWORD } from '../../experience/helpers.js';
import { expectFocusKept, keyboardActivate } from './helpers.js';

test('/account: "Save details" by keyboard keeps focus', async ({ page, shop, mailpit, unique }) => {
	test.setTimeout(60_000);
	await signUpAndLogIn(page, { shop, mailpit, email: unique.email('hunt-a11y-save') });
	await page.fill('#wf-acct-name', 'Asha K');
	await keyboardActivate(page.locator('#wf-account-form button[type="submit"]'));
	await expect(page.locator('#wf-acct-note')).toHaveText(/Saved/);
	await expectFocusKept(page, 'account details saved');
});

test('/login: "Create Account" by keyboard keeps focus', async ({ page, shop, unique }) => {
	const email = unique.email('hunt-a11y-signup');
	await shop.visit('/login');
	await page.click('#wf-tab-signup');
	await page.fill('#wf-signup-name', 'Asha Kumar');
	await page.fill('#wf-signup-email', email);
	await page.fill('#wf-signup-password', ACCOUNT_PASSWORD);
	await keyboardActivate(page.locator('#wf-signup-form button[type="submit"]'));
	await expect(page.locator('#wf-auth-notice')).toContainText(`we sent a link to ${email}`);
	await expectFocusKept(page, 'sign-up done', { ms: 300 });
});
