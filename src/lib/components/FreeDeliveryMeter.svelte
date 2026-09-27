<script>
	/*
	 * Free-delivery meter (roadmap M1): an 8px pill track whose #ffc33a fill
	 * (a palette literal in wefeasto.css, so the colour mix remaps it) shows
	 * how close the bag is to free delivery. The width is driven from here,
	 * not the markup: with motion it tweens (GSAP back.out(1.4), 0.6 s) and
	 * pulses when it grows; under ?nofx=1 / reduced motion it is set at once.
	 */
	import { motionOK } from '$lib/fx.js';

	let { progress = 0, valuetext = '', label = 'Progress to free delivery' } = $props();

	// Floored below the threshold: ₹498 of ₹499 reads 99%, never a full bar that still pays delivery.
	const pct = $derived.by(() => {
		const p = Math.max(0, Math.min(1, Number(progress) || 0));
		return p >= 1 ? 100 : Math.min(99, Math.floor(p * 100));
	});

	let track;
	let fill;
	let shown = -1; // last width applied (plain variable: not reactive state)

	$effect(() => {
		const p = pct;
		if (!fill) return;
		const gsap = window.gsap;
		if (motionOK() && gsap) {
			if (shown < 0) {
				gsap.fromTo(fill, { width: '0%' }, { width: p + '%', duration: 0.6, ease: 'back.out(1.4)', overwrite: true });
			} else if (p !== shown) {
				gsap.to(fill, { width: p + '%', duration: 0.6, ease: 'back.out(1.4)', overwrite: true });
				if (p > shown && track) {
					gsap.fromTo(track, { scaleY: 1.6 }, { scaleY: 1, duration: 0.45, ease: 'back.out(2)', overwrite: true, clearProps: 'transform' });
				}
			}
		} else {
			if (gsap) gsap.killTweensOf([fill, track]);
			fill.style.width = p + '%';
		}
		shown = p;
	});
</script>

<div class="wf-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct} aria-valuetext={valuetext || undefined} aria-label={label} bind:this={track}><div class="wf-meter-fill" data-wf-meter-fill bind:this={fill}></div></div>
