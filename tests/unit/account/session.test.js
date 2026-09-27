/*
 * $lib/session.js with a mocked $lib/api.js: every action's request, the
 * error mapping (bodies copied from the running CMS, see the module header),
 * the session store, the nav hint and the ?next= sanitizer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/api.js', () => ({ api: apiMock }));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/track.js', () => ({ track: trackMock }));

const S = await import('$lib/session.js');
const { session, user, MESSAGES } = S;

/* ---------- api() result builders (same shapes api.js produces) ---------- */

const ok = (data, status = 200) => ({ ok: true, status, data, error: null });
/** Payload built-in error body → api.js toError() normalisation. */
const payloadErr = (status, message, fieldErrors) => {
	const code = { 400: 'VALIDATION', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' }[status] ?? 'INTERNAL';
	return {
		ok: false,
		status,
		data: null,
		error: { code, message, details: fieldErrors ? { collection: 'customers', errors: fieldErrors } : null }
	};
};
const netErr = (code = 'NETWORK') => ({ ok: false, status: 0, data: null, error: { code, message: 'x', details: null } });
const custom = (status, code) => ({ ok: false, status, data: null, error: { code, message: code, details: null } });

const CUSTOMER = {
	id: 7,
	name: 'Asha Kumar',
	phone: '+919845262777',
	email: 'asha@example.com',
	_verified: true,
	sessions: [{ id: 's1' }],
	collection: 'customers',
	_strategy: 'local-jwt'
};
const VIEW = { id: 7, email: 'asha@example.com', name: 'Asha Kumar', phone: '+919845262777' };

/* ---------- a working localStorage ---------- */

function memoryStorage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		clear: () => m.clear(),
		_map: m
	};
}

