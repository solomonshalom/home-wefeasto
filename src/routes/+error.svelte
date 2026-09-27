<script>
	/*
	 * Errors SvelteKit renders itself: `vite preview` server-renders unknown
	 * URLs here with status 404, and client-side navigations whose load()
	 * fails (/products/not-a-cereal) land here too. On the static host an
	 * unknown URL gets build/404.html instead, the prerendered src/routes/404
	 * page. Both render the same branded NotFound body.
	 */
	import { page } from '$app/state';
	import NotFound from '$lib/components/NotFound.svelte';
	import { setMiniCardSource } from '$lib/components/MiniProductCard.svelte';

	setMiniCardSource('not-found'); // bestseller adds here say so ('404' would fail cart.js's source pattern)
</script>

<NotFound status={page.status} />
