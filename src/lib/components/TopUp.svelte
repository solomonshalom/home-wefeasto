<script module>
	/* Dismissed top-up suggestions: never suggested again this tab session. */
	import { writable } from 'svelte/store';

	const TOPUP_DISMISSED_KEY = 'wefeasto_topup_dismissed';
	export const topUpDismissed = writable(readDismissed());

	function readDismissed() {
		if (typeof window === 'undefined') return [];
		try {
			const list = JSON.parse(window.sessionStorage.getItem(TOPUP_DISMISSED_KEY) || '[]');
			return Array.isArray(list) ? list.filter((s) => typeof s === 'string').slice(0, 20) : [];
		} catch (e) {
			return [];
		}
	}

	export function dismissTopUp(slug) {
		if (typeof slug !== 'string') return;
		topUpDismissed.update((list) => {
			const next = list.includes(slug) ? list : [...list, slug].slice(-20);
			try {
				window.sessionStorage.setItem(TOPUP_DISMISSED_KEY, JSON.stringify(next));
			} catch (e) {
				/* memory only */
			}
			return next;
		});
	}
</script>

<script>
	/*
	 * Free-delivery meter + one-tap top-up (roadmap M1), shared by the cart
	 * summary and the mini-bag toast. The suggestion is $shared
	 * topUpSuggestion() over the live catalog (snapshot until /api answers):
	 * never a sold-out SKU, never more than maxPerOrder, and nothing is ever
	 * added without a tap. "+ Add" adds exactly one unit (source 'topup');
	 * × asks for a different suggestion for the rest of this tab session.
	 * `onquote(q)` hands the whole $shared quote to the parent (the toast's
	 * Checkout total), so the pricing code only loads with this component.
	 */
	import { onMount } from 'svelte';
	import { Cart } from '$lib/cart.js';
	import { liveCatalog, loadLive, catalogForPricing } from '$lib/live.js';
	import { productBySlug } from '$lib/data/products.js';
	import { quote, topUpSuggestion, cartToItems } from '$shared/pricing.js';
	import { formatPaise } from '$shared/money.js';
	import { track } from '$lib/track.js';
	import FreeDeliveryMeter from '$lib/components/FreeDeliveryMeter.svelte';
	import { keepFocus } from '$lib/focus.js';

	let { bag = {}, note = false, onquote = null } = $props();

	// catalogForPricing() reads live.js state; reading $liveCatalog makes it reactive.
	const catalog = $derived.by(() => {
		$liveCatalog;
		return catalogForPricing();
	});
	const settings = $derived($liveCatalog.settings);
	const q = $derived(quote({ items: cartToItems(bag), catalog, settings }));
	const suggestion = $derived(topUpSuggestion(bag, catalog, settings, { exclude: $topUpDismissed }));
	const thumb = $derived(suggestion ? productBySlug(suggestion.slug) : null);

	const noteText = $derived(
		q.isFreeDelivery
			? 'Free delivery unlocked — yours is free!'
			: formatPaise(q.amountToFreeDeliveryPaise) + ' away from free delivery'
	);
	const valuetext = $derived(
		q.isFreeDelivery ? 'Free delivery unlocked' : formatPaise(q.amountToFreeDeliveryPaise) + ' to go for free delivery'
	);

	$effect(() => {
		if (onquote) onquote(q);
	});

	onMount(() => {
		loadLive(); // memoized: fresh prices, stock and settings for the meter and the suggestion
	});

	let block = $state(null);

	/*
	 * + Add that reaches free delivery, or × on the last suggestion, unmounts
	 * the row with its focused button: focus stays in this block, on the note
	 * (the toast) or the meter, which say where free delivery stands now. In
	 * the toast that also keeps its focus hold (no auto-dismiss under the user).
	 */
	const focusTargets = () => [block?.querySelector('[data-wf-topup-note]'), block?.querySelector('.wf-meter'), block];

	function add(e) {
		e.preventDefault();
		if (!suggestion) return;
		const { slug } = suggestion;
		keepFocus(
			e.currentTarget.closest('.wf-topup'),
			() => {
				track('topup_add', { slug });
				Cart.add(slug, 1, { source: 'topup' });
			},
			focusTargets
		);
	}

	function skip(e) {
		e.preventDefault();
		if (!suggestion) return;
		const { slug } = suggestion;
		keepFocus(e.currentTarget.closest('.wf-topup'), () => dismissTopUp(slug), focusTargets);
	}
</script>

{#if q.subtotalPaise > 0}<div class="wf-topup-block" bind:this={block}>{#if note}<div class="wf-topup-note" data-wf-topup-note>{noteText}</div>{/if}<FreeDeliveryMeter progress={q.freeDeliveryProgress} {valuetext} />{#if suggestion}<div class="wf-topup" data-wf-topup={suggestion.slug}>{#if thumb}<img class="wf-topup-thumb" src={thumb.image} alt="" width="40" height="40" loading="lazy">{/if}<p class="wf-topup-text">Add <strong>{suggestion.name} · {formatPaise(suggestion.pricePaise)}</strong>{suggestion.crosses ? ' → free delivery' : ' · then ' + formatPaise(suggestion.remainingAfterPaise) + ' to go'}</p><button type="button" class="wf-chip wf-topup-add" aria-label="Add one {suggestion.name} for {formatPaise(suggestion.pricePaise)}" onclick={add}>+ Add</button><button type="button" class="wf-topup-skip" aria-label="Suggest something else" title="Suggest something else" onclick={skip}>×</button></div>{/if}</div>{/if}