let storage;
beforeEach(() => {
	apiMock.mockReset();
	trackMock.mockReset();
	storage = memoryStorage();
	vi.stubGlobal('window', { localStorage: storage });
	S._resetSession();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const lastCall = () => apiMock.mock.calls.at(-1);

describe('initial state and SSR safety', () => {
	it("starts 'unknown' with no user, and importing made no request", () => {
		expect(get(session)).toEqual({ status: 'unknown', user: null });
		expect(get(user)).toBeNull();
		expect(apiMock).not.toHaveBeenCalled();
	});

	it('refresh() on the server does nothing', async () => {
		vi.resetModules();
		vi.doMock('$app/environment', () => ({ browser: false }));
		const ssr = await import('$lib/session.js');
		expect(await ssr.refresh()).toEqual({ ok: false, user: null, skipped: true });
		expect(get(ssr.session).status).toBe('unknown');
		expect(apiMock).not.toHaveBeenCalled();
		vi.doUnmock('$app/environment');
		vi.resetModules();
	});
});

describe('toCustomer()', () => {
	it('keeps only id, email, name, phone (never tokens or sessions)', () => {
		expect(S.toCustomer(CUSTOMER)).toEqual(VIEW);
	});
	it('fills missing strings with ""', () => {
		expect(S.toCustomer({ id: 'abc', collection: 'customers', phone: null })).toEqual({ id: 'abc', email: '', name: '', phone: '' });
	});
	it.each([[null], [undefined], ['x'], [{}], [{ id: null }], [{ id: '' }], [{ id: NaN }], [{ id: 1, collection: 'users' }]])('rejects %j', (raw) => {
		expect(S.toCustomer(raw)).toBeNull();
	});
});

describe('refresh()', () => {
	it('GET /customers/me → authenticated, sets the nav hint', async () => {
		apiMock.mockResolvedValue(ok({ user: CUSTOMER, token: 'jwt', exp: 1 }));
		const r = await S.refresh();
		expect(r).toEqual({ ok: true, user: VIEW });
		expect(apiMock).toHaveBeenCalledWith('/customers/me', expect.objectContaining({ timeoutMs: expect.any(Number) }));
		expect(get(session)).toEqual({ status: 'authenticated', user: VIEW });
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBe('1');
	});

	it('{user: null} → anonymous and the hint is cleared', async () => {
		storage.setItem(S.SESSION_HINT_KEY, '1');
		apiMock.mockResolvedValue(ok({ user: null, message: 'Account' }));
		expect(await S.refresh()).toEqual({ ok: true, user: null });
		expect(get(session)).toEqual({ status: 'anonymous', user: null });
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBeNull();
	});

	it('a non-customer user in the body → anonymous', async () => {
		apiMock.mockResolvedValue(ok({ user: { id: 1, collection: 'users' } }));
		expect((await S.refresh()).user).toBeNull();
		expect(get(session).status).toBe('anonymous');
	});

	it.each([401, 403, 404])('%i → anonymous (no CMS behind /api reads as logged out)', async (status) => {
		apiMock.mockResolvedValue(payloadErr(status, 'x'));
		expect(await S.refresh()).toEqual({ ok: true, user: null });
		expect(get(session).status).toBe('anonymous');
	});

	it('offline / 5xx → error, and the known state is kept', async () => {
		apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
		await S.refresh();
		apiMock.mockResolvedValueOnce(netErr());
		const r = await S.refresh();
		expect(r.ok).toBe(false);
		expect(r.user).toEqual(VIEW);
		expect(r.error.code).toBe('NETWORK');
		expect(get(session).status).toBe('authenticated');
		apiMock.mockResolvedValueOnce(custom(502, 'INTERNAL'));
		expect((await S.refresh()).error.code).toBe('UNKNOWN');
		expect(get(session).status).toBe('authenticated');
	});

	it('concurrent calls share one request', async () => {
		let resolve;
		apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
		const a = S.refresh();
		const b = S.refresh();
		resolve(ok({ user: CUSTOMER }));
		expect(await a).toEqual(await b);
		expect(apiMock).toHaveBeenCalledTimes(1);
		apiMock.mockResolvedValue(ok({ user: null }));
		await S.refresh();
		expect(apiMock).toHaveBeenCalledTimes(2);
	});

	describe('an answer overtaken by a login / logout', () => {
		const deferred = () => {
			let resolve;
			const promise = new Promise((r) => (resolve = r));
			return { promise, resolve };
		};

		it('a /me that left before a login cannot undo it (e.g. /login mount check on a slow network)', async () => {
			const stale = deferred();
			apiMock.mockReturnValueOnce(stale.promise);
			const early = S.refresh(); // left with no cookie yet
			apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER })).mockResolvedValueOnce(ok({ user: CUSTOMER }));
			expect((await S.login('asha@example.com', 'secret-pass')).ok).toBe(true);
			stale.resolve(ok({ user: null }));
			expect(await early).toEqual({ ok: true, user: VIEW, stale: true });
			expect(get(session)).toEqual({ status: 'authenticated', user: VIEW });
			expect(storage.getItem(S.SESSION_HINT_KEY)).toBe('1');
		});

		it('a refresh() after the login asks /me afresh instead of joining the old request', async () => {
			const stale = deferred();
			apiMock.mockReturnValueOnce(stale.promise);
			const early = S.refresh();
			apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER })).mockResolvedValueOnce(ok({ user: CUSTOMER }));
			await S.login('asha@example.com', 'secret-pass');
			apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
			const after = S.refresh(); // /account's start() right after the login
			expect(await after).toEqual({ ok: true, user: VIEW });
			expect(apiMock).toHaveBeenCalledTimes(4); // early /me, login, login's /me, a fresh /me
			stale.resolve(ok({ user: null }));
			await early;
			expect(get(session).status).toBe('authenticated');
		});

		it('a /me that left before a logout cannot log the customer back in', async () => {
			apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
			await S.refresh();
			const stale = deferred();
			apiMock.mockReturnValueOnce(stale.promise);
			const early = S.refresh();
			apiMock.mockResolvedValueOnce(ok({ message: 'Logout successful.' }));
			await S.logout();
			stale.resolve(ok({ user: CUSTOMER }));
			expect((await early).user).toBeNull();
			expect(get(session)).toEqual({ status: 'anonymous', user: null });
		});
	});

	describe('{ ifHinted: true } (the nav)', () => {
		it('no hint → no request, status stays unknown', async () => {
			const r = await S.refresh({ ifHinted: true });
			expect(r).toMatchObject({ ok: true, user: null, skipped: true });
			expect(apiMock).not.toHaveBeenCalled();
			expect(get(session).status).toBe('unknown');
		});
		it('hint present → asks /me', async () => {
			storage.setItem(S.SESSION_HINT_KEY, '1');
			apiMock.mockResolvedValue(ok({ user: CUSTOMER }));
			expect((await S.refresh({ ifHinted: true })).user).toEqual(VIEW);
			expect(apiMock).toHaveBeenCalledTimes(1);
		});
		it('storage throwing → asks /me (cannot know)', async () => {
			vi.stubGlobal('window', {
				get localStorage() {
					throw new Error('SecurityError');
				}
			});
			apiMock.mockResolvedValue(ok({ user: CUSTOMER }));
			expect((await S.refresh({ ifHinted: true })).user).toEqual(VIEW);
			expect(get(session).status).toBe('authenticated'); // and writing the hint did not throw
		});
	});
});

