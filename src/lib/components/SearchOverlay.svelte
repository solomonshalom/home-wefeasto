<script>
	import { onMount, tick } from 'svelte';
	import { searchOpen, searchSnap, closeSearch, searchCatalog } from '$lib/search.js';
	import { formatINR } from '$lib/data/products.js';
	import { motionOK, lenis } from '$lib/fx.js';

	let overlayEl;
	let innerEl;
	let resultsEl;
	let inputEl;

	let hidden = $state(true);
	let query = $state('');
	let results = $state([]);
	let isOpen = false;
	let debounceTimer = null;

	async function runSearch() {
		results = searchCatalog(query);
		await tick();
		if (motionOK() && resultsEl && resultsEl.children.length) {
			window.gsap.from(resultsEl.children, {
				y: 14,
				autoAlpha: 0,
				duration: 0.5,
				ease: 'power2.out',
				stagger: 0.05,
				overwrite: true,
				clearProps: 'all'
			});
		}
	}

	function onInput() {
		window.clearTimeout(debounceTimer);
		if (!motionOK()) {
			runSearch(); // synchronous under nofx
			return;
		}
		debounceTimer = window.setTimeout(runSearch, 120);
	}

	function open() {
		if (isOpen) return;
		isOpen = true;
		hidden = false;
		document.body.classList.add('wf-no-scroll');
		if (lenis) lenis.stop();
		runSearch();
		if (motionOK()) {
			const tl = window.gsap.timeline();
			tl.fromTo(overlayEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, ease: 'power2.out' });
			if (innerEl) {
				tl.fromTo(
					innerEl,
					{ y: 30, autoAlpha: 0, clipPath: 'inset(0% 0% 8% 0%)' },
					{ y: 0, autoAlpha: 1, clipPath: 'inset(0% 0% 0% 0%)', duration: 0.55, ease: 'expo.out', clearProps: 'clipPath' },
					'-=0.25'
				);
			}
			window.setTimeout(() => {
				if (inputEl) {
					inputEl.focus();
					inputEl.select();
				}
			}, 150);
		} else if (inputEl) {
			// Instant display toggle (nofx / reduced motion / no GSAP).
			inputEl.focus();
			inputEl.select();
		}
	}

	function close() {
		if (!isOpen) return;
		isOpen = false;
		const finish = () => {
			hidden = true;
			document.body.classList.remove('wf-no-scroll');
			if (lenis) lenis.start();
		};
		if (motionOK()) {
			window.gsap.to(overlayEl, { autoAlpha: 0, duration: 0.28, ease: 'power2.in', onComplete: finish });
		} else {
			finish();
		}
	}

	$effect(() => {
		if ($searchOpen) open();
		else close();
	});

	// Route changed: shut instantly and clear the query, like a fresh page load.
	let lastSnap = 0;
	$effect(() => {
		if ($searchSnap !== lastSnap) {
			lastSnap = $searchSnap;
			isOpen = false;
			hidden = true;
			query = '';
			if (typeof document !== 'undefined') document.body.classList.remove('wf-no-scroll');
			if (lenis) lenis.start();
		}
	});

	function onCloseClick(e) {
		e.preventDefault();
		closeSearch();
	}

	onMount(() => {
		// Let the overlay's own results list wheel-scroll while Lenis owns the
		// page — set at runtime exactly like the original js/wefeasto.js did.
		overlayEl.setAttribute('data-lenis-prevent', '');
		const onKey = (e) => {
			if (isOpen && (e.key === 'Escape' || e.key === 'Esc')) closeSearch();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});
</script>

<div id="wf-search-overlay" class="wf-search-overlay" {hidden} role="dialog" aria-modal="true" aria-label="Search Wefeasto" bind:this={overlayEl}><div class="wf-search-inner" bind:this={innerEl}><div class="wf-search-bar"><input class="wf-search-input" type="text" placeholder="Search products &amp; recipes…" aria-label="Search products and recipes" autocomplete="off" bind:value={query} bind:this={inputEl} oninput={onInput}><button class="wf-search-close" type="button" aria-label="Close search" onclick={onCloseClick}>✕</button></div><div class="wf-search-results" aria-live="polite" bind:this={resultsEl}>{#if !hidden}{#if results.length === 0}<p class="wf-search-empty">No matches — try “muesli” or “oats”</p>{:else}{#each results as item (item.url)}<a class="wf-search-card" href={item.url}><span class="wf-search-card-media"><img src={item.image} loading="lazy" alt={item.label}></span><span class="wf-search-card-name">{item.label}</span><span class="wf-search-card-meta">{#if item.type === 'product'}<span class="wf-chip wf-chip-small">{formatINR(item.price)}</span>{:else}<span class="wf-chip wf-chip-small">Recipe</span>{/if}<span class="wf-search-card-cat">{item.category}</span></span></a>{/each}{/if}{/if}</div></div></div>
