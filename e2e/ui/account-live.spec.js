/*
 * Unstubbed smoke: the storefront preview proxying /api to a real Payload CMS,
 * with Mailpit for the verification, reset and newsletter emails. Opt-in, so
 * the `ui` project stays CMS-free:
 *
 *   ACCOUNT_LIVE_CMS=1 PW_PORT=4400 npx playwright test --project=ui e2e/ui/account-live.spec.js
 *
 * Needs: `vite preview` on PW_PORT with CMS_URL pointing at a CMS whose
 * STOREFRONT_URL is that preview (email links) and whose STOREFRONT_ORIGINS
 * includes it (cookie auth), and Mailpit's API (MAILPIT_URL, default
 * http://127.0.0.1:54326). Every address is unique; only this test's own
 * messages are deleted.
 */
import { test, expect } from '@playwright/test';

const LIVE = process.env.ACCOUNT_LIVE_CMS === '1';
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:54326';

test.skip(!LIVE, 'set ACCOUNT_LIVE_CMS=1 (and run a CMS behind the preview) to run the live smoke');
test.describe.configure({ mode: 'serial' });

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const EMAIL = `acct-live-${stamp}@example.com`;
const NEWS_EMAIL = `acct-news-${stamp}@example.com`;
const PASSWORD = 'first-password-1';
const NEW_PASSWORD = 'second-password-2';

