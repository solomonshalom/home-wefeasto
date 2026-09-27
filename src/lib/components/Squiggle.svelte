<script>
	/*
	 * Hand-drawn wave underline — port of the Squiggle in bublr's
	 * pages/for-sale.js. A single Q sets the first half-wave and each T
	 * reflects it, so the crests alternate on their own. It matches the
	 * hand-drawn Open Peeps line art.
	 *
	 * Colour comes from a palette literal in wefeasto.css (.wf-squiggle and
	 * its tone modifiers), so the colour-mix shuffle remaps it.
	 *
	 * Draw-on: when it scrolls into view, the stroke draws itself left to
	 * right (.8 s expo.out). The hidden starting state is set from JS only,
	 * so without JS — or under ?nofx=1 / reduced motion — it is simply drawn.
	 * Pass draw={false} to always show it static (e.g. a celebration that
	 * already played once); ondrawn fires when the draw-on finishes.
	 */
	import { onMount } from 'svelte';
	import { motionOK } from '$lib/fx.js';

	let {
		tone = 'lime', // lime | coral | plum | yellow | ink
		width = 200, // CSS px; the viewBox keeps its 200 x 12 proportions
		draw = true,
		delay = 0, // seconds before the draw-on starts (once in view)
		ondrawn = undefined,
		class: className = ''
	} = $props();

	let path;

	onMount(() => {
		if (!draw || !motionOK()) return;
		let len = 0;
		try {
			len = path.getTotalLength();
		} catch (e) {
			return; // no geometry (unrendered): just stay drawn
		}
		if (!len) return;
		const gsap = window.gsap;
		gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
		let tween = null;
		const play = () => {
			tween = gsap.to(path, {
				strokeDashoffset: 0,
				duration: 0.8,
				delay,
				ease: 'expo.out',
				onComplete() {
					gsap.set(path, { clearProps: 'strokeDasharray,strokeDashoffset' });
					ondrawn?.();
				}
			});
		};
		let io = null;
		if ('IntersectionObserver' in window) {
			io = new IntersectionObserver((entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				io.disconnect();
				io = null;
				play();
			});
			io.observe(path.ownerSVGElement);
		} else {
			play();
		}
		return () => {
			io?.disconnect();
			tween?.kill();
			gsap.set(path, { clearProps: 'strokeDasharray,strokeDashoffset' });
		};
	});
</script>

<svg class={['wf-squiggle', tone !== 'lime' && `wf-squiggle-${tone}`, className]} viewBox="0 0 200 12" width={width} height={(width * 12) / 200} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path bind:this={path} d="M3 8 Q12.5 1.5 22 8 T41 8 T60 8 T79 8 T98 8 T117 8 T136 8 T155 8 T174 8 T193 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
