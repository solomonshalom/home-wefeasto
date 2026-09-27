<script>
	import { onMount } from 'svelte';
	import AddToCart from '$lib/components/AddToCart.svelte';
	import YourUsual from '$lib/components/YourUsual.svelte';
	import { shopItems } from '$lib/data/catalog-views.js';
	import { liveCatalog, loadLive, withLivePrices } from '$lib/live.js';
	import { searchKey } from '$lib/search.js';

	// Every product in catalog order, derived from the CMS snapshot
	// (src/lib/data/cms-snapshot.json): priceLine, star rating and pack size come
	// from pricePaise/rating/packSize, so the grid never disagrees with the PDP,
	// cart and search.
	const items = shopItems();
	// Once the live catalog has loaded (onMount below), the price lines are
	// re-derived from the CMS's current prices; the cards and their order stay
	// (the filter keeps the same DOM nodes). Sold out: each AddToCart says so.
	const livePriceLines = $derived($liveCatalog.ready ? new Map(shopItems(withLivePrices).map((i) => [i.slug, i.priceLine])) : null);

	const FILTERS = ['all', 'Flakes', 'Oats', 'Muesli', 'Mix'];

	/* Live filter — direct port of the shop.html page script: chips AND text
	   query, GSAP exit/entrance tweens on the same DOM nodes. */
	let gridEl;
	let emptyEl;
	let query = $state('');
	let activeCat = $state('all');
	let debounceTimer = null;
	let refreshTimer = null;
	let cards = [];

	let reduceMotion = false;
	function motionOK() {
		return typeof window.gsap !== 'undefined' && !reduceMotion;
	}

	function isHiddenCard(card) {
		return card.style.display === 'none';
	}

	function matches(card, q) {
		if (activeCat !== 'all' && (card.getAttribute('data-category') || '') !== activeCat) return false;
		if (!q) return true;
		// Folded like the search overlay's (searchKey): "Choco’s" from an iPhone finds Choco's.
		const hay = searchKey(
			(card.getAttribute('data-name') || '') +
				' ' +
				(card.getAttribute('data-category') || '') +
				' ' +
				(card.getAttribute('data-terms') || '')
		);
		return hay.indexOf(q) > -1;
	}

	function queueRefresh() {
		window.clearTimeout(refreshTimer);
		refreshTimer = window.setTimeout(() => {
			if (typeof window.ScrollTrigger !== 'undefined') window.ScrollTrigger.refresh();
		}, 340);
	}

	function applyFilter() {
		const q = searchKey(query);
		const toShow = [];
		const toHide = [];
		cards.forEach((card) => {
			(matches(card, q) ? toShow : toHide).push(card);
		});
		if (emptyEl) emptyEl.hidden = toShow.length > 0;

		if (!motionOK()) {
			toHide.forEach((card) => (card.style.display = 'none'));
			toShow.forEach((card) => {
				card.style.display = '';
				card.style.opacity = '';
				card.style.visibility = '';
				card.style.transform = '';
			});
			return;
		}

		// Cards that will need an entrance tween (were hidden, or reveal not fired yet).
		const entering = toShow.filter(
			(card) => isHiddenCard(card) || Number(window.getComputedStyle(card).opacity) < 1
		);
		toHide.forEach((card) => {
			if (isHiddenCard(card)) return;
			window.gsap.to(card, {
				autoAlpha: 0,
				y: 14,
				duration: 0.22,
				ease: 'power2.in',
				overwrite: true,
				onComplete() {
					card.style.display = 'none';
					queueRefresh();
				}
			});
		});
		toShow.forEach((card) => (card.style.display = ''));
		if (entering.length) {
			window.gsap.fromTo(
				entering,
				{ autoAlpha: 0, y: 18 },
				{ autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out', stagger: 0.06, overwrite: true, clearProps: 'transform' }
			);
		}
		queueRefresh();
	}

	function onChipClick(cat) {
		activeCat = cat;
		applyFilter();
	}

	function onInput() {
		window.clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(applyFilter, 140);
	}

	function onKeydown(e) {
		if (e.key === 'Enter') e.preventDefault();
	}

	onMount(() => {
		try {
			reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch (e) {
			/* noop */
		}
		cards = Array.prototype.slice.call(gridEl.querySelectorAll('.wf-shop-item'));
		loadLive();
		return () => {
			window.clearTimeout(debounceTimer);
			window.clearTimeout(refreshTimer);
		};
	});
</script>

<svelte:head>
	<title>Wefeasto — Shop</title>
</svelte:head>

<div class="page-wrapper">
<div class="section">
<div class="container">
<div class="wf-shop-header wf-hero-stagger">
<div class="text-block-3">The Menu</div>
<div class="divider"></div>
<h1 class="heading-2">wake up early, eat fresh &amp; healthy</h1>
<div class="divider"></div>
<p class="p-large">Super delicious, crunchy and healthy — browse the full Wefeasto range and stock your breakfast shelf.</p>
</div>
<div class="divider _42px mobile-32px"></div>
<YourUsual variant="shop" />
<div class="wf-shop-toolbar">
<input class="text-field-2 w-input wf-shop-search" id="wf-shop-search" type="text" maxlength="256" placeholder="Search cornflakes, muesli, oats…" aria-label="Search the menu" autocomplete="off" bind:value={query} oninput={onInput} onkeydown={onKeydown}>
<div class="wf-shop-filters" role="group" aria-label="Filter products by category">
{#each FILTERS as f (f)}
<button type="button" class="wf-chip wf-filter-chip{activeCat === f ? ' wf-active' : ''}" data-wf-filter={f} aria-pressed={activeCat === f ? 'true' : 'false'} onclick={() => onChipClick(f)}>{f === 'all' ? 'All' : f}</button>
{/each}
</div>
</div>
<div class="divider _42px mobile-32px"></div>
<div class="grid-6 wf-shop-grid" id="wf-shop-grid" bind:this={gridEl}>
{#each items as item (item.slug)}
<div class="wf-reveal wf-shop-item" data-name={item.name} data-category={item.category} data-terms={item.terms}><div class="div-block-84 wf-card"><a class="wf-card-cover" href="/products/{item.slug}" aria-label={item.viewAria}></a><div class="div-block-85"><img src={item.image} loading="lazy" alt={item.alt} class="image-4"><div class="text-block-3-copy">{item.category}</div><div class="wf-view-cue" aria-hidden="true">View Product</div></div><div class="div-block-83"><h4 class="heading-11">{item.name}</h4><div class="divider _6px"></div><div class="wf-price">{livePriceLines?.get(item.slug) ?? item.priceLine}</div><div class="divider _6px"></div><div class="wf-card-meta"><div class="wf-stars" role="img" aria-label={item.starsAria} style="--wf-rating:{item.starsRating}"><span class="wf-stars-fill">★★★★★</span></div>{#if item.pack}<div>{item.pack}</div>{/if}</div><div class="divider _8px"></div><AddToCart slug={item.slug} extraClass="wf-shop-add" /></div></div></div>
{/each}
<div id="wf-shop-empty" class="wf-search-empty" hidden bind:this={emptyEl}>Nothing matches — try “muesli”</div>
</div>
</div>
</div>
</div>
