/*
 * Customer accounts (roadmap S3) against the static build, with /api stubbed
 * by a tiny in-memory Payload stand-in (bodies and status codes copied from
 * the running CMS): /login (log in, sign up, forgot, ?verify, ?next), the
 * reset-password page, /account (orders, buy again, details, log out, the
 * logged-out redirect and a session that dies mid-visit), the nav and
 * mobile-nav account links, and the phone layout. Key flows also run with
 * ?nofx=1 and with localStorage throwing.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stubApi, blockStorage, expectNoHorizontalOverflow } from './helpers.js';

const CUSTOMER = {
	id: 7,
	name: 'Asha Kumar',
	phone: '+919845262777',
	email: 'asha@example.com',
	_verified: true,
	collection: 'customers',
	_strategy: 'local-jwt'
};
const TOKEN = 'q2Jx8b0v3M4sQ1eN7lK5pZ9wY6tR2uH8cD0fG4aB1iE';
const TOKEN_COD = 'Zx9-_Yw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1Oo0Nn9Mm8Ll7Kk';
// orders/mine carries `token` on every order (checkout-backend.md §1.8).
const ORDERS = [
	{
		number: 'WF-10007',
		status: 'cod_pending',
		paymentMethod: 'cod',
		fulfilmentStatus: 'unfulfilled',
		createdAt: '2026-08-02T10:00:00.000Z',
		totalPaise: 22400,
		token: TOKEN_COD,
		items: [{ slug: 'steel-cut-oats', name: 'Steel-Cut Oats', qty: 1, unitPaise: 13500, lineTotalPaise: 13500, image: '/images/wefeasto/product-steel-cut-oats.jpg' }]
	},
	{
		number: 'WF-10012',
		status: 'paid',
		fulfilmentStatus: 'shipped',
		createdAt: '2026-09-20T10:00:00.000Z',
		totalPaise: 67500,
		token: TOKEN,
		items: [
			{ slug: 'muesli', name: 'Muesli', qty: 2, unitPaise: 25000, lineTotalPaise: 50000, image: '/images/wefeasto/product-muesli.jpg' },
			{ slug: 'cornflakes', name: 'Cornflakes', qty: 1, unitPaise: 17500, lineTotalPaise: 17500, image: '/images/wefeasto/product-cornflakes.jpg' }
		]
	}
];

const err = (status, message, errors) => ({ status, json: { errors: [errors ? { name: 'ValidationError', message, data: { collection: 'customers', errors } } : { message }] } });
const isApi = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/');

/**
 * In-memory stand-in for the CMS behind /api. `opts` override one endpoint
 * each: a { status, json } object, or a function (body, server) → one.
 */
async function fakeCms(page, opts = {}) {
	const server = { user: opts.user ?? null, calls: [], statusOrders: opts.statusOrders ?? null };
	const answer = (o, body, dflt) => (typeof o === 'function' ? o(body, server) : o) ?? dflt;
	await page.route(isApi, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const method = req.method();
		let body = null;
		try {
			body = req.postDataJSON();
		} catch (e) {
			body = req.postData();
		}
		server.calls.push({ method, path: url.pathname, body });
		const p = url.pathname;
		let res;
		if (p === '/api/customers/me' && method === 'GET') res = answer(opts.me, body, { status: 200, json: { user: server.user, message: 'Account' } });
		else if (p === '/api/customers/login' && method === 'POST')
			res = answer(opts.login, body, null) ?? (() => {
				server.user = CUSTOMER;
				return { status: 200, json: { message: 'Authentication Passed', token: 'jwt', exp: 1, user: CUSTOMER } };
			})();
		else if (p === '/api/customers' && method === 'POST') res = answer(opts.signup, body, { status: 201, json: { doc: { id: 9, email: body?.email }, message: 'Customer successfully created.' } });
		else if (p === '/api/customers/logout' && method === 'POST') {
			res = answer(opts.logout, body, null) ?? (server.user ? { status: 200, json: { message: 'Logout successful.' } } : err(400, 'No User'));
			if (res.status === 200) server.user = null;
		} else if (p === '/api/customers/forgot-password' && method === 'POST') res = answer(opts.forgot, body, { status: 200, json: { message: 'Success' } });
		else if (p === '/api/customers/reset-password' && method === 'POST')
			res = answer(opts.reset, body, null) ?? (() => {
				server.user = CUSTOMER;
				return { status: 200, json: { message: 'Password reset successfully.', token: 'jwt', user: CUSTOMER } };
			})();
		else if (p.startsWith('/api/customers/verify/') && method === 'POST') res = answer(opts.verify, body, { status: 200, json: { message: 'Account verified successfully.' } });
		else if (p === `/api/customers/${CUSTOMER.id}` && method === 'PATCH')
			res = answer(opts.patch, body, null) ?? (() => {
				server.user = { ...server.user, ...body };
				return { status: 200, json: { doc: server.user, message: 'Updated successfully.' } };
			})();
		else if (p === '/api/store/orders/status' && method === 'GET') {
			// The guest status endpoint /order calls: the DTO without the token, or the one generic 404.
			const o = (server.statusOrders ?? ORDERS).find((x) => x.number === url.searchParams.get('no') && x.token === url.searchParams.get('t'));
			res = o ? { status: 200, json: { ...o, token: undefined, contact: { firstName: 'Asha', emailMasked: 'a•••@example.com' } } } : { status: 404, json: { error: { code: 'NOT_FOUND', message: 'x' } } };
		} else if (p === '/api/store/account/resend-verification' && method === 'POST') res = answer(opts.resend, body, { status: 200, json: { ok: true } });
		else if (p === '/api/store/orders/mine' && method === 'GET')
			res = answer(opts.orders, body, null) ?? (server.user ? { status: 200, json: { orders: ORDERS } } : err(401, 'Please log in to continue.'));
		else res = { status: 404, json: {} };
		if (res.gate) await res.gate; // held until the test has seen the busy state
		await route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.json ?? {}) });
	});
	return server;
}

const callsTo = (server, path, method) => server.calls.filter((c) => c.path === path && (!method || c.method === method));

/** Uncaught errors only (the stubbed 4xx responses are logged by Chromium on purpose). */
function pageErrors(page) {
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text());
	});
	return errors;
}

/** Hydrated: the nav badge gets its class/count only after the layout mounted. */
async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

async function open(page, path) {
	await page.goto(path);
	await hydrated(page);
}

const notice = (page) => page.locator('#wf-auth-notice');

async function logIn(page, email = 'asha@example.com', password = 'secret-pass-1') {
	await page.fill('#wf-login-email', email);
	await page.fill('#wf-login-password', password);
	await page.click('#wf-login-form button[type="submit"]');
}

test.beforeEach(async ({ context }) => {
	await stubApi(context); // anything not routed below: "no CMS"
});

