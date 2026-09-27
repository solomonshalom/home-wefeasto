// @vitest-environment jsdom
/*
 * The emailed one-shot links, mounted in the browser (hunt client-ux: one-shot-links-stranded).
 * - /reset-password: the token leaves the address bar on mount but is kept for this tab, so a
 *   reload of an unused link still shows the form; used / expired / malformed → dropped.
 * - /login?verify=: a verify request that never got its answer (offline) offers "Try again",
 *   which re-sends the kept token; VERIFY_INVALID is final (no retry, token dropped); a reload
 *   picks a kept token up again.
 * End to end: e2e/full/hunt/client-ux/one-shot-links-stranded.spec.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from '../../../node_modules/svelte/src/index-client.js';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/'), state: {} }));
const nav = vi.hoisted(() => ({ goto: vi.fn(), replaceState: vi.fn() }));
const auth = vi.hoisted(() => ({ resetPassword: vi.fn(), verifyEmail: vi.fn(), refresh: vi.fn() }));
// 'svelte' resolves to its server entry under vitest (onMount a no-op): use the client one.
vi.mock('svelte', async () => await import('../../../node_modules/svelte/src/index-client.js'));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.js', () => ({ api: vi.fn() }));
vi.mock('$lib/track.js', () => ({ track: vi.fn() }));
vi.mock('$lib/fx.js', () => ({ motionOK: () => false, noMotion: () => true }));
vi.mock('$lib/session.js', async (orig) => ({ ...(await orig()), ...auth }));

const { default: ResetPage } = await import('../../../src/routes/reset-password/+page.svelte');
const { default: LoginPage } = await import('../../../src/routes/login/+page.svelte');
const { LINK_TOKEN_KEYS } = await import('../../../src/routes/login/link-token.js');
const { MESSAGES } = await import('$lib/session.js');

const TOKEN = '1707d8f866934bf96b9f200be9e52b47b0fb242d';
const settle = async () => {
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};
let app = null;
function open(C, path) {
	route.url = new URL(path, 'http://localhost');
	const target = document.createElement('div');
	document.body.appendChild(target);
	app = mount(C, { target });
	flushSync();
	return target;
}
function setNavType(type) {
	vi.stubGlobal('performance', { ...globalThis.performance, getEntriesByType: (t) => (t === 'navigation' ? [{ type }] : []) });
}

beforeEach(() => {
	sessionStorage.clear();
	for (const f of [...Object.values(nav), ...Object.values(auth)]) f.mockReset();
	auth.refresh.mockResolvedValue({ ok: true, user: null });
	setNavType('navigate');
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('/reset-password', () => {
	const missing = (t) => t.querySelector('[data-wf-reset-missing]');

	it('the link token leaves the address bar but survives a reload of this tab', async () => {
		let t = open(ResetPage, `/reset-password?token=${TOKEN}`);
		await settle();
		expect(nav.replaceState).toHaveBeenCalledTimes(1);
		expect(String(nav.replaceState.mock.calls[0][0])).toBe('http://localhost/reset-password');
		expect(t.querySelector('#wf-reset-form')).not.toBeNull();
		unmount(app);
		setNavType('reload');
		t = open(ResetPage, '/reset-password'); // what the reload finds
		await settle();
		expect(missing(t)).toBeNull();
		expect(t.querySelector('#wf-reset-form button[type="submit"]').disabled).toBe(false);
		auth.resetPassword.mockResolvedValue({ ok: true });
		t.querySelector('#wf-reset-password').value = t.querySelector('#wf-reset-confirm').value = 'newpassword2';
		for (const id of ['#wf-reset-password', '#wf-reset-confirm']) t.querySelector(id).dispatchEvent(new Event('input', { bubbles: true }));
		t.querySelector('#wf-reset-form').requestSubmit();
		await settle();
		expect(auth.resetPassword).toHaveBeenCalledWith(TOKEN, 'newpassword2');
		expect(nav.goto).toHaveBeenCalledWith('/login?reset=1', { replaceState: true });
		expect(sessionStorage.getItem(LINK_TOKEN_KEYS.reset)).toBeNull(); // used: gone
	});

	it('used/expired (RESET_INVALID) drops the kept token', async () => {
		const t = open(ResetPage, `/reset-password?token=${TOKEN}`);
		await settle();
		auth.resetPassword.mockResolvedValue({ ok: false, error: { code: 'RESET_INVALID', message: MESSAGES.RESET_INVALID } });
		t.querySelector('#wf-reset-password').value = t.querySelector('#wf-reset-confirm').value = 'newpassword2';
		for (const id of ['#wf-reset-password', '#wf-reset-confirm']) t.querySelector(id).dispatchEvent(new Event('input', { bubbles: true }));
		t.querySelector('#wf-reset-form').requestSubmit();
		await settle();
		expect(t.querySelector('#wf-reset-notice').textContent).toBe(MESSAGES.RESET_INVALID);
		expect(sessionStorage.getItem(LINK_TOKEN_KEYS.reset)).toBeNull();
	});

	it('no token anywhere: "open the link again" (not "incomplete"); a malformed one: "incomplete", and nothing kept', async () => {
		let t = open(ResetPage, '/reset-password');
		await settle();
		expect(missing(t).getAttribute('data-wf-reset-missing')).toBe('none');
		expect(missing(t).textContent).not.toContain('incomplete');
		expect(missing(t).textContent).toContain('open the reset link from your email again');
		unmount(app);
		sessionStorage.setItem(LINK_TOKEN_KEYS.reset, JSON.stringify({ t: TOKEN, at: Date.now() }));
		t = open(ResetPage, '/reset-password?token=not%20a%20token!');
		await settle();
		expect(missing(t).getAttribute('data-wf-reset-missing')).toBe('malformed');
		expect(missing(t).textContent).toBe('This reset link is incomplete. Open the link from your email again, or ask for a new one.');
		expect(sessionStorage.getItem(LINK_TOKEN_KEYS.reset)).toBeNull();
	});
});

describe('/login?verify=', () => {
	const notice = (t) => t.querySelector('#wf-auth-notice');
	const retry = (t) => t.querySelector('[data-wf-verify-retry]');
	const offline = { ok: false, error: { code: 'NETWORK', message: MESSAGES.NETWORK } };

	it('offline → "Try again" re-sends the kept token → "Email verified — log in"; the token is then gone', async () => {
		auth.verifyEmail.mockResolvedValueOnce(offline).mockResolvedValueOnce({ ok: true });
		const t = open(LoginPage, `/login?verify=${TOKEN}`);
		await settle();
		expect(String(nav.replaceState.mock.calls[0][0])).toBe('http://localhost/login');
		expect(notice(t).textContent).toBe(MESSAGES.NETWORK);
		expect(retry(t).textContent).toBe('Try again');
		expect(JSON.parse(sessionStorage.getItem(LINK_TOKEN_KEYS.verify)).t).toBe(TOKEN);
		retry(t).click();
		await settle();
		expect(auth.verifyEmail.mock.calls).toEqual([[TOKEN], [TOKEN]]);
		expect(notice(t).textContent).toBe('Email verified — log in');
		expect(retry(t)).toBeNull();
		expect(sessionStorage.getItem(LINK_TOKEN_KEYS.verify)).toBeNull();
	});

	it('used/expired (VERIFY_INVALID) is final: no "Try again", nothing kept', async () => {
		auth.verifyEmail.mockResolvedValue({ ok: false, error: { code: 'VERIFY_INVALID', message: MESSAGES.VERIFY_INVALID } });
		const t = open(LoginPage, `/login?verify=${TOKEN}`);
		await settle();
		expect(notice(t).textContent).toBe(MESSAGES.VERIFY_INVALID);
		expect(retry(t)).toBeNull();
		expect(sessionStorage.getItem(LINK_TOKEN_KEYS.verify)).toBeNull();
	});

	it('a reload after the lost answer verifies with the kept token; a fresh /login visit does not', async () => {
		auth.verifyEmail.mockResolvedValueOnce(offline);
		open(LoginPage, `/login?verify=${TOKEN}`);
		await settle();
		unmount(app);
		open(LoginPage, '/login'); // navigated here, not a reload: an ordinary /login
		await settle();
		expect(auth.verifyEmail).toHaveBeenCalledTimes(1);
		unmount(app);
		setNavType('reload');
		auth.verifyEmail.mockResolvedValueOnce({ ok: true });
		const t = open(LoginPage, '/login');
		await settle();
		expect(auth.verifyEmail.mock.calls).toEqual([[TOKEN], [TOKEN]]);
		expect(notice(t).textContent).toBe('Email verified — log in');
		expect(sessionStorage.getItem(LINK_TOKEN_KEYS.verify)).toBeNull();
	});

	it('?signup=1 (/order\'s "Create an account") opens Sign Up and leaves the address bar', async () => {
		const t = open(LoginPage, '/login?next=/account&signup=1');
		await settle();
		expect(t.querySelector('#wf-panel-signup').hidden).toBe(false);
		expect(t.querySelector('#wf-panel-login').hidden).toBe(true);
		expect(t.querySelector('#wf-tab-signup').getAttribute('aria-selected')).toBe('true');
		expect(String(nav.replaceState.mock.calls[0][0])).toBe('http://localhost/login?next=%2Faccount');
	});

	it('the submit buttons turn on once mounted', async () => {
		const t = open(LoginPage, '/login');
		await settle();
		for (const id of ['wf-login-form', 'wf-signup-form', 'wf-forgot-form']) expect(t.querySelector(`#${id} button[type="submit"]`).disabled, id).toBe(false);
	});
});
