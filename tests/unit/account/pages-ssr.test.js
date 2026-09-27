/*
 * What the prerendered pages ship before hydration (account, login,
 * reset-password, the home newsletter form, the nav account link).
 * Browser behaviour: e2e/ui/{account,newsletter,policy}*.spec.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';
import { JSDOM } from 'jsdom';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/'), state: {} }));
vi.mock('$app/state', () => ({ page: route }));

const ROOT = path.resolve(import.meta.dirname, '../../..');
const { default: LoginPage } = await import('../../../src/routes/login/+page.svelte');
const { default: AccountPage } = await import('../../../src/routes/account/+page.svelte');
const { default: ResetPage } = await import('../../../src/routes/reset-password/+page.svelte');
const { default: HomePage } = await import('../../../src/routes/+page.svelte');
const { default: Nav } = await import('$lib/components/Nav.svelte');

const ssr = (C, props = {}) => render(C, { props });
const doc = (C, props) => new JSDOM(ssr(C, props).body).window.document;

describe('/login', () => {
	const out = ssr(LoginPage);
	const d = new JSDOM(out.body).window.document;

	it('keeps the card, tabs and notice; hides Google sign-in and the "or" divider', () => {
		expect(d.querySelector('.wf-login-card')).not.toBeNull();
		expect(d.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(d.querySelector('#wf-tab-login').getAttribute('aria-selected')).toBe('true');
		const notice = d.querySelector('#wf-auth-notice');
		expect(notice.hasAttribute('hidden')).toBe(true);
		expect(notice.getAttribute('role')).toBe('status');
		expect(notice.textContent).toBe('');
		expect(out.body).not.toContain('Continue with Google');
		expect(d.querySelector('.wf-or')).toBeNull();
		expect(d.querySelector('.wf-google')).toBeNull();
		expect(out.body).not.toContain('Prototype only');
	});

	it('three panels: login visible, forgot + signup hidden; tabpanels are divs around the forms', () => {
		const panels = [...d.querySelectorAll('[role="tabpanel"]')];
		expect(panels.map((p) => [p.id, p.tagName, p.hasAttribute('hidden')])).toEqual([
			['wf-panel-login', 'DIV', false],
			['wf-panel-forgot', 'DIV', true],
			['wf-panel-signup', 'DIV', true]
		]);
		for (const p of panels) expect(p.querySelector('form[novalidate]')).not.toBeNull();
		expect(d.querySelector('#wf-login-form button[type="submit"]').textContent).toBe('Log In');
		expect(d.querySelector('#wf-signup-form button[type="submit"]').textContent).toBe('Create Account');
		expect(d.querySelector('#wf-forgot-form button[type="submit"]').textContent).toBe('Send reset link');
		expect(d.querySelector('[data-wf-forgot]').tagName).toBe('BUTTON');
		expect(d.querySelector('a[href="#"]')).toBeNull();
	});

	it('the field ids, names and autocomplete hints the forms rely on', () => {
		for (const [id, ac] of [
			['wf-login-email', 'email'],
			['wf-login-password', 'current-password'],
			['wf-signup-name', 'name'],
			['wf-signup-email', 'email'],
			['wf-signup-password', 'new-password'],
			['wf-forgot-email', 'email']
		]) {
			expect(d.getElementById(id)?.getAttribute('autocomplete'), id).toBe(ac);
			expect(d.querySelector(`label[for="${id}"]`), id).not.toBeNull();
		}
	});

	it('forms POST: a submit before hydration never puts a password in the URL', () => {
		for (const id of ['wf-login-form', 'wf-signup-form', 'wf-forgot-form']) expect(d.getElementById(id).getAttribute('method'), id).toBe('post');
		expect(doc(ResetPage).getElementById('wf-reset-form').getAttribute('method')).toBe('post');
	});

	it('before hydration every submit button is disabled (Enter/tap would POST the password to the static host)', () => {
		// hunt client-ux prehydration-forms-native-submit: a disabled default button also blocks implicit submission.
		for (const id of ['wf-login-form', 'wf-signup-form', 'wf-forgot-form']) {
			const submits = [...d.getElementById(id).querySelectorAll('button[type="submit"], input[type="submit"]')];
			expect(submits, id).toHaveLength(1);
			expect(submits[0].hasAttribute('disabled'), id).toBe(true);
		}
		expect(d.querySelector('#wf-login-form noscript')?.textContent).toContain('needs JavaScript');
		expect(d.querySelector('[data-wf-verify-retry]')).toBeNull(); // only after a failed verify
	});

	it('no referrer leaves a page that can carry a token', () => {
		expect(out.head).toMatch(/<meta name="referrer" content="no-referrer"\s*\/?>/);
	});
});

describe('/account', () => {
	const out = ssr(AccountPage);
	const d = new JSDOM(out.body).window.document;

	it('prerendered shell: hero, a loading state and a no-JS note; nothing personal', () => {
		expect(d.querySelector('.wf-hero-stagger h1').textContent).toBe('Your breakfast shelf');
		expect(d.querySelector('#wf-account .wf-account-wait').textContent).toContain('Opening your shelf');
		expect(d.querySelector('#wf-account').getAttribute('aria-busy')).toBe('true');
		expect(out.body).toContain('<noscript>');
		expect(d.querySelector('.wf-order-row')).toBeNull();
		expect(d.querySelector('#wf-account-form')).toBeNull();
		expect(out.head).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
	});
});

describe('/reset-password', () => {
	const out = ssr(ResetPage);
	const d = new JSDOM(out.body).window.document;

	it('form with the two password fields; submit disabled until the token is read', () => {
		expect(d.querySelector('h1').textContent).toBe('Choose a new password');
		expect(d.querySelector('#wf-reset-password').getAttribute('autocomplete')).toBe('new-password');
		expect(d.querySelector('#wf-reset-confirm')).not.toBeNull();
		expect(d.querySelector('#wf-reset-form button[type="submit"]').hasAttribute('disabled')).toBe(true);
		expect(d.querySelector('#wf-reset-hint').textContent).toBe('At least 8 characters.');
		expect(out.head).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
		expect(out.head).toMatch(/<meta name="referrer" content="no-referrer"\s*\/?>/);
	});
});

describe('home newsletter (Stay Crunchy)', () => {
	const d = doc(HomePage);
	const form = d.querySelector('#email-form-2');

	it('same form, plus a hidden honeypot input named website', () => {
		expect(form).not.toBeNull();
		expect(form.querySelector('input[type="email"]#email').getAttribute('name')).toBe('email');
		expect(form.querySelector('input[type="submit"]').getAttribute('value')).toBe('Submit');
		const hp = form.querySelector('input[name="website"]');
		expect(hp).not.toBeNull();
		expect(hp.getAttribute('tabindex')).toBe('-1');
		expect(hp.getAttribute('autocomplete')).toBe('off');
		expect(hp.getAttribute('aria-hidden')).toBe('true');
		expect(hp.parentElement.className).toBe('wf-hp');
		expect(form.querySelector('.wf-nl-spinner')).toBeNull(); // only while loading
	});

	it('success copy lives in the existing .w-form-done region; #newsletter anchors the block', () => {
		expect(d.querySelector('.w-form-done').textContent.trim()).toBe('Check your inbox to confirm — then breakfast recipes are on their way.');
		expect(d.querySelector('.w-form-fail').textContent.trim()).toBe('Oops! Something went wrong while submitting the form.');
		expect(d.querySelector('#newsletter .text-block-3').textContent).toBe('Stay Crunchy');
		expect(d.querySelector('#newsletter #email-form-2')).not.toBeNull();
	});

	it('before hydration Submit is disabled, and the form is never a GET (the address must not reach a URL)', () => {
		// hunt client-ux prehydration-forms-native-submit: Enter before hydration sent GET /?email=<address>.
		expect(form.getAttribute('method')).toBe('post');
		expect(form.querySelector('input[type="submit"]').hasAttribute('disabled')).toBe(true);
	});

	it('the page source never posts to webflow.com', () => {
		const src = fs.readFileSync(path.join(ROOT, 'src/routes/+page.svelte'), 'utf8');
		expect(src).not.toMatch(/webflow\.com\/api/);
		expect(src).toContain("api('/store/newsletter'");
	});
});

describe('nav account link', () => {
	it('prerenders exactly as before: /login, "Login"', () => {
		const d = doc(Nav);
		const a = d.querySelector('a.link-block-3._2');
		expect(a.getAttribute('href')).toBe('/login');
		expect(a.getAttribute('aria-label')).toBe('Login');
		expect(a.querySelector('img').getAttribute('alt')).toBe('Account');
	});
});
