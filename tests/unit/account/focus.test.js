/*
 * src/routes/login/focus.js: where keyboard focus goes after a busy (disabled)
 * button settles on /login, /account and /reset-password. A tiny fake DOM:
 * elements know their parent, focus() moves document.activeElement.
 */
import { describe, it, expect } from 'vitest';
import { focusLost, focusIfLost, submitterOf } from '../../../src/routes/login/focus.js';

function fakeDoc() {
	const doc = { activeElement: null };
	const el = (name, { parent = null, disabled = false, connected = true, focusable = true } = {}) => {
		const node = {
			name,
			parent,
			disabled,
			isConnected: connected,
			focus() {
				if (focusable) doc.activeElement = node;
			},
			contains(other) {
				for (let n = other; n; n = n.parent) if (n === node) return true;
				return false;
			}
		};
		return node;
	};
	doc.documentElement = el('html');
	doc.body = el('body', { parent: doc.documentElement });
	doc.activeElement = doc.body;
	return { doc, el };
}

describe('focusLost()', () => {
	it('<body>, <html> or nothing focused → lost', () => {
		const { doc } = fakeDoc();
		expect(focusLost(doc)).toBe(true);
		doc.activeElement = doc.documentElement;
		expect(focusLost(doc)).toBe(true);
		doc.activeElement = null;
		expect(focusLost(doc)).toBe(true);
	});

	it('focus on a control → not lost, unless it sits in a container that is going away', () => {
		const { doc, el } = fakeDoc();
		const panel = el('signup panel', { parent: doc.body });
		const input = el('name input', { parent: panel });
		input.focus();
		expect(focusLost(doc)).toBe(false);
		expect(focusLost(doc, { within: [panel] })).toBe(true);
		expect(focusLost(doc, { within: [null, undefined] })).toBe(false);
	});

	it('no document (SSR) → false', () => {
		expect(focusLost(undefined)).toBe(false);
	});
});

describe('focusIfLost()', () => {
	it('puts focus back on the settled button when it fell to <body>', () => {
		const { doc, el } = fakeDoc();
		const button = el('Save details', { parent: doc.body });
		expect(focusIfLost(button, { doc })).toBe(true);
		expect(doc.activeElement).toBe(button);
	});

	it('never takes focus from wherever the customer moved it meanwhile', () => {
		const { doc, el } = fakeDoc();
		const button = el('Save details', { parent: doc.body });
		const phone = el('phone', { parent: doc.body });
		phone.focus();
		expect(focusIfLost(button, { doc })).toBe(false);
		expect(doc.activeElement).toBe(phone);
	});

	it('focus inside a panel on its way out counts as lost (sign-up → Log In tab)', () => {
		const { doc, el } = fakeDoc();
		const signup = el('signup panel', { parent: doc.body });
		const field = el('email', { parent: signup });
		const tab = el('Log In tab', { parent: doc.body });
		field.focus();
		expect(focusIfLost(tab, { doc, within: [signup] })).toBe(true);
		expect(doc.activeElement).toBe(tab);
	});

	it.each([
		['missing', () => null],
		['still disabled', (el, doc) => el('b', { parent: doc.body, disabled: true })],
		['removed from the page', (el, doc) => el('b', { parent: doc.body, connected: false })]
	])('a target that is %s is left alone', (_, make) => {
		const { doc, el } = fakeDoc();
		expect(focusIfLost(make(el, doc), { doc })).toBe(false);
		expect(doc.activeElement).toBe(doc.body);
	});

	it('reports false when the browser refused focus (hidden target)', () => {
		const { doc, el } = fakeDoc();
		const hidden = el('hidden', { parent: doc.body, focusable: false });
		expect(focusIfLost(hidden, { doc })).toBe(false);
	});
});

describe('submitterOf()', () => {
	it('SubmitEvent.submitter first', () => {
		const submitter = { focus() {} };
		expect(submitterOf({ submitter, currentTarget: { querySelector: () => 'other' } })).toBe(submitter);
	});

	it("else the form's submit button (Enter in a field, older browsers)", () => {
		const button = { focus() {} };
		const form = { querySelector: (sel) => (sel.includes('button[type="submit"]') ? button : null) };
		expect(submitterOf({ submitter: null, currentTarget: form })).toBe(button);
		expect(submitterOf({ target: form })).toBe(button);
	});

	it('nothing to go on → null', () => {
		expect(submitterOf({})).toBeNull();
		expect(submitterOf(undefined)).toBeNull();
	});
});
