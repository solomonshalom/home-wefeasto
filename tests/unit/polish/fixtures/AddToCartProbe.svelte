<script>
	/* Test double for AddToCart.svelte: shows the props MiniProductCard hands it. */
	let { slug, source = 'card' } = $props();
</script>

<i data-probe-slug={slug} data-probe-source={source}></i>
