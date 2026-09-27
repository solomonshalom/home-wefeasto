// @vitest-environment jsdom
/*
 * The page intro (.wf-hero-stagger, fx.js initHero) must never hide the page
 * heading from keyboard focus or the accessibility tree (final verification
 * pass 1: e2e/ui/order.spec.js "focus lands on the page heading, not <body>"
 * failed on an idle machine). It used gsap autoAlpha, i.e. visibility:hidden
 * for the first ~0.4 s, and focus() on a visibility:hidden <h1> is a no-op, so
 * focus.js fell through to <body>. The intro now fades opacity only.
 *
 * Runs the real GSAP build the site ships (static/js/gsap.min.js) in jsdom,
 * paused at the start of the intro. JSDOM lays nothing out, so
 * getClientRects is stubbed (every element is "rendered").
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('$app/environment', () => ({ browser: true }));

const GSAP_SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../static/js/gsap.min.js'), 'utf8');
const HERO =
	'<div class="page-wrapper"><div class="wf-hero-stagger" id="hero"><div class="wf-chip">Your Bag</div><div class="divider"></div>' +
	'<h1 class="heading-2">Almost breakfast time.</h1></div><div class="wf-hero-stagger" id="hero2"><p>Lead</p><div data-w-id="x">ix2</div></div></div>';

let fx;
let focus;

beforeAll(async () => {
	window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	Element.prototype.getClientRects = function () {
		return [{}];
	};
	// The UMD build installs window.gsap when run with `this` = window (as the <script> tag does).
	new Function(GSAP_SRC).call(window);
	expect(typeof window.gsap?.to).toBe('function');
	document.body.innerHTML = HERO;
	fx = await import('../../../src/lib/fx.js');
	focus = await import('../../../src/lib/focus.js');
	fx.pageSetup();
	// Frozen at t=0, inside the 0.15 s delay: the intro's hidden "from" state.
	// (Paused before pageSetup, gsap.set would not render at all.)
	window.gsap.globalTimeline.pause();
});

afterAll(() => {
	fx?.pageTeardown();
	window.gsap?.globalTimeline.resume();
});

const style = (el) => window.getComputedStyle(el);

describe('fx.js initHero: the intro fades with opacity only', () => {
	it('hides every hero child with opacity 0 and a rise, never visibility:hidden', () => {
		expect(fx.motionOK()).toBe(true);
		const kids = [...document.querySelectorAll('#hero > *'), document.querySelector('#hero2 > p')];
		for (const el of kids) {
			expect(style(el).opacity).toBe('0');
			expect(style(el).visibility).not.toBe('hidden');
			expect(el.style.visibility).toBe('');
			expect(el.style.transform).toContain('translate'); // y: 24 still applied
		}
	});

	it('leaves data-w-id (IX2) children alone', () => {
		const ix2 = document.querySelector('#hero2 [data-w-id]');
		expect(ix2.getAttribute('style')).toBeNull();
	});

	it('the <h1> can take focus mid-intro (focus.js focusFirst lands on it, not <body>)', () => {
		const h1 = document.querySelector('h1');
		const got = focus.focusFirst([h1]);
		expect(got).toBe(h1);
		expect(document.activeElement).toBe(h1);
		expect(h1.getAttribute('tabindex')).toBe('-1');
	});

	it('ends fully shown with no transform left behind', () => {
		const h1 = document.querySelector('h1');
		const tweens = window.gsap.getTweensOf(h1);
		expect(tweens).toHaveLength(1); // the intro (overwrite: true replaced the set)
		tweens.forEach((t) => t.progress(1)); // past delay + stagger + 1 s
		expect(style(h1).opacity).toBe('1');
		expect(style(h1).visibility).not.toBe('hidden');
		expect(h1.style.transform).toBe(''); // clearProps: 'transform'
	});
});
