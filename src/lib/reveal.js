/*
 * reveal(): a GSAP entrance for CLIENT-RENDERED content, as a Svelte
 * attachment (bublr GsapReveal / FadeIn):
 *
 *   <div {@attach reveal()}>…</div>                       y 8 -> 0, fade in, .4 s power3.out
 *   <ul {@attach reveal({ children: true, stagger: .04 })}>  each child in turn
 *
 * fx.js pageSetup() only wires .wf-reveal / .wf-hero-stagger markup that is
 * present when a page mounts. Anything rendered later — fetched orders, the
 * account page, toast bodies — never gets those, so it uses this instead.
 * Prerendered markup should keep using .wf-reveal.
 *
 * - Content is never hidden from markup or CSS: the hidden "from" state is
 *   set by GSAP at attach time, so no-JS and failed-JS both show it.
 * - No-op under ?nofx=1 / prefers-reduced-motion / missing GSAP (motionOK()).
 * - The tween is killed when the element detaches and inline styles are
 *   cleared when it completes, so nothing lingers.
 */
import { motionOK } from '$lib/fx.js';

/**
 * @param {{ y?: number, duration?: number, delay?: number, ease?: string,
 *           stagger?: number, children?: boolean }} [opts]
 *   Seconds (GSAP units). children: animate node.children instead of node.
 * @returns {(node: HTMLElement) => (void | (() => void))}
 */
export function reveal({ y = 8, duration = 0.4, delay = 0, ease = 'power3.out', stagger = 0, children = false } = {}) {
	return (node) => {
		if (!motionOK()) return;
		const targets = children ? Array.from(node.children) : node;
		if (children && !targets.length) return;
		const tween = window.gsap.fromTo(
			targets,
			{ autoAlpha: 0, y },
			{
				autoAlpha: 1,
				y: 0,
				duration,
				delay,
				ease,
				stagger,
				clearProps: 'transform,opacity,visibility'
			}
		);
		return () => {
			tween.kill();
			// killed mid-flight: don't leave the element half-hidden
			window.gsap.set(targets, { clearProps: 'transform,opacity,visibility' });
		};
	};
}
