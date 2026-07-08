<script>
	import { onMount } from 'svelte';
	import RecipeListCard from '$lib/components/RecipeListCard.svelte';
	import { recipesContent } from '$lib/data/recipes-content.js';

	const slugs = Object.keys(recipesContent); // recipes.html card order
	const FILTERS = ['All', 'Breakfast', 'Kids', 'Snacks', 'Desserts'];

	/* Category filter — direct port of the recipes.html page script. */
	let gridEl;
	let activeCat = $state('All');
	let reduceMotion = false;

	function applyFilter(cat) {
		const cards = Array.prototype.slice.call(gridEl.querySelectorAll('.wf-recipe-item'));
		const shown = [];
		cards.forEach((card) => {
			const match = cat === 'All' || card.getAttribute('data-wf-category') === cat;
			card.style.display = match ? '' : 'none';
			if (match) shown.push(card);
		});
		if (window.gsap && !reduceMotion && shown.length) {
			window.gsap.fromTo(
				shown,
				{ y: 24, autoAlpha: 0 },
				{ y: 0, autoAlpha: 1, duration: 0.55, ease: 'power2.out', stagger: 0.06, overwrite: true, clearProps: 'all' }
			);
		}
		if (window.ScrollTrigger) window.ScrollTrigger.refresh();
	}

	function onChipClick(cat) {
		activeCat = cat;
		applyFilter(cat);
	}

	onMount(() => {
		try {
			reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch (e) {
			/* noop */
		}
	});
</script>

<svelte:head>
	<title>Wefeasto — Recipes</title>
</svelte:head>

<div class="page-wrapper"><div class="section"><div class="container"><div class="wf-hero-stagger"><div class="text-block-3">From the Kitchen</div><div class="divider"></div><h1 class="heading-2">Recipes that start with a crunch.</h1><div class="divider _32px"></div><p class="p-large">From no-cook overnight oats to chai-time chivda — twelve kitchen-tested ways to turn Wefeasto cereals into breakfasts, lunchbox bars and snacks the whole house will finish.</p><div class="divider _42px"></div><div class="wf-filter-bar" role="group" aria-label="Filter recipes by category">{#each FILTERS as f (f)}<button type="button" class="wf-chip wf-filter-chip{activeCat === f ? ' wf-active' : ''}" data-wf-filter={f} aria-pressed={activeCat === f ? 'true' : 'false'} onclick={() => onChipClick(f)}>{f}</button>{/each}</div></div></div></div><div class="section"><div class="container"><div class="grid-6 _2" id="wf-recipe-grid" bind:this={gridEl}>{#each slugs as slug (slug)}<RecipeListCard {slug} card={recipesContent[slug].card} />{/each}</div></div></div></div>
