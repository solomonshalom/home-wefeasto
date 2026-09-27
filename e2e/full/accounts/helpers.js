/*
 * Domain helpers for the accounts / newsletter / welcome-offer / policies specs
 * (e2e/full/accounts/*.spec.js). Contracts: storefront-account.md, storefront-fixes.md,
 * cms-hardening.md, retention-backend.md; roadmap S3, M6, S6, M7, S12.
 *
 * Accounts are made through the same /api the browser uses (storefront proxy → slot CMS),
 * so a test that is not about signing up doesn't pay for the UI. Calls that need the
 * session run fetch() inside the page (pageFetch): the browser sends its HttpOnly, Secure
 * payload-token cookie, so a login there signs the page in, and orders placed there are
 * linked to that customer exactly as orders placed from /checkout while signed in.
 */
import crypto from 'node:crypto';
import { expect } from '../fixtures.js';

export const PASSWORD = 'breakfast-club-2026';
export const NEW_PASSWORD = 'second-breakfast-2026';

/** Customer-facing copy (session.js MESSAGES, /login, /account, home newsletter notices). */
export const COPY = Object.freeze({
	UNVERIFIED: 'Please verify your email — we sent you a link',
	LOCKED: 'Too many attempts — try again in 10 minutes',
	WRONG_CREDENTIALS: 'That email and password don’t match. Try again, or reset your password.',
	EMAIL_TAKEN: 'That email already has an account — log in instead, or reset your password.',
	WEAK_PASSWORD: 'Choose a password with at least 8 characters.',
	PASSWORD_MISMATCH: 'Those passwords don’t match.',
	PHONE_INVALID: 'Enter a 10-digit Indian mobile number.',
	NAME_REQUIRED: 'Tell us your name.',
	VERIFY_INVALID: 'This link has expired or was already used. If you’ve confirmed your email already, just log in.',
	RESET_INVALID: 'This reset link has expired or was already used — ask for a new one below.',
	SESSION_EXPIRED: 'Your session has ended — please log in again.',
	RESEND_SENT: 'If that email needs verifying, a new link is on its way.',
	VERIFIED: 'Email verified — log in',
	RESET_DONE: 'Password updated — log in with your new password.',
	SAVED: 'Saved — thanks!',
	signupSent: (email) => `Check your email — we sent a link to ${email} to confirm your account.`,
	forgotSent: (email) => `If there’s an account for ${email}, a reset link is on its way. It works for one hour.`,
	NL_SUCCESS: 'Check your inbox to confirm — then breakfast recipes are on their way.',
	NL_SUBSCRIBED: 'You’re subscribed — check your inbox for your welcome treat.',
	NL_EXPIRED: 'That confirmation link has expired or was replaced — sign up again below.',
	NL_UNSUBSCRIBED: 'You’re unsubscribed. You won’t get marketing emails from us.',
	NL_UNSUB_INVALID: 'That unsubscribe link didn’t work — reply to any of our emails and we’ll take you off.'
});

export const SUBJECT = Object.freeze({
	VERIFY: 'Confirm your Wefeasto account',
	RESET: 'Reset your Wefeasto password',
	NL_CONFIRM: 'Confirm your Wefeasto subscription',
	WELCOME: "You're in"
});

/* ------------------------------------------------------------------ email links */

function linkMatching(mailpit, msg, re, what) {
	const link = mailpit.extractLinks(msg).find((l) => re.test(l));
	expect(link, `${what} in "${msg?.Subject}"`).toBeTruthy();
	return link;
}

/** The storefront /login?verify=<token> link of a verification email. */
export const verifyLink = (mailpit, msg) => linkMatching(mailpit, msg, /\/login\?verify=[A-Za-z0-9_-]+/, 'a /login?verify= link');
/** The storefront /reset-password?token= link of a reset email. */
export const resetLink = (mailpit, msg) => linkMatching(mailpit, msg, /\/reset-password\?token=[A-Za-z0-9_-]+/, 'a /reset-password?token= link');
/** The CMS /api/store/newsletter/confirm?t= link. */
export const confirmLink = (mailpit, msg) => linkMatching(mailpit, msg, /\/api\/store\/newsletter\/confirm\?t=[A-Za-z0-9_-]+/, 'a newsletter confirm link');
/** The CMS /api/store/newsletter/unsubscribe?t= link in a marketing email body. */
export const unsubscribeLink = (mailpit, msg) => linkMatching(mailpit, msg, /\/api\/store\/newsletter\/unsubscribe\?t=[A-Za-z0-9_-]+/, 'an unsubscribe link');

