/*
 * HUNT-CONC-R4-1 (cms-platform, src/collections/Customers.ts + Users.ts `auth.useSessions`, src/auth/loginSessions.ts):
 * Payload's login adds its session by writing back the WHOLE account row it read before checking the password
 * (payload/dist/auth/sessions.js addSessionToUser: `db.updateOne({ data: user })` — hash, salt,
 * resetPasswordToken/Expiration, sessions, name, phone …). The HUNT-CONC-5 fix only serialises logins with each
 * other, so any other write to the account that commits while a login is in flight is silently undone:
 *   1. a password reset (POST /reset-password answers 200 "reset") is reverted: the NEW password is refused,
 *      the OLD one works again, every session the reset revoked is valid again, and the one-time reset link is
 *      revived. Someone who keeps signing in with a leaked password keeps the account after the owner resets it.
 *   2. the customer's own "Save details" (PATCH /api/customers/:id) answers 200 and is reverted.
 * The logins below are the only concurrency: a few sign-ins of the same account (other devices / an attacker's
 * script) spread over ~50 ms while the reset / save runs. With no overlapping login both work (control).
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';

const OLD = 'old-password-0000';

function client(stack) {
	return async (method, path, body, headers = {}) => {
		const r = await fetch(`${stack.cmsUrl}/api/${path}`, {
			method,
			headers: { 'content-type': 'application/json', Origin: stack.sfUrl, ...headers },
			body: body ? JSON.stringify(body) : undefined
		});
		const text = await r.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: r.status, json, token: /payload-token=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? null };
	};
}

const later = (ms, fn) => new Promise((r) => setTimeout(r, ms)).then(fn);

async function newCustomer(adminSession, unique, extra = {}) {
	const email = unique.email('hunt-r4-login');
	const r = await adminSession.request('POST', 'customers?depth=0', { body: { email, password: OLD, name: 'Old Name', phone: '+919800000001', _verified: true, ...extra } });
	expect(r.status).toBe(201);
	return { email, id: r.json.doc.id };
}

test.describe('a login never undoes another write to the account', () => {
	test.setTimeout(120_000);

	test('password reset overlapping sign-ins: the new password works, the old one and old sessions do not', async ({ stack, adminSession, unique, db }) => {
		const call = client(stack);
		const ids = [];
		try {
			for (const logins of [0, 4]) {
				const { email, id } = await newCustomer(adminSession, unique);
				ids.push(id);
				const before = await call('POST', 'customers/login', { email, password: OLD }); // e.g. the attacker's session
				expect(before.status).toBe(200);
				expect((await call('POST', 'customers/forgot-password', { email })).status).toBe(200);
				const [{ reset_password_token: token }] = await db.query('select reset_password_token from customers where email = $1', [email]);
				const next = `new-password-${crypto.randomBytes(4).toString('hex')}`;
				const [reset, ...signins] = await Promise.all([
					later(10, () => call('POST', 'customers/reset-password', { token, password: next })),
					...Array.from({ length: logins }, (_, k) => later(k * 15, () => call('POST', 'customers/login', { email, password: OLD })))
				]);
				expect(reset.status, 'the reset itself succeeds').toBe(200);
				const label = `${logins} overlapping sign-in(s): ${signins.map((s) => s.status).join(',') || 'none'}`;
				const now = {
					newPassword: (await call('POST', 'customers/login', { email, password: next })).status,
					oldPassword: (await call('POST', 'customers/login', { email, password: OLD })).status,
					sessionFromBeforeTheReset: Boolean((await call('GET', 'customers/me', undefined, { Cookie: `payload-token=${before.token}` })).json?.user),
					resetLinkAgain: (await call('POST', 'customers/reset-password', { token, password: `again-${next}` })).status
				};
				expect(now, label).toEqual({ newPassword: 200, oldPassword: 401, sessionFromBeforeTheReset: false, resetLinkAgain: 403 });
			}
		} finally {
			for (const id of ids) await adminSession.request('DELETE', `customers/${id}`);
		}
	});

	test('"Save details" overlapping sign-ins on other devices is kept', async ({ stack, adminSession, unique }) => {
		const call = client(stack);
		const ids = [];
		try {
			for (const logins of [0, 4]) {
				const { email, id } = await newCustomer(adminSession, unique);
				ids.push(id);
				const me = await call('POST', 'customers/login', { email, password: OLD });
				const [save] = await Promise.all([
					later(10, () => call('PATCH', `customers/${id}?depth=0`, { name: 'New Name', phone: '+919800000002' }, { Cookie: `payload-token=${me.token}` })),
					...Array.from({ length: logins }, (_, k) => later(k * 15, () => call('POST', 'customers/login', { email, password: OLD })))
				]);
				expect(save.status).toBe(200);
				expect(save.json?.doc?.name).toBe('New Name');
				const stored = (await adminSession.request('GET', `customers/${id}?depth=0`)).json;
				expect({ name: stored.name, phone: stored.phone }, `${logins} overlapping sign-in(s)`).toEqual({ name: 'New Name', phone: '+919800000002' });
			}
		} finally {
			for (const id of ids) await adminSession.request('DELETE', `customers/${id}`);
		}
	});
});
