<script>
	/*
	 * Mini-bag toast (roadmap M4): after a wf:cart-add, a small card with what
	 * was added, the free-delivery meter + one-tap top-up (TopUp.svelte) and
	 * Checkout / View bag. Mounted once in +layout.svelte, outside
	 * .page-wrapper (its enter transform would trap a fixed child), z 1100:
	 * above the mobile nav (1050), below the search overlay and veil (9999).
	 *
	 * - Non-modal: no backdrop, no focus steal, no lenis.stop().
	 * - Not on /cart, /checkout or /order (their summaries update instead).
	 * - Auto-dismisses after 5 s; hover, focus inside and a press hold it open.
	 *   Esc closes it when focus is inside (focus goes back where it came from).
 * - The mobile menu (an aria-modal sheet at z 1050) closes it: opening the
 *   menu shuts the card (no focus restore; the sheet takes focus), and no
 *   card opens while the menu is up. Left open, the card sat on top of the
 *   sheet's entries: their taps landed on it, and a hover or press on it
 *   held it there (WCAG 2.4.11: focus on Account/Bag was hidden under it).
	 * - Rapid adds update the open card in place: quantities merge, the timer
	 *   restarts, the meter pulses. Any navigation closes it.
	 * - The message is mirrored into a visually hidden aria-live="polite"
	 *   region that exists from mount (a live region must predate its text):
	 *   it stays empty for LIVE_SETTLE_MS after it is inserted, so adds
	 *   replayed from before this mounted (and any in that first moment)
	 *   reach it as a change a screen reader announces, not as initial text.
	 *   Every add is spoken, even one whose words match what the region
	 *   already says (another press at the per-order cap): the region is
	 *   cleared and refilled RESAY_MS later, so it is a change again.
	 * - Motion: bublr notification tokens (in .2 s y 16→0 + fade,
	 *   cubic-bezier(0,0,.2,1); out .15 s cubic-bezier(.4,0,1,1)); zero under
	 *   ?nofx=1 / reduced motion via ms().
	 * - Weight: the layout loads this component when the browser is idle or
	 *   on the first add, and hands over the adds it saw before this mounted
	 *   (`replay`); `onready` tells it to stop queueing. The pricing half
	 *   (TopUp: $shared quote + the live overlay) is its own chunk, fetched the
	 *   same way, and reports the quote back.
	 * Client-only: nothing is prerendered.
	 */
	import { onMount, untrack } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { cart, CART_ADD_EVENT } from '$lib/cart.js';
	import { productBySlug } from '$lib/data/products.js';
	import { formatPaise } from '$shared/money.js';
	import { motionOK } from '$lib/fx.js';
	import { ms, EASE } from '$lib/motion.js';
	import { track } from '$lib/track.js';
	import { mobileNav } from '$lib/components/MobileNav.svelte';

	/** replay: [{detail, at, path}] queued by the layout before this mounted. */
	let { replay = [], onready = null } = $props();

	const SUPPRESS = ['/cart', '/checkout', '/order'];
	const DISMISS_MS = 5000;
	/** How long the empty live region sits in the page before it may speak. */
	const LIVE_SETTLE_MS = 150;
	/**
	 * Clear-then-refill gap for words the region already holds (the CDK
	 * LiveAnnouncer's 100 ms): long enough for the accessibility tree to see
	 * the empty region, so the same words read as new. A same-tick clear +
	 * refill can reach a screen reader as no change at all.
	 */
	const RESAY_MS = 100;

	let mounted = $state(false);
	/** The live region has been in the DOM long enough for assistive tech to register it. */
	let liveReady = $state(false);
	let open = $state(false);
	/** Units added while this card has been open, in order: [{slug, qty}]. */
	let added = $state([]);
	let lastSlug = $state(null);
	let capped = $state(null); // {slug, max} when the last add hit maxPerOrder
	let announce = $state(''); // what the live region says while the card is open
	let addSeq = $state(0); // bumped by every add the card takes
	let saidFor = 0; // the add `announce` was last written for
	let resay = null; // pending refill after a clear (RESAY_MS)

	let card = $state(null);
	let timer = null;
	const holds = new Set();
	let returnFocus = null;

	const path = $derived(page.url.pathname);
	const suppressed = $derived(SUPPRESS.some((p) => path === p || path.startsWith(p + '/')));

	/** TopUp.svelte, loaded on demand; it reports the bag's quote through onquote. */
	let TopUp = $state.raw(null);
	let q = $state(null);
	let topUpLoading = null;
	function loadTopUp() {
		topUpLoading ??= import('$lib/components/TopUp.svelte').then(
			(m) => (TopUp = m.default),
			() => (topUpLoading = null) // offline: try again on the next add
		);
		return topUpLoading;
	}
	const totalText = $derived(q && q.subtotalPaise > 0 ? formatPaise(q.totalPaise) : '');

	const units = $derived(added.reduce((a, l) => a + l.qty, 0));
	const single = $derived(added.length === 1 ? added[0] : null);
	const lead = $derived(productBySlug(lastSlug));
	const title = $derived.by(() => {
		if (capped && !units) return (productBySlug(capped.slug)?.name || 'This item') + ' ×' + capped.max;
		if (single) return (productBySlug(single.slug)?.name || single.slug) + ' ×' + single.qty;
		return units + ' items';
	});
	const tail = $derived(
		capped && !units
			? `is in your bag — ${capped.max} is the most we can send in one order`
			: capped
				? `added to your bag — ${capped.max} is the most per order`
				: 'added to your bag'
	);

	/* ---- timer: runs only while nothing holds the card open ---- */

	function arm() {
		window.clearTimeout(timer);
		timer = null;
		if (open && holds.size === 0) timer = window.setTimeout(() => close(), DISMISS_MS);
	}
	function hold(reason) {
		holds.add(reason);
		arm();
	}
	function release(reason) {
		holds.delete(reason);
		arm();
	}

	function close({ restoreFocus = false } = {}) {
		if (!open) return;
		// The card lingers for its out transition: let taps go through it now.
		if (card) card.style.pointerEvents = 'none';
		open = false;
		holds.clear();
		window.clearTimeout(timer);
		timer = null;
		if (restoreFocus && returnFocus && returnFocus.isConnected) {
			try {
				returnFocus.focus({ preventScroll: true });
			} catch (e) {
				/* noop */
			}
		}
		returnFocus = null;
		window.clearTimeout(resay);
		resay = null;
		announce = ''; // a later card starts from an empty region
	}

	function onAdd(e) {
		const d = e && e.detail;
		// Legacy events without detail (or with nothing added and no cap) don't open anything.
		if (!d || typeof d.slug !== 'string' || suppressed || mobileNav.open) return;
		const lines = Array.isArray(d.lines) ? d.lines : d.qty > 0 ? [{ slug: d.slug, qty: d.qty }] : [];
		if (!lines.length && !d.capped) return;

		const wasOpen = open;
		const next = wasOpen ? added.map((l) => ({ ...l })) : [];
		for (const l of lines) {
			const row = next.find((r) => r.slug === l.slug);
			if (row) row.qty += l.qty;
			else next.push({ slug: l.slug, qty: l.qty });
		}
		added = next;
		lastSlug = lines.length ? lines[lines.length - 1].slug : d.slug;
		capped = d.capped ? { slug: d.slug, max: d.inBag } : wasOpen ? capped : null;
		if (!wasOpen) {
			const active = document.activeElement;
			returnFocus = active && active !== document.body && !(card && card.contains(active)) ? active : null;
		}
		// A card reopened during its out transition is the same element: live again.
		if (card) card.style.pointerEvents = '';
		open = true;
		addSeq += 1;
		loadTopUp();
		arm();
		if (wasOpen && card && motionOK()) {
			window.gsap.fromTo(card, { scale: 0.98 }, { scale: 1, duration: 0.2, ease: 'power2.out', clearProps: 'transform' });
		}
	}

	// The live region text follows the card (and re-announces merges). A new
	// add whose words are already in the region (a repeat press at the cap)
	// clears it and refills it RESAY_MS later, so it is spoken again too.
	$effect(() => {
		if (!open) return;
		const msg = `${title} ${tail}.` + (totalText ? ` Bag total ${totalText}.` : '');
		const seq = addSeq;
		untrack(() => {
			window.clearTimeout(resay);
			resay = null;
			if (seq !== saidFor && msg === announce) {
				announce = '';
				resay = window.setTimeout(() => {
					resay = null;
					if (open) announce = msg;
				}, RESAY_MS);
			} else announce = msg;
			saidFor = seq;
		});
	});

	// The mobile menu opening (or a card somehow opening under an open menu)
	// closes the card at once.
	$effect(() => {
		if (open && mobileNav.open) untrack(() => close());
	});

	function onKeydown(e) {
		if (e.key === 'Escape' || e.key === 'Esc') {
			e.stopPropagation();
			close({ restoreFocus: true });
		}
	}

	function onFocusOut(e) {
		if (!card || !card.contains(e.relatedTarget)) release('focus');
	}

	function onPointerDown() {
		hold('press');
		const up = () => {
			window.removeEventListener('pointerup', up, true);
			window.removeEventListener('pointercancel', up, true);
			release('press');
		};
		window.addEventListener('pointerup', up, true);
		window.addEventListener('pointercancel', up, true);
	}

	function toastIn() {
		return { duration: ms(200), easing: EASE.enter, css: (t, u) => `opacity: ${t}; transform: translateY(${u * 16}px);` };
	}
	function toastOut() {
		return { duration: ms(150), easing: EASE.exit, css: (t, u) => `opacity: ${t}; transform: translateY(${u * 8}px);` };
	}

	afterNavigate((nav) => {
		if (nav.type === 'enter') return;
		close();
	});

	onMount(() => {
		mounted = true; // inserts the (empty) live region on this flush
		const settle = window.setTimeout(() => (liveReady = true), LIVE_SETTLE_MS);
		window.addEventListener(CART_ADD_EVENT, onAdd);
		// Adds the layout saw before this component existed (still on this page
		// and recent enough to matter), then take over.
		for (const r of replay.splice(0)) {
			if (r && r.path === window.location.pathname && Date.now() - r.at < DISMISS_MS) onAdd({ detail: r.detail });
		}
		if (onready) onready();
		// Fetch the pricing half while the browser is idle, so the first toast is complete at once.
		const idle = window.requestIdleCallback
			? window.requestIdleCallback(() => loadTopUp(), { timeout: 4000 })
			: window.setTimeout(() => loadTopUp(), 2500);
		return () => {
			window.removeEventListener(CART_ADD_EVENT, onAdd);
			window.clearTimeout(timer);
			window.clearTimeout(settle);
			window.clearTimeout(resay);
			if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
			else window.clearTimeout(idle);
		};
	});
