<script>
	import { onMount, tick } from 'svelte';
	import { Cart, cart, cartTotal } from '$lib/cart.js';
	import { formatINR } from '$lib/data/products.js';

	const FREE_DELIVERY = 499;

	let listEl;
	let mounted = $state(false);
	let rows = $state([]); // snapshot of {slug, product} in original render order
	let showEmpty = $state(false);

	let reduceMotion = false;
	function motionOK() {
		return typeof window.gsap !== 'undefined' && !reduceMotion;
	}

	const subtotal = $derived($cartTotal);
	const noteText = $derived(
		subtotal >= FREE_DELIVERY
			? 'Free delivery above ₹499 — yours is free!'
			: 'Free delivery above ₹499 — add ' + formatINR(FREE_DELIVERY - subtotal) + ' more'
	);

	function qtyOf(slug) {
		return parseInt($cart[slug], 10) || 0;
	}

	function setQty(slug, qty) {
		Cart.setQty(slug, Math.max(1, parseInt(qty, 10) || 1));
	}

	function onQtyChange(e, slug) {
		const v = Math.max(1, parseInt(e.target.value, 10) || 1);
		e.target.value = v;
		setQty(slug, v);
	}

	async function showEmptyState(animate) {
		showEmpty = true;
		await tick();
		if (animate && motionOK() && listEl && listEl.firstElementChild) {
			window.gsap.from(listEl.firstElementChild, { y: 24, autoAlpha: 0, duration: 0.7, ease: 'power3.out', clearProps: 'all' });
		}
	}

	function removeRow(e, slug) {
		e.preventDefault();
		const rowEl = e.currentTarget.closest('[data-wf-row]');
		Cart.remove(slug);
		const finish = () => {
			rows = rows.filter((r) => r.slug !== slug);
			if (!rows.length) showEmptyState(true);
		};
		if (motionOK() && rowEl) {
			window.gsap.to(rowEl, {
				height: 0,
				autoAlpha: 0,
				paddingTop: 0,
				paddingBottom: 0,
				borderBottomWidth: 0,
				duration: 0.45,
				ease: 'power2.inOut',
				onComplete: finish
			});
		} else {
			finish();
		}
	}

	onMount(async () => {
		try {
			reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch (e) {
			/* noop */
		}
		rows = Cart.items().filter((i) => i.product && i.qty > 0);
		mounted = true;
		if (!rows.length) {
			showEmptyState(true);
			return;
		}
		await tick();
		if (motionOK() && listEl) {
			window.gsap.from(listEl.querySelectorAll('.wf-cart-row, .wf-summary'), {
				y: 24,
				autoAlpha: 0,
				duration: 0.6,
				ease: 'power3.out',
				stagger: 0.06,
				clearProps: 'all'
			});
		}
	});
</script>

<svelte:head>
	<title>Wefeasto — Your Bag</title>
</svelte:head>

<div class="page-wrapper">
<div class="section"><div class="container">
<div class="wf-hero-stagger"><div class="wf-chip">Your Bag</div><div class="divider"></div><h1 class="heading-2">Almost breakfast time.</h1></div>
<div class="divider _42px mobile-24px"></div>
<div id="wf-cart-list" aria-live="polite" bind:this={listEl}><noscript><p class="p-large">Your bag needs JavaScript to display. Meanwhile, head back to the <a href="/shop">shop</a>.</p></noscript>{#if mounted}{#if showEmpty}<div class="wf-cart-empty"><h2 class="heading-2">Your bag is empty</h2><div class="divider _8px"></div><p class="p-large">Fill it with something crunchy, healthy and delicious — your mornings will thank you.</p><div class="divider _32px mobile-24px"></div><div class="wf-cart-empty-actions"><a href="/shop" class="button w-inline-block"><div>Shop Breakfast</div></a></div></div>{:else}<div class="wf-cart-layout"><div class="wf-cart-rows">{#each rows as row (row.slug)}{@const p = row.product}<div class="wf-cart-row" data-wf-row={row.slug}><a class="wf-cart-thumb" href={p.url} aria-label="View {p.name}" tabindex="-1"><img src={p.image} loading="lazy" alt={p.name}></a><div class="wf-cart-info"><a class="wf-cart-name" href={p.url}>{p.name}</a><div class="wf-cart-unit">{formatINR(p.price)}{p.packSize ? ' · ' + p.packSize : ''}</div></div><div class="wf-cart-qty"><div class="wf-qty"><button type="button" class="wf-qty-btn" data-wf-qty-minus aria-label="Decrease quantity of {p.name}" onclick={(e) => { e.preventDefault(); setQty(row.slug, qtyOf(row.slug) - 1); }}>−</button><input class="wf-qty-input" id="wf-qty-{row.slug}" type="number" value={qtyOf(row.slug)} min="1" aria-label="Quantity of {p.name}" onchange={(e) => onQtyChange(e, row.slug)}><button type="button" class="wf-qty-btn" data-wf-qty-plus aria-label="Increase quantity of {p.name}" onclick={(e) => { e.preventDefault(); setQty(row.slug, qtyOf(row.slug) + 1); }}>+</button></div></div><div class="wf-price wf-cart-line" data-wf-line>{formatINR(p.price * qtyOf(row.slug))}</div><button type="button" class="wf-cart-remove" aria-label="Remove {p.name} from bag" onclick={(e) => removeRow(e, row.slug)}>×</button></div>{/each}</div><div class="wf-summary" id="wf-cart-summary"><h3 class="wf-summary-heading">Order Summary</h3><div class="wf-summary-divider"></div><div class="wf-summary-row"><span>Subtotal</span><span data-wf-subtotal>{formatINR(subtotal)}</span></div><div class="wf-summary-note" data-wf-note>{noteText}</div><div class="wf-summary-divider"></div><div class="wf-summary-row wf-summary-total"><span>Total</span><span data-wf-total>{formatINR(subtotal)}</span></div><div class="wf-summary-actions"><a href="/checkout" class="button w-inline-block"><div>Proceed to Checkout</div></a><a href="/shop" class="button secondary w-inline-block"><div>Continue Shopping</div></a></div></div></div>{/if}{/if}</div>
</div></div>
</div>
