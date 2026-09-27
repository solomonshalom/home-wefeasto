/*
 * Keyboard focus after a busy button settles (/login, /account, /reset-password).
 *
 * Busy submits are `disabled` + `aria-busy` (storefront-account.md: "Busy submit"),
 * and a disabled button drops keyboard focus to <body> the moment it is disabled.
 * Nothing brings it back on its own, so the next Tab starts over and a screen
 * reader loses its place (WCAG 2.4.3). Once the request settles and the page has
 * re-rendered (`await tick()`), the pages call focusIfLost() to put focus
 * somewhere useful, without ever taking it from wherever the customer has
 * moved it in the meantime.
 */

/**
 * Is keyboard focus lost: on <body>/<html> (or nowhere), or inside one of
 * `within` (containers that are going away, e.g. a panel being swapped out)?
 * @param {Document} [doc]
 * @param {{ within?: Array<Element | null | undefined> }} [opts]
 */
export function focusLost(doc = globalThis.document, { within = [] } = {}) {
	if (!doc) return false;
	const a = doc.activeElement;
	if (!a || a === doc.body || a === doc.documentElement) return true;
	return within.some((c) => !!c && typeof c.contains === 'function' && c.contains(a));
}

/**
 * Move focus to `el` when focus is lost (see focusLost). `el` must still be in
 * the document and enabled. Returns whether `el` now has focus.
 * @param {HTMLElement | null | undefined} el
 * @param {{ doc?: Document, within?: Array<Element | null | undefined> }} [opts]
 */
export function focusIfLost(el, { doc = globalThis.document, within = [] } = {}) {
	if (!el || !doc || !el.isConnected || el.disabled) return false;
	if (!focusLost(doc, { within })) return false;
	el.focus();
	return doc.activeElement === el;
}

/**
 * The button that submitted a form: `SubmitEvent.submitter`, else the form's
 * first submit button. Read it before the first `await` (currentTarget is gone
 * after the handler returns).
 * @param {Event & { submitter?: HTMLElement | null }} e
 */
export function submitterOf(e) {
	const s = e?.submitter;
	if (s && typeof s.focus === 'function') return s;
	const form = e?.currentTarget ?? e?.target;
	return form && typeof form.querySelector === 'function' ? form.querySelector('button[type="submit"], input[type="submit"]') : null;
}
