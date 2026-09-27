/*
 * HUNT-CONC-R2-2: ten wrong-password sign-ins at once freeze the whole CMS for 30 s.
 *
 * The HUNT-CONC-5 fix (src/auth/loginSessions.ts) opens a transaction (one pool connection) at the start of
 * every REST login. A wrong password then makes Payload count the attempt with incrementLoginAttempts, which
 * deliberately runs WITHOUT req (payload/dist/auth/strategies/local/incrementLoginAttempts.js) and so needs a
 * SECOND pool connection while the first is held. With DATABASE_POOL_MAX (10, the default) such logins in
 * flight, every connection is held by a login waiting for another one: nothing progresses until pg's
 * connectionTimeoutMillis (30 s). Meanwhile every other request (catalog, checkout, verify, Razorpay
 * webhooks) waits for a connection too; the logins that time out answer 500 "Something went wrong" and log
 * "cannot begin transaction: timeout exceeded when trying to connect". Ten attempts is exactly the
 * production per-IP login limit (10/min), so one client can do this every minute.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/concurrency/login-pool-starvation.spec.js
 */
import { test, expect, uniqueEmail } from '../../fixtures.js';
import { cmsCall } from './helpers.js';

const POOL = 10; // scripts/e2e/config.mjs DATABASE_POOL_MAX = the production default (src/env.ts)

test('ten concurrent wrong-password logins neither fail nor stall the rest of the CMS', async ({ stack }) => {
	test.setTimeout(120_000);
	const emails = Array.from({ length: POOL }, () => uniqueEmail('hc-pool'));
	for (const email of emails) {
		const r = await cmsCall(stack, 'POST', 'customers', { body: { email, password: 'Correct-Horse-Battery-9', name: 'Pool Hunt' } });
		expect(r.status, r.text.slice(0, 200)).toBe(201);
	}

	const t0 = Date.now();
	const timed = (p) => p.then((r) => ({ status: r.status, ms: Date.now() - t0, body: r.text.slice(0, 100) }));
	const logins = emails.map((email) => timed(cmsCall(stack, 'POST', 'customers/login', { body: { email, password: 'not-the-password-1' } })));
	await new Promise((r) => setTimeout(r, 200));
	// A shopper browsing / checking out at the same moment.
	const catalog = timed(cmsCall(stack, 'GET', 'store/catalog'));
	const quote = timed(cmsCall(stack, 'POST', 'store/quote', { body: { items: [{ slug: 'cornflakes', qty: 1 }], method: 'upi' } }));
	const [results, cat, q] = await Promise.all([Promise.all(logins), catalog, quote]);

	const summary = `logins ${results.map((r) => `${r.status}@${r.ms}ms`).join(' ')} | catalog ${cat.status}@${cat.ms}ms | quote ${q.status}@${q.ms}ms`;
	expect.soft(results.map((r) => r.status), summary).toEqual(Array(POOL).fill(401));
	expect.soft(Math.max(...results.map((r) => r.ms)), `slowest wrong-password login (${summary})`).toBeLessThan(5_000);
	expect(Math.max(cat.ms, q.ms), `an unrelated shopper request waited (${summary})`).toBeLessThan(5_000);
});