/** Wait for a message to `to` whose subject matches, and return its first link matching `re`. */
async function mailLink(request, to, subject, re, { timeout = 60_000 } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const res = await request.get(`${MAILPIT}/api/v1/search`, { params: { query: `to:"${to}"` } });
		const list = (await res.json()).messages ?? [];
		const msg = list.find((m) => subject.test(m.Subject));
		if (msg) {
			const full = await (await request.get(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
			const link = (full.HTML || full.Text || '').match(re)?.[0];
			if (link) return link.replace(/&amp;/g, '&');
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`no "${subject}" email for ${to}`);
}

async function deleteMine(request, to) {
	const res = await request.get(`${MAILPIT}/api/v1/search`, { params: { query: `to:"${to}"` } });
	const ids = ((await res.json()).messages ?? []).map((m) => m.ID);
	if (ids.length) await request.delete(`${MAILPIT}/api/v1/messages`, { data: { IDs: ids } });
}

async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

const notice = (page) => page.locator('#wf-auth-notice');

test.afterAll(async ({ request }) => {
	if (!LIVE) return;
	await deleteMine(request, EMAIL);
	await deleteMine(request, NEWS_EMAIL);
});

test('sign up → verify by email → log in → account → details → log out → reset password', async ({ page, request }) => {
	test.setTimeout(240_000);

	// sign up
	await page.goto('/login');
	await hydrated(page);
	await page.click('#wf-tab-signup');
	await page.fill('#wf-signup-name', 'Live Smoke');
	await page.fill('#wf-signup-email', EMAIL);
	await page.fill('#wf-signup-password', PASSWORD);
	await page.click('#wf-signup-form button[type="submit"]');
	await expect(notice(page)).toContainText('Check your email', { timeout: 30_000 });

	// not verified yet
	await page.fill('#wf-login-password', PASSWORD);
	await page.click('#wf-login-form button[type="submit"]');
	await expect(notice(page)).toHaveText('Please verify your email — we sent you a link', { timeout: 30_000 });

	// the emailed link: /login?verify=<token> on this storefront
	const verifyUrl = await mailLink(request, EMAIL, /Confirm your Wefeasto account/, /https?:\/\/[^"'\s<>]+\/login\?verify=[A-Za-z0-9%._-]+/);
	const verifyPath = new URL(verifyUrl).pathname + new URL(verifyUrl).search;
	await page.goto(verifyPath);
	await expect(notice(page)).toHaveText('Email verified — log in', { timeout: 30_000 });
	// …and readable once the motion is over (W2V-1: it froze mid-fade as a thin line)
	await page.waitForTimeout(800);
	expect(await notice(page).evaluate((el) => ({ opacity: getComputedStyle(el).opacity, style: el.getAttribute('style') || '' }))).toEqual({ opacity: '1', style: '' });
	expect((await notice(page).boundingBox()).height).toBeGreaterThanOrEqual(40);

	// log in → /account
	await page.fill('#wf-login-email', EMAIL);
	await page.fill('#wf-login-password', PASSWORD);
	await page.click('#wf-login-form button[type="submit"]');
	await page.waitForURL((u) => u.pathname === '/account', { timeout: 30_000 });
	await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Live.');
	await expect(page.locator('#wf-acct-email')).toHaveValue(EMAIL);
	// orders: a list, the empty state, or (backend not deployed yet) the retry state — never a crash
	await expect(page.locator('[data-wf-orders], [data-wf-orders-empty], [data-wf-orders-error]').first()).toBeVisible({ timeout: 30_000 });

	// the nav knows (after a reload, via the hint + /api/customers/me)
	await page.reload();
	await hydrated(page);
	await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/account');

	// details are saved to the CMS
	await page.fill('#wf-acct-phone', '98452 62777');
	await page.click('#wf-account-form button[type="submit"]');
	await expect(page.locator('#wf-acct-note')).toHaveText('Saved — thanks!', { timeout: 30_000 });
	const me = await page.evaluate(() => fetch('/api/customers/me').then((r) => r.json()));
	expect(me.user.phone).toBe('+919845262777');

	// log out → the session is gone server-side too
	await page.click('[data-wf-logout]');
	await page.waitForURL((u) => u.pathname === '/');
	expect((await page.evaluate(() => fetch('/api/customers/me').then((r) => r.json()))).user).toBeNull();
	await page.goto('/account');
	await page.waitForURL((u) => u.pathname === '/login');

	// forgot → emailed /reset-password?token= → new password → log in with it
	await hydrated(page);
	await page.fill('#wf-login-email', EMAIL);
	await page.click('[data-wf-forgot]');
	await page.click('#wf-forgot-form button[type="submit"]');
	await expect(notice(page)).toContainText('a reset link is on its way', { timeout: 30_000 });
	const resetUrl = await mailLink(request, EMAIL, /Reset your Wefeasto password/, /https?:\/\/[^"'\s<>]+\/reset-password\?token=[A-Za-z0-9%._-]+/);
	await page.goto(new URL(resetUrl).pathname + new URL(resetUrl).search);
	await hydrated(page);
	await page.fill('#wf-reset-password', NEW_PASSWORD);
	await page.fill('#wf-reset-confirm', NEW_PASSWORD);
	await page.click('#wf-reset-form button[type="submit"]');
	await page.waitForURL((u) => u.pathname === '/login', { timeout: 30_000 });
	await expect(notice(page)).toHaveText('Password updated — log in with your new password.');
	// the reset's own session was ended
	expect((await page.evaluate(() => fetch('/api/customers/me').then((r) => r.json()))).user).toBeNull();
	await page.fill('#wf-login-email', EMAIL);
	await page.fill('#wf-login-password', PASSWORD);
	await page.click('#wf-login-form button[type="submit"]');
	await expect(notice(page)).toHaveText('That email and password don’t match. Try again, or reset your password.', { timeout: 30_000 });
	await page.fill('#wf-login-password', NEW_PASSWORD);
	await page.click('#wf-login-form button[type="submit"]');
	await page.waitForURL((u) => u.pathname === '/account', { timeout: 30_000 });

	// the reset link is single-use
	await page.goto(new URL(resetUrl).pathname + new URL(resetUrl).search);
	await hydrated(page);
	await page.fill('#wf-reset-password', 'third-password-3');
	await page.fill('#wf-reset-confirm', 'third-password-3');
	await page.click('#wf-reset-form button[type="submit"]');
	await expect(page.locator('#wf-reset-notice')).toContainText('expired or was already used', { timeout: 30_000 });
});

test('newsletter: subscribe → confirmation email → confirm link → ?subscribed=1 notice', async ({ page, request }) => {
	test.setTimeout(180_000);
	const requests = [];
	page.on('request', (r) => requests.push(r.url()));
	await page.goto('/');
	await hydrated(page);
	await page.locator('#email').scrollIntoViewIfNeeded();
	await page.fill('#email', NEWS_EMAIL);
	await page.click('#email-form-2 input[type="submit"]');
	await expect(page.locator('.w-form-done')).toHaveText('Check your inbox to confirm — then breakfast recipes are on their way.', { timeout: 30_000 });
	expect(requests.filter((u) => /webflow\.com/.test(u))).toEqual([]);
	const confirmUrl = await mailLink(request, NEWS_EMAIL, /confirm/i, /https?:\/\/[^"'\s<>]+\/api\/store\/newsletter\/confirm\?t=[A-Za-z0-9%._-]+/);
	await page.goto(confirmUrl); // CMS origin → 303 → this storefront
	await page.waitForURL((u) => u.pathname === '/' && u.hash === '#newsletter', { timeout: 30_000 });
	await hydrated(page);
	await expect(page.locator('.w-form-done')).toHaveText('You’re subscribed — check your inbox for your welcome treat.');
	await expect.poll(() => new URL(page.url()).search).toBe('');
	// landed with the heading clear of the sticky nav (W2V-7), after the slide-in
	await page.waitForTimeout(2500);
	const l = await page.evaluate(() => {
		const nl = document.getElementById('newsletter');
		return {
			top: nl.getBoundingClientRect().top,
			heading: nl.querySelector('h2').getBoundingClientRect().top,
			nav: document.querySelector('.div-block-79').getBoundingClientRect().bottom
		};
	});
	expect(Math.abs(l.top - 96)).toBeLessThanOrEqual(2);
	expect(l.heading).toBeGreaterThanOrEqual(l.nav + 8);
});
