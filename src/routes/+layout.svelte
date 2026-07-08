<script>
	import { onMount } from 'svelte';
	import { onNavigate, afterNavigate } from '$app/navigation';
	import Nav from '$lib/components/Nav.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import SearchOverlay from '$lib/components/SearchOverlay.svelte';
	import { snapCloseSearch } from '$lib/search.js';
	import {
		initLenis,
		initAnchorScroll,
		syncLenis,
		refreshNofx,
		pageSetup,
		pageTeardown,
		playEnterTransition,
		playLeaveTransition,
		popCartBadges,
		hideVeilNow
	} from '$lib/fx.js';

	let { children } = $props();

	onMount(() => {
		initLenis();
		initAnchorScroll();
		const onCartAdd = () => popCartBadges();
		window.addEventListener('wf:cart-add', onCartAdd);
		// Leaving for an external link mid-veil must never strand a covered page.
		const onPageHide = () => hideVeilNow();
		window.addEventListener('pagehide', onPageHide);
		pageSetup();
		playEnterTransition();
		return () => {
			window.removeEventListener('wf:cart-add', onCartAdd);
			window.removeEventListener('pagehide', onPageHide);
			pageTeardown();
		};
	});

	onNavigate(async (navigation) => {
		// Same-page hash navigation — scrolling, not a navigation (the original
		// leave handler skipped these too).
		if (
			navigation.from?.url.pathname === navigation.to?.url.pathname &&
			navigation.to?.url.hash
		) {
			return;
		}
		// Back/forward should feel instant (the original's bfcache restores did) —
		// only link/goto navigations get the leave veil.
		if (navigation.type !== 'popstate') {
			await playLeaveTransition();
		}
		pageTeardown();
	});

	afterNavigate((navigation) => {
		if (navigation.type === 'enter') return; // first load: onMount handles it
		refreshNofx();
		snapCloseSearch();
		syncLenis();
		pageSetup();
		playEnterTransition();
	});
</script>

<Nav />
<SearchOverlay />
{@render children()}
<Footer />