describe('login()', () => {
	it('posts normalised email + password, confirms the cookie with /me, becomes authenticated, tracks', async () => {
		apiMock.mockResolvedValueOnce(ok({ message: 'Authentication Passed', token: 'jwt', exp: 1, user: CUSTOMER }));
		apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER, collection: 'customers' }));
		const r = await S.login('  Asha@Example.COM ', 'secret-pass');
		expect(r).toEqual({ ok: true, user: VIEW });
		expect(apiMock.mock.calls[0]).toEqual(['/customers/login', { method: 'POST', body: { email: 'asha@example.com', password: 'secret-pass' } }]);
		expect(apiMock.mock.calls[1]).toEqual(['/customers/me', expect.objectContaining({ timeoutMs: expect.any(Number) })]);
		expect(apiMock).toHaveBeenCalledTimes(2);
		expect(get(session)).toEqual({ status: 'authenticated', user: VIEW });
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBe('1');
		expect(trackMock).toHaveBeenCalledWith('account_login');
		expect(JSON.stringify(get(session))).not.toContain('jwt');
	});

	it.each([
		['unverified (403)', payloadErr(403, 'Please verify your email before logging in.'), 'UNVERIFIED', MESSAGES.UNVERIFIED],
		['locked (401 …locked…)', payloadErr(401, 'This user is locked due to having too many failed login attempts.'), 'LOCKED', MESSAGES.LOCKED],
		['wrong password (401)', payloadErr(401, 'The email or password provided is incorrect.'), 'WRONG_CREDENTIALS', MESSAGES.WRONG_CREDENTIALS],
		['rate limited (429)', custom(429, 'RATE_LIMITED'), 'RATE_LIMITED', MESSAGES.RATE_LIMITED],
		['offline', netErr('NETWORK'), 'NETWORK', MESSAGES.NETWORK],
		['timeout', netErr('TIMEOUT'), 'TIMEOUT', MESSAGES.TIMEOUT],
		['server error', custom(500, 'INTERNAL'), 'UNKNOWN', MESSAGES.UNKNOWN],
		['bad email (400 path email)', payloadErr(400, 'The following field is invalid: email', [{ path: 'email', message: 'This field is required.' }]), 'EMAIL_INVALID', MESSAGES.EMAIL_INVALID]
	])('%s → %s', async (_, res, code, message) => {
		apiMock.mockResolvedValue(res);
		const r = await S.login('asha@example.com', 'whatever-1');
		expect(r.ok).toBe(false);
		expect(r.error.code).toBe(code);
		expect(r.error.message).toBe(message);
		expect(get(session).status).toBe('unknown');
		expect(trackMock).not.toHaveBeenCalled();
	});

	it('the exact copy the task asks for', () => {
		expect(MESSAGES.UNVERIFIED).toBe('Please verify your email — we sent you a link');
		expect(MESSAGES.LOCKED).toBe('Too many attempts — try again in 10 minutes');
	});

	it.each([
		['', 'pw', 'EMAIL_INVALID', 'email'],
		['not-an-email', 'pw', 'EMAIL_INVALID', 'email'],
		[null, 'pw', 'EMAIL_INVALID', 'email'],
		['asha@example.com', '', 'PASSWORD_REQUIRED', 'password'],
		['asha@example.com', undefined, 'PASSWORD_REQUIRED', 'password']
	])('client checks: (%j, %j) → %s without a request', async (email, pw, code, field) => {
		const r = await S.login(email, pw);
		expect(r.error).toMatchObject({ code, field });
		expect(apiMock).not.toHaveBeenCalled();
	});

	it('a 200 without a customer is not a login', async () => {
		apiMock.mockResolvedValue(ok({ user: null }));
		expect((await S.login('asha@example.com', 'secret-pass')).error.code).toBe('UNKNOWN');
		expect(get(session).status).toBe('unknown');
	});

	describe('the session cookie has to stick (blocked cookies: hunt login-cookies-blocked)', () => {
		const LOGIN_OK = ok({ message: 'Authentication Passed', token: 'jwt', exp: 1, user: CUSTOMER });

		it.each([
			['/me says nobody (200 {user:null})', ok({ user: null, message: 'Account' })],
			['/me says 401', payloadErr(401, 'Unauthorized')],
			['/me says 403', payloadErr(403, 'You are not allowed to perform this action.')]
		])('%s → COOKIES_BLOCKED, anonymous, no "logged in" anywhere', async (_, me) => {
			storage.setItem(S.SESSION_HINT_KEY, '1');
			apiMock.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce(me);
			const r = await S.login('asha@example.com', 'secret-pass');
			expect(r).toEqual({ ok: false, error: { code: 'COOKIES_BLOCKED', message: MESSAGES.COOKIES_BLOCKED } });
			expect(r.error.field).toBeUndefined(); // no input is at fault
			expect(get(session)).toEqual({ status: 'anonymous', user: null });
			expect(storage.getItem(S.SESSION_HINT_KEY)).toBeNull();
			expect(trackMock).not.toHaveBeenCalled();
		});

		it('the copy names cookies and keeps guest checkout open', () => {
			expect(MESSAGES.COOKIES_BLOCKED).toMatch(/cookies/i);
			expect(MESSAGES.COOKIES_BLOCKED).toMatch(/guest/i);
		});

		it('/me still says somebody else (the old cookie was kept) → COOKIES_BLOCKED, the store follows /me', async () => {
			const OTHER = { ...CUSTOMER, id: 8, email: 'ravi@example.com', name: 'Ravi' };
			apiMock.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce(ok({ user: OTHER }));
			const r = await S.login('asha@example.com', 'secret-pass');
			expect(r.error.code).toBe('COOKIES_BLOCKED');
			expect(get(session)).toEqual({ status: 'authenticated', user: { id: 8, email: 'ravi@example.com', name: 'Ravi', phone: '+919845262777' } });
		});

		it("an id of another type still matches ('7' vs 7)", async () => {
			apiMock.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce(ok({ user: { ...CUSTOMER, id: '7', name: 'Asha K' } }));
			const r = await S.login('asha@example.com', 'secret-pass');
			expect(r.ok).toBe(true);
			expect(r.user.name).toBe('Asha K'); // /me's fresher copy wins
		});

		it.each([
			['offline', netErr('NETWORK')],
			['timeout', netErr('TIMEOUT')],
			['5xx', custom(502, 'INTERNAL')],
			['rate limited', custom(429, 'RATE_LIMITED')],
			['no /me route (404)', payloadErr(404, 'Not Found')]
		])("/me can't tell (%s) → trust the login answer", async (_, me) => {
			apiMock.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce(me);
			const r = await S.login('asha@example.com', 'secret-pass');
			expect(r).toEqual({ ok: true, user: VIEW });
			expect(get(session)).toEqual({ status: 'authenticated', user: VIEW });
			expect(trackMock).toHaveBeenCalledWith('account_login');
		});

		it('a login failure never asks /me', async () => {
			apiMock.mockResolvedValueOnce(payloadErr(401, 'The email or password provided is incorrect.'));
			await S.login('asha@example.com', 'secret-pass');
			expect(apiMock).toHaveBeenCalledTimes(1);
		});
	});
});

