<script>
	/*
	 * Prerendered to build/404.html: the page the static host (Vercel) serves,
	 * with a 404 status, for any URL that has no file. Real markup, so it reads
	 * without JS; svelte.config.js makes its asset paths root-absolute so it
	 * works at any depth, and with JS it hydrates like any other page.
	 */
	import NotFound from '$lib/components/NotFound.svelte';
	import { setMiniCardSource } from '$lib/components/MiniProductCard.svelte';

	setMiniCardSource('not-found'); // same add-to-cart source as the client-side +error.svelte
</script>

<NotFound status={404} />
