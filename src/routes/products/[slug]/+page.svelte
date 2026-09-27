<script>
	import QtyStepper from '$lib/components/QtyStepper.svelte';
	import AddToCart from '$lib/components/AddToCart.svelte';
	import PartnersDropdown from '$lib/components/PartnersDropdown.svelte';
	import MiniProductCard from '$lib/components/MiniProductCard.svelte';
	import ProductFacts from '$lib/components/ProductFacts.svelte';
	import { onMount } from 'svelte';
	import { settings as snapshotSettings, products as snapshotProducts } from '$lib/data/cms-snapshot.json';
	import { formatPaise } from '$shared/money.js';
	import { priceText } from '$lib/data/derive.js';
	import { liveCatalog, loadLive, readyRow } from '$lib/live.js';

	let { data } = $props();

	const content = $derived(data.content);
	// content.chips is CMS text (pack size, calories) and may repeat: keyed by
	// position, since a duplicate each key throws while hydrating (production too).

	// Live overlay (SPEC §1; live-catalog.md §2). The prerendered page (SEO,
	// no JS) shows the snapshot; once the live catalog has loaded, the price,
	// stock and COD flag are the CMS's current ones. AddToCart blocks the add.
	onMount(() => {
		loadLive();
	});
	const live = $derived(readyRow($liveCatalog, data.product.slug));
	const price = $derived(live ? priceText(live.pricePaise) : content.priceText);
	const soldOut = $derived(live?.inStock === false);
	const settings = $derived($liveCatalog.ready ? $liveCatalog.settings : snapshotSettings);

	// "Buy direct" perks (roadmap S7): only perks that exist, from the store settings.
	const perks = $derived.by(() => {
		const list = [];
		if (settings.deliveryFeePaise === 0) list.push('free delivery');
		else if (settings.freeDeliveryThresholdPaise > 0) list.push('free delivery over ' + formatPaise(settings.freeDeliveryThresholdPaise));
		const item = live || snapshotProducts.find((p) => p.slug === data.product.slug);
		if (settings.codEnabled && item && item.codAllowed) list.push('COD available');
		list.push('fresh from our kitchen');
		return 'Buying here: ' + list.join(' · ');
	});
	let qty = $state(1);

	// New product page → fresh quantity, like a fresh page load did.
	$effect(() => {
		data.content;
		qty = 1;
	});
</script>

<svelte:head>
	<title>Wefeasto — {content.title}</title>
</svelte:head>

<div class="page-wrapper">
<div class="section"><div class="container"><div class="container"><div class="w-layout-grid grid-2 wf-pdp-grid"><div class="div-block-77 _2 wf-reveal"><img src={content.heroImage} alt={content.heroAlt} class="image-4"></div><div class="div-block-76"><div class="div-block-78"><div class="text-block-3">{data.product.category}</div><div class="divider"></div><h1 class="heading-2">{content.h1}</h1><div class="divider _8px"></div><div><div class="wf-stars" role="img" aria-label={content.starsAria} style="--wf-rating:{content.starsRating}"><span class="wf-stars-fill">★★★★★</span></div> <strong>{content.ratingBold}</strong></div><div class="divider _8px"></div><div class="w-layout-grid grid-3"><div class="wf-price wf-price-large">{price}</div>{#if soldOut}<div class="wf-chip wf-chip-small wf-chip-soldout" data-wf-soldout>Sold out</div>{/if}{#each content.chips as chip, i (i)}<div class="wf-chip wf-chip-small">{chip}</div>{/each}</div><div class="divider"></div><p class="p-large">{content.description}</p><div class="divider _24px"></div><div class="w-layout-grid grid-3"><QtyStepper id={content.qtyId} bind:value={qty} /><AddToCart slug={data.product.slug} qtyInputId={content.qtyId} source="pdp" /></div><div class="divider"></div><p class="p-small wf-perks" data-wf-perks>{perks}</p><PartnersDropdown partners={content.partners} /><ProductFacts slug={data.product.slug} /></div></div></div></div></div></div>
<div class="section"><div class="div-block-90"><div class="divider _64px"></div><div class="div-block-91"><h2>Goes well with</h2><a href="/shop" class="button secondary w-inline-block"><div>View All</div></a></div><div class="divider _42px"></div><div class="grid-6 _2">{#each content.goesWith as card (card.slug)}<MiniProductCard {card} source="goes-with" />{/each}</div><div class="divider _64px"></div></div></div>
{#if content.recipeCardDetails.length}<div class="section"><div class="div-block-90"><div class="div-block-91"><h2>{content.recipesHeading}</h2><a href="/recipes" class="button secondary w-inline-block"><div>View All</div></a></div><div class="divider _42px"></div><div class="grid-6 _2">{#each content.recipeCardDetails as d (d.slug)}<div class="wf-reveal"><div class="div-block-84 wf-card"><a class="wf-card-cover" href="/recipes/{d.slug}" aria-label={d.coverAria}></a><div class="div-block-85"><img src={d.image} loading="lazy" alt={d.alt} class="image-4"><div class="text-block-3-copy">{d.catLabel}</div></div><div class="div-block-83"><div>{d.catText}</div><div class="divider _6px"></div><h4 class="heading-11">{d.title}</h4><p class="p-small">{d.desc}</p><div class="divider _6px"></div><div class="w-layout-grid grid-10"><div class="div-block-96"><div class="div-block-97"><img src="/images/webclip.png" loading="lazy" alt="Wefeasto Kitchen avatar — dark Wefeasto brand mark" class="image-5"></div><div style="background-color:{d.iconColor}" class="div-block-97 _2"><img src={d.iconSrc} loading="lazy" alt={d.iconAlt} class="image-7"></div></div><div id="w-node-f4e7aae3-7159-cc67-6f44-315b001511aa-81c6f288" class="div-block-98"><div>Wefeasto Kitchen</div></div></div></div></div></div>{/each}</div><div class="divider _64px"></div></div></div>{/if}
</div>