/** HELLO-XXXX (Crockford base32, 4 or 6 chars) from a welcome email. */
export function welcomeCode(msg) {
	const m = `${msg?.Text || ''} ${msg?.HTML || ''}`.match(/\bHELLO-[0-9A-HJKMNP-TV-Z]{4,6}\b/);
	expect(m, `a HELLO- code in "${msg?.Subject}"`).toBeTruthy();
	return m[0];
}

/** A header's values (Mailpit returns arrays), case-insensitive name. */
export function header(headers, name) {
	const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
	return key ? [].concat(headers[key]) : [];
}

/* ------------------------------------------------------------------ accounts via the API */

async function sfFetch(stack, method, path, body) {
	const res = await fetch(`${stack.sfUrl}/api/${path.replace(/^\/+/, '')}`, {
		method,
		headers: body !== undefined ? { 'content-type': 'application/json' } : {},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		redirect: 'manual'
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* not JSON */
	}
	return { status: res.status, json, text, headers: res.headers };
}
export const sfApi = sfFetch;

/**
 * Sign up through POST /api/customers (what session.js signup() sends) and, unless
 * `verify: false`, follow the emailed token through POST /api/customers/verify/<token>.
 * Resolves { email, name, password, verifyUrl }.
 */
export async function createCustomer({ stack, mailpit, unique }, { name = 'Asha Kumar', email, password = PASSWORD, verify = true, tag = 'acct' } = {}) {
	const addr = email ?? unique.email(tag);
	const r = await sfFetch(stack, 'POST', 'customers', { name, email: addr, password });
	expect(r.status, `signup ${addr}: ${r.text.slice(0, 300)}`).toBe(201);
	const msg = await mailpit.waitForMessage({ to: addr, subjectIncludes: SUBJECT.VERIFY });
	const verifyUrl = verifyLink(mailpit, msg);
	if (verify) {
		const token = new URL(verifyUrl).searchParams.get('verify');
		const v = await sfFetch(stack, 'POST', `customers/verify/${encodeURIComponent(token)}`);
		expect(v.status, `verify ${addr}: ${v.text.slice(0, 200)}`).toBe(200);
	}
	return { email: addr, name, password, verifyUrl };
}

/**
 * fetch() inside the page (same origin, so the browser sends its HttpOnly, Secure
 * payload-token cookie; Playwright's APIRequestContext would not send a Secure cookie over
 * http://localhost). The page must be on the storefront. → { status, json, text }.
 */
export async function pageFetch(page, method, path, body, headers = {}) {
	return page.evaluate(
		async ({ method, path, body, headers }) => {
			const res = await fetch(path, {
				method,
				credentials: 'same-origin',
				headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
				body: body !== undefined ? JSON.stringify(body) : undefined
			});
			const text = await res.text();
			let json = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				/* not JSON */
			}
			return { status: res.status, json, text };
		},
		{ method, path, body, headers }
	);
}

/** Make sure the page is on the storefront (pageFetch needs its origin). */
async function onSite(page, shop) {
	if (!page.url().startsWith('http')) await shop.visit('/shop');
}

/** Sign the page in through POST /api/customers/login from the page (sets the cookie). */
export async function apiLogin(page, shop, email, password = PASSWORD) {
	await onSite(page, shop);
	const r = await pageFetch(page, 'POST', '/api/customers/login', { email, password });
	expect(r.status, `login ${email}: ${r.text.slice(0, 200)}`).toBe(200);
	expect(r.json.token, 'no JWT in the login body (cms-hardening §1)').toBeUndefined();
	return r.json.user;
}

/** GET /api/customers/me from the page → user | null. */
export async function me(page) {
	const r = await pageFetch(page, 'GET', '/api/customers/me');
	expect(r.status).toBe(200);
	return r.json?.user ?? null;
}

