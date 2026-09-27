/*
 * HUNT-CONC-5 (cms-platform, src/collections/Customers.ts + Users.ts `auth.useSessions: true`): Payload keeps
 * the login sessions in an array on the customer (user) document, and a login appends its session by
 * rewriting that array from the copy it read. Two logins of the same account that overlap (phone + laptop,
 * a double-submitted sign-in form, two admins sharing an account) therefore each write "old sessions + mine";
 * the later write drops the earlier session, so one of the two freshly signed-in browsers is silently signed
 * out (GET /api/customers/me → user: null). Sequential logins keep both sessions.
 */
import { test, expect } from '../../fixtures.js';

test('two overlapping logins of one customer both stay signed in', async ({ stack, adminSession, unique }) => {
	const email = unique.email('hunt-login');
	const password = 'correct-horse-battery-9';
	const created = await adminSession.request('POST', 'customers?depth=0', { body: { email, password, name: 'Hunt Login', _verified: true } });
	expect(created.status).toBe(201);
	const id = created.json.doc.id;

	const login = async () => {
		const r = await fetch(`${stack.cmsUrl}/api/customers/login`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: stack.sfUrl }, body: JSON.stringify({ email, password }) });
		expect(r.status).toBe(200);
		return /payload-token=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
	};
	const signedIn = async (token) => {
		const r = await fetch(`${stack.cmsUrl}/api/customers/me`, { headers: { Cookie: `payload-token=${token}`, Origin: stack.sfUrl } });
		return Boolean((await r.json()).user);
	};

	try {
		// control: one after the other, both sessions survive
		const s1 = await login();
		const s2 = await login();
		expect([await signedIn(s1), await signedIn(s2)]).toEqual([true, true]);

		for (let i = 0; i < 3; i++) {
			const tokens = await Promise.all([login(), login()]);
			expect(await Promise.all(tokens.map(signedIn)), `round ${i}: both browsers that just signed in are still signed in`).toEqual([true, true]);
		}
	} finally {
		await adminSession.request('DELETE', `customers/${id}`);
	}
});
