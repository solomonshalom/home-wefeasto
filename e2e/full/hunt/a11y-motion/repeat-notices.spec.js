/*
 * HUNT a11y-motion (sf-account): a message that repeats word for word is never announced
 * again (WCAG 4.1.3 Status Messages).
 *
 * /login's #wf-auth-notice (role=status, aria-live=polite) and /reset-password's
 * #wf-reset-notice (role=alert) only speak when their text changes in the DOM. When the
 * next attempt ends with the same words, nothing in either region changes:
 *
 *   - /login: a second wrong password → showNotice() sees the same text and only plays the
 *     visual shake (no DOM change); focus stays in the password field it was already in.
 *   - /login "Forgot password?": asking again for the same address → same neutral copy, no
 *     DOM change, focus back on the (re-enabled) button.
 *   - /reset-password: a second too-short password → `error = null` and `error = {...}`
 *     land in the same flush, so the {#if error} alert is neither removed nor re-inserted.
 *
 * A sighted customer sees the notice shake or stay; a screen-reader user who presses Enter
 * again hears nothing at all and cannot tell whether the attempt failed, is still running,
 * or worked. /checkout already solves this ("cleared first, so the same words twice are
 * still spoken twice" in its live region) and /account clears its note before saving.
 *
 * The assertion: during the repeated attempt, text is (re-)inserted into a live region
 * (a childList/characterData mutation that carries the message), which is what makes
 * assistive technology speak it.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/repeat-notices.spec.js
 */
import { test, expect } from '../../fixtures.js';

/** Record text that lands inside any live region (aria-live, role=status|alert) from now on. */
const recordLiveText = (page) =>
	page.evaluate(() => {
		const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]';
		window.__liveText = [];
		new MutationObserver((ms) => {
			for (const m of ms) {
				const t = m.type === 'characterData' ? m.target.parentElement : m.target;
				const added = m.type === 'characterData' ? [m.target] : [...m.addedNodes];
				const inLive = (n) => (n.nodeType === 1 ? n.closest(LIVE) || n.querySelector?.(LIVE) : n.parentElement?.closest(LIVE));
				for (const n of added) {
					const text = (n.textContent || '').trim();
					if (text && (inLive(n) || (t && t.closest && t.closest(LIVE)))) window.__liveText.push(text);
				}
			}
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
const liveText = (page) => page.evaluate(() => window.__liveText.join(' | '));

test('/login: a second wrong password is announced again', async ({ page, shop, unique }) => {
	await shop.visit('/login');
	await page.fill('#wf-login-email', unique.email('hunt-rep-login'));
	await page.fill('#wf-login-password', 'wrong-password-1');
	await Promise.all([page.waitForResponse('**/api/customers/login'), page.locator('#wf-login-password').press('Enter')]);
	const notice = page.locator('#wf-auth-notice');
	await expect(notice).toContainText('don’t match');
	await page.waitForTimeout(600); // fade-in done

	await recordLiveText(page);
	await page.fill('#wf-login-password', 'wrong-password-2');
	await Promise.all([page.waitForResponse('**/api/customers/login'), page.locator('#wf-login-password').press('Enter')]);
	await page.waitForTimeout(600);
	await expect(notice).toContainText('don’t match');
	expect(await liveText(page), 'the second "don’t match" reaches a live region again').toContain('don’t match');
});

test('/login: asking for a reset link twice announces the second answer', async ({ page, shop, unique }) => {
	await shop.visit('/login');
	await page.getByRole('button', { name: /forgot password/i }).click();
	await page.fill('#wf-forgot-email', unique.email('hunt-rep-forgot'));
	await Promise.all([page.waitForResponse('**/api/customers/forgot-password'), page.locator('#wf-forgot-email').press('Enter')]);
	const notice = page.locator('#wf-auth-notice');
	await expect(notice).toContainText('reset link is on its way');
	await page.waitForTimeout(600);

	await recordLiveText(page);
	await Promise.all([page.waitForResponse('**/api/customers/forgot-password'), page.locator('#wf-forgot-email').press('Enter')]);
	await page.waitForTimeout(600);
	expect(await liveText(page), 'the second "reset link is on its way" reaches a live region again').toContain('reset link is on its way');
});

test('/reset-password: a second too-short password is announced again', async ({ page, shop }) => {
	await shop.visit('/reset-password?token=' + 'a'.repeat(40));
	const pw = page.locator('#wf-reset-password');
	await pw.fill('short');
	await page.fill('#wf-reset-confirm', 'short');
	await page.locator('#wf-reset-confirm').press('Enter');
	const alert = page.locator('#wf-reset-notice');
	await expect(alert).toContainText('at least 8 characters');
	await expect(pw).toBeFocused();

	await recordLiveText(page);
	await pw.fill('short2');
	await pw.press('Enter');
	await page.waitForTimeout(400);
	await expect(alert).toContainText('at least 8 characters');
	expect(await liveText(page), 'the second "at least 8 characters" reaches the alert again').toContain('at least 8 characters');
});
