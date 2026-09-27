<script>
	/*
	 * Floating "Mix colors" switch (bottom-left on every page) — port of the
	 * initColorMix toggle in js/wefeasto.js. On = shuffle the site palette,
	 * off = restore it; each fresh enable deals a new shuffle. Styles live in
	 * static/css/wefeasto.css (.wf-colormix); the swatch dots use palette
	 * literals there, so they preview the live mix.
	 *
	 * The pill is not rendered on the bag, checkout and order pages, where it
	 * would cover "Proceed to Checkout" and the payment pills on phones. The
	 * component itself stays mounted, so an active mix stays applied there.
	 */
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		readColorMixMap,
		buildColorMixMap,
		storeColorMixMap,
		clearColorMixMap,
		applyColorMix,
		removeColorMix,
		syncVeilColor
	} from '$lib/colormix.js';

	const HIDE = ['/cart', '/checkout', '/order'];
	const path = $derived(page.url.pathname);
	const hidden = $derived(HIDE.some((p) => path === p || path.startsWith(p + '/')));

	let on = $state(false);

	onMount(() => {
		const map = readColorMixMap();
		on = !!map;
		if (map) {
			applyColorMix(map);
			syncVeilColor(map);
		}
		return () => removeColorMix();
	});

	afterNavigate((navigation) => {
		if (navigation.type === 'enter') return; // first load: onMount handles it
		// New route content: freshly rendered inline chip colours (and any
		// late-loaded route css) need remapping under the same stored shuffle.
		const map = readColorMixMap();
		if (map) applyColorMix(map);
	});

	function toggle() {
		if (on) {
			removeColorMix();
			clearColorMixMap();
			syncVeilColor(null);
			on = false;
		} else {
			const map = buildColorMixMap(); // every enable deals a fresh shuffle
			storeColorMixMap(map);
			applyColorMix(map);
			syncVeilColor(map);
			on = true;
		}
	}
</script>

{#if !hidden}<button type="button" class="wf-colormix" role="switch" aria-checked={on} aria-label="Mix up the site colors" onclick={toggle}><span class="wf-colormix-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="wf-colormix-label">Mix colors</span><span class="wf-colormix-switch" aria-hidden="true"></span></button>{/if}
