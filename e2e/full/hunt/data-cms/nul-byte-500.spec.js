/*
 * HUNT data-cms: a U+0000 (NUL) character in any string reaching Postgres makes the query fail
 * (`invalid byte sequence for encoding "UTF8": 0x00`) and Payload answers 500 "Something went wrong."
 * Anonymous callers can trigger it on the customer auth routes and on any REST `where` filter; a failed
 * signup also logs the whole INSERT with its parameters (salt, pbkdf2 hash, verification token) at ERROR.
 * The custom /api/store/* endpoints already refuse or strip it (checkout, newsletter, resend-verification).
 *
 * Correct behaviour: a 4xx (validation / bad request / invalid credentials), never a 500.
 */
import { test, expect } from '../../fixtures.js';

const NUL = '\u0000';

async function post(cmsUrl, path, body) {
	const r = await fetch(`${cmsUrl}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	return { status: r.status, text: (await r.text()).slice(0, 200) };
}

test('NUL in public auth input is a 4xx, not a 500', async ({ stack, unique }) => {
	const email = unique.email('nul');
	const results = {
		signup: await post(stack.cmsUrl, 'customers', { email, password: 'hunt-password-123', name: `Asha${NUL}K` }),
		login: await post(stack.cmsUrl, 'customers/login', { email: `a${NUL}${email}`, password: 'hunt-password-123' }),
		forgot: await post(stack.cmsUrl, 'customers/forgot-password', { email: `a${NUL}${email}` }),
		reset: await post(stack.cmsUrl, 'customers/reset-password', { token: `t${NUL}x`, password: 'hunt-password-123' }),
		verify: await post(stack.cmsUrl, `customers/verify/a${encodeURIComponent(NUL)}b`, {}),
		staffLogin: await post(stack.cmsUrl, 'users/login', { email: `a${NUL}b@wefeasto.test`, password: 'x-password-123' })
	};
	const where = await fetch(`${stack.cmsUrl}/api/products?where[slug][equals]=a%00b&depth=0`);
	results.whereFilter = { status: where.status, text: (await where.text()).slice(0, 200) };

	const fiveHundreds = Object.fromEntries(Object.entries(results).filter(([, r]) => r.status >= 500));
	expect(fiveHundreds, JSON.stringify(results, null, 1)).toEqual({});
});
