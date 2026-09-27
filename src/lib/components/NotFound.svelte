<script>
	/*
	 * Branded error page body (roadmap S9), shared by src/routes/+error.svelte
	 * (SSR 404s in preview, client-side 404s such as /products/not-a-cereal)
	 * and the prerendered src/routes/404 page, which becomes build/404.html:
	 * what the static host serves for unknown URLs, readable without JS.
	 * Search, three bestsellers, and the layout's PeepStrip crowd right below —
	 * a dead end that still leads somewhere.
	 */
	import { openSearch } from '$lib/search.js';
	import { products, formatINR } from '$lib/data/products.js';
	import { productsContent } from '$lib/data/products-content.js';
	import { homeBestsellers } from '$lib/data/catalog-views.js';
	import MiniProductCard from '$lib/components/MiniProductCard.svelte';

	/** @type {{ status?: number }} */
	let { status = 404 } = $props();

	// Every product already has a "Goes well with" card in products-content.js:
	// reuse its copy (image alt) and derive the rest from the product record,
	// so name, price, rating and pack always follow the catalog.
	const cardCopy = new Map();
	for (const content of Object.values(productsContent)) {
		for (const card of content.goesWith || []) if (!cardCopy.has(card.slug)) cardCopy.set(card.slug, card);
	}

	function cardFor(p) {
		const rating = Number(p.rating) || 0;
		return {
			slug: p.slug,
			viewAria: `View ${p.name}`,
			image: p.image,
			alt: cardCopy.get(p.slug)?.alt || `Wefeasto ${p.name}`,
			catLabel: p.category,
			starsAria: `Rated ${rating.toFixed(1)} out of 5`,
			starsRating: String(rating),
			meta: [p.packSize, p.calories ? `${p.calories} cal` : null].filter(Boolean).join(' · '),
			name: p.name,
			price: formatINR(p.price)
		};
	}

	// The home page's "Shop Bestsellers" (the catalog's homeFeatured flag, in
	// catalog order), topped up from the catalog if fewer than three are set.
	const picks = homeBestsellers()
		.map((b) => products.find((p) => p.url === b.url))
		.filter(Boolean);
	for (const p of products) if (picks.length < 3 && !picks.includes(p)) picks.push(p);
	const cards = picks.slice(0, 3).map(cardFor);

	const is404 = $derived(status === 404);
</script>

<svelte:head>
	<title>Wefeasto — {is404 ? 'Page not found' : 'Something went wrong'}</title>
	<meta name="robots" content="noindex">
	<!-- Search opens a JS overlay: without JS it would be a dead button (Shop Breakfast still leads on). -->
	<noscript><style>.wf-notfound-search{display:none!important}</style></noscript>
</svelte:head>

<div class="page-wrapper">
<div class="section"><div class="container"><div class="wf-cart-empty wf-notfound"><div class="wf-hero-stagger"><div class="wf-chip">Error {status}</div><div class="divider"></div><h1 class="heading-2">{is404 ? 'This page wandered off.' : 'Something went wrong.'}</h1><div class="divider _8px"></div><p class="p-large wf-notfound-lead">{is404 ? 'The link may be old, or the page has moved. Search the shop, or start with a breakfast favourite.' : 'Please try again in a moment. Meanwhile, the shop and our favourites are right here.'}</p><div class="divider _32px mobile-24px"></div><div class="wf-cart-empty-actions wf-notfound-actions"><button type="button" class="button w-button wf-notfound-search" onclick={() => openSearch()}>Search Wefeasto</button><a href="/shop" class="button secondary w-inline-block"><div>Shop Breakfast</div></a></div></div></div></div></div>
<div class="section"><div class="div-block-90"><div class="div-block-91"><h2>Shop Bestsellers</h2><a href="/shop" class="button secondary w-inline-block"><div>View All</div></a></div><div class="divider _42px"></div><div class="grid-6 _2">{#each cards as card (card.slug)}<MiniProductCard {card} />{/each}</div><div class="divider _64px"></div></div></div>
</div>