test.describe('/login', () => {
	test('no Google sign-in, no "or" divider, no prototype notice', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login');
		await expect(page.locator('#wf-login-form')).toBeVisible();
		await expect(page.getByText('Continue with Google')).toHaveCount(0);
		await expect(page.locator('.wf-or')).toHaveCount(0);
		await expect(notice(page)).toBeHidden();
	});

	for (const variant of ['normal', 'nofx', 'no-storage']) {
		test(`log in → /account with orders (${variant})`, async ({ page }) => {
			if (variant === 'no-storage') await page.addInitScript(blockStorage);
			const errors = pageErrors(page);
			const server = await fakeCms(page);
			await open(page, variant === 'nofx' ? '/login?nofx=1' : '/login');
			await logIn(page, '  Asha@Example.com ', 'secret-pass-1');
			await page.waitForURL('**/account*');
			expect(callsTo(server, '/api/customers/login')[0].body).toEqual({ email: 'asha@example.com', password: 'secret-pass-1' });
			await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Asha.');
			await expect(page.locator('.wf-order-row')).toHaveCount(2);
			expect(errors).toEqual([]);
		});
	}

	test('a busy spinner while logging in; the button is disabled', async ({ page }) => {
		let release;
		const gate = new Promise((r) => (release = r));
		await fakeCms(page, { login: () => ({ status: 401, json: { errors: [{ message: 'The email or password provided is incorrect.' }] }, gate }) });
		await open(page, '/login');
		await logIn(page);
		const btn = page.locator('#wf-login-form button[type="submit"]');
		await expect(btn).toBeDisabled();
		await expect(btn).toHaveAttribute('aria-busy', 'true');
		await expect(btn.locator('svg.wf-spinner')).toBeVisible();
		await expect(btn).toContainText('Logging in');
		release();
		await expect(btn).toHaveText('Log In');
		await expect(btn).toBeEnabled();
	});

	const failures = [
		['unverified', err(403, 'Please verify your email before logging in.'), 'Please verify your email — we sent you a link'],
		['wrong password', err(401, 'The email or password provided is incorrect.'), 'That email and password don’t match. Try again, or reset your password.'],
		['locked', err(401, 'This user is locked due to having too many failed login attempts.'), 'Too many attempts — try again in 10 minutes'],
		['rate limited', { status: 429, json: { error: { code: 'RATE_LIMITED', message: 'x' } } }, 'Too many attempts — please wait a minute and try again.']
	];
	for (const [name, res, copy] of failures) {
		test(`login ${name}: inline notice, stays on /login`, async ({ page }) => {
			const server = await fakeCms(page, { login: res });
			await open(page, '/login');
			await logIn(page);
			await expect(notice(page)).toBeVisible();
			await expect(notice(page)).toHaveText(copy);
			await expect(notice(page)).toHaveAttribute('role', 'status');
			expect(new URL(page.url()).pathname).toBe('/login');
			expect(callsTo(server, '/api/customers/login')).toHaveLength(1);
			// submitting again re-acknowledges (same text), no duplicate notices
			await page.click('#wf-login-form button[type="submit"]');
			await expect.poll(() => callsTo(server, '/api/customers/login').length).toBe(2);
			await expect(page.locator('.wf-auth-notice')).toHaveCount(1);
		});
	}

	test('client-side check: bad email → notice, aria-invalid + focus, no request', async ({ page }) => {
		const server = await fakeCms(page);
		await open(page, '/login');
		await logIn(page, 'not-an-email', 'x');
		await expect(notice(page)).toHaveText('Enter a valid email address.');
		const email = page.locator('#wf-login-email');
		await expect(email).toHaveAttribute('aria-invalid', 'true');
		await expect(email).toBeFocused();
		expect(callsTo(server, '/api/customers/login')).toHaveLength(0);
	});

	test('sign up → "check your email", back on Log In with the email filled', async ({ page }) => {
		const server = await fakeCms(page);
		await open(page, '/login');
		await page.click('#wf-tab-signup');
		await expect(page.locator('#wf-panel-signup')).toBeVisible();
		await expect(page.locator('#wf-tab-signup')).toHaveAttribute('aria-selected', 'true');
		await page.fill('#wf-signup-name', 'Asha Kumar');
		await page.fill('#wf-signup-email', 'asha@example.com');
		await page.fill('#wf-signup-password', 'longpassword1');
		await page.click('#wf-signup-form button[type="submit"]');
		await expect(notice(page)).toContainText('Check your email — we sent a link to asha@example.com');
		await expect(notice(page)).toHaveClass(/wf-is-ok/);
		await expect(page.locator('#wf-panel-login')).toBeVisible();
		await expect(page.locator('#wf-login-email')).toHaveValue('asha@example.com');
		expect(callsTo(server, '/api/customers', 'POST')[0].body).toEqual({ name: 'Asha Kumar', email: 'asha@example.com', password: 'longpassword1' });
		expect(new URL(page.url()).pathname).toBe('/login');
	});

	test('sign up: email taken / short password', async ({ page }) => {
		const server = await fakeCms(page, {
			signup: err(400, 'The following field is invalid: email', [{ message: 'A user with the given email is already registered.', path: 'email' }])
		});
		await open(page, '/login');
		await page.click('#wf-tab-signup');
		await page.fill('#wf-signup-name', 'Asha');
		await page.fill('#wf-signup-email', 'asha@example.com');
		await page.fill('#wf-signup-password', 'short');
		await page.click('#wf-signup-form button[type="submit"]');
		await expect(notice(page)).toHaveText('Choose a password with at least 8 characters.');
		await expect(page.locator('#wf-signup-password')).toBeFocused();
		expect(callsTo(server, '/api/customers', 'POST')).toHaveLength(0);
		await page.fill('#wf-signup-password', 'longpassword1');
		await page.click('#wf-signup-form button[type="submit"]');
		await expect(notice(page)).toHaveText('That email already has an account — log in instead, or reset your password.');
		await expect(page.locator('#wf-signup-email')).toHaveAttribute('aria-invalid', 'true');
	});

	test.describe('"Send the link again" (resend verification)', () => {
		const UNVERIFIED = err(403, 'Please verify your email before logging in.');
		const SENT = 'If that email needs verifying, a new link is on its way.';
		const resendBtn = (page) => page.locator('[data-wf-resend-verification]');

		test('unverified login → Send the link again: spinner, neutral notice, focus moves on', async ({ page }) => {
			let release;
			const gate = new Promise((r) => (release = r));
			const errors = pageErrors(page);
			const server = await fakeCms(page, { login: UNVERIFIED, resend: () => ({ status: 200, json: { ok: true }, gate }) });
			await open(page, '/login');
			await logIn(page, '  Asha@Example.com ', 'secret-pass-1');
			await expect(notice(page)).toHaveText('Please verify your email — we sent you a link');
			await expect(resendBtn(page)).toHaveText('Send the link again');
			await resendBtn(page).click();
			await expect(resendBtn(page)).toBeDisabled();
			await expect(resendBtn(page)).toHaveAttribute('aria-busy', 'true');
			await expect(resendBtn(page).locator('svg.wf-spinner')).toBeVisible();
			await expect(resendBtn(page)).toContainText('Sending');
			release();
			await expect(notice(page)).toHaveText(SENT);
			await expect(notice(page)).toHaveClass(/wf-is-ok/);
			await expect(page.locator('[data-wf-resend]')).toHaveCount(0);
			await expect(page.locator('#wf-login-password')).toBeFocused();
			expect(callsTo(server, '/api/store/account/resend-verification', 'POST').map((c) => c.body)).toEqual([{ email: 'asha@example.com' }]);
			expect(new URL(page.url()).pathname).toBe('/login');
			expect(errors).toEqual([]);
		});

		test('a wrong password offers no resend', async ({ page }) => {
			await fakeCms(page, { login: err(401, 'The email or password provided is incorrect.') });
			await open(page, '/login');
			await logIn(page);
			await expect(notice(page)).toContainText('don’t match');
			await expect(page.locator('[data-wf-resend]')).toHaveCount(0);
		});

		test('after signing up: "Didn’t get it? Send the link again" for that address', async ({ page }) => {
			const server = await fakeCms(page);
			await open(page, '/login?nofx=1');
			await page.click('#wf-tab-signup');
			await page.fill('#wf-signup-name', 'Asha Kumar');
			await page.fill('#wf-signup-email', 'Asha@Example.com');
			await page.fill('#wf-signup-password', 'longpassword1');
			await page.click('#wf-signup-form button[type="submit"]');
			await expect(notice(page)).toContainText('Check your email — we sent a link to asha@example.com');
			await expect(page.locator('[data-wf-resend]')).toHaveText('Didn’t get it? Send the link again');
			await resendBtn(page).click();
			await expect(notice(page)).toHaveText(SENT);
			expect(callsTo(server, '/api/store/account/resend-verification', 'POST').map((c) => c.body)).toEqual([{ email: 'asha@example.com' }]);
		});

		test('429 → the link-sending rate-limit copy, and the action steps aside', async ({ page }) => {
			// cms-hardening.md §3: the custom endpoint's 429 body
			const limited = { status: 429, json: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a moment and try again.', details: { retryAfterSeconds: 42 } } } };
			await fakeCms(page, { login: UNVERIFIED, resend: limited });
			await open(page, '/login');
			await logIn(page);
			await resendBtn(page).click();
			await expect(notice(page)).toHaveText('You’ve asked for a few links already — please wait a minute, then try again.');
			await expect(notice(page)).not.toHaveClass(/wf-is-ok/);
			await expect(page.locator('[data-wf-resend]')).toHaveCount(0);
		});

		test('offline → connection copy, and the action stays to try again', async ({ page }) => {
			let offline = true;
			const server = await fakeCms(page, { login: UNVERIFIED });
			await page.route('**/api/store/account/resend-verification', (route) => (offline ? route.abort('internetdisconnected') : route.fallback()));
			await open(page, '/login');
			await logIn(page);
			await resendBtn(page).click();
			await expect(notice(page)).toHaveText('We couldn’t reach Wefeasto — check your connection and try again.');
			await expect(resendBtn(page)).toBeEnabled();
			offline = false;
			await resendBtn(page).click();
			await expect(notice(page)).toHaveText(SENT);
			expect(callsTo(server, '/api/store/account/resend-verification', 'POST')).toHaveLength(1);
		});

		test('switching tabs takes the action away with the notice', async ({ page }) => {
			await fakeCms(page, { login: UNVERIFIED });
			await open(page, '/login');
			await logIn(page);
			await expect(resendBtn(page)).toBeVisible();
			await page.click('#wf-tab-signup');
			await expect(page.locator('[data-wf-resend]')).toHaveCount(0);
		});
	});

	test('server password rule (8–128) and a sign-up 429 map to friendly copy', async ({ page }) => {
		// Bodies as cms-hardening.md §2–3 specifies them.
		let answer = err(400, 'The following field is invalid: password', [{ message: 'Keep your password under 129 characters.', path: 'password' }]);
		await fakeCms(page, { signup: () => answer });
		await open(page, '/login');
		await page.click('#wf-tab-signup');
		await page.fill('#wf-signup-name', 'Asha');
		await page.fill('#wf-signup-email', 'asha@example.com');
		await page.fill('#wf-signup-password', 'longpassword1');
		await page.click('#wf-signup-form button[type="submit"]');
		await expect(notice(page)).toHaveText('That password is too long — use 128 characters or fewer.');
		await expect(page.locator('#wf-signup-password')).toHaveAttribute('aria-invalid', 'true');
		answer = err(400, 'The following field is invalid: password', [{ message: 'Choose a password with at least 8 characters.', path: 'password' }]);
		await page.click('#wf-signup-form button[type="submit"]');
		await expect(notice(page)).toHaveText('Choose a password with at least 8 characters.');
		answer = { status: 429, json: { errors: [{ name: 'APIError', message: 'Too many attempts. Please wait a moment and try again.', data: { code: 'RATE_LIMITED', retryAfterSeconds: 240 } }] } };
		await page.click('#wf-signup-form button[type="submit"]');
		await expect(notice(page)).toHaveText('Too many attempts — please wait 4 minutes and try again.');
	});

	test('tabs: arrow keys switch panels (roving tabindex)', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login');
		await page.focus('#wf-tab-login');
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('#wf-tab-signup')).toBeFocused();
		await expect(page.locator('#wf-panel-signup')).toBeVisible();
		await expect(page.locator('#wf-tab-login')).toHaveAttribute('tabindex', '-1');
		await page.keyboard.press('Home');
		await expect(page.locator('#wf-tab-login')).toBeFocused();
		await expect(page.locator('#wf-panel-login')).toBeVisible();
	});

	test('?verify=<token>: verifies, strips the token, "Email verified — log in"', async ({ page }) => {
		const server = await fakeCms(page);
		const token = '1ebab832cf75df7fbeb9923f414bea0d903d62d7';
		await open(page, `/login?verify=${token}`);
		await expect(notice(page)).toHaveText('Email verified — log in');
		expect(callsTo(server, `/api/customers/verify/${token}`, 'POST')).toHaveLength(1);
		expect(new URL(page.url()).search).toBe('');
		expect(callsTo(server, '/api/customers/me')).toHaveLength(0); // not redirected anywhere
	});

	test('?verify with a used/expired token → honest error', async ({ page }) => {
		await fakeCms(page, { verify: err(403, 'Verification token is invalid.') });
		await open(page, '/login?verify=1ebab832cf75df7fbeb9923f414bea0d903d62d7');
		await expect(notice(page)).toHaveText('This link has expired or was already used. If you’ve confirmed your email already, just log in.');
	});

	test('?verify with a malformed token never reaches the API', async ({ page }) => {
		const server = await fakeCms(page);
		await open(page, '/login?verify=..%2F..%2Fcustomers%2Fme');
		await expect(notice(page)).toContainText('expired or was already used');
		expect(server.calls.filter((c) => c.path.includes('verify'))).toEqual([]);
	});

	const nextCases = [
		['/cart', '/cart'],
		['/products/muesli', '/products/muesli'],
		['//evil.com', '/account'],
		['/\\evil.com', '/account'],
		['https://evil.com/', '/account'],
		['javascript:alert(1)', '/account'],
		['%2F%2Fevil.com', '/account']
	];
	for (const [next, want] of nextCases) {
		test(`?next=${next} → ${want} after login`, async ({ page }) => {
			await fakeCms(page);
			await open(page, `/login?next=${encodeURIComponent(next)}`);
			await logIn(page);
			await page.waitForURL((u) => u.pathname === want);
			expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin); // never left the site
			expect(page.url()).not.toContain('evil');
		});
	}

	test('already logged in: /login goes straight on to ?next', async ({ page }) => {
		await fakeCms(page, { user: CUSTOMER });
		await page.goto('/login?next=/shop');
		await page.waitForURL((u) => u.pathname === '/shop');
	});

	/* PI-ACC-1: the one-shot links are "the above" in storefront-account.md §2
	   ("Already logged in (and none of the above) → goto(next)"). A signed-in
	   customer who follows /reset-password's "Get a new reset link"
	   (/login?forgot=1) must get the forgot panel, not /account (which has no
	   password change). The session check still runs, so the nav learns it. */
	for (const [query, check] of [
		['?forgot=1', async (page) => await expect(page.locator('#wf-panel-forgot')).toBeVisible()],
		['?forgot=1&next=/shop', async (page) => await expect(page.locator('#wf-panel-forgot')).toBeVisible()],
		['?reset=1', async (page) => await expect(notice(page)).toHaveText('Password updated — log in with your new password.')]
	]) {
		for (const variant of ['motion', 'nofx']) {
			test(`signed in: /login${query} stays on /login (${variant})`, async ({ page }) => {
				const server = await fakeCms(page, { user: CUSTOMER });
				const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/customers/me');
				await page.goto(`/login${query}${variant === 'nofx' ? '&nofx=1' : ''}`);
				await hydrated(page);
				await check(page);
				expect((await me).status()).toBe(200);
				// Whatever the answer triggers (a client-side goto) has run once the network is quiet.
				await page.waitForLoadState('networkidle');
				await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
				expect(new URL(page.url()).pathname).toBe('/login');
				await check(page);
				expect(callsTo(server, '/api/customers/me', 'GET').length).toBeGreaterThanOrEqual(1);
				// The one-shot flags are stripped, ?next= is kept.
				const q = new URL(page.url()).searchParams;
				expect(q.get('forgot')).toBeNull();
				expect(q.get('reset')).toBeNull();
				if (query.includes('next=')) expect(q.get('next')).toBe('/shop');
				// The nav learned the session from the check.
				await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/account');
			});
		}
	}

	test('signed in: /login?forgot=1 sends a reset link and stays put', async ({ page }) => {
		const server = await fakeCms(page, { user: CUSTOMER });
		await open(page, '/login?forgot=1');
		await expect(page.locator('#wf-panel-forgot')).toBeVisible();
		await page.fill('#wf-forgot-email', CUSTOMER.email);
		await page.click('#wf-forgot-form button[type="submit"]');
		await expect.poll(() => callsTo(server, '/api/customers/forgot-password', 'POST').length).toBe(1);
		expect(callsTo(server, '/api/customers/forgot-password')[0].body).toEqual({ email: CUSTOMER.email });
		await page.waitForLoadState('networkidle');
		expect(new URL(page.url()).pathname).toBe('/login');
	});

	test('?session=expired shows why they are here', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login?next=/account&session=expired');
		await expect(notice(page)).toHaveText('Your session has ended — please log in again.');
		expect(new URL(page.url()).searchParams.get('session')).toBeNull();
		expect(new URL(page.url()).searchParams.get('next')).toBe('/account');
	});
});

