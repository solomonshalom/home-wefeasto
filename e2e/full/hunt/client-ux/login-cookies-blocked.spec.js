/*
 * Hunt (client-ux): with cookies blocked (Safari "Block All Cookies" — the same setting the
 * storage-blocked variant models), the right password gets "Welcome back! Taking you to your
 * account…", then /account finds no session and bounces straight back to an empty /login with
 * no message at all. The customer can repeat this forever without learning why. The page should
 * say that cookies are needed to log in (and never claim success when the session didn't stick).
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/login-cookies-blocked.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { createCustomer, openLogin, notice, PASSWORD } from '../../accounts/helpers.js';
import { blockCookies } from './helpers.js';

test('cookies blocked: the right password explains that cookies are needed instead of silently bouncing back to /login', async ({ page, shop, stack, mailpit, unique }) => {
	const { email } = await createCustomer({ stack, mailpit, unique });
	await blockCookies(page);
	await openLogin(page, shop);
	await page.fill('#wf-login-email', email);
	await page.fill('#wf-login-password', PASSWORD);
	await page.locator('#wf-login-password').press('Enter');

	// Whatever the page does next, the customer must end up told why they are not logged in.
	await expect(notice(page), 'a notice explains that cookies are blocked').toContainText(/cookie/i, { timeout: 15_000 });
	await expect(page.locator('#wf-login-email'), 'still on the log-in form (no session)').toBeVisible();
});