/**
 * Place an order from the page (its cookie = its customer), the way /checkout does:
 * quote first, then POST /api/store/checkout with a fresh Idempotency-Key.
 * Resolves { number, token, status, totalPaise, payment, form, quote }.
 */
export async function placeOrderAs(page, shop, unique, { items = { muesli: 1 }, method = 'cod', form = {}, consent = false, couponCode } = {}) {
	await onSite(page, shop);
	const f = unique.form({ ...form, method });
	const lines = Object.entries(items).map(([slug, qty]) => ({ slug, qty }));
	const q = await pageFetch(page, 'POST', '/api/store/quote', { items: lines, couponCode, email: f.email, pin: f.pin, method });
	expect(q.status, `quote: ${q.text.slice(0, 300)}`).toBe(200);
	const quote = q.json.quote;
	const body = {
		items: lines,
		contact: { name: f.name, email: f.email, phone: f.phone.startsWith('+') ? f.phone : `+91${f.phone}` },
		address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
		method,
		expectedTotalPaise: quote.totalPaise,
		consent: { marketing: !!consent },
		source: 'web',
		...(couponCode ? { couponCode } : {})
	};
	const r = await pageFetch(page, 'POST', '/api/store/checkout', body, { 'Idempotency-Key': crypto.randomUUID() });
	expect([200, 201], `checkout: ${r.text.slice(0, 400)}`).toContain(r.status);
	return { ...r.json.order, payment: r.json.payment, form: f, quote };
}

/** The customer row id for an email (admin REST). */
export async function customerId(admin, email) {
	const c = await admin.findCustomer(email);
	expect(c, `customer ${email}`).toBeTruthy();
	return c.id;
}

/** End every server-side session of a customer (Payload useSessions): the cookie stops working. */
export async function endSessions(db, admin, email) {
	const id = await customerId(admin, email);
	await db.query('delete from customers_sessions where _parent_id = $1', [id]);
}

/* ------------------------------------------------------------------ UI */

export const notice = (page) => page.locator('#wf-auth-notice');

/** /login ready: hydrated and the login form interactive. */
export async function openLogin(page, shop, query = '') {
	await shop.visit(`/login${query}`);
	await expect(page.locator('#wf-login-form')).toBeVisible();
}

/** Sign up from /login (the page must be open). */
export async function signUpUI(page, { name = 'Asha Kumar', email, password = PASSWORD }) {
	await page.click('#wf-tab-signup');
	await expect(page.locator('#wf-panel-signup')).toBeVisible();
	await page.fill('#wf-signup-name', name);
	await page.fill('#wf-signup-email', email);
	await page.fill('#wf-signup-password', password);
	await page.click('#wf-signup-form button[type="submit"]');
}

/** Log in from /login (the page must be open on the Log In panel). */
export async function logInUI(page, email, password = PASSWORD) {
	await expect(page.locator('#wf-panel-login')).toBeVisible();
	await page.fill('#wf-login-email', email);
	await page.fill('#wf-login-password', password);
	const done = page.waitForResponse((r) => r.url().endsWith('/api/customers/login') && r.request().method() === 'POST');
	await page.click('#wf-login-form button[type="submit"]');
	return done;
}

/** The nav account icon (Nav.svelte). */
export const navAccount = (page) => page.locator('.div-block-79 a.link-block-3._2');
/** The footer account link (first column). */
export const footerAccount = (page) => page.locator('.footer-link-column').first().locator('a.footer-link').last();

/** /account fully loaded (welcome line + orders settled). */
export async function waitAccountReady(page) {
	await page.waitForURL((u) => u.pathname === '/account');
	await expect(page.locator('[data-wf-hello]')).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('[data-wf-orders], [data-wf-orders-empty], [data-wf-orders-error]').first()).toBeVisible({ timeout: 15_000 });
}

/** Subscribe from the home page form; resolves once the success state shows. */
export async function subscribeUI(page, shop, email) {
	await shop.visit('/');
	const form = page.locator('#email-form-2');
	await form.locator('input[name="email"]').fill(email);
	const res = page.waitForResponse((r) => r.url().endsWith('/api/store/newsletter') && r.request().method() === 'POST');
	await form.locator('input[type="submit"]').click();
	expect((await res).status()).toBe(200);
	await expect(form).toHaveAttribute('data-wf-nl-state', 'success');
	await expect(page.locator('.w-form-done')).toHaveText(COPY.NL_SUCCESS);
}

