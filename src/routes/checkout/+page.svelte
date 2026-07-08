<script>
	import { onMount, tick } from 'svelte';
	import { Cart, cartItems, cartTotal } from '$lib/cart.js';
	import { formatINR } from '$lib/data/products.js';

	const FREE_DELIVERY = 499;

	let mounted = $state(false);
	let formEl;
	let headerEl;
	let thanksEl;
	let payMethod = $state('upi');
	let placed = $state(false);
	let submitDisabled = $state(false);
	let hideFormNow = $state(false);
	let thanksHidden = $state(true);
	let orderNo = $state('Order #WF-0000');

	let reduceMotion = false;
	function motionOK() {
		return typeof window.gsap !== 'undefined' && !reduceMotion;
	}

	const items = $derived($cartItems.filter((i) => i.product && i.qty > 0));
	const subtotal = $derived($cartTotal);
	const note = $derived(
		subtotal >= FREE_DELIVERY
			? 'Free delivery above ₹499 — yours is free!'
			: 'Free delivery above ₹499 — add ' + formatINR(FREE_DELIVERY - subtotal) + ' more'
	);

	function clearCart() {
		Cart.items().forEach((i) => Cart.remove(i.slug));
	}

	async function reveal() {
		hideFormNow = true;
		thanksHidden = false;
		clearCart();
		await tick();
		if (thanksEl && motionOK()) {
			window.gsap.from(thanksEl.children, {
				y: 26,
				autoAlpha: 0,
				duration: 0.7,
				ease: 'power3.out',
				stagger: 0.08,
				clearProps: 'all'
			});
		}
		try {
			window.scrollTo(0, 0);
		} catch (err) {
			/* noop */
		}
	}

	function onSubmit(e) {
		e.preventDefault();
		if (placed) return;
		if (!formEl.checkValidity()) {
			if (formEl.reportValidity) formEl.reportValidity();
			return;
		}
		placed = true;
		submitDisabled = true;
		orderNo = 'Order #WF-' + String(Math.floor(1000 + Math.random() * 9000));
		if (motionOK()) {
			window.gsap
				.timeline({ onComplete: reveal })
				.to([headerEl, formEl].filter(Boolean), { y: -24, autoAlpha: 0, duration: 0.45, ease: 'power2.in', stagger: 0.06 });
		} else {
			reveal();
		}
	}

	onMount(() => {
		try {
			reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch (e) {
			/* noop */
		}
		mounted = true;
	});
</script>

<svelte:head>
	<title>Wefeasto — Checkout</title>
</svelte:head>

<div class="page-wrapper">
<div class="section"><div class="container">
<div class="wf-hero-stagger" id="wf-co-header" bind:this={headerEl} style={hideFormNow ? 'display: none;' : undefined}><div class="wf-chip">Checkout</div><div class="divider"></div><h1 class="heading-2">Where should breakfast go?</h1></div>
<div class="divider _42px mobile-24px"></div>
<form id="wf-checkout-form" class="wf-co-grid" novalidate bind:this={formEl} style={hideFormNow ? 'display: none;' : undefined} onsubmit={onSubmit}>
<div class="wf-co-form">
<div class="wf-field"><label class="wf-label" for="wf-co-name">Full Name</label><input class="wf-input" id="wf-co-name" name="fullName" type="text" placeholder="Asha Kumar" autocomplete="name" required></div>
<div class="wf-field"><label class="wf-label" for="wf-co-phone">Phone</label><input class="wf-input" id="wf-co-phone" name="phone" type="tel" placeholder="+91 98452 62777" autocomplete="tel" required></div>
<div class="wf-field"><label class="wf-label" for="wf-co-address">Address</label><textarea class="wf-textarea" id="wf-co-address" name="address" rows="3" placeholder="Flat, street, landmark" autocomplete="street-address" required></textarea></div>
<div class="wf-co-two">
<div class="wf-field"><label class="wf-label" for="wf-co-city">City</label><input class="wf-input" id="wf-co-city" name="city" type="text" placeholder="Bengaluru" autocomplete="address-level2" required></div>
<div class="wf-field"><label class="wf-label" for="wf-co-pin">PIN Code</label><input class="wf-input" id="wf-co-pin" name="pin" type="text" inputmode="numeric" pattern={'[0-9]{6}'} maxlength="6" placeholder="560001" autocomplete="postal-code" title="6-digit PIN code" required></div>
</div>
<div class="divider _8px"></div>
<h3 class="wf-co-subhead">Payment</h3>
<div class="wf-pay-pills" role="radiogroup" aria-label="Payment method">
<label class="wf-pay-pill"><input type="radio" name="wf-pay" value="upi" bind:group={payMethod}>UPI</label>
<label class="wf-pay-pill"><input type="radio" name="wf-pay" value="card" bind:group={payMethod}>Card</label>
<label class="wf-pay-pill"><input type="radio" name="wf-pay" value="cod" bind:group={payMethod}>Cash on Delivery</label>
</div>
<div class="wf-pay-panel" id="wf-pay-upi" hidden={payMethod !== 'upi'}>
<div class="wf-field"><label class="wf-label" for="wf-co-upi">UPI ID</label><input class="wf-input" id="wf-co-upi" name="upiId" type="text" placeholder="yourname@upi"></div>
</div>
<div class="wf-pay-panel" id="wf-pay-card" hidden={payMethod !== 'card'}>
<div class="wf-field"><label class="wf-label" for="wf-co-card-number">Card Number</label><input class="wf-input" id="wf-co-card-number" name="cardNumber" type="text" inputmode="numeric" placeholder="4242 4242 4242 4242"></div>
<div class="wf-field"><label class="wf-label" for="wf-co-card-name">Name on Card</label><input class="wf-input" id="wf-co-card-name" name="cardName" type="text" placeholder="ASHA KUMAR"></div>
<div class="wf-co-two">
<div class="wf-field"><label class="wf-label" for="wf-co-card-exp">Expiry</label><input class="wf-input" id="wf-co-card-exp" name="cardExpiry" type="text" placeholder="MM/YY" maxlength="5"></div>
<div class="wf-field"><label class="wf-label" for="wf-co-card-cvv">CVV</label><input class="wf-input" id="wf-co-card-cvv" name="cardCvv" type="password" inputmode="numeric" placeholder="•••" maxlength="4"></div>
</div>
</div>
<div class="wf-form-note"><small>Prototype — no real payment is processed.</small></div>
<div class="divider _32px mobile-24px"></div>
<button type="submit" class="button w-button" id="wf-place-order" disabled={submitDisabled || undefined}>Place Order</button>
</div>
<div class="wf-summary" id="wf-co-summary">
<h3 class="wf-summary-heading">Order Summary</h3>
<div class="wf-summary-divider"></div>
{#if !mounted}
<p class="p-large">Loading your bag…</p>
{:else if !items.length}
<p class="p-large">Your bag is empty — add something tasty first.</p>
<div class="divider"></div>
<a href="/shop" class="button secondary w-inline-block"><div>Browse the Shop</div></a>
{:else}
{#each items as i (i.slug)}
<div class="wf-summary-row"><span>{i.product.name} × {i.qty}</span><span>{formatINR(i.product.price * i.qty)}</span></div>
{/each}
<div class="wf-summary-divider"></div>
<div class="wf-summary-row"><span>Subtotal</span><span>{formatINR(subtotal)}</span></div>
<div class="wf-summary-note">{note}</div>
<div class="wf-summary-divider"></div>
<div class="wf-summary-row wf-summary-total"><span>Total</span><span>{formatINR(subtotal)}</span></div>
{/if}
</div>
</form>
<div class="wf-co-thanks" id="wf-co-thanks" hidden={thanksHidden} bind:this={thanksEl}>
<h2 class="heading-2">Order confirmed 🎉</h2>
<div class="divider"></div>
<div class="wf-chip" id="wf-co-order-no">{orderNo}</div>
<div class="divider"></div>
<p class="p-large">Thank you! This is a design prototype — UPI payments arrive in Phase 2.</p>
<div class="divider _32px mobile-24px"></div>
<div class="wf-co-actions">
<a href="/" class="button w-inline-block"><div>Back to Home</div></a>
<a href="/recipes" class="button secondary w-inline-block"><div>Browse Recipes</div></a>
</div>
</div>
</div></div>
</div>
