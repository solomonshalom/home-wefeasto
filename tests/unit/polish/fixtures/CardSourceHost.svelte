<script>
	/*
	 * Test host: sets the MiniProductCard source default for its subtree (as
	 * +error.svelte does) and renders one card without and one with an
	 * explicit `source`.
	 */
	import { untrack } from 'svelte';
	import MiniProductCard, { setMiniCardSource } from '$lib/components/MiniProductCard.svelte';

	let { inherited, card, explicit } = $props();

	untrack(() => {
		if (inherited !== undefined) setMiniCardSource(inherited); // once, at init (like +error.svelte)
	});
</script>

<MiniProductCard {card} /><MiniProductCard {card} source={explicit} />
