/*
 * Shared helpers for the a11y-motion hunt repros (e2e/full/hunt/a11y-motion/**).
 */
import { expect } from '../../fixtures.js';

/** What has keyboard focus: {body, tag, id, cls, text, connected}. */
export const focused = (page) =>
	page.evaluate(() => {
		const a = document.activeElement;
		return {
			body: !a || a === document.body || a === document.documentElement,
			tag: a ? a.nodeName : null,
			id: a?.id || '',
			cls: a ? String(a.className) : '',
			text: a ? (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 60) : ''
		};
	});

/** Keyboard focus is still on an element (not dropped to <body>) after `ms`. */
export async function expectFocusKept(page, what, { ms = 0 } = {}) {
	if (ms) await page.waitForTimeout(ms);
	const f = await focused(page);
	expect(f.body, `${what}: keyboard focus fell back to <body> (${JSON.stringify(f)})`).toBe(false);
	return f;
}

/** Press Enter on `locator` the way a keyboard user does (focus it, then Enter). */
export async function keyboardActivate(locator) {
	await locator.focus();
	await expect(locator).toBeFocused();
	await locator.page().keyboard.press('Enter');
}

/** Seed localStorage keys before the first navigation of this page (once per tab). */
export async function seedStorage(page, entries) {
	await page.addInitScript((e) => {
		try {
			if (sessionStorage.getItem('__wf_hunt_seeded')) return;
			sessionStorage.setItem('__wf_hunt_seeded', '1');
			for (const [k, v] of Object.entries(e)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
		} catch {
			/* storage unavailable */
		}
	}, entries);
}

/** Text of every live region on the page (aria-live, role=status|alert|log). */
export const liveTexts = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]')].map((el) => el.textContent.replace(/\s+/g, ' ').trim())
	);
