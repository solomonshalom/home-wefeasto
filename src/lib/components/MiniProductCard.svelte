<script module>
	import { getContext, setContext } from 'svelte';

	const SOURCE = Symbol('wf-mini-card-source');

	/**
	 * Default add-to-cart `source` for every MiniProductCard below the calling
	 * component (call it during component init). For cards rendered inside a
	 * component that has no `source` prop to pass on, e.g. +error.svelte →
	 * NotFound's bestsellers. An explicit `source` prop still wins.
	 * @param {string} source
	 */
	export function setMiniCardSource(source) {
		setContext(SOURCE, source);
	}
</script>

<script>
	/*
	 * Small product card used in "Goes well with" (product pages) and
	 * "Shop the Ingredients" (recipe pages). Rendered from a per-page record
	 * extracted verbatim from the original HTML. `source` rides along to
	 * AddToCart (the wf:cart-add event and add_to_cart analytics): 'goes-with',
	 * 'recipe-ingredients', 'not-found', … — markup is the same for all.
	 */
	import AddToCart from '$lib/components/AddToCart.svelte';
	import { liveCatalog, readyRow } from '$lib/live.js';
	import { priceText } from '$lib/data/derive.js';

	let { card, source = undefined } = $props();

	const inherited = getContext(SOURCE);
	const addSource = $derived(source ?? inherited ?? 'card');
	// The live price once the catalog has loaded (AddToCart asks for it on
	// mount); the prerendered card keeps the snapshot's.
	const price = $derived.by(() => {
		const row = readyRow($liveCatalog, card.slug);
		return row ? priceText(row.pricePaise) : card.price;
	});
</script>

<div class="wf-reveal"><div class="div-block-84 wf-card"><div class="div-block-85"><a href="/products/{card.slug}" aria-label={card.viewAria}><img src={card.image} loading="lazy" alt={card.alt} class="image-4"></a><div class="text-block-3-copy">{card.catLabel}</div></div><div class="div-block-83"><div class="wf-card-meta"><div class="wf-stars" role="img" aria-label={card.starsAria} style="--wf-rating:{card.starsRating}"><span class="wf-stars-fill">★★★★★</span></div><div>{card.meta}</div></div><div class="divider _6px"></div><h4 class="heading-11"><a href="/products/{card.slug}" class="wf-card-link">{card.name}</a></h4><div class="wf-price">{price}</div><div class="divider _8px"></div><AddToCart slug={card.slug} source={addSource} /></div></div></div>
