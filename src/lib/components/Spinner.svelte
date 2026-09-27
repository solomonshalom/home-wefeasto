<script>
	/*
	 * Busy indicator — port of bublr/src/components/spinner.js: a 24-unit SVG
	 * with a faint track ring (.25) and a heavier arc (.75) turning once a
	 * second. Drawn in currentColor, so it takes the colour of the button or
	 * text it sits in. Spin lives in wefeasto.css (.wf-spinner).
	 *
	 * It never stops: under reduced motion (or ?nofx=1) it slows to one turn
	 * every 2.4 s — progress feedback is essential, not decoration.
	 *
	 * Decorative by default (aria-hidden) — pair it with visible or live text
	 * ("Confirming your payment…"). Pass `label` when the spinner is the only
	 * signal; it then becomes role="img" with that accessible name.
	 */
	import { onMount } from 'svelte';
	import { noMotion } from '$lib/fx.js';

	let { size = '1em', label = null, class: className = '' } = $props();

	// ?nofx=1 is invisible to CSS media queries: mark it after mount.
	let slow = $state(false);
	onMount(() => {
		slow = noMotion();
	});
</script>

<svg class={['wf-spinner', slow && 'wf-spinner-slow', className]} style:width={size} style:height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label || undefined} focusable="false"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" opacity=".25" /><path fill="currentColor" opacity=".75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
