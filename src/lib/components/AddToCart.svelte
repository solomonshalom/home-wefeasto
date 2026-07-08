<script>
	/*
	 * "Add to Cart" button — port of the [data-wf-add] delegated handler
	 * (Cart.add + badge pop + transient "Added ✓" label swap).
	 */
	import { Cart } from '$lib/cart.js';

	let { slug, qtyInputId = null, extraClass = '' } = $props();

	let adding = $state(false);
	let label = $state('Add to Cart');

	const cls = $derived(['button', extraClass, 'w-inline-block'].filter(Boolean).join(' '));

	function onClick(e) {
		e.preventDefault();
		let qty = 1;
		if (qtyInputId) {
			const el = document.getElementById(qtyInputId);
			if (el) qty = Math.max(1, parseInt(el.value, 10) || 1);
		}
		Cart.add(slug, qty); // also pops the badge via the wf:cart-add event
		if (adding) return;
		adding = true;
		label = 'Added ✓';
		window.setTimeout(() => {
			label = 'Add to Cart';
			adding = false;
		}, 1400);
	}
</script>

<a href="#" class={cls} data-wf-add={slug} data-wf-qty-input={qtyInputId ? '#' + qtyInputId : undefined} data-wf-adding={adding ? '1' : undefined} onclick={onClick}><div>{label}</div></a>
