<script>
	/*
	 * Small product card used in "Goes well with" (product pages) and
	 * "Shop the Ingredients" (recipe pages). Rendered from a per-page record
	 * extracted verbatim from the original HTML.
	 */
	import AddToCart from '$lib/components/AddToCart.svelte';

	let { card } = $props();
</script>

<div class="wf-reveal"><div class="div-block-84 wf-card"><div class="div-block-85"><a href="/products/{card.slug}" aria-label={card.viewAria}><img src={card.image} loading="lazy" alt={card.alt} class="image-4"></a><div class="text-block-3-copy">{card.catLabel}</div></div><div class="div-block-83"><div class="wf-card-meta"><div class="wf-stars" role="img" aria-label={card.starsAria} style="--wf-rating:{card.starsRating}"><span class="wf-stars-fill">★★★★★</span></div><div>{card.meta}</div></div><div class="divider _6px"></div><h4 class="heading-11"><a href="/products/{card.slug}" class="wf-card-link">{card.name}</a></h4><div class="wf-price">{card.price}</div><div class="divider _8px"></div><AddToCart slug={card.slug} /></div></div></div>