describe('signup()', () => {
	const input = { name: '  Asha   Kumar ', email: 'Asha@Example.com', password: 'longpassword1' };

	it('posts only name, email, password; nobody is logged in yet (verify: true)', async () => {
		apiMock.mockResolvedValue(ok({ doc: { id: 1, email: 'asha@example.com' }, message: 'Customer successfully created.' }, 201));
		expect(await S.signup({ ...input, _verified: true, marketingOptIn: true })).toEqual({ ok: true, email: 'asha@example.com' });
		expect(lastCall()).toEqual(['/customers', { method: 'POST', body: { name: 'Asha Kumar', email: 'asha@example.com', password: 'longpassword1' } }]);
		expect(get(session).status).toBe('unknown');
		expect(trackMock).toHaveBeenCalledWith('account_signup');
	});

	it.each([
		['email taken', payloadErr(400, 'The following field is invalid: email', [{ message: 'A user with the given email is already registered.', path: 'email' }]), 'EMAIL_TAKEN', 'email'],
		['email rejected', payloadErr(400, 'The following field is invalid: Email', [{ label: 'Email', message: 'Please enter a valid email address.', path: 'email' }]), 'EMAIL_INVALID', 'email'],
		['weak password (server rule)', payloadErr(400, 'The following field is invalid: password', [{ message: 'This value must be longer than the minimum length of 3 characters.', path: 'password' }]), 'WEAK_PASSWORD', 'password'],
		['name too long', payloadErr(400, 'x', [{ path: 'name', message: 'too long' }]), 'NAME_TOO_LONG', 'name'],
		['rate limited', custom(429, 'RATE_LIMITED'), 'RATE_LIMITED', undefined],
		['offline', netErr(), 'NETWORK', undefined]
	])('%s → %s', async (_, res, code, field) => {
		apiMock.mockResolvedValue(res);
		const r = await S.signup(input);
		expect(r.error.code).toBe(code);
		expect(r.error.field).toBe(field);
		expect(r.error.message).toBe(MESSAGES[code]);
	});

	it.each([
		[{ ...input, name: '   ' }, 'NAME_REQUIRED', 'name'],
		[{ ...input, name: 'x'.repeat(101) }, 'NAME_TOO_LONG', 'name'],
		[{ ...input, email: 'nope' }, 'EMAIL_INVALID', 'email'],
		[{ ...input, password: '' }, 'PASSWORD_REQUIRED', 'password'],
		[{ ...input, password: 'short12' }, 'WEAK_PASSWORD', 'password'],
		[{ ...input, password: 'x'.repeat(129) }, 'LONG_PASSWORD', 'password'],
		[{ ...input, password: 12345678 }, 'WEAK_PASSWORD', 'password'],
		[undefined, 'NAME_REQUIRED', 'name']
	])('client rule %# → %s (no request)', async (i, code, field) => {
		expect((await S.signup(i)).error).toMatchObject({ code, field });
		expect(apiMock).not.toHaveBeenCalled();
	});

	it('the weak-password rule is exactly PASSWORD_MIN characters', async () => {
		apiMock.mockResolvedValue(ok({ doc: {} }, 201));
		expect((await S.signup({ ...input, password: 'x'.repeat(S.PASSWORD_MIN - 1) })).ok).toBe(false);
		expect((await S.signup({ ...input, password: 'x'.repeat(S.PASSWORD_MIN) })).ok).toBe(true);
		expect(S.PASSWORD_MIN).toBeGreaterThanOrEqual(3); // never looser than Payload's own minimum
	});
});

describe('forgotPassword()', () => {
	it('posts the normalised email; ok for any well-formed address', async () => {
		apiMock.mockResolvedValue(ok({ message: 'Success' }));
		expect(await S.forgotPassword(' Asha@Example.com')).toEqual({ ok: true, email: 'asha@example.com' });
		expect(lastCall()).toEqual(['/customers/forgot-password', { method: 'POST', body: { email: 'asha@example.com' } }]);
	});
	it('bad email → no request', async () => {
		expect((await S.forgotPassword('nope')).error).toMatchObject({ code: 'EMAIL_INVALID', field: 'email' });
		expect(apiMock).not.toHaveBeenCalled();
	});
	it.each([
		[payloadErr(400, 'Missing email.'), 'EMAIL_INVALID'],
		[custom(429, 'RATE_LIMITED'), 'RATE_LIMITED'],
		[netErr(), 'NETWORK'],
		[custom(500, 'INTERNAL'), 'UNKNOWN']
	])('%j → %s', async (res, code) => {
		apiMock.mockResolvedValue(res);
		expect((await S.forgotPassword('asha@example.com')).error.code).toBe(code);
	});
});

