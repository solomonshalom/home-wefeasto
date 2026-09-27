/*
 * Motion tokens for UI chrome (toasts, panels, spinners, list rows) — ported
 * from bublr/src/lib/animation-config.js — plus Svelte transition helpers.
 *
 * These are the fast "app UI" timings (100-300 ms). Page content keeps the
 * storefront's slower, creamier fx.js motion (.wf-reveal, .wf-hero-stagger,
 * 0.55-1.15 s expo.out).
 *
 * Svelte transitions ignore prefers-reduced-motion and ?nofx=1 on their own,
 * so every duration here goes through ms(), which returns 0 whenever fx.js
 * says motion is off. Use ms() for any transition you write inline too:
 *   transition:fade={{ duration: ms(DURATION.fast) }}
 */
import { noMotion } from '$lib/fx.js';

/** CSS cubic-bezier(x1, y1, x2, y2) as an easing fn (UnitBezier, same maths as browsers). */
export function bezier(x1, y1, x2, y2) {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
	const sampleY = (t) => ((ay * t + by) * t + cy) * t;
	const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
	return (x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		// Newton-Raphson, then bisection if the slope is too flat
		let t = x;
		for (let i = 0; i < 8; i++) {
			const e = sampleX(t) - x;
			if (Math.abs(e) < 1e-6) return sampleY(t);
			const d = slopeX(t);
			if (Math.abs(d) < 1e-6) break;
			t -= e / d;
		}
		let lo = 0;
		let hi = 1;
		t = x;
		while (hi - lo > 1e-6) {
			if (sampleX(t) < x) lo = t;
			else hi = t;
			t = (lo + hi) / 2;
		}
		return sampleY(t);
	};
}

/** bublr DURATION, in ms (Svelte transitions take ms). */
export const DURATION = { instant: 100, fast: 150, normal: 200, slow: 300 };

/** bublr STAGGER, in ms. `list` = AnimatedList staggerChildren (.04 s). */
export const STAGGER = { fast: 30, normal: 50, list: 40 };

/** The same curves as CSS strings (for style rules and inline transitions). */
export const CSS_EASE = {
	standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
	enter: 'cubic-bezier(0, 0, 0.2, 1)',
	exit: 'cubic-bezier(0.4, 0, 1, 1)',
	premium: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
	settle: 'cubic-bezier(0.22, 1, 0.36, 1)', // the storefront's button lift curve
	thumb: 'cubic-bezier(0.32, 0.72, 0, 1)' // switch thumb
};

/** Easing functions for Svelte transitions. */
export const EASE = {
	standard: bezier(0.4, 0, 0.2, 1),
	enter: bezier(0, 0, 0.2, 1),
	exit: bezier(0.4, 0, 1, 1),
	premium: bezier(0.25, 0.46, 0.45, 0.94),
	settle: bezier(0.22, 1, 0.36, 1),
	thumb: bezier(0.32, 0.72, 0, 1)
};

/** Duration helper: n ms, or 0 when motion is off (reduced motion / ?nofx=1). */
export const ms = (n) => (noMotion() ? 0 : n);

/**
 * Panel slide along X, in % of its own width (bublr panelVariants:
 * x 100% -> 0, opacity .5 -> 1, .2 s enter-ease). from: 1 = from the right,
 * -1 = from the left. Use .15 s with EASE.exit for the out: transition.
 */
export function slideX(node, { duration = DURATION.normal, delay = 0, easing = EASE.enter, opacity = 0.5, from = 1 } = {}) {
	return {
		duration: ms(duration),
		delay: ms(delay),
		easing,
		css: (t, u) => `transform: translateX(${u * 100 * from}%); opacity: ${opacity + (1 - opacity) * t};`
	};
}

/** Rise into place (bublr itemVariants: opacity 0, y 6 -> 0, .25 s premium ease). */
export function rise(node, { y = 6, duration = 250, delay = 0, easing = EASE.premium } = {}) {
	return {
		duration: ms(duration),
		delay: ms(delay),
		easing,
		css: (t, u) => `opacity: ${t}; transform: translateY(${u * y}px);`
	};
}

/** Exit to the side (bublr AnimatedListItemWithExit: opacity 0, x -20, .15 s). */
export function exitX(node, { x = -20, duration = DURATION.fast, delay = 0, easing = EASE.enter } = {}) {
	return {
		duration: ms(duration),
		delay: ms(delay),
		easing,
		css: (t, u) => `opacity: ${t}; transform: translateX(${u * x}px);`
	};
}

/** Scale in (bublr scaleInVariants: scale .95 -> 1, .3 s enter-ease). */
export function scaleIn(node, { start = 0.95, duration = DURATION.slow, delay = 0, easing = EASE.enter } = {}) {
	return {
		duration: ms(duration),
		delay: ms(delay),
		easing,
		css: (t, u) => `opacity: ${t}; transform: scale(${start + (1 - start) * t});`
	};
}
