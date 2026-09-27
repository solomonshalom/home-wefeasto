/*
 * Keyboard focus that outlives the control holding it (WCAG 2.4.3 Focus
 * Order). When the focused control unmounts (a bag row expiring, a top-up
 * suggestion or an offer chip going away, "Your usual" after Add all), the
 * browser drops focus to <body>: a screen-reader user hears nothing and the
 * next Tab starts from the top of the page. The rule used everywhere:
 * if focus was inside the part that is about to go, move it to a stable
 * neighbour once the DOM has updated. Nothing moves when focus was elsewhere
 * (a mouse click in Safari never focuses a button, a user who already tabbed
 * away keeps their place). Controls that are merely unavailable stay
 * focusable with aria-disabled instead of `disabled` (live-catalog.md).
 */
import { tick } from 'svelte';

const NATIVE_FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';
const TABBABLE =
	'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

const doc = () => (typeof document === 'undefined' ? null : document);

/** Is keyboard focus on `el` or inside it? */
export function focusWithin(el) {
	const d = doc();
	const a = d && d.activeElement;
	return !!(el && a && a !== d.body && el.contains(a));
}

/** Focus has been lost: nothing focused, <body>, or an element that left the document or got disabled. */
export function focusLost() {
	const d = doc();
	if (!d) return false;
	const a = d.activeElement;
	return !a || a === d.body || a === d.documentElement || !a.isConnected || a.disabled === true;
}

/** Is `el` visibility:hidden/collapse (browsers refuse to focus it; it is out of the accessibility tree)? */
function invisible(el) {
	try {
		const v = el.ownerDocument.defaultView.getComputedStyle(el).visibility;
		return v === 'hidden' || v === 'collapse';
	} catch (e) {
		return false;
	}
}

/** Can `el` take focus right now (in the document, rendered, visible, not inert or disabled)? */
function usable(el) {
	return !!(el && el.nodeType === 1 && el.isConnected && !el.disabled && !el.closest('[inert], [hidden]') && el.getClientRects().length > 0 && !invisible(el));
}

/** The first element in `root` a Tab would reach (skips tabindex=-1, e.g. the cart thumb link). */
export function firstTabbable(root) {
	if (!root || root.nodeType !== 1) return null;
	if (root.matches(TABBABLE)) return root;
	return [...root.querySelectorAll(TABBABLE)].find(usable) ?? null;
}

/**
 * Focus the first usable candidate (a function is called first). A candidate
 * that is not focusable by nature (a heading, a note) gets tabindex="-1":
 * reachable by script, never a Tab stop. Keyboard users get it scrolled into
 * view; pointer users are not scrolled. Returns the focused element or null.
 * @param {Array<Element | null | undefined | (() => Element | null | undefined)>} candidates
 */
export function focusFirst(candidates) {
	const d = doc();
	if (!d) return null;
	for (let c of candidates || []) {
		if (typeof c === 'function') c = c();
		if (!usable(c)) continue;
		if (!c.matches(NATIVE_FOCUSABLE)) c.setAttribute('tabindex', '-1');
		c.focus({ preventScroll: true });
		if (d.activeElement !== c) continue;
		let keyboard = false;
		try {
			keyboard = c.matches(':focus-visible');
		} catch (e) {
			/* old engines: no :focus-visible */
		}
		if (keyboard) {
			const r = c.getBoundingClientRect();
			if (r.bottom < 0 || r.top > window.innerHeight) c.scrollIntoView({ block: 'nearest' });
		}
		return c;
	}
	return null;
}

/**
 * Run `change` (it may unmount or disable the control that has focus). If
 * focus was inside `scope` before, and after the DOM has updated it is lost,
 * move it to the first usable candidate (`candidates` may be a function,
 * called after the update, so it can find elements that only exist then).
 * Returns the element that received focus, or null.
 * @param {Element | null | undefined} scope
 * @param {() => void} change
 * @param {any[] | (() => any[])} candidates
 */
export async function keepFocus(scope, change, candidates) {
	const had = focusWithin(scope);
	change();
	if (!had) return null;
	await tick();
	if (!focusLost()) return null;
	return focusFirst(typeof candidates === 'function' ? candidates() : candidates);
}

/**
 * Visible headings before `el` in document order (not inside it), nearest
 * first: where a keyboard user "was" once `el` is gone.
 * @param {Element | null | undefined} el
 */
export function headingsBefore(el) {
	const d = doc();
	if (!d || !el) return [];
	return [...d.querySelectorAll('h1, h2, h3, h4, h5, h6')]
		.filter((h) => !el.contains(h) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
		.reverse();
}
