<script>
	import { onMount } from 'svelte';
	import { onNavigate, afterNavigate } from '$app/navigation';
	import Nav from '$lib/components/Nav.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import SearchOverlay from '$lib/components/SearchOverlay.svelte';
	import ColorMixToggle from '$lib/components/ColorMixToggle.svelte';
	import PeepStrip from '$lib/components/PeepStrip.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import AnnouncementBar from '$lib/components/AnnouncementBar.svelte';
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

	// data: footer links and legal line (+layout.server.js, prerender time).
	let { children, data } = $props();

	// Mini-bag toast (CartToast): nothing on first paint. It is fetched while
	// the browser is idle, or on the first add; adds that happen before it has
	// mounted are queued and replayed by it, so none is lost.
	let CartToast = $state.raw(null);
	let toastReady = false;
	const earlyAdds = [];
	let toastLoading = null;
	function loadToast() {
		toastLoading ??= import('$lib/components/CartToast.svelte').then(
			(m) => (CartToast = m.default),
			() => (toastLoading = null) // offline: try again on the next add
		);
	}

	onMount(() => {
		initLenis();
		initAnchorScroll();
		const onCartAdd = (e) => {
			popCartBadges();
			if (!toastReady) {
				earlyAdds.push({ detail: e.detail, at: Date.now(), path: location.pathname });
				loadToast();
			}
		};
		window.addEventListener('wf:cart-add', onCartAdd);
		const idle = window.requestIdleCallback
			? window.requestIdleCallback(loadToast, { timeout: 4000 })
			: window.setTimeout(loadToast, 2500);
		// Leaving for an external link mid-veil must never strand a covered page.
		const onPageHide = () => hideVeilNow();
		window.addEventListener('pagehide', onPageHide);
		pageSetup();
		playEnterTransition();
		return () => {
			window.removeEventListener('wf:cart-add', onCartAdd);
			window.removeEventListener('pagehide', onPageHide);
			if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
			else window.clearTimeout(idle);
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

<AnnouncementBar />
<Nav />
<SearchOverlay />
{@render children()}
<PeepStrip />
<Footer pages={data?.footerPages} legal={data?.legal} />
<ColorMixToggle />
<MobileNav />
{#if CartToast}<CartToast replay={earlyAdds} onready={() => (toastReady = true)} />{/if}
