/*
 * Hunt (payments-security) — login CSRF: any website can sign a shopper's browser into the attacker's account.
 *
 * Payload's REST handlers read `multipart/form-data` bodies (JSON in a `_payload` part), and multipart is
 * a "simple" enctype an HTML form may POST cross-site without a CORS preflight. POST /api/customers/login
 * checks neither Origin nor Sec-Fetch-Site (Payload's `csrf` allow-list only guards reading the cookie),
 * and the response's Set-Cookie (SameSite=Lax) is stored because it answers a top-level navigation.
 * After a drive-by visit the shopper is silently signed in as the attacker: every order they then place is
 * linked to the attacker's customer id, so GET /api/store/orders/mine hands the attacker the guest tokens
 * (and POST /checkout/retry on an unpaid one returns the full name/email/phone in payment.prefill).
 */
import { test, expect } from '../../fixtures.js';

const ATTACKER_PAGE = 'http://attacker.example/win-a-hamper.html';

test('a cross-site form POST cannot sign the browser into another account', async ({ page, stack, adminSession, unique }) => {
	const attacker = { email: unique.email('hps-attacker'), password: 'attacker-password-2026' };
	await adminSession.ok('POST', 'customers?depth=0', { body: { ...attacker, _verified: true } });

	const payload = JSON.stringify(attacker).replace(/"/g, '&quot;');
	await page.route(`${ATTACKER_PAGE}*`, (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><form id="f" method="POST" enctype="multipart/form-data" action="${stack.sfUrl}/api/customers/login"><input type="hidden" name="_payload" value="${payload}"></form><script>document.getElementById('f').submit()</script>`
		})
	);

	await page.goto(ATTACKER_PAGE);
	await page.waitForURL(`${stack.sfUrl}/api/customers/login`);

	// Later the shopper opens the shop in the same browser.
	await page.goto(`${stack.sfUrl}/`);
	const me = await page.evaluate(async () => (await fetch('/api/customers/me', { credentials: 'include' })).json());
	expect(me.user?.email ?? null, 'the shop must not be signed in as the attacker').toBeNull();
});
