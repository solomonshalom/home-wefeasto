<script module>
	import { Cart } from '$lib/cart.js';
	import { soldOutIn } from '$lib/live.js';

	export const SOLD_OUT_LABEL = 'Sold out';

	/**
	 * What a click on the button does: add `qty` of `slug` unless the settled
	 * live catalog (`state` = `$liveCatalog`) says it's sold out. Before the
	 * first live load settles it adds as it always did; the server re-quotes
	 * every order, and the bag flags a line that sold out since.
	 * @param {string} slug
	 * @param {number} qty
	 * @param {string} source
	 * @param {import('$lib/live.js').LiveState} state
	 * @param {{ add: (slug: string, qty: number, opts: object) => unknown }} [cart]
	 * @returns {boolean} whether it added
	 */
	export function addFromButton(slug, qty, source, state, cart = Cart) {
		if (soldOutIn(state, slug)) return false;
		cart.add(slug, qty, { source }); // also pops the badge + opens the toast via wf:cart-add
		return true;
	}
</script>

<script>
	/*
	 * "Add to Cart" button — port of the [data-wf-add] delegated handler
	 * (Cart.add + badge pop + transient "Added ✓" label swap).
	 * `source` rides along on the wf:cart-add event ('pdp' | 'card' |
	 * 'recipe' | …) so the mini-bag toast and analytics know where the add
	 * came from. `label` overrides the resting text (the recipe rail's
	 * "Add Muesli · ₹250"); the default markup is unchanged.
	 *
	 * Live stock (SPEC §1, live-catalog.md §2): on mount it asks for the live
	 * catalog (memoized, one request per page for every button). Once that
	 * settles and the CMS has none of the product, the button reads
	 * `soldOutLabel`, carries aria-disabled="true" + data-wf-soldout, and a
	 * click adds nothing. It stays focusable (no `disabled`), so focus order
	 * and screen-reader discovery don't change. The prerendered and hydrated
	 * markup is always the snapshot's (ready is false until then).
	 *
	 * It acts, it never navigates: the Webflow `<a href="#">` (kept for the
	 * styles and every [data-wf-add] hook) is exposed as role="button" and
	 * works like one from the keyboard (WCAG 4.1.2, ARIA APG button): Enter
	 * adds (the link activation), and so does Space, on key-up like a native
	 * button, without scrolling the page.
	 */
	import { onMount } from 'svelte';
	import { liveCatalog, loadLive } from '$lib/live.js';

	let {
		slug,
		qtyInputId = null,
		extraClass = '',
		source = 'card',
		label: restLabel = 'Add to Cart',
		soldOutLabel = SOLD_OUT_LABEL
	} = $props();

	let adding = $state(false);
	let added = $state(false);
	const soldOut = $derived(soldOutIn($liveCatalog, slug));
	const label = $derived(soldOut ? soldOutLabel : added ? 'Added ✓' : restLabel);

	const cls = $derived(['button', extraClass, soldOut ? 'wf-soldout' : '', 'w-inline-block'].filter(Boolean).join(' '));

	onMount(() => {
		loadLive();
	});

	function onClick(e) {
		e.preventDefault();
		add();
	}

	const isSpace = (e) => e.key === ' ' || e.key === 'Spacebar';
	// A Space that went down on this button (a key-up alone, e.g. after
	// tabbing in with Space held, adds nothing: native buttons behave so).
	let spaceDown = false;

	function onKeydown(e) {
		if (!isSpace(e)) return;
		e.preventDefault(); // a button: Space must not scroll the page away
		spaceDown = true;
	}

	function onKeyup(e) {
		if (!isSpace(e)) return;
		e.preventDefault();
		if (!spaceDown) return;
		spaceDown = false;
		add();
	}

	function add() {
		let qty = 1;
		if (qtyInputId) {
			const el = document.getElementById(qtyInputId);
			if (el) qty = Math.max(1, parseInt(el.value, 10) || 1);
		}
		if (!addFromButton(slug, qty, source, $liveCatalog)) return;
		if (adding) return;
		adding = true;
		added = true;
		window.setTimeout(() => {
			added = false;
			adding = false;
		}, 1400);
	}
</script>

<!-- svelte-ignore a11y_invalid_attribute (a Webflow <a href="#"> kept for its styles and hooks; exposed as role="button") -->
<a href="#" role="button" class={cls} data-wf-add={slug} data-wf-qty-input={qtyInputId ? '#' + qtyInputId : undefined} data-wf-adding={adding ? '1' : undefined} data-wf-soldout={soldOut ? '' : undefined} aria-disabled={soldOut ? 'true' : undefined} onclick={onClick} onkeydown={onKeydown} onkeyup={onKeyup} onblur={() => (spaceDown = false)}><div>{label}</div></a>