/** Home page after a confirm/unsubscribe redirect: the notice region (done | fail) is visible with `text`. */
export async function expectHomeNotice(page, shop, { tone, text, formHidden }) {
	await page.waitForURL((u) => u.pathname === '/');
	await shop.waitHydrated();
	const region = page.locator(tone === 'done' ? '.w-form-done' : '.w-form-fail');
	await expect(region).toBeVisible();
	await expect(region).toHaveText(text);
	if (formHidden === true) await expect(page.locator('#email-form-2')).toBeHidden();
	if (formHidden === false) await expect(page.locator('#email-form-2')).toBeVisible();
	await expect.poll(() => [...new URL(page.url()).searchParams.keys()].filter((k) => /subscribed/.test(k)), { message: 'param stripped' }).toEqual([]);
	expect(new URL(page.url()).hash).toBe('#newsletter');
}

/**
 * Subscribe (API) → confirm (GET the emailed link) → welcome email.
 * Resolves { email, confirmUrl, welcome (full message), code }.
 */
export async function subscribeAndConfirm({ api, mailpit, unique }, { email, tag = 'nl' } = {}) {
	const addr = email ?? unique.email(tag);
	const r = await api.newsletter(addr);
	expect(r.status).toBe(200);
	const msg = await mailpit.waitForMessage({ to: addr, subjectIncludes: SUBJECT.NL_CONFIRM });
	const confirmUrl = confirmLink(mailpit, msg);
	const res = await fetch(confirmUrl, { redirect: 'manual' });
	expect(res.status).toBe(303);
	expect(res.headers.get('location')).toMatch(/\/\?subscribed=1#newsletter$/);
	const welcome = await mailpit.waitForMessage({ to: addr, subjectIncludes: SUBJECT.WELCOME });
	return { email: addr, confirmUrl, welcome, code: /HELLO-/.test(`${welcome.Text} ${welcome.HTML}`) ? welcomeCode(welcome) : null };
}

/* ------------------------------------------------------------------ CMS pages (policies) */

/**
 * Pages created/changed through `adminSession` in a test; `restore()` deletes the created
 * ones and PATCHes changed ones back to their original fields (call it in afterEach).
 */
export class PagesAdmin {
	constructor(adminSession) {
		this.s = adminSession;
		this.created = [];
		this.originals = new Map();
	}

	async list() {
		return (await this.s.ok('GET', 'pages?depth=0&limit=100&draft=true&sort=sortOrder')).docs;
	}

	async bySlug(slug) {
		return (await this.list()).find((p) => p.slug === slug) ?? null;
	}

	async create(data) {
		const r = await this.s.request('POST', 'pages?depth=0', { body: data });
		if (r.json?.doc?.id) this.created.push(r.json.doc.id);
		return r;
	}

	/** PATCH by slug (the original is remembered for restore()). */
	async update(slug, data) {
		const doc = await this.bySlug(slug);
		if (!doc) throw new Error(`no page ${slug}`);
		if (!this.originals.has(doc.id)) {
			const { title, bodyHtml, published, sortOrder, _status } = doc;
			this.originals.set(doc.id, { title, bodyHtml, published, sortOrder, _status });
		}
		return this.s.request('PATCH', `pages/${doc.id}?depth=0`, { body: data });
	}

	async restore() {
		const errors = [];
		const created = this.created.splice(0);
		for (const id of created) {
			const r = await this.s.request('DELETE', `pages/${id}`);
			if (r.status >= 400 && r.status !== 404) errors.push(`delete page ${id} → ${r.status}`);
		}
		for (const [id, orig] of this.originals) {
			if (created.includes(id)) continue; // made by this test: deleted above
			const r = await this.s.request('PATCH', `pages/${id}?depth=0${orig._status === 'draft' ? '&draft=true' : ''}`, { body: orig });
			if (r.status >= 400) errors.push(`restore page ${id} → ${r.status} ${r.text.slice(0, 200)}`);
		}
		this.originals.clear();
		if (errors.length) throw new Error(errors.join('\n'));
	}
}
