/*
 * Hunt (payments-security, round 4) — one anonymous request with a malformed-but-harmless parameter gets
 * 500 "Something went wrong." from the production CMS and writes an ERROR line with a full stack trace (and,
 * for the database ones, the whole failed SQL statement with its parameters) to the CMS log.
 *
 * None of these carry a NUL byte (that is data-cms round-1 "NUL byte in public auth input", a different
 * cause), and none are 4xx refusals (that is the round-2 "routine refusals logged at ERROR" finding, fixed by
 * downgrading 4xx APIErrors in src/lib/logging.ts). They are inputs Payload passes straight to Postgres or to
 * a field hook without checking their type:
 *   - GET /api/products/abc, /api/products/99999999999999999999   id not an integer / out of range
 *                                                                  → `invalid input syntax for type integer`
 *   - GET /api/products?page=-5                                    → negative OFFSET
 *   - GET /api/products?where[goesWith][near]=1,2                  → `near` on a relationship column
 *   - POST /api/customers {email: [...]}                           → TypeError `s.toLowerCase is not a function`
 *                                                                    in the auth email field's hook
 *   - POST /api/customers/login multipart `_payload` that isn't JSON → SyntaxError from JSON.parse
 * All are reachable without a session, directly or through the storefront's /api proxy, so any visitor can
 * produce a stream of 500s + ERROR stacks (alert noise, log cost, hiding real incidents).
 *
 * Correct behaviour: a 4xx (400 bad request / validation, or 404 for an id that can't exist), never a 500.
 */
import { test, expect } from '../../fixtures.js';

async function call(url, init = {}) {
	const r = await fetch(url, init);
	return { status: r.status, text: (await r.text()).slice(0, 160) };
}

test('malformed public REST input is refused with a 4xx, never a 500', async ({ stack, unique }) => {
	const cms = `${stack.cmsUrl}/api`;
	const sf = `${stack.sfUrl}/api`;
	const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: stack.sfUrl }, body: JSON.stringify(body) });
	const multipart = (payload) => {
		const fd = new FormData();
		fd.set('_payload', payload);
		return { method: 'POST', headers: { origin: stack.sfUrl }, body: fd };
	};

	const results = {
		'GET products/abc': await call(`${cms}/products/abc?depth=0`),
		'GET products/<huge id>': await call(`${cms}/products/99999999999999999999?depth=0`),
		'GET products?page=-5': await call(`${cms}/products?page=-5&depth=0`),
		'GET products?where[goesWith][near]': await call(`${cms}/products?where%5BgoesWith%5D%5Bnear%5D=1,2&depth=0`),
		'POST customers {email: []} (storefront proxy)': await call(
			`${sf}/customers`,
			json({ email: [unique.email('hps-arr')], password: 'breakfast-club-2026' })
		),
		'POST customers/login bad _payload (storefront proxy)': await call(`${sf}/customers/login`, multipart('{not json'))
	};

	const fiveHundreds = Object.fromEntries(Object.entries(results).filter(([, r]) => r.status >= 500));
	expect(fiveHundreds, JSON.stringify(results, null, 1)).toEqual({});
});