describe('resendVerification()', () => {
	it('POST /store/account/resend-verification with the normalised email', async () => {
		apiMock.mockResolvedValue(ok({ ok: true }));
		expect(await S.resendVerification('  Asha@Example.com ')).toEqual({ ok: true, email: 'asha@example.com' });
		expect(apiMock.mock.calls).toEqual([['/store/account/resend-verification', { method: 'POST', body: { email: 'asha@example.com' } }]]);
		expect(get(session).status).toBe('unknown'); // nobody is logged in by asking
	});
	it.each([[''], ['nope'], [undefined], [42]])('bad email %j → EMAIL_INVALID, no request', async (e) => {
		expect((await S.resendVerification(e)).error).toMatchObject({ code: 'EMAIL_INVALID', field: 'email' });
		expect(apiMock).not.toHaveBeenCalled();
	});
	it.each([
		['429 (auth rate limit)', custom(429, 'RATE_LIMITED'), 'RATE_LIMITED', MESSAGES.LINKS_RATE_LIMITED],
		['429 with a Payload-style body', payloadErr(429, 'Too many requests'), 'RATE_LIMITED', MESSAGES.LINKS_RATE_LIMITED],
		['400', custom(400, 'VALIDATION'), 'EMAIL_INVALID', MESSAGES.EMAIL_INVALID],
		['offline', netErr(), 'NETWORK', MESSAGES.NETWORK],
		['timeout', netErr('TIMEOUT'), 'TIMEOUT', MESSAGES.TIMEOUT],
		['404 (endpoint missing)', custom(404, 'NOT_FOUND'), 'UNKNOWN', MESSAGES.UNKNOWN],
		['500', custom(500, 'INTERNAL'), 'UNKNOWN', MESSAGES.UNKNOWN]
	])('%s → %s with friendly copy', async (_, res, code, message) => {
		apiMock.mockResolvedValue(res);
		const r = await S.resendVerification('asha@example.com');
		expect(r.ok).toBe(false);
		expect(r.error.code).toBe(code);
		expect(r.error.message).toBe(message);
	});
	it('the neutral success copy never confirms that an account exists', () => {
		expect(MESSAGES.RESEND_SENT).toBe('If that email needs verifying, a new link is on its way.');
	});
});

