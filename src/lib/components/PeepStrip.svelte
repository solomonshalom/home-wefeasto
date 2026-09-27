<script>
	/*
	 * The site-wide PeepWalk crowd, mounted once in +layout.svelte between the
	 * page and <Footer /> — the footer's top border is the ground the crowd
	 * walks behind. It persists across client navigations (no remount, one
	 * ticker listener). Hidden where it would compete with a task: checkout,
	 * login, password reset, and /order (which renders its own crowd).
	 * Without JS the blank band is hidden (noscript style).
	 */
	import { page } from '$app/state';
	import PeepWalk from '$lib/components/PeepWalk.svelte';

	const HIDE = ['/checkout', '/login', '/order', '/reset-password'];
	const path = $derived(page.url.pathname);
	const show = $derived(!HIDE.some((p) => path === p || path.startsWith(p + '/')));
</script>

<svelte:head><noscript><style>.wf-peepwalk{display:none}</style></noscript></svelte:head>
{#if show}<PeepWalk />{/if}
