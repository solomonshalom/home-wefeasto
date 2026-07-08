<script>
	/*
	 * Recipe card used on /recipes and in "Related Posts" on recipe pages —
	 * whole card is one link via .wf-card-cover.
	 */
	let { slug, card } = $props();
</script>

<div class="wf-reveal wf-recipe-item" data-wf-category={card.category}><div class="div-block-84 wf-card"><a class="wf-card-cover" href="/recipes/{slug}" aria-label={card.coverAria}></a><div class="div-block-85"><img src={card.image} loading="lazy" alt={card.cardAlt} class="image-4"><div class="text-block-3-copy">{card.catLabel}</div></div><div class="div-block-83"><h4 class="heading-11">{card.title}</h4><div class="divider _6px"></div><div class="wf-card-meta"><div class="w-layout-grid grid-10"><div class="div-block-96"><div class="div-block-97"><img src="/images/webclip.png" loading="lazy" alt="Wefeasto Kitchen avatar — dark Wefeasto brand mark" class="image-5"></div><div style="background-color:{card.iconColor}" class="div-block-97 _2"><img src={card.iconSrc} loading="lazy" alt={card.iconAlt} class="image-7"></div></div><div id="w-node-f4e7aae3-7159-cc67-6f44-315b001511aa-81c6f288" class="div-block-98"><div>Wefeasto Kitchen</div></div></div><div>{card.serves}</div></div><div class="divider _6px"></div><div class="p-small text-medium text-secondary">{card.prepLine}</div></div></div></div>