/*
 * #wf-auth-notice once the motion has finished (W2V-1). A message that
 * replaced one still fading in used to stay frozen mid-tween, e.g. the
 * verify link's "Email verified — log in" as a 7px sliver at 15% opacity.
 * The specs above only read the text, so they passed. These wait for the
 * notice to settle and then check what the visitor actually sees: shown, full
 * opacity, natural height, no inline styles left behind by a tween.
 */
test.describe('/login notice motion', () => {
	const VERIFIED = 'Email verified — log in';
	const VERIFY_INVALID = 'This link has expired or was already used. If you’ve confirmed your email already, just log in.';
	const TOKEN_40 = '1ebab832cf75df7fbeb9923f414bea0d903d62d7';

	const noticeState = (page) =>
		notice(page).evaluate((el) => {
			const cs = getComputedStyle(el);
			return {
				text: el.textContent,
				hidden: el.hidden,
				opacity: cs.opacity,
				visibility: cs.visibility,
				style: el.getAttribute('style') || '',
				height: Math.round(el.getBoundingClientRect().height)
			};
		});

	/** Settled on `text`, and still so after every notice tween (≤ 0.4 s) could have ended. */
	async function expectNoticeSettled(page, text) {
		const shown = { text, hidden: false, opacity: '1', visibility: 'visible', style: '' };
		await expect.poll(() => noticeState(page), { timeout: 5000 }).toMatchObject(shown);
		await page.waitForTimeout(600);
		const s = await noticeState(page);
		expect(s).toMatchObject(shown);
		expect(s.height).toBeGreaterThanOrEqual(40); // one line + 2 × 12px padding
	}

	/** Hidden, and no tween left anything behind on the element. */
	async function expectNoticeGone(page) {
		await expect.poll(() => noticeState(page), { timeout: 5000 }).toMatchObject({ hidden: true, style: '' });
	}

	/** Resolves once the notice is visibly part-way through a fade in or out (0 < opacity < 1). */
	const midFade = (page) =>
		page.waitForFunction(
			() => {
				const n = document.getElementById('wf-auth-notice');
				if (!n) return false; // not parsed yet
				const o = +getComputedStyle(n).opacity;
				return !n.hidden && o > 0 && o < 1;
			},
			null,
			{ polling: 'raf' }
		);

	const after = (ms, res) => () => ({ ...res, gate: new Promise((r) => setTimeout(r, ms)) });
	const ok = { status: 200, json: { message: 'Account verified successfully.' } };
	const verifyCases = [
		['verified, instant answer', { verify: after(0, ok) }, TOKEN_40, VERIFIED],
		['verified, answer mid fade-in (150 ms)', { verify: after(150, ok) }, TOKEN_40, VERIFIED],
		['verified, answer after the fade (900 ms)', { verify: after(900, ok) }, TOKEN_40, VERIFIED],
		['used/expired token', { verify: after(0, err(403, 'Verification token is invalid.')) }, TOKEN_40, VERIFY_INVALID],
		['malformed token, no request', {}, '..%2F..%2Fcustomers%2Fme', VERIFY_INVALID]
	];
	for (const variant of ['motion', 'nofx']) {
		const q = variant === 'nofx' ? '&nofx=1' : '';
		for (const [name, opts, token, text] of verifyCases) {
			test(`?verify (${name}): the notice ends fully shown (${variant})`, async ({ page }) => {
				await fakeCms(page, opts);
				await page.goto(`/login?verify=${token}${q}`);
				await expectNoticeSettled(page, text);
			});
		}
		for (const [query, text] of [
			['?reset=1', 'Password updated — log in with your new password.'],
			['?session=expired', 'Your session has ended — please log in again.']
		]) {
			test(`${query}: the notice ends fully shown (${variant})`, async ({ page }) => {
				await fakeCms(page);
				await page.goto(`/login${query}${q}`);
				await expectNoticeSettled(page, text);
			});
		}
	}

	test('verify answers while "Confirming your email…" is visibly fading in', async ({ page }) => {
		let release;
		const gate = new Promise((r) => (release = r));
		await fakeCms(page, { verify: () => ({ ...ok, gate }) });
		await page.goto(`/login?verify=${TOKEN_40}`, { waitUntil: 'commit' }); // 'load' can come after the fade
		await midFade(page);
		await expect(notice(page)).toHaveText('Confirming your email…');
		release();
		await expectNoticeSettled(page, VERIFIED);
	});

	test('a new message that interrupts a fade-in is shown in full', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login');
		await logIn(page, 'not-an-email', 'x'); // client-side: no request, instant notice
		await midFade(page);
		// A second client-side failure inside the same 0.35s fade (a Playwright
		// fill + click round trip can outlast it): valid email, no password.
		await page.evaluate(() => {
			const set = (id, v) => {
				const el = document.getElementById(id);
				el.value = v;
				el.dispatchEvent(new Event('input', { bubbles: true }));
			};
			set('wf-login-email', 'asha@example.com');
			set('wf-login-password', '');
			document.getElementById('wf-login-form').requestSubmit();
		});
		await expectNoticeSettled(page, 'Enter your password.');
	});

	test('switching tabs mid fade-in hides the notice cleanly; the next one shows in full', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login');
		await logIn(page, 'not-an-email', 'x');
		await midFade(page);
		await page.click('#wf-tab-signup');
		await expectNoticeGone(page);
		await expect(page.locator('#wf-panel-signup')).toBeVisible();
		await page.fill('#wf-signup-name', 'Asha');
		await page.fill('#wf-signup-email', 'asha@example.com');
		await page.fill('#wf-signup-password', 'short');
		await page.click('#wf-signup-form button[type="submit"]');
		await expectNoticeSettled(page, 'Choose a password with at least 8 characters.');
	});

	test('a message that arrives mid-hide comes back in full', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login');
		await logIn(page, 'not-an-email', 'x');
		await expectNoticeSettled(page, 'Enter a valid email address.');
		await page.click('#wf-tab-signup'); // starts the hide
		await midFade(page);
		await page.evaluate(() => document.getElementById('wf-login-form').requestSubmit());
		await expectNoticeSettled(page, 'Enter a valid email address.');
	});

	test('repeat submits shake the same message, then leave no inline transform', async ({ page }) => {
		const server = await fakeCms(page, { login: err(401, 'The email or password provided is incorrect.') });
		await open(page, '/login');
		await logIn(page, 'asha@example.com', 'wrong-pass');
		await expectNoticeSettled(page, 'That email and password don’t match. Try again, or reset your password.');
		await page.click('#wf-login-form button[type="submit"]');
		await expect.poll(() => callsTo(server, '/api/customers/login').length).toBe(2);
		await expectNoticeSettled(page, 'That email and password don’t match. Try again, or reset your password.');
	});
});

