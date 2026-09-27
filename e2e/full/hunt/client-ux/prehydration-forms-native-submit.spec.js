/*
 * Hunt (client-ux, sf-account): a form used before the page's JavaScript has hydrated falls back to
 * the browser's native submission, and what the customer did is lost.
 *
 * - /login "Log In" (and Sign Up / Forgot — same markup: <form method="post"> with an enabled submit
 *   button): the email + password are form-POSTed to the static host (/login), the page reloads with
 *   an empty form and no message; the customer is not logged in.
 * - Home newsletter (<form method="get">): GET /?email=<address>&website= — the address lands in the
 *   address bar / history / host logs, the page reloads, and nobody is subscribed.
 *
 * On a first visit over mobile data this window is several seconds (Fast 3G, no cache: /login is
 * visible at ~2.5 s and hydrated at ~7.4 s), and password-manager autofill + Enter takes one. The
 * checkout already guards against exactly this (Pay is disabled until mounted); these forms don't.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/prehydration-forms-native-submit.spec.js
 */
import { test, expect, waitHydrated } from '../../fixtures.js';
import { createCustomer, PASSWORD } from '../../accounts/helpers.js';
import { holdHydration, recordDocuments } from './helpers.js';

test('/login: Log In pressed before hydration never form-POSTs the password to the page, and the typed email survives', async ({ page, stack, mailpit, unique }) => {
	const { email } = await createCustomer({ stack, mailpit, unique });
	const docs = recordDocuments(page);
	const release = await holdHydration(page);
	await page.goto('/login', { waitUntil: 'domcontentloaded' });
	await page.fill('#wf-login-email', email);
	await page.fill('#wf-login-password', PASSWORD);
	await page.locator('#wf-login-password').press('Enter'); // autofill + Enter, a second after the page shows
	await page.waitForTimeout(1000);
	release();
	await waitHydrated(page);
	await page.waitForTimeout(1500);

	const posts = docs.filter((d) => d.method === 'POST');
	expect(posts.map((d) => `${d.method} ${new URL(d.url).pathname} ${d.body.replace(/password=[^&]*/, 'password=***')}`), 'no native form POST of the credentials to the static host').toEqual([]);
	// Either the tap was honoured (logged in → /account) or the form still holds what was typed.
	const onAccount = new URL(page.url()).pathname === '/account';
	if (!onAccount) await expect(page.locator('#wf-login-email'), 'the typed email is still there').toHaveValue(email);
});

test('home newsletter: Submit before hydration never puts the email address into the URL', async ({ page, unique }) => {
	const email = unique.email('nl');
	const docs = recordDocuments(page);
	const release = await holdHydration(page);
	await page.goto('/', { waitUntil: 'domcontentloaded' });
	await page.fill('#email', email);
	await page.locator('#email').press('Enter');
	await page.waitForTimeout(1000);
	release();
	await waitHydrated(page);
	await page.waitForTimeout(1500);

	const leaked = docs.filter((d) => decodeURIComponent(d.url).includes(email)).map((d) => `${d.method} ${d.url}`);
	expect(leaked, 'no navigation carries the address in its URL').toEqual([]);
	expect(decodeURIComponent(page.url()), 'the address bar never shows the address').not.toContain(email);
	await expect(page.locator('#email'), 'the typed address is still in the field (nothing was lost)').toHaveValue(email);
});