describe('server password rule (min 8, max 128) and auth 429s → copy', () => {
	// cms-hardening.md §2 messages, and Payload's own validation wording.
	const tooShort = [{ path: 'password', message: 'Choose a password with at least 8 characters.' }];
	const tooLong = [{ path: 'password', message: 'Keep your password under 129 characters.' }];
	const payloadShort = [{ path: 'password', message: 'This value must be longer than the minimum length of 8 characters.' }];
	const payloadLong = [{ path: 'password', message: 'This value must be shorter than the max length of 128 characters.' }];
	it.each([
		['signup', tooShort, 'WEAK_PASSWORD'],
		['signup', tooLong, 'LONG_PASSWORD'],
		['signup', payloadShort, 'WEAK_PASSWORD'],
		['signup', payloadLong, 'LONG_PASSWORD'],
		['reset', tooShort, 'WEAK_PASSWORD'],
		['reset', tooLong, 'LONG_PASSWORD'],
		['reset', payloadLong, 'LONG_PASSWORD']
	])('%s: %j → %s on the password field', (action, errors, code) => {
		expect(S.authError(action, payloadErr(400, 'The following field is invalid: password', errors))).toEqual({ code, message: MESSAGES[code], field: 'password' });
	});
	it('LONG_PASSWORD names the limit', () => {
		expect(MESSAGES.LONG_PASSWORD).toContain(String(S.PASSWORD_MAX));
		expect(S.PASSWORD_MAX).toBe(128);
	});
	it.each(['login', 'signup', 'reset', 'verify'])('%s 429 → RATE_LIMITED "wait a minute"', (action) => {
		expect(S.authError(action, custom(429, 'RATE_LIMITED'))).toEqual({ code: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED });
	});
	it.each(['forgot', 'resend'])('%s 429 → RATE_LIMITED with the link-sending copy', (action) => {
		expect(S.authError(action, custom(429, 'RATE_LIMITED'))).toEqual({ code: 'RATE_LIMITED', message: MESSAGES.LINKS_RATE_LIMITED });
	});
	it('a 429 wins over any field error in the body', () => {
		expect(S.authError('signup', payloadErr(429, 'x', tooShort)).code).toBe('RATE_LIMITED');
	});
	it('retryAfterSeconds (cms-hardening §3) says how long to wait', () => {
		// Payload built-ins: errors[0].data → details {code, retryAfterSeconds}
		const builtin = (secs) => ({ ok: false, status: 429, data: null, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a moment and try again.', details: { code: 'RATE_LIMITED', retryAfterSeconds: secs } } });
		expect(S.authError('login', builtin(42)).message).toBe('Too many attempts — please wait a minute and try again.');
		expect(S.authError('signup', builtin(540)).message).toBe('Too many attempts — please wait 9 minutes and try again.');
		expect(S.authError('forgot', builtin(3600)).message).toBe('You’ve asked for a few links already — please wait an hour, then try again.');
		expect(S.authError('resend', builtin(61)).message).toBe('You’ve asked for a few links already — please wait 2 minutes, then try again.');
		for (const junk of [0, -5, 'soon', null, NaN]) expect(S.authError('login', builtin(junk)).message).toBe(MESSAGES.RATE_LIMITED);
	});
	it.each([
		[undefined, null],
		[0, null],
		[1, 'a minute'],
		[60, 'a minute'],
		[61, '2 minutes'],
		[599, '10 minutes'],
		[3599, '60 minutes'],
		[3600, 'an hour'],
		['120', '2 minutes']
	])('waitText(%j) → %j', (secs, text) => {
		expect(S.waitText(secs)).toBe(text);
	});
});

describe('resetPassword()', () => {
	const TOKEN = '1707d8f866934bf96b9f200be9e52b47b0fb242d';

	it('posts token + password, then ends the session Payload opened', async () => {
		apiMock.mockResolvedValueOnce(ok({ message: 'Password reset successfully.', token: 'jwt', user: CUSTOMER }));
		apiMock.mockResolvedValueOnce(ok({ message: 'Logout successful.' }));
		storage.setItem(S.SESSION_HINT_KEY, '1');
		expect(await S.resetPassword(TOKEN, 'newpassword2')).toEqual({ ok: true });
		expect(apiMock.mock.calls).toEqual([
			['/customers/reset-password', { method: 'POST', body: { token: TOKEN, password: 'newpassword2' } }],
			['/customers/logout', { method: 'POST' }]
		]);
		expect(get(session)).toEqual({ status: 'anonymous', user: null });
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBeNull();
	});

	it.each([
		['used/expired token (403)', payloadErr(403, 'Token is either invalid or has expired.'), 'RESET_INVALID', undefined],
		['weak password (400 path password)', payloadErr(400, 'x', [{ path: 'password', message: 'This value must be longer…' }]), 'WEAK_PASSWORD', 'password'],
		['offline', netErr(), 'NETWORK', undefined],
		['rate limited', custom(429, 'RATE_LIMITED'), 'RATE_LIMITED', undefined]
	])('%s → %s (and no logout call)', async (_, res, code, field) => {
		apiMock.mockResolvedValueOnce(res);
		const r = await S.resetPassword(TOKEN, 'newpassword2');
		expect(r.error.code).toBe(code);
		expect(r.error.field).toBe(field);
		expect(apiMock).toHaveBeenCalledTimes(1);
	});

	it.each([[''], [null], ['short'], ['has space x'], ['../../x/y'], ['a'.repeat(600)]])('malformed token %j → RESET_INVALID, no request', async (t) => {
		expect((await S.resetPassword(t, 'newpassword2')).error.code).toBe('RESET_INVALID');
		expect(apiMock).not.toHaveBeenCalled();
	});

	it('weak new password → no request', async () => {
		expect((await S.resetPassword(TOKEN, 'short')).error).toMatchObject({ code: 'WEAK_PASSWORD', field: 'password' });
		expect(apiMock).not.toHaveBeenCalled();
	});
});

describe('verifyEmail()', () => {
	it('POST /customers/verify/<token>', async () => {
		apiMock.mockResolvedValue(ok({ message: 'Account verified successfully.' }));
		expect(await S.verifyEmail('1ebab832cf75df7fbeb9923f414bea0d903d62d7')).toEqual({ ok: true });
		expect(lastCall()).toEqual(['/customers/verify/1ebab832cf75df7fbeb9923f414bea0d903d62d7', { method: 'POST' }]);
	});
	it.each([
		[payloadErr(403, 'Verification token is invalid.'), 'VERIFY_INVALID'],
		[payloadErr(404, 'x'), 'VERIFY_INVALID'],
		[netErr(), 'NETWORK'],
		[custom(500, 'INTERNAL'), 'UNKNOWN']
	])('%j → %s', async (res, code) => {
		apiMock.mockResolvedValue(res);
		expect((await S.verifyEmail('1ebab832cf75df7fbeb9923f414bea0d903d62d7')).error.code).toBe(code);
	});
	it.each([['../customers/me'], ['a/b'], ['x'], [''], [undefined], ['%2e%2e%2fme']])('never puts %j in the path', async (t) => {
		expect((await S.verifyEmail(t)).error.code).toBe('VERIFY_INVALID');
		expect(apiMock).not.toHaveBeenCalled();
	});
});

describe('logout()', () => {
	beforeEach(async () => {
		apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
		await S.refresh();
		apiMock.mockReset();
	});

	it('200 → anonymous, hint cleared', async () => {
		apiMock.mockResolvedValue(ok({ message: 'Logout successful.' }));
		expect(await S.logout()).toEqual({ ok: true });
		expect(lastCall()).toEqual(['/customers/logout', { method: 'POST' }]);
		expect(get(session)).toEqual({ status: 'anonymous', user: null });
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBeNull();
	});

	it('400 "No User" (cookie already gone) is logged out too', async () => {
		apiMock.mockResolvedValue(payloadErr(400, 'No User'));
		expect(await S.logout()).toEqual({ ok: true });
		expect(get(session).status).toBe('anonymous');
	});

	it.each([[netErr()], [custom(500, 'INTERNAL')], [custom(429, 'RATE_LIMITED')]])('%j → error, still logged in locally (the cookie still works)', async (res) => {
		apiMock.mockResolvedValue(res);
		const r = await S.logout();
		expect(r.ok).toBe(false);
		expect(get(session).status).toBe('authenticated');
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBe('1');
	});
});

describe('updateProfile()', () => {
	beforeEach(async () => {
		apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
		await S.refresh();
		apiMock.mockReset();
	});

	it('PATCH /customers/:id with the name and an E.164 phone', async () => {
		apiMock.mockResolvedValue(ok({ doc: { ...CUSTOMER, name: 'Asha K', phone: '+919876543210' } }));
		const r = await S.updateProfile({ name: ' Asha  K ', phone: '098765 43210' });
		expect(lastCall()).toEqual(['/customers/7', { method: 'PATCH', body: { name: 'Asha K', phone: '+919876543210' } }]);
		expect(r).toEqual({ ok: true, user: { ...VIEW, name: 'Asha K', phone: '+919876543210' } });
		expect(get(user)).toEqual(r.user);
	});

	it('an empty phone clears it (null)', async () => {
		apiMock.mockResolvedValue(ok({ doc: { ...CUSTOMER, phone: null } }));
		const r = await S.updateProfile({ name: 'Asha', phone: '  ' });
		expect(lastCall()[1].body).toEqual({ name: 'Asha', phone: null });
		expect(r.user.phone).toBe('');
	});

	it.each(['12345', '+14155552671', '5123456789', 'call me', '+91 98452 6277'])('phone %j → PHONE_INVALID, no request', async (phone) => {
		expect((await S.updateProfile({ name: 'Asha', phone })).error).toEqual({ code: 'PHONE_INVALID', message: MESSAGES.PHONE_INVALID, field: 'phone' });
		expect(apiMock).not.toHaveBeenCalled();
	});

	it.each(['+91 98452 62777', '9845262777', '09845262777', '919845262777'])('phone %j is accepted as +919845262777', async (phone) => {
		apiMock.mockResolvedValue(ok({ doc: CUSTOMER }));
		await S.updateProfile({ name: 'Asha', phone });
		expect(lastCall()[1].body.phone).toBe('+919845262777');
	});

	it('name required / too long', async () => {
		expect((await S.updateProfile({ name: ' ', phone: '' })).error.code).toBe('NAME_REQUIRED');
		expect((await S.updateProfile({ name: 'x'.repeat(101), phone: '' })).error.code).toBe('NAME_TOO_LONG');
		expect(apiMock).not.toHaveBeenCalled();
	});

	it.each([401, 403])('%i (session revoked) → SESSION_EXPIRED and anonymous', async (status) => {
		apiMock.mockResolvedValue(payloadErr(status, 'You are not allowed to perform this action.'));
		expect((await S.updateProfile({ name: 'Asha', phone: '' })).error.code).toBe('SESSION_EXPIRED');
		expect(get(session).status).toBe('anonymous');
	});

	it('server-side phone rejection → PHONE_INVALID on the phone field', async () => {
		apiMock.mockResolvedValue(payloadErr(400, 'The following field is invalid: Phone', [{ label: 'Phone', path: 'phone', message: 'Enter the phone number in international format' }]));
		expect((await S.updateProfile({ name: 'Asha', phone: '9845262777' })).error).toMatchObject({ code: 'PHONE_INVALID', field: 'phone' });
		expect(get(session).status).toBe('authenticated');
	});

	it('not logged in → SESSION_EXPIRED without a request', async () => {
		S._resetSession();
		expect((await S.updateProfile({ name: 'Asha' })).error.code).toBe('SESSION_EXPIRED');
		expect(apiMock).not.toHaveBeenCalled();
	});
});

describe('loadMyOrders()', () => {
	it('GET /store/orders/mine → orders', async () => {
		apiMock.mockResolvedValue(ok({ orders: [{ number: 'WF-10001' }] }));
		expect(await S.loadMyOrders()).toEqual({ ok: true, orders: [{ number: 'WF-10001' }] });
		expect(lastCall()).toEqual(['/store/orders/mine']);
	});
	it('a body without an array → []', async () => {
		apiMock.mockResolvedValue(ok({ orders: 'nope' }));
		expect(await S.loadMyOrders()).toEqual({ ok: true, orders: [] });
	});
	it.each([401, 403])('%i → SESSION_EXPIRED, session ends', async (status) => {
		apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
		await S.refresh();
		apiMock.mockResolvedValueOnce(payloadErr(status, 'x'));
		expect((await S.loadMyOrders()).error.code).toBe('SESSION_EXPIRED');
		expect(get(session).status).toBe('anonymous');
	});
	it.each([[custom(404, 'NOT_FOUND'), 'UNKNOWN'], [netErr(), 'NETWORK'], [custom(500, 'INTERNAL'), 'UNKNOWN']])('%j → %s, session kept', async (res, code) => {
		apiMock.mockResolvedValueOnce(ok({ user: CUSTOMER }));
		await S.refresh();
		apiMock.mockResolvedValueOnce(res);
		expect((await S.loadMyOrders()).error.code).toBe(code);
		expect(get(session).status).toBe('authenticated');
	});
});

describe('authError() never leaks server wording', () => {
	it('unknown actions and odd bodies fall back to the generic copy', () => {
		expect(S.authError('login', { status: 418, error: { code: 'X', message: 'SELECT * FROM users', details: null } }).message).toBe(MESSAGES.UNKNOWN);
		expect(S.authError('signup', { status: 400, error: { code: 'VALIDATION', message: 'The following field is invalid: foo', details: { errors: [{ path: 'foo' }] } } }).message).toBe(MESSAGES.UNKNOWN);
		expect(S.authError('update', undefined).message).toBe(MESSAGES.UNKNOWN);
	});
});

describe('safeNext() — ?next= sanitizer', () => {
	it.each([
		['/account', '/account'],
		['/cart', '/cart'],
		['/cart?add=muesli:2&src=usual', '/cart?add=muesli:2&src=usual'],
		['/products/muesli#facts', '/products/muesli#facts'],
		['/order?no=WF-10001&t=abc', '/order?no=WF-10001&t=abc'],
		['/a/../shop', '/shop'],
		['/javascript:alert(1)', '/javascript:alert(1)'], // a same-origin path, harmless
		['/%E0%A4%A8%E0%A4%AE', '/%E0%A4%A8%E0%A4%AE']
	])('keeps same-origin path %j → %j', (raw, want) => {
		expect(S.safeNext(raw)).toBe(want);
	});

	it.each([
		['//evil.com'],
		['//evil.com/account'],
		['///evil.com'],
		['/\\evil'],
		['/\\/evil.com'],
		['\\/evil.com'],
		['\\\\evil.com'],
		['https://x'],
		['https://evil.com/account'],
		['http:evil.com'],
		['javascript:alert(1)'],
		['JavaScript:alert(1)'],
		['data:text/html,<script>alert(1)</script>'],
		['mailto:a@b.c'],
		['evil.com'],
		['account'],
		['./account'],
		['../account'],
		[' /account'],
		['/account '],
		['/\t/evil.com'],
		['/\n/evil.com'],
		['/\r\n/evil.com'],
		['/%09/evil.com'],
		['/%0a/evil.com'],
		['%2F%2Fevil.com'],
		['/%2F%2Fevil.com'],
		['/%2fevil.com'],
		['/%5Cevil'],
		['/%5cevil.com'],
		['/%255Cevil'],
		['/%252F%252Fevil.com'],
		['/%25252F%25252Fevil.com'],
		['/%E0%A4%A'],
		['/login'],
		['/login?next=/account'],
		['/reset-password?token=x'],
		[''],
		[null],
		[undefined],
		[42],
		[['/account']],
		['/' + 'a'.repeat(1100)],
		// dot segments collapse only when the URL is parsed (after the raw checks):
		// each of these would come back as the protocol-relative '//evil.example'
		['/.//evil.example'],
		['/x/..//evil.example'],
		['/././/evil.example/steal'],
		['/%2e%2e//evil.example'],
		['/x/%2E%2E//evil.example'],
		['/%2e//evil.example'],
		['/a/b/../..//evil.example?x=1#h'],
		['/%2e%2e/login']
	])('rejects %j → /account', (raw) => {
		expect(S.safeNext(raw)).toBe('/account');
	});

	it('custom fallback', () => {
		expect(S.safeNext('//evil.com', '/')).toBe('/');
		expect(S.safeNext(null, '/shop')).toBe('/shop');
	});

	it('the result is always a same-origin path', () => {
		for (const raw of ['/x', '//y', '/\\z', 'https://a', '/%2F%2Fb', '/./c', '/%20', '/.//d', '/e/..//f', '/%2e%2e//g']) {
			const out = S.safeNext(raw);
			expect(out.startsWith('/')).toBe(true);
			expect(out.startsWith('//')).toBe(false);
			expect(new URL(out, 'https://shop.test').origin).toBe('https://shop.test');
		}
	});
});

describe('loginHref()', () => {
	it('encodes a safe next and extra params', () => {
		expect(S.loginHref('/account')).toBe('/login?next=%2Faccount');
		expect(S.loginHref('/account', { session: 'expired' })).toBe('/login?next=%2Faccount&session=expired');
		expect(S.loginHref('//evil.com')).toBe('/login?next=%2Faccount');
	});
});

describe('isAuthToken()', () => {
	it.each([
		['1ebab832cf75df7fbeb9923f414bea0d903d62d7', true],
		['abc_DEF-123456', true],
		['short', false],
		['has space in it', false],
		['a/b/c/d/e/f/g', false],
		['a%2Fb%2Fc%2Fd', false],
		[null, false],
		[12345678901, false]
	])('%j → %s', (t, want) => {
		expect(S.isAuthToken(t)).toBe(want);
	});
});