test.describe('forgot → reset password', () => {
	test('forgot panel sends the link; reset page sets the password; back on /login with a notice', async ({ page }) => {
		const server = await fakeCms(page);
		await open(page, '/login');
		await page.fill('#wf-login-email', 'asha@example.com');
		await page.click('[data-wf-forgot]');
		await expect(page.locator('#wf-panel-forgot')).toBeVisible();
		await expect(page.locator('#wf-forgot-email')).toHaveValue('asha@example.com');
		await expect(page.locator('#wf-forgot-email')).toBeFocused();
		await page.click('#wf-forgot-form button[type="submit"]');
		await expect(notice(page)).toContainText('If there’s an account for asha@example.com, a reset link is on its way.');
		expect(callsTo(server, '/api/customers/forgot-password')[0].body).toEqual({ email: 'asha@example.com' });
		await page.click('[data-wf-back-to-login]');
		await expect(page.locator('#wf-panel-login')).toBeVisible();

		const token = '1707d8f866934bf96b9f200be9e52b47b0fb242d';
		await open(page, `/reset-password?token=${token}`);
		await expect.poll(() => new URL(page.url()).search).toBe(''); // token dropped from the address bar
		await page.fill('#wf-reset-password', 'newpassword2');
		await page.fill('#wf-reset-confirm', 'newpassword3');
		await page.click('#wf-reset-form button[type="submit"]');
		await expect(page.locator('#wf-reset-notice')).toHaveText('Those passwords don’t match.');
		await expect(page.locator('#wf-reset-confirm')).toBeFocused();
		expect(callsTo(server, '/api/customers/reset-password')).toHaveLength(0);
		await page.fill('#wf-reset-confirm', 'newpassword2');
		await page.click('#wf-reset-form button[type="submit"]');
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(notice(page)).toHaveText('Password updated — log in with your new password.');
		expect(callsTo(server, '/api/customers/reset-password')[0].body).toEqual({ token, password: 'newpassword2' });
		expect(callsTo(server, '/api/customers/logout')).toHaveLength(1); // the auto-session is ended
		expect(new URL(page.url()).search).toBe('');
	});

	test('reset: weak password is refused before any request', async ({ page }) => {
		const server = await fakeCms(page);
		await open(page, '/reset-password?token=1707d8f866934bf96b9f200be9e52b47b0fb242d');
		await page.fill('#wf-reset-password', 'short');
		await page.fill('#wf-reset-confirm', 'short');
		await page.click('#wf-reset-form button[type="submit"]');
		await expect(page.locator('#wf-reset-notice')).toHaveText('Choose a password with at least 8 characters.');
		await expect(page.locator('#wf-reset-password')).toHaveAttribute('aria-invalid', 'true');
		expect(callsTo(server, '/api/customers/reset-password')).toHaveLength(0);
	});

	test('reset: used/expired token → error and a way to get a new link', async ({ page }) => {
		await fakeCms(page, { reset: err(403, 'Token is either invalid or has expired.') });
		await open(page, '/reset-password?token=1707d8f866934bf96b9f200be9e52b47b0fb242d');
		await page.fill('#wf-reset-password', 'newpassword2');
		await page.fill('#wf-reset-confirm', 'newpassword2');
		await page.click('#wf-reset-form button[type="submit"]');
		await expect(page.locator('#wf-reset-notice')).toHaveText('This reset link has expired or was already used — ask for a new one below.');
		await page.click('[data-wf-reset-again]');
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(page.locator('#wf-panel-forgot')).toBeVisible();
	});

	test('reset: no token in the link', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/reset-password');
		await expect(page.locator('[data-wf-reset-missing]')).toBeVisible();
		await expect(page.locator('#wf-reset-form')).toHaveCount(0);
		await expect(page.locator('a[href="/login?forgot=1"]')).toBeVisible();
	});
});

