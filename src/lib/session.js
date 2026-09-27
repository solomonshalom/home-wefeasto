/*
 * Customer session (roadmap S3): Payload's `customers` auth behind the
 * same-origin /api proxy. The session itself is the HttpOnly `payload-token`
 * cookie; this module never sees or stores a token. It only keeps who is
 * logged in (for the nav link and /account) and turns Payload's error bodies
 * into customer-friendly copy.
 *
 *   session  store { status, user }
 *            status 'unknown'       nothing checked yet (SSR, before mount)
 *                   'anonymous'     /api/customers/me said nobody is logged in
 *                   'authenticated' user is { id, email, name, phone }
 *   user     store: the customer, or null (also while the status is 'unknown')
 *
 * Every action resolves to { ok: true, … } or { ok: false, error: { code,
 * message, field? } } and never throws. SSR-safe: nothing runs on import, and
 * on the server api() answers NETWORK without a request.
 *
 * Status codes verified against the running CMS (cms-foundation contract §6):
 * login unverified 403, bad credentials 401, locked 401 ("…locked…"),
 * duplicate signup 400 (path email), short password 400 (path password),
 * bad/used verify or reset token 403, PATCH of someone else / after logout 403.
 *
 * A login only counts once GET /me confirms the cookie stuck: a browser that
 * blocks cookies gets Payload's 200 but keeps no session (COOKIES_BLOCKED).
 *
 * Other tabs: a logout / login there reaches this tab through the hint's
 * `storage` event, and a signed-in tab re-checks when it comes back into view
 * (see "other tabs" below).
 */
import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { api } from '$lib/api.js';
import { track } from '$lib/track.js';
import { normalizeEmail, normalizeINMobile } from '$shared/validate.js';

/** localStorage flag: "this browser logged in", so the nav only asks /me when it may pay off. */
export const SESSION_HINT_KEY = 'wefeasto_signed_in';

/**
 * Password rule, the same on both sides: the CMS enforces 8–128 characters
 * (a 400 on `password` maps to WEAK_PASSWORD / LONG_PASSWORD in authError()).
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const NAME_MAX = 100; // customers.name maxLength

export const MESSAGES = Object.freeze({
	UNVERIFIED: 'Please verify your email — we sent you a link',
	LOCKED: 'Too many attempts — try again in 10 minutes',
	WRONG_CREDENTIALS: 'That email and password don’t match. Try again, or reset your password.',
	EMAIL_TAKEN: 'That email already has an account — log in instead, or reset your password.',
	WEAK_PASSWORD: `Choose a password with at least ${PASSWORD_MIN} characters.`,
	LONG_PASSWORD: `That password is too long — use ${PASSWORD_MAX} characters or fewer.`,
	PASSWORD_REQUIRED: 'Enter your password.',
	PASSWORD_MISMATCH: 'Those passwords don’t match.',
	EMAIL_INVALID: 'Enter a valid email address.',
	NAME_REQUIRED: 'Tell us your name.',
	NAME_TOO_LONG: `Keep your name under ${NAME_MAX} characters.`,
	PHONE_INVALID: 'Enter a 10-digit Indian mobile number.',
	VERIFY_INVALID: 'This link has expired or was already used. If you’ve confirmed your email already, just log in.',
	RESET_INVALID: 'This reset link has expired or was already used — ask for a new one below.',
	SESSION_EXPIRED: 'Your session has ended — please log in again.',
	RATE_LIMITED: 'Too many attempts — please wait a minute and try again.',
	LINKS_RATE_LIMITED: 'You’ve asked for a few links already — please wait a few minutes, then try again.',
	RESEND_SENT: 'If that email needs verifying, a new link is on its way.',
	COOKIES_BLOCKED: 'Your browser is blocking cookies for this site — allow cookies to log in (you can still check out as a guest).',
	NETWORK: 'We couldn’t reach Wefeasto — check your connection and try again.',
	TIMEOUT: 'That took too long — please try again.',
	UNKNOWN: 'Something went wrong — please try again.'
});

const INITIAL = Object.freeze({ status: 'unknown', user: null });
/* Listens to the other tabs while anything shows the session (the nav always does). */
const store = writable(INITIAL, () => watchOtherTabs());