</script>

{#if mounted}<div class="wf-sr-only" aria-live="polite" aria-atomic="true" data-wf-toast-live>{liveReady && open ? announce : ''}</div>{#if open}
<!-- The listeners only pause the auto-dismiss timer (hover, focus inside, press) and let Esc close the card; every action inside is a real button or link. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="wf-toast" role="region" aria-labelledby="wf-toast-title" data-wf-toast bind:this={card} in:toastIn out:toastOut onmouseenter={() => hold('hover')} onmouseleave={() => release('hover')} onfocusin={() => hold('focus')} onfocusout={onFocusOut} onpointerdown={onPointerDown} onkeydown={onKeydown}><div class="wf-toast-head">{#if lead}<img class="wf-toast-thumb" src={lead.image} alt="" width="48" height="48">{/if}<p class="wf-toast-title" id="wf-toast-title"><strong>{title}</strong> {tail}</p><button type="button" class="wf-toast-close" aria-label="Close" onclick={() => close({ restoreFocus: true })}>×</button></div>{#if TopUp}<TopUp bag={$cart} note onquote={(v) => (q = v)} />{/if}<div class="wf-toast-actions"><a href="/checkout" class="button w-inline-block" data-wf-toast-checkout onclick={() => track('toast_checkout_click', { totalPaise: q ? q.totalPaise : null })}><div>{totalText ? 'Checkout · ' + totalText : 'Checkout'}</div></a><a href="/cart" class="button secondary w-inline-block" data-wf-toast-bag><div>View bag</div></a></div></div>{/if}{/if}
