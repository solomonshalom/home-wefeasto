/*
 * Hunt (client-ux, sf-account): the emailed one-shot links drop their token from the address bar
 * on mount, before it has done its job — so anything that makes the customer try again strands them.
 *
 * - /reset-password?token=…: one reload (pull-to-refresh, Android discarding the tab while the
 *   customer is in their password manager, "request desktop site") and the page says
 *   "This reset link is incomplete. Open the link from your email again" — the link was complete
 *   and still unused.
 * - /login?verify=…: the verify request hits a network blip → "We couldn't reach Wefeasto — check
 *   your connection and try again." But the token is already gone: reloading /login does nothing,
 *   and there is no retry control. The only way is back to the email, which the page doesn't say.
 *
 * Correct: the token survives on this tab until it has been used (e.g. sessionStorage / memory kept
 * across a reload), or the page offers a working retry.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/one-shot-links-stranded.spec.js
 */
import { test, expect, waitHydrated } from '../../fixtures.js';
import { createCustomer, sfApi, resetLink, SUBJECT, COPY, NEW_PASSWORD, notice } from '../../accounts/helpers.js';

test('/reset-password: a reload of an unused reset link still lets the customer choose a new password', async ({ page, stack, mailpit, unique }) => {
	const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'reset-reload' });
	const r = await sfApi(stack, 'POST', 'customers/forgot-password', { email });
	expect(r.status).toBe(200);
	const link = resetLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.RESET }));

	await page.goto(link);
	await waitHydrated(page);
	await expect(page.locator('#wf-reset-form')).toBeVisible();
	await page.reload(); // pull-to-refresh / the tab reloaded after a trip to the password manager
	await waitHydrated(page);
	await expect(page.locator('[data-wf-reset-missing]'), 'not "This reset link is incomplete"').toHaveCount(0);
	await expect(page.locator('#wf-reset-form')).toBeVisible();
	await page.fill('#wf-reset-password', NEW_PASSWORD);
	await page.fill('#wf-reset-confirm', NEW_PASSWORD);
	await page.click('#wf-reset-form button[type="submit"]');
	await page.waitForURL((u) => u.pathname === '/login');
	await expect(notice(page)).toHaveText(COPY.RESET_DONE);
});

test('/login?verify=: after a network blip on the verify request, "try again" can actually verify the email', async ({ page, stack, mailpit, unique, consoleErrors }) => {
	consoleErrors.allow(/Failed to load resource|net::ERR/);
	const { verifyUrl } = await createCustomer({ stack, mailpit, unique }, { tag: 'verify-blip', verify: false });
	let blip = true;
	await page.route('**/api/customers/verify/**', (route) => {
		if (!blip) return route.continue();
		blip = false;
		return route.abort('internetdisconnected');
	});
	await page.goto(verifyUrl);
	await waitHydrated(page);
	await expect(notice(page)).toContainText('try again');

	// Try again: a retry control if the page offers one, else what the copy implies — reload.
	const retry = page.locator('#wf-auth-notice, .wf-login-card').getByRole('button', { name: /try again|retry|verify/i });
	if (await retry.count()) await retry.first().click();
	else {
		await page.reload();
		await waitHydrated(page);
	}
	await expect(notice(page), 'the email gets verified on the second try').toHaveText(COPY.VERIFIED, { timeout: 15_000 });
});