export const session = { subscribe: store.subscribe };
export const user = derived(store, (s) => s.user);

/* ---------- small helpers ---------- */

const str = (v) => (typeof v === 'string' ? v : '');

/** Only the fields the storefront shows. Anything that isn't a customer → null. */
export function toCustomer(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (raw.collection !== undefined && raw.collection !== 'customers') return null;
	const id = raw.id;
	if (!((typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id))) return null;
	return { id, email: str(raw.email), name: str(raw.name), phone: str(raw.phone) };
}

function readHint() {
	try {
		return window.localStorage.getItem(SESSION_HINT_KEY); // null = absent
	} catch (e) {
		return undefined; // storage unavailable: unknown
	}
}

function writeHint(on) {
	try {
		if (on) window.localStorage.setItem(SESSION_HINT_KEY, '1');
		else window.localStorage.removeItem(SESSION_HINT_KEY);
	} catch (e) {
		/* storage unavailable: the nav just asks /me every time */
	}
}

/* Bumped whenever an action (login, logout, reset, a refused request) decides
   who is logged in. A /me answer that left before the bump describes the old
   cookie: refresh() drops it rather than undo a login that just happened. */
let epoch = 0;

function setAuthenticated(customer) {
	epoch++;
	store.set({ status: 'authenticated', user: customer });
	if (browser) writeHint(true);
}

function setAnonymous() {
	epoch++;
	store.set({ status: 'anonymous', user: null });
	if (browser) writeHint(false);
}

/* ---------- other tabs ----------
   Every tab shares the one session cookie, and the hint is how a tab hears
   about the others: a logout there (or a session found gone, a password
   reset) removes it, a login sets it. Without this, a tab left open on
   /account kept showing the name, phone and orders after the customer logged
   out in another tab (roadmap S3: "Logging out hides the orders").
   - hint removed → ask /me again at once (the server has the last word, so a
     tab that just logged in isn't thrown out by a stale answer elsewhere);
     no answer (offline) → anonymous anyway, trusting the other tab.
   - hint set while not signed in here → ask /me (the nav learns).
   - back to a tab (visibilitychange / a page restored from the bfcache) with a
     signed-in session → ask /me again, at most every RECHECK_MS: a session
     revoked elsewhere, or another customer who logged in since, shows up. */
export const RECHECK_MS = 30_000;
let checkedAt = 0;

function recheck() {
	epoch++; // an answer already on its way left with the old cookie
	return refresh().then((r) => {
		if (!r.ok && !r.stale && get(store).status !== 'anonymous' && readHint() === null) {
			epoch++;
			store.set({ status: 'anonymous', user: null });
		}
		return r;
	});
}

function onStorage(e) {
	if (e.key !== SESSION_HINT_KEY && e.key !== null) return; // null: storage.clear()
	const status = get(store).status;
	const hint = readHint();
	if (hint === null) {
		if (status !== 'anonymous') recheck();
	} else if (hint !== undefined && status !== 'authenticated') recheck();
}