/* Hunt fixes (sf-account): a login whose session cookie never sticks (cookies
   blocked) must say so instead of "Welcome back!" + a silent bounce, and busy
   (disabled) buttons must not leave keyboard focus on <body> once they settle. */
test.describe('blocked cookies and keyboard focus', () => {
	const COOKIES = 'Your browser is blocking cookies for this site — allow cookies to log in (you can still check out as a guest).';
	const onBody = (page) => page.evaluate(() => !document.activeElement || document.activeElement === document.body);
	const pressEnterOn = async (locator) => {
		await expect(locator).toBeVisible(); // the details card reveals in (visibility) after /me
		await locator.focus();
		await expect(locator).toBeFocused();
		await locator.page().keyboard.press('Enter');
	};

	for (const variant of ['motion', 'nofx']) {
		test(`the right password but the cookie didn't stick: a cookie notice, still on /login (${variant})`, async ({ page }) => {
			// /me keeps answering "nobody": the browser stored no session cookie.
			const server = await fakeCms(page, { me: { status: 200, json: { user: null, message: 'Account' } } });
			await open(page, variant === 'nofx' ? '/login?nofx=1' : '/login');
			const seen = [];
			await page.exposeFunction('__wfNotice', (t) => seen.push(t));
			await page.evaluate(() => {
				const n = document.getElementById('wf-auth-notice');
				new MutationObserver(() => window.__wfNotice(n.textContent)).observe(n, { childList: true, characterData: true, subtree: true });
			});
			await page.fill('#wf-login-email', 'asha@example.com');
			await page.fill('#wf-login-password', 'secret-pass-1');
			const btn = page.locator('#wf-login-form button[type="submit"]');
			await pressEnterOn(btn);
			await expect(notice(page)).toHaveText(COOKIES);
			await expect(notice(page)).not.toHaveClass(/wf-is-ok/);
			await expect(btn).toBeFocused(); // no field at fault: focus back on the button
			expect(seen.some((t) => /Welcome back/.test(t)), 'never claims success').toBe(false);
			expect(callsTo(server, '/api/customers/login')).toHaveLength(1);
			expect(callsTo(server, '/api/customers/me').length).toBeGreaterThanOrEqual(2); // on mount + the check after logging in
			await page.waitForTimeout(500);
			expect(new URL(page.url()).pathname).toBe('/login');
			await expect(page.locator('#wf-login-email')).toHaveValue('asha@example.com');
			expect(await page.evaluate(() => localStorage.getItem('wefeasto_signed_in'))).toBeNull();
		});

		test(`keyboard: Create Account → focus on the Log In tab, never <body> (${variant})`, async ({ page }) => {
			await fakeCms(page);
			await open(page, variant === 'nofx' ? '/login?nofx=1' : '/login');
			await page.click('#wf-tab-signup');
			await page.fill('#wf-signup-name', 'Asha Kumar');
			await page.fill('#wf-signup-email', 'asha@example.com');
			await page.fill('#wf-signup-password', 'longpassword1');
			await pressEnterOn(page.locator('#wf-signup-form button[type="submit"]'));
			await expect(notice(page)).toContainText('we sent a link to asha@example.com');
			await expect(page.locator('#wf-tab-login')).toBeFocused();
			await expect(page.locator('#wf-panel-login')).toBeVisible();
			await expect(page.locator('#wf-tab-login')).toBeFocused(); // and it stays there once the panels settle
		});
	}

	test('keyboard: a login refusal with no field at fault puts focus back on Log In', async ({ page }) => {
		await fakeCms(page, { login: err(401, 'This user is locked due to having too many failed login attempts.') });
		await open(page, '/login');
		await page.fill('#wf-login-email', 'asha@example.com');
		await page.fill('#wf-login-password', 'secret-pass-1');
		const btn = page.locator('#wf-login-form button[type="submit"]');
		await pressEnterOn(btn);
		await expect(notice(page)).toHaveText('Too many attempts — try again in 10 minutes');
		await expect(btn).toBeFocused();
	});

	test('keyboard: forgot password sent → focus back on "Send reset link"', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/login?forgot=1');
		await page.fill('#wf-forgot-email', 'asha@example.com');
		const btn = page.locator('#wf-forgot-form button[type="submit"]');
		await pressEnterOn(btn);
		await expect(notice(page)).toContainText('a reset link is on its way');
		await expect(btn).toBeFocused();
	});

	test('keyboard: /account Save details keeps focus on the button (saved, and a server error)', async ({ page }) => {
		let fail = false;
		await fakeCms(page, { user: CUSTOMER, patch: () => (fail ? { status: 500, json: {} } : null) });
		await open(page, '/account');
		const btn = page.locator('#wf-account-form button[type="submit"]');
		await page.fill('#wf-acct-name', 'Asha K');
		await pressEnterOn(btn);
		await expect(page.locator('#wf-acct-note')).toHaveText('Saved — thanks!');
		await expect(btn).toBeFocused();
		fail = true;
		await pressEnterOn(btn);
		await expect(page.locator('#wf-acct-note')).toHaveText('Something went wrong — please try again.');
		await expect(btn).toBeFocused();
		expect(await onBody(page)).toBe(false);
	});

	test('keyboard: a failed log out puts focus back on Log out', async ({ page }) => {
		await fakeCms(page, { user: CUSTOMER, logout: { status: 503, json: {} } });
		await open(page, '/account');
		const btn = page.locator('[data-wf-logout]');
		await pressEnterOn(btn);
		await expect(page.locator('.wf-account-out [role="alert"]')).toBeVisible();
		await expect(btn).toBeFocused();
		expect(new URL(page.url()).pathname).toBe('/account');
	});

	test('keyboard: a used reset link moves focus on to "Ask for a new reset link"', async ({ page }) => {
		await fakeCms(page, { reset: err(403, 'Token is either invalid or has expired.') });
		await open(page, '/reset-password?token=1707d8f866934bf96b9f200be9e52b47b0fb242d');
		await page.fill('#wf-reset-password', 'newpassword2');
		await page.fill('#wf-reset-confirm', 'newpassword2');
		await pressEnterOn(page.locator('#wf-reset-form button[type="submit"]'));
		await expect(page.locator('#wf-reset-notice')).toContainText('expired or was already used');
		await expect(page.locator('[data-wf-reset-again]')).toBeFocused();
	});
});

