<script>
	import { onMount } from 'svelte';
	import AddToCart from '$lib/components/AddToCart.svelte';

	const items = [
		{
			slug: 'cornflakes',
			name: 'Cornflakes',
			category: 'Flakes',
			terms: 'corn flakes corn flakes cereal breakfast chivda',
			image: '/images/wefeasto/product-cornflakes.jpg',
			alt: 'Bowl of Wefeasto Cornflakes with milk',
			viewAria: 'View Cornflakes',
			priceLine: '₹175 · 120 cal',
			starsAria: 'Rated 5 out of 5',
			starsRating: '5',
			pack: '500 g'
		},
		{
			slug: 'steel-cut-oats',
			name: 'Steel-Cut Oats',
			category: 'Oats',
			terms: 'oats steel cut oatmeal porridge overnight oats breakfast',
			image: '/images/wefeasto/product-steel-cut-oats.jpg',
			alt: 'Bowl of Wefeasto Steel-Cut Oats porridge',
			viewAria: 'View Steel-Cut Oats',
			priceLine: '₹135 · 80 cal',
			starsAria: 'Rated 4.3 out of 5',
			starsRating: '4.3',
			pack: '500 g'
		},
		{
			slug: 'rolled-oats',
			name: 'Rolled Oats',
			category: 'Oats',
			terms: 'rolled oats oats oatmeal porridge overnight oats quick oats breakfast',
			image: '/images/wefeasto/product-rolled-oats.jpg',
			alt: 'Top-down bowl of Wefeasto Rolled Oats with banana and berries',
			viewAria: 'View Rolled Oats',
			priceLine: '₹125 · 90 cal',
			starsAria: 'Rated 4.4 out of 5',
			starsRating: '4.4',
			pack: '500 g'
		},
		{
			slug: 'muesli',
			name: 'Muesli',
			category: 'Muesli',
			terms: 'muesli granola cereal nuts fruit parfait breakfast',
			image: '/images/wefeasto/product-muesli.jpg',
			alt: 'Bowl of Wefeasto Muesli with nuts and fruit',
			viewAria: 'View Muesli',
			priceLine: '₹250 · 100 cal',
			starsAria: 'Rated 4 out of 5',
			starsRating: '4',
			pack: '400 g'
		},
		{
			slug: 'choco-flakes',
			name: "Choco's",
			category: 'Flakes',
			terms: 'choco chocos chocolate choco flakes kids cereal',
			image: '/images/wefeasto/product-choco-flakes.jpg',
			alt: "Bowl of Wefeasto Choco's chocolate flakes with milk",
			viewAria: "View Choco's",
			priceLine: '₹200 · 120 cal',
			starsAria: 'Rated 4.5 out of 5',
			starsRating: '4.5',
			pack: '250 g'
		},
		{
			slug: 'health-mix',
			name: 'Health Mix',
			category: 'Mix',
			terms: 'health mix multigrain millet ragi sathu maavu porridge smoothie',
			image: '/images/wefeasto/product-health-mix.jpg',
			alt: 'Glass of Wefeasto Health Mix multigrain porridge',
			viewAria: 'View Health Mix',
			priceLine: '₹270 · 120 cal',
			starsAria: 'Rated 5 out of 5',
			starsRating: '5',
			pack: null
		}
	];

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
		const hay = (
			(card.getAttribute('data-name') || '') +
			' ' +
			(card.getAttribute('data-category') || '') +
			' ' +
			(card.getAttribute('data-terms') || '')
		).toLowerCase();
		return hay.indexOf(q) > -1;
	}

	function queueRefresh() {
		window.clearTimeout(refreshTimer);
		refreshTimer = window.setTimeout(() => {
			if (typeof window.ScrollTrigger !== 'undefined') window.ScrollTrigger.refresh();
		}, 340);
	}

	function applyFilter() {
		const q = query.trim().toLowerCase();
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
<div class="wf-reveal wf-shop-item" data-name={item.name} data-category={item.category} data-terms={item.terms}><div class="div-block-84 wf-card"><a class="wf-card-cover" href="/products/{item.slug}" aria-label={item.viewAria}></a><div class="div-block-85"><img src={item.image} loading="lazy" alt={item.alt} class="image-4"><div class="text-block-3-copy">{item.category}</div><div class="wf-view-cue" aria-hidden="true">View Product</div></div><div class="div-block-83"><h4 class="heading-11">{item.name}</h4><div class="divider _6px"></div><div class="wf-price">{item.priceLine}</div><div class="divider _6px"></div><div class="wf-card-meta"><div class="wf-stars" role="img" aria-label={item.starsAria} style="--wf-rating:{item.starsRating}"><span class="wf-stars-fill">★★★★★</span></div>{#if item.pack}<div>{item.pack}</div>{/if}</div><div class="divider _8px"></div><AddToCart slug={item.slug} extraClass="wf-shop-add" /></div></div></div>
{/each}
<div id="wf-shop-empty" class="wf-search-empty" hidden bind:this={emptyEl}>Nothing matches — try “muesli”</div>
</div>
</div>
</div>
</div>