function onReturn(e) {
	if (e.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
	if (e.type === 'pageshow' && !e.persisted) return;
	if (get(store).status !== 'authenticated' || Date.now() - checkedAt < RECHECK_MS) return;
	refresh();
}

function watchOtherTabs() {
	if (!browser || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
	const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
	window.addEventListener('storage', onStorage);
	window.addEventListener('pageshow', onReturn);
	doc?.addEventListener('visibilitychange', onReturn);
	return () => {
		window.removeEventListener('storage', onStorage);
		window.removeEventListener('pageshow', onReturn);
		doc?.removeEventListener('visibilitychange', onReturn);
	};
}

const fail = (code, field = undefined, message = MESSAGES[code] ?? MESSAGES.UNKNOWN) => ({
	ok: false,
	error: field ? { code, message, field } : { code, message }
});

/** Field errors from a Payload ValidationError body (api.js keeps `errors[0].data` as details). */
function fieldErrors(res) {
	const list = res?.error?.details?.errors;
	return Array.isArray(list) ? list.filter((e) => e && typeof e.path === 'string') : [];
}

const messageOf = (res) => str(res?.error?.message);

/**
 * Payload/api.js failure → { code, message, field? } for the given action.
 * Exported for tests.
 * @param {'login'|'signup'|'forgot'|'resend'|'reset'|'verify'|'update'|'logout'|'me'|'orders'} action
 * @param {{ status: number, error: { code: string, message: string, details: any } | null }} res
 */
export function authError(action, res) {
	const status = res?.status ?? 0;
	const code = res?.error?.code;
	if (code === 'NETWORK' || code === 'TIMEOUT' || code === 'ABORTED') return fail(code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK').error;
	if (status === 429 || code === 'RATE_LIMITED') {
		// Link-sending endpoints get their own copy ("wait a minute" undersells their windows);
		// the server's retryAfterSeconds (cms-hardening §3), when sent, says how long.
		const links = action === 'forgot' || action === 'resend';
		const wait = waitText(res?.error?.details?.retryAfterSeconds);
		const message = wait
			? links
				? `You’ve asked for a few links already — please wait ${wait}, then try again.`
				: `Too many attempts — please wait ${wait} and try again.`
			: links
				? MESSAGES.LINKS_RATE_LIMITED
				: MESSAGES.RATE_LIMITED;
		return fail('RATE_LIMITED', undefined, message).error;
	}
	const msg = messageOf(res);
	const fields = fieldErrors(res);
	const on = (path) => fields.find((e) => e.path === path);
	// Server password rule (min 8, max 128): Payload's "shorter than the max length" → LONG, anything else → WEAK.
	const passwordError = () => (TOO_LONG_RE.test(on('password')?.message ?? '') ? fail('LONG_PASSWORD', 'password').error : fail('WEAK_PASSWORD', 'password').error);

	switch (action) {
		case 'login':
			if (status === 403 && /verify/i.test(msg)) return fail('UNVERIFIED').error;
			if (/locked/i.test(msg)) return fail('LOCKED').error;
			if (status === 401) return fail('WRONG_CREDENTIALS').error;
			if (on('email')) return fail('EMAIL_INVALID', 'email').error;
			if (on('password')) return fail('PASSWORD_REQUIRED', 'password').error;
			break;
		case 'signup':
			if (on('email')) {
				return /already|registered|exists|unique|taken/i.test(on('email').message ?? '')
					? fail('EMAIL_TAKEN', 'email').error
					: fail('EMAIL_INVALID', 'email').error;
			}
			if (on('password')) return passwordError();
			if (on('name')) return fail('NAME_TOO_LONG', 'name').error;
			break;
		case 'forgot':
		case 'resend':
			if (status === 400) return fail('EMAIL_INVALID', 'email').error;
			break;
		case 'reset':
			if (on('password')) return passwordError();
			if (status === 403 || status === 404 || /token/i.test(msg)) return fail('RESET_INVALID').error;
			break;
		case 'verify':
			if (status === 400 || status === 403 || status === 404) return fail('VERIFY_INVALID').error;
			break;
		case 'update':
			if (status === 401 || status === 403) return fail('SESSION_EXPIRED').error;
			if (on('phone')) return fail('PHONE_INVALID', 'phone').error;
			if (on('name')) return fail('NAME_TOO_LONG', 'name').error;
			break;
		case 'me':
		case 'orders':
		case 'logout':
			if (status === 401 || status === 403) return fail('SESSION_EXPIRED').error;
			break;
	}
	return fail('UNKNOWN').error;
}

/** Payload's "shorter than the max length", cms-hardening's "Keep your password under 129 characters." and similar. */
const TOO_LONG_RE = /shorter than|max(imum)? length|too long|at most|no more than|\bunder \d+/i;

/** Retry-After seconds → 'a minute' | '4 minutes' | 'an hour'; null when absent or nonsense. */
export function waitText(seconds) {
	const s = Number(seconds);
	if (!Number.isFinite(s) || s <= 0) return null;
	if (s <= 60) return 'a minute';
	if (s < 3600) return `${Math.ceil(s / 60)} minutes`;
	return 'an hour';
}

function checkPassword(password) {
	if (typeof password !== 'string' || password.length < PASSWORD_MIN) return fail(password ? 'WEAK_PASSWORD' : 'PASSWORD_REQUIRED', 'password');
	if (password.length > PASSWORD_MAX) return fail('LONG_PASSWORD', 'password');
	return null;
}

/** Payload auth tokens are hex; accept a conservative URL-safe alphabet and nothing else. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,512}$/;
export const isAuthToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/* ---------- ?next= ---------- */

const PROBE_ORIGIN = 'https://wefeasto.invalid';

/**
 * Where to go after logging in: a same-origin path only. Accepts '/x…' with a
 * single leading '/', rejects protocol-relative ('//evil'), backslash tricks
 * ('/\evil', browsers read '\' as '/'), schemes ('https:', 'javascript:'),
 * whitespace/control characters (browsers strip tab/newline: '/\t/evil') and
 * the same shapes percent-encoded (checked on up to 3 decodings). Pages that
 * would bounce straight back (/login, /reset-password) → fallback.
 * @param {unknown} raw  the ?next= value (already URL-decoded once by URLSearchParams)
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeNext(raw, fallback = '/account') {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return fallback;
	let probe = raw;
	for (let i = 0; i < 4; i++) {
		if (!/^\/(?![/\\])/.test(probe)) return fallback; // single leading slash
		if (/[\\\s\u0000-\u001f\u007f]/.test(probe)) return fallback;
		let next;
		try {
			next = decodeURIComponent(probe);
		} catch (e) {
			return fallback; // malformed escapes
		}
		if (next === probe) break;
		probe = next;
	}
	let url;
	try {
		url = new URL(raw, PROBE_ORIGIN);
	} catch (e) {
		return fallback;
	}
	if (url.origin !== PROBE_ORIGIN) return fallback;
	// Parsing collapses dot segments AFTER the raw checks: '/.//evil', '/x/..//evil' and
	// '/%2e%2e//evil' all come out as the protocol-relative '//evil' — another host.
	if (!/^\/(?![/\\])/.test(url.pathname)) return fallback;
	if (/^\/(login|reset-password)(\/|$)/.test(url.pathname)) return fallback;
	return url.pathname + url.search + url.hash;
}

/** '/login?next=…' for a same-origin path (anything unsafe falls back to /account). */
export function loginHref(next = '/account', extra = {}) {
	const q = new URLSearchParams({ next: safeNext(next), ...extra });
	return '/login?' + q.toString();
}

/* ---------- session reads ---------- */

/** GET /customers/me gets this long (login waits on it too). */
const ME_TIMEOUT_MS = 8000;

/** The /me request in flight: { at: the epoch it left in, promise }. */
let inflight = null;

/**
 * Re-read the session from GET /api/customers/me (concurrent calls share one
 * request). With `{ ifHinted: true }` it skips the request when this browser
 * has never logged in (no hint): the nav uses that so anonymous visitors cost
 * the CMS nothing. A network failure leaves the known state as it was.
 * An answer overtaken by an action (a login that finished while /me was out)
 * is dropped: it resolves to the state that action set (`stale: true`), and a
 * call made after the action asks /me afresh instead of joining it.
 * @param {{ ifHinted?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, user: object | null, skipped?: boolean, stale?: boolean, error?: object }>}
 */
export function refresh({ ifHinted = false } = {}) {
	if (!browser) return Promise.resolve({ ok: false, user: null, skipped: true });
	if (ifHinted && readHint() === null) return Promise.resolve({ ok: true, user: get(store).user, skipped: true });
	if (inflight && inflight.at === epoch) return inflight.promise;
	const entry = { at: epoch, promise: null };
	inflight = entry;
	entry.promise = (async () => {
		try {
			const res = await api('/customers/me', { timeoutMs: ME_TIMEOUT_MS });
			if (entry.at !== epoch) return { ok: true, user: get(store).user, stale: true };
			if (res.ok || (res.status >= 400 && res.status < 500)) checkedAt = Date.now();
			if (res.ok) {
				const customer = toCustomer(res.data?.user);
				if (customer) setAuthenticated(customer);
				else setAnonymous();
				return { ok: true, user: customer };
			}
			// 401/403, or no CMS behind /api (404 in UI tests, odd 4xx): nobody we can vouch for.
			if (res.status >= 400 && res.status < 500) {
				setAnonymous();
				return { ok: true, user: null };
			}
			return { ok: false, user: get(store).user, error: authError('me', res) };
		} finally {
			if (inflight === entry) inflight = null;
		}
	})();
	return entry.promise;
}

/* ---------- actions ---------- */

/**
 * @param {string} email
 * @param {string} password
 */
export async function login(email, password) {
	const e = normalizeEmail(email);
	if (!e) return fail('EMAIL_INVALID', 'email');
	if (typeof password !== 'string' || !password) return fail('PASSWORD_REQUIRED', 'password');
	if (password.length > PASSWORD_MAX) return fail('WRONG_CREDENTIALS');
	const res = await api('/customers/login', { method: 'POST', body: { email: e, password } });
	if (!res.ok) return { ok: false, error: authError('login', res) };
	const customer = toCustomer(res.data?.user);
	if (!customer) return fail('UNKNOWN');
	/* The session is the HttpOnly cookie that answer set. A browser that blocks
	   cookies (Safari "Block All Cookies", a site exception in Chrome, where
	   navigator.cookieEnabled still says true) gets the same 200 and stores
	   nothing, so ask /me before calling it a login: an answer about nobody
	   (or somebody else) means the cookie didn't stick. Only an answer that
	   can't tell (offline, 5xx, a rate limit) falls back to the login body. */
	const me = await api('/customers/me', { timeoutMs: ME_TIMEOUT_MS });
	const holder = me.ok ? toCustomer(me.data?.user) : null;
	if ((me.ok || me.status === 401 || me.status === 403) && String(holder?.id) !== String(customer.id)) {
		if (holder) setAuthenticated(holder);
		else setAnonymous();
		return fail('COOKIES_BLOCKED');
	}
	const who = holder ?? customer;
	setAuthenticated(who);
	track('account_login');
	return { ok: true, user: who };
}

/**
 * Create an account. Payload sends the verification email; nobody is logged
 * in until the link is opened (verify: true).
 * @param {{ name?: string, email?: string, password?: string }} input
 */
export async function signup({ name, email, password } = {}) {
	const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
	if (!n) return fail('NAME_REQUIRED', 'name');
	if (n.length > NAME_MAX) return fail('NAME_TOO_LONG', 'name');
	const e = normalizeEmail(email);
	if (!e) return fail('EMAIL_INVALID', 'email');
	const bad = checkPassword(password);
	if (bad) return bad;
	// Only these three fields: never _verified, marketing flags or addresses.
	const res = await api('/customers', { method: 'POST', body: { name: n, email: e, password } });
	if (!res.ok) return { ok: false, error: authError('signup', res) };
	track('account_signup');
	return { ok: true, email: e };
}

/** Always "sent" for a well-formed email (Payload answers 200 for unknown addresses too). */
export async function forgotPassword(email) {
	const e = normalizeEmail(email);
	if (!e) return fail('EMAIL_INVALID', 'email');
	const res = await api('/customers/forgot-password', { method: 'POST', body: { email: e } });
	if (!res.ok) return { ok: false, error: authError('forgot', res) };
	return { ok: true, email: e };
}

/**
 * Ask for a fresh email-verification link (POST /api/store/account/resend-verification).
 * The server answers 200 {ok:true} whatever the address (no account probing), so
 * success only means "if that email needs verifying, a link is on its way".
 * 429 → RATE_LIMITED with the link-sending copy.
 * @param {string} email
 */
export async function resendVerification(email) {
	const e = normalizeEmail(email);
	if (!e) return fail('EMAIL_INVALID', 'email');
	const res = await api('/store/account/resend-verification', { method: 'POST', body: { email: e } });
	if (!res.ok) return { ok: false, error: authError('resend', res) };
	return { ok: true, email: e };
}

/**
 * Set a new password from the emailed token. Payload logs the customer in on
 * success; we end that session straight away so the flow finishes on /login
 * ("log in with your new password") with no stray session left behind.
 * @param {string} token
 * @param {string} password
 */
export async function resetPassword(token, password) {
	if (!isAuthToken(token)) return fail('RESET_INVALID');
	const bad = checkPassword(password);
	if (bad) return bad;
	const res = await api('/customers/reset-password', { method: 'POST', body: { token, password } });
	if (!res.ok) return { ok: false, error: authError('reset', res) };
	await api('/customers/logout', { method: 'POST' });
	setAnonymous();
	return { ok: true };
}

/** Confirm the email address from the ?verify=<token> link. */
export async function verifyEmail(token) {
	if (!isAuthToken(token)) return fail('VERIFY_INVALID');
	const res = await api('/customers/verify/' + encodeURIComponent(token), { method: 'POST' });
	if (!res.ok) return { ok: false, error: authError('verify', res) };
	return { ok: true };
}

/**
 * End the session (the server revokes it). Payload answers 400 "No User" when
 * the cookie was already gone: that is logged out too. Offline → error, and
 * the local state is kept, since the cookie is still valid.
 */
export async function logout() {
	const res = await api('/customers/logout', { method: 'POST' });
	if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
		setAnonymous();
		return { ok: true };
	}
	return { ok: false, error: authError('logout', res) };
}

/**
 * Save name and phone (PATCH /api/customers/:id). Phone '' clears it; any
 * other value must be an Indian mobile and is stored as E.164 (+91…).
 * @param {{ name?: string, phone?: string }} input
 */
export async function updateProfile({ name, phone } = {}) {
	const current = get(store).user;
	if (!current) return fail('SESSION_EXPIRED');
	const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
	if (!n) return fail('NAME_REQUIRED', 'name');
	if (n.length > NAME_MAX) return fail('NAME_TOO_LONG', 'name');
	const rawPhone = typeof phone === 'string' ? phone.trim() : '';
	const p = rawPhone ? normalizeINMobile(rawPhone) : null;
	if (rawPhone && !p) return fail('PHONE_INVALID', 'phone');
	const res = await api('/customers/' + encodeURIComponent(String(current.id)), { method: 'PATCH', body: { name: n, phone: p } });
	if (!res.ok) {
		const error = authError('update', res);
		if (error.code === 'SESSION_EXPIRED') setAnonymous();
		return { ok: false, error };
	}
	const customer = toCustomer(res.data?.doc) ?? { ...current, name: n, phone: p ?? '' };
	setAuthenticated(customer);
	return { ok: true, user: customer };
}

/**
 * The logged-in customer's orders (GET /api/store/orders/mine → { orders }).
 * 401/403 ends the local session (SESSION_EXPIRED).
 * @returns {Promise<{ ok: true, orders: object[] } | { ok: false, error: object }>}
 */
export async function loadMyOrders() {
	const res = await api('/store/orders/mine');
	if (res.ok) return { ok: true, orders: Array.isArray(res.data?.orders) ? res.data.orders : [] };
	const error = authError('orders', res);
	if (error.code === 'SESSION_EXPIRED') setAnonymous();
	return { ok: false, error };
}

/** Tests only: back to the pristine 'unknown' state. */
export function _resetSession() {
	inflight = null;
	checkedAt = 0;
	store.set(INITIAL);
}