test.describe('/account', () => {
	test('logged out → /login?next=/account; logging in comes back', async ({ page }) => {
		const server = await fakeCms(page);
		await page.goto('/account');
		await page.waitForURL((u) => u.pathname === '/login');
		expect(new URL(page.url()).searchParams.get('next')).toBe('/account');
		await hydrated(page);
		await logIn(page);
		await page.waitForURL((u) => u.pathname === '/account');
		await expect(page.locator('.wf-order-row')).toHaveCount(2);
		expect(callsTo(server, '/api/store/orders/mine').length).toBeGreaterThanOrEqual(1);
	});

	test('orders: newest first, status chips, totals, Buy again → the bag, View on every order', async ({ page }) => {
		await fakeCms(page, { user: CUSTOMER });
		await open(page, '/account');
		await expect(page.locator('.wf-hero-stagger h1')).toHaveText('Your breakfast shelf');
		const rows = page.locator('.wf-order-row');
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toHaveAttribute('data-wf-order', 'WF-10012');
		await expect(rows.nth(0).locator('[data-wf-order-items]')).toHaveText('Muesli ×2 · Cornflakes');
		await expect(rows.nth(0).locator('.wf-order-status')).toHaveText('Shipped');
		await expect(rows.nth(0).locator('[data-wf-order-total]')).toHaveText('₹675');
		await expect(rows.nth(0).locator('.wf-order-date')).toHaveText(/Placed 20 Sept? 2026/);
		await expect(rows.nth(1).locator('.wf-order-status')).toHaveText('Order placed · pay on delivery');
		await expect(rows.nth(0).locator('[data-wf-view-order]')).toHaveAttribute('href', `/order?no=WF-10012&t=${TOKEN}`);
		await expect(rows.nth(1).locator('[data-wf-view-order]')).toHaveAttribute('href', `/order?no=WF-10007&t=${TOKEN_COD}`);
		const again = rows.nth(0).locator('[data-wf-buy-again]');
		await expect(again).toHaveAttribute('href', '/cart?add=muesli:2,cornflakes:1&src=usual');
		await again.click();
		await page.waitForURL((u) => u.pathname === '/cart');
		await expect(page.locator('.wf-cart-row[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('2');
		await expect(page.locator('.wf-cart-row[data-wf-row="cornflakes"] .wf-qty-input')).toHaveValue('1');
	});

	test('View opens /order for every order, whatever its status', async ({ page }) => {
		const item = (slug, name, unit) => ({ slug, name, qty: 1, unitPaise: unit, lineTotalPaise: unit });
		const mk = (n, status, extra = {}) => ({
			number: `WF-1010${n}`,
			status,
			paymentStatus: status === 'paid' ? 'captured' : status === 'payment_failed' ? 'failed' : 'none',
			paymentMethod: status.startsWith('cod') ? 'cod' : 'online',
			requestedMethod: status.startsWith('cod') ? 'cod' : 'upi',
			fulfilmentStatus: 'unfulfilled',
			createdAt: `2026-09-2${n}T10:00:00.000Z`,
			items: [item('muesli', 'Muesli', 25000)],
			subtotalPaise: 25000,
			discountPaise: 0,
			deliveryPaise: 4900,
			codFeePaise: 0,
			totalPaise: 29900,
			canRetryPayment: status === 'payment_failed',
			token: `tok${n}-` + 'aB3_'.repeat(10),
			...extra
		});
		const list = [mk(1, 'paid'), mk(2, 'cod_pending'), mk(3, 'payment_failed'), mk(4, 'cancelled'), mk(5, 'pending_payment'), mk(6, 'needs_review')];
		const want = { paid: 'confirmed', cod_pending: 'confirmed', payment_failed: 'failed', cancelled: 'cancelled', pending_payment: 'confirming', needs_review: 'review' };
		const errors = pageErrors(page);
		const server = await fakeCms(page, { user: CUSTOMER, orders: { status: 200, json: { orders: list } }, statusOrders: list });
		for (const o of list) {
			await open(page, '/account');
			const row = page.locator(`.wf-order-row[data-wf-order="${o.number}"]`);
			const view = row.locator('[data-wf-view-order]');
			await expect(view).toHaveAttribute('href', `/order?no=${o.number}&t=${o.token}`);
			await view.click();
			await page.waitForURL((u) => u.pathname === '/order' && u.searchParams.get('no') === o.number);
			await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', want[o.status]);
			await expect(page.locator('#wf-co-order-no')).toHaveText(`Order ${o.number}`);
			await expect(page.locator('[data-wf-notfound]')).toHaveCount(0);
			const looks = callsTo(server, '/api/store/orders/status', 'GET');
			expect(looks.length).toBeGreaterThan(0);
		}
		expect(errors).toEqual([]);
	});

	test('no orders yet: empty state with a Shop link', async ({ page }) => {
		await fakeCms(page, { user: CUSTOMER, orders: { status: 200, json: { orders: [] } } });
		await open(page, '/account');
		await expect(page.locator('[data-wf-orders-empty]')).toContainText('No orders yet');
		await expect(page.locator('[data-wf-orders-empty] a[href="/shop"]')).toBeVisible();
	});

	test('orders fail to load → retry', async ({ page }) => {
		let fail = true;
		await fakeCms(page, { user: CUSTOMER, orders: () => (fail ? { status: 500, json: { error: { code: 'INTERNAL', message: 'x' } } } : null) });
		await open(page, '/account');
		await expect(page.locator('[data-wf-orders-error]')).toContainText('We couldn’t load your orders just now.');
		fail = false;
		await page.locator('[data-wf-orders-error] button').click();
		await expect(page.locator('.wf-order-row')).toHaveCount(2);
	});

	test('a 401 mid-session → /login?next=/account with a notice', async ({ page }) => {
		await fakeCms(page, { user: CUSTOMER, orders: err(401, 'Unauthorized') });
		await page.goto('/account');
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(notice(page)).toHaveText('Your session has ended — please log in again.');
		expect(new URL(page.url()).searchParams.get('next')).toBe('/account');
	});

	test('details: phone validated client-side, saved as +91…, email read-only', async ({ page }) => {
		const server = await fakeCms(page, { user: { ...CUSTOMER, phone: null } });
		await open(page, '/account');
		await expect(page.locator('#wf-acct-email')).toHaveValue('asha@example.com');
		await expect(page.locator('#wf-acct-email')).toHaveAttribute('readonly', '');
		await page.fill('#wf-acct-phone', '12345');
		await page.click('#wf-account-form button[type="submit"]');
		await expect(page.locator('#wf-acct-note')).toHaveText('Enter a 10-digit Indian mobile number.');
		await expect(page.locator('#wf-acct-phone')).toHaveAttribute('aria-invalid', 'true');
		expect(callsTo(server, '/api/customers/7', 'PATCH')).toHaveLength(0);
		await page.fill('#wf-acct-name', 'Asha K');
		await page.fill('#wf-acct-phone', '098765 43210');
		await page.click('#wf-account-form button[type="submit"]');
		await expect(page.locator('#wf-acct-note')).toHaveText('Saved — thanks!');
		expect(callsTo(server, '/api/customers/7', 'PATCH')[0].body).toEqual({ name: 'Asha K', phone: '+919876543210' });
		await expect(page.locator('#wf-acct-phone')).toHaveValue('+91 98765 43210');
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Asha.');
	});

	/* PI-EXP-3: the "(optional)" hint was `opacity: .6` on the #333 label, 3.69:1 on
	   white (WCAG 1.4.3 wants 4.5:1). axe on the settled details card, both motion modes. */
	for (const variant of ['motion', 'nofx']) {
		test(`details: the "(optional)" hint passes colour contrast (${variant})`, async ({ page }) => {
			await fakeCms(page, { user: CUSTOMER });
			await open(page, `/account${variant === 'nofx' ? '?nofx=1' : ''}`);
			const soft = page.locator('label[for="wf-acct-phone"] .wf-label-soft');
			await expect(soft).toHaveText('(optional)');
			// The card's reveal has finished: colours are final.
			await expect.poll(() => page.locator('.wf-account-details').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
			await page.evaluate(async () => {
				await document.fonts?.ready;
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			});
			const r = await new AxeBuilder({ page }).include('.wf-account-details').withRules(['color-contrast']).analyze();
			expect(r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target} ${n.failureSummary}`))).toEqual([]);
			expect(r.passes.flatMap((v) => v.nodes.map((n) => String(n.target))).some((t) => t.includes('wf-label-soft'))).toBe(true);
			// Softness by colour, not opacity (opacity hides the real ratio from a colour change).
			expect(await soft.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		});
	}

	test('log out → home; the nav points at /login again', async ({ page }) => {
		const server = await fakeCms(page, { user: CUSTOMER });
		await page.addInitScript(() => {
			try {
				localStorage.setItem('wefeasto_signed_in', '1');
			} catch (e) {}
		});
		await open(page, '/account');
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/account');
		await page.click('[data-wf-logout]');
		await page.waitForURL((u) => u.pathname === '/');
		expect(callsTo(server, '/api/customers/logout')).toHaveLength(1);
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/login');
		expect(await page.evaluate(() => localStorage.getItem('wefeasto_signed_in'))).toBeNull();
		await page.goto('/account');
		await page.waitForURL((u) => u.pathname === '/login');
	});

	test('offline on first load → error with retry, no redirect', async ({ page }) => {
		let offline = true;
		await fakeCms(page, { user: CUSTOMER });
		await page.route('**/api/customers/me', (route) => (offline ? route.abort('internetdisconnected') : route.fallback()));
		await open(page, '/account');
		await expect(page.locator('.wf-account-problem')).toContainText('We couldn’t reach Wefeasto');
		expect(new URL(page.url()).pathname).toBe('/account');
		offline = false;
		await page.locator('.wf-account-problem button').click();
		await expect(page.locator('.wf-order-row')).toHaveCount(2);
	});
});

test.describe('nav account link', () => {
	test('never logged in here: no /me request, the icon keeps /login', async ({ page }) => {
		const server = await fakeCms(page, { user: CUSTOMER });
		await open(page, '/shop');
		await page.waitForTimeout(300);
		expect(callsTo(server, '/api/customers/me')).toHaveLength(0);
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/login');
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('aria-label', 'Login');
	});

	test('logged in (hint + /me): icon, footer and mobile menu point at /account', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await fakeCms(page, { user: CUSTOMER });
		await page.addInitScript(() => localStorage.setItem('wefeasto_signed_in', '1'));
		await open(page, '/shop');
		const icon = page.locator('a.link-block-3._2');
		await expect(icon).toHaveAttribute('href', '/account');
		await expect(icon).toHaveAttribute('aria-label', 'Your account');
		await expect(page.locator('.footer-section .footer-link[href="/account"]')).toHaveText('Account');
		await page.click('#wf-menu-btn');
		await expect(page.locator('.wf-mnav-actions a').first()).toHaveAttribute('href', '/account');
	});

	test('a stale hint (session gone) falls back to /login and clears itself', async ({ page }) => {
		await fakeCms(page);
		await page.addInitScript(() => {
			if (!sessionStorage.getItem('seeded')) {
				localStorage.setItem('wefeasto_signed_in', '1');
				sessionStorage.setItem('seeded', '1');
			}
		});
		await open(page, '/shop');
		await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_signed_in'))).toBeNull();
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/login');
	});
});

test.describe('phone layout (390px)', () => {
	test.use({ viewport: { width: 390, height: 844 } });
	for (const path of ['/login', '/login?forgot=1', '/account', '/reset-password?token=1707d8f866934bf96b9f200be9e52b47b0fb242d']) {
		test(`${path}: no horizontal overflow`, async ({ page }) => {
			await fakeCms(page, { user: path === '/account' ? CUSTOMER : null });
			await open(page, path);
			if (path === '/account') await expect(page.locator('.wf-order-row')).toHaveCount(2);
			await expectNoHorizontalOverflow(page);
		});
	}

	test('/account order actions sit side by side, same height', async ({ page }) => {
		await fakeCms(page, { user: CUSTOMER });
		await open(page, '/account');
		const btns = page.locator('.wf-order-row').first().locator('.wf-order-btn');
		await expect(btns).toHaveCount(2);
		// measured once the row's entrance has settled
		await expect
			.poll(async () => {
				const [a, b] = [await btns.nth(0).boundingBox(), await btns.nth(1).boundingBox()];
				return Math.abs(a.y - b.y) < 1 && Math.abs(a.height - b.height) < 1 && a.height >= 44;
			})
			.toBe(true);
	});
});

test.describe('other tabs (hunt: logout-other-tab-keeps-account)', () => {
	const bye = { status: 200, json: { message: 'Logout successful.' } };

	test('logging out in another tab takes this /account to /login: no orders or details left on screen', async ({ page, context }) => {
		const shared = { user: CUSTOMER };
		const me = () => ({ status: 200, json: { user: shared.user, message: 'Account' } });
		await fakeCms(page, { user: CUSTOMER, me });
		await open(page, '/account');
		await expect(page.locator('.wf-order-row')).toHaveCount(2);
		const other = await context.newPage();
		await fakeCms(other, { user: CUSTOMER, me, logout: () => ((shared.user = null), bye) });
		await open(other, '/account');
		await other.click('[data-wf-logout]');
		await other.waitForURL((u) => u.pathname === '/');
		// no focus / visibility events: the hint's removal is enough
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(page.locator('[data-wf-orders]')).toHaveCount(0);
		await expect(page.locator('#wf-account-form')).toHaveCount(0);
		await expect(notice(page)).toHaveText('Your session has ended — please log in again.');
	});

	test('logging in in another tab: this tab’s nav learns without a reload', async ({ page, context }) => {
		const shared = { user: null };
		const me = () => ({ status: 200, json: { user: shared.user, message: 'Account' } });
		await fakeCms(page, { me });
		await open(page, '/shop');
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/login');
		const other = await context.newPage();
		await fakeCms(other, { user: CUSTOMER, me, login: () => ((shared.user = CUSTOMER), { status: 200, json: { message: 'Authentication Passed', user: CUSTOMER } }) });
		await open(other, '/login');
		await logIn(other);
		await other.waitForURL((u) => u.pathname === '/account');
		await expect(page.locator('a.link-block-3._2')).toHaveAttribute('href', '/account');
	});

	test('someone else logged in since: coming back to /account shows them, not the last customer', async ({ page }) => {
		const BOB = { ...CUSTOMER, id: 8, name: 'Bob Mathew', email: 'bob@example.com', phone: '' };
		const shared = { user: CUSTOMER };
		await fakeCms(page, {
			user: CUSTOMER,
			me: () => ({ status: 200, json: { user: shared.user, message: 'Account' } }),
			orders: () => ({ status: 200, json: { orders: shared.user.id === BOB.id ? [] : ORDERS } })
		});
		await open(page, '/account');
		await expect(page.locator('.wf-order-row')).toHaveCount(2);
		await expect(page.locator('#wf-acct-name')).toHaveValue('Asha Kumar');
		shared.user = BOB;
		// the re-check waits RECHECK_MS (30 s) between asks: move the page's clock on (time keeps running)
		await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 31_000);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Bob.');
		await expect(page.locator('#wf-acct-name')).toHaveValue('Bob Mathew');
		await expect(page.locator('#wf-acct-email')).toHaveValue('bob@example.com');
		await expect(page.locator('[data-wf-orders-empty]')).toBeVisible();
		await expect(page.locator('.wf-order-row')).toHaveCount(0);
	});
});

test.describe('the same message twice is announced twice (hunt: repeat-notices)', () => {
	/** Text that lands in a live region (as a new node or a text change) from now on. */
	const recordLive = (page) =>
		page.evaluate(() => {
			const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]';
			window.__live = [];
			new MutationObserver((ms) => {
				for (const m of ms) {
					const nodes = m.type === 'characterData' ? [m.target] : [...m.addedNodes];
					for (const n of nodes) {
						const el = n.nodeType === 1 ? n : n.parentElement;
						if (el?.closest(LIVE) && n.textContent.trim()) window.__live.push(n.textContent.trim());
					}
				}
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
		});
	const live = (page) => page.evaluate(() => window.__live.join(' | '));
	const WRONG = 'That email and password don’t match. Try again, or reset your password.';

	for (const variant of ['motion', 'nofx']) {
		test(`/login: a second wrong password (${variant})`, async ({ page }) => {
			const server = await fakeCms(page, { login: err(401, 'The email or password provided is incorrect.') });
			await open(page, variant === 'nofx' ? '/login?nofx=1' : '/login');
			await logIn(page, 'asha@example.com', 'wrong-pass-1');
			await expect(notice(page)).toHaveText(WRONG);
			await recordLive(page);
			await page.fill('#wf-login-password', 'wrong-pass-2');
			await page.locator('#wf-login-password').press('Enter');
			await expect.poll(() => callsTo(server, '/api/customers/login').length).toBe(2);
			await expect.poll(() => live(page)).toContain(WRONG);
			await expect(notice(page)).toHaveText(WRONG);
			await expect(notice(page).locator('span')).toHaveCount(1); // one message, not two
		});
	}

	test('/login: asking for a reset link twice', async ({ page }) => {
		const server = await fakeCms(page);
		await open(page, '/login?forgot=1');
		await page.fill('#wf-forgot-email', 'asha@example.com');
		await page.locator('#wf-forgot-email').press('Enter');
		await expect(notice(page)).toContainText('a reset link is on its way');
		await recordLive(page);
		await page.locator('#wf-forgot-email').press('Enter');
		await expect.poll(() => callsTo(server, '/api/customers/forgot-password').length).toBe(2);
		await expect.poll(() => live(page)).toContain('a reset link is on its way');
	});

	test('/reset-password: a second too-short password', async ({ page }) => {
		await fakeCms(page);
		await open(page, '/reset-password?token=1707d8f866934bf96b9f200be9e52b47b0fb242d');
		await page.fill('#wf-reset-password', 'short');
		await page.fill('#wf-reset-confirm', 'short');
		await page.locator('#wf-reset-confirm').press('Enter');
		const alert = page.locator('#wf-reset-notice');
		await expect(alert).toHaveText('Choose a password with at least 8 characters.');
		await expect(page.locator('#wf-reset-password')).toBeFocused();
		await recordLive(page);
		await page.fill('#wf-reset-password', 'short2');
		await page.locator('#wf-reset-password').press('Enter');
		await expect.poll(() => live(page)).toContain('at least 8 characters');
		await expect(alert).toHaveText('Choose a password with at least 8 characters.');
		await expect(page.locator('#wf-reset-password')).toHaveAttribute('aria-invalid', 'true');
		await expect(page.locator('#wf-reset-password')).toBeFocused();
	});
});

test('/account: "Buy again" is named by what it shows (WCAG 2.5.3 label in name)', async ({ page }) => {
	await fakeCms(page, { user: CUSTOMER });
	await open(page, '/account');
	await expect(page.locator('.wf-order-row')).toHaveCount(2);
	await expect(page.locator('.wf-order-row').nth(0).locator('[data-wf-buy-again]')).toHaveAccessibleName('Buy again: order WF-10012');
	await expect(page.getByRole('link', { name: /^Buy again\b/ })).toHaveCount(2);
});
