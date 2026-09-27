<script>
	import { onMount, tick, untrack } from 'svelte';
	import { searchOpen, searchSnap, closeSearch, searchCatalog } from '$lib/search.js';
	import { formatINR } from '$lib/data/products.js';
	import { priceText } from '$lib/data/derive.js';
	import { motionOK, lenis } from '$lib/fx.js';
	import { liveCatalog, loadLive, readyRow } from '$lib/live.js';

	let overlayEl;
	let innerEl;
	let resultsEl;
	let inputEl;

	let hidden = $state(true);
	let query = $state('');
	let results = $state([]);
	let isOpen = false;
	let debounceTimer = null;
	// What had focus when search opened (the nav button, the 404 page's
	// button): it gets focus back on close.
	let opener = null;
	// Bumped by every open, close and snap, so a focus attempt still pending
	// from an earlier open (a tween callback, a tick), or the end of an
	// earlier close's fade, never acts on the overlay's current state.
	let openId = 0;
	// The open timeline and the close fade (motion only), so either can be
	// stopped when the other starts.
	let openTl = null;
	let closeTween = null;

	/** A product result's price chip: live price once the catalog has loaded (asked for on open), "· Sold out" when the CMS has none. */
	function chipText(item) {
		const row = readyRow($liveCatalog, item.url.replace(/^\/products\//, ''));
		if (!row) return formatINR(item.price);
		return priceText(row.pricePaise) + (row.inStock ? '' : ' · Sold out');
	}

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

	/**
	 * Focus and select the query field. False while it can't take focus yet:
	 * still `hidden` (Svelte hasn't flushed), or under GSAP's autoAlpha 0
	 * (visibility: hidden) before the panel's tween has rendered a frame.
	 */
	function focusInput() {
		if (!inputEl) return false;
		inputEl.focus({ preventScroll: true });
		if (document.activeElement !== inputEl) return false;
		inputEl.select();
		return true;
	}

	async function open() {
		if (isOpen) return;
		isOpen = true;
		const id = ++openId;
		const active = document.activeElement;
		opener = active && active !== document.body && !overlayEl.contains(active) ? active : null;
		hidden = false;
		loadLive(); // memoized; the chips switch to live prices when it lands
		document.body.classList.add('wf-no-scroll');
		if (lenis) lenis.stop();
		runSearch();
		if (closeTween) closeTween.kill(); // reopened mid fade-out
		closeTween = null;
		if (motionOK()) {
			// Focus lands as soon as the panel is visible: its tween's first
			// frames (GSAP renders them after Svelte has unhidden the overlay),
			// with the timeline's end as a last resort.
			let focused = false;
			const focusOnce = () => {
				if (!focused && id === openId) focused = focusInput();
			};
			openTl = window.gsap.timeline({ onComplete: focusOnce });
			openTl.fromTo(overlayEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, ease: 'power2.out' });
			if (innerEl) {
				openTl.fromTo(
					innerEl,
					{ y: 30, autoAlpha: 0, clipPath: 'inset(0% 0% 8% 0%)' },
					{ y: 0, autoAlpha: 1, clipPath: 'inset(0% 0% 0% 0%)', duration: 0.55, ease: 'expo.out', clearProps: 'clipPath', onStart: focusOnce, onUpdate: focusOnce },
					'-=0.25'
				);
			}
		} else {
			// Instant display toggle (nofx / reduced motion / no GSAP). Drop any
			// inline opacity/visibility an earlier animated open or close left
			// (a client navigation can switch ?nofx=1 on in between).
			if (window.gsap) window.gsap.set([overlayEl, innerEl].filter(Boolean), { clearProps: 'all' });
			await tick(); // the hidden attribute goes on this flush; a hidden input can't take focus
			if (id === openId) focusInput();
		}
	}

	/** Give focus back to the opener, unless focus has already moved on outside the overlay. */
	function restoreFocus() {
		const back = opener;
		opener = null;
		if (!back || !back.isConnected || typeof back.focus !== 'function') return;
		const active = document.activeElement;
		if (active && active !== document.body && !overlayEl.contains(active)) return;
		back.focus({ preventScroll: true });
	}

	function close() {
		if (!isOpen) return;
		isOpen = false;
		const id = ++openId;
		restoreFocus();
		if (openTl) openTl.kill(); // closed mid open: stop fading in
		openTl = null;
		const finish = () => {
			if (id !== openId) return; // reopened (or snapped) during the fade
			closeTween = null;
			hidden = true;
			document.body.classList.remove('wf-no-scroll');
			if (lenis) lenis.start();
		};
		if (motionOK()) {
			closeTween = window.gsap.to(overlayEl, { autoAlpha: 0, duration: 0.28, ease: 'power2.in', onComplete: finish });
		} else {
			finish();
		}
	}

	// Route changed: shut instantly and clear the query, like a fresh page load.
	// No focus return: the navigation owns focus now.
	function snapShut() {
		isOpen = false;
		openId++;
		opener = null;
		if (openTl) openTl.kill();
		if (closeTween) closeTween.kill();
		openTl = closeTween = null;
		hidden = true;
		query = '';
		if (typeof document !== 'undefined') document.body.classList.remove('wf-no-scroll');
		if (lenis) lenis.start();
	}

	// One effect for both stores: snapCloseSearch() sets searchOpen to false and
	// bumps searchSnap together, and that must read as a snap, not a close.
	let lastSnap = 0;
	$effect(() => {
		const wantOpen = $searchOpen;
		const snap = $searchSnap;
		untrack(() => {
			if (snap !== lastSnap) {
				lastSnap = snap;
				snapShut();
			} else if (wantOpen) open();
			else close();
		});
	});

	function onCloseClick(e) {
		e.preventDefault();
		closeSearch();
	}

	/** What Tab can reach inside the overlay right now (result cards still fading in are `visibility: hidden`). */
	function tabbables() {
		return Array.prototype.filter.call(
			overlayEl.querySelectorAll('input, button, a[href]'),
			(el) => !el.disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
		);
	}

	/**
	 * Keep Tab and Shift+Tab inside the open dialog (it is aria-modal): the
	 * field, the close button, then the result cards, and round again.
	 */
	function trapTab(e) {
		const items = tabbables();
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		const inside = overlayEl.contains(active);
		if (e.shiftKey ? !inside || active === first : !inside || active === last) {
			e.preventDefault();
			(e.shiftKey ? last : first).focus();
		}
	}

	onMount(() => {
		// Let the overlay's own results list wheel-scroll while Lenis owns the
		// page — set at runtime exactly like the original js/wefeasto.js did.
		overlayEl.setAttribute('data-lenis-prevent', '');
		const onKey = (e) => {
			if (!isOpen) return;
			if (e.key === 'Escape' || e.key === 'Esc') closeSearch();
			else if (e.key === 'Tab') trapTab(e);
		};
		// Backstop for the trap: focus that still lands on the page behind the
		// open overlay (a card that turned hidden mid-Tab, a script) comes back.
		const onFocusIn = (e) => {
			if (!isOpen || hidden || overlayEl.contains(e.target)) return;
			const [first] = tabbables();
			if (first) first.focus();
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('focusin', onFocusIn);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('focusin', onFocusIn);
		};
	});
</script>

<div id="wf-search-overlay" class="wf-search-overlay" {hidden} role="dialog" aria-modal="true" aria-label="Search Wefeasto" bind:this={overlayEl}><div class="wf-search-inner" bind:this={innerEl}><div class="wf-search-bar"><input class="wf-search-input" type="text" placeholder="Search products &amp; recipes…" aria-label="Search products and recipes" autocomplete="off" bind:value={query} bind:this={inputEl} oninput={onInput}><button class="wf-search-close" type="button" aria-label="Close search" onclick={onCloseClick}>✕</button></div><div class="wf-search-results" aria-live="polite" bind:this={resultsEl}>{#if !hidden}{#if results.length === 0}<p class="wf-search-empty">No matches — try “muesli” or “oats”</p>{:else}{#each results as item (item.url)}<a class="wf-search-card" href={item.url}><span class="wf-search-card-media"><img src={item.image} loading="lazy" alt={item.label}></span><span class="wf-search-card-name">{item.label}</span><span class="wf-search-card-meta">{#if item.type === 'product'}<span class="wf-chip wf-chip-small">{chipText(item)}</span>{:else}<span class="wf-chip wf-chip-small">Recipe</span>{/if}<span class="wf-search-card-cat">{item.category}</span></span></a>{/each}{/if}{/if}</div></div></div>
