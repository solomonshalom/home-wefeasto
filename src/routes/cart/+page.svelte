<script>
	/*
	 * The bag. Client-rendered (the cart lives in localStorage); without JS a
	 * <noscript> note points back to the shop.
	 * - Honest totals (roadmap M1): Subtotal, Delivery (FREE or the fee), the
	 *   free-delivery note + meter + one-tap top-up, Total = subtotal + fee —
	 *   all from $shared quote() over the live catalog (snapshot until /api
	 *   answers). Lines with a stock problem are flagged and left out of the
	 *   totals, exactly as the server will do.
	 * - Remove → inline "Removed Muesli · Undo" in the row's place for 6 s (S4).
	 *   The undo row is .wf-cart-undo only, never .wf-cart-row, so counting
	 *   .wf-cart-row (legacy selectors, the port's regression tools) still
	 *   counts bag lines.
	 * - /cart?add=slug:qty,… deep links (M5): parsed in onMount only, so link
	 *   previews never touch a cart. The bag is topped up to at least the linked
	 *   quantities (opening the link twice or refreshing adds nothing more),
	 *   then add/src/offer are stripped from the URL. &src= is kept per tab
	 *   for attribution. /cart?offer=CODE stores a 30-day link offer shown as a
	 *   removable chip; the server validates it at checkout (S6).
	 * - Reacts to qty changes, the top-up and other tabs (storage events).
	 * - Keyboard focus never falls to <body> (WCAG 2.4.3, $lib/focus.js): an
	 *   expiring undo row or a removed offer chip hands focus to a neighbour,
	 *   and "+" at the per-order cap stays focusable (aria-disabled, no-op).
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { Cart, cart, saveOffer, readOffer, clearOffer, rememberSource } from '$lib/cart.js';
	import { productBySlug } from '$lib/data/products.js';
	import { liveCatalog, loadLive, catalogForPricing } from '$lib/live.js';
	import { motionOK } from '$lib/fx.js';
	import { keepFocus, firstTabbable } from '$lib/focus.js';
	import { quote, cartToItems } from '$shared/pricing.js';
	import { formatPaise } from '$shared/money.js';
	import { parseAddParam, parseSrcParam } from '$shared/cart-links.js';
	import { checkoutErrorCopy } from '$shared/errors.js';
	import TopUp from '$lib/components/TopUp.svelte';
	import YourUsual from '$lib/components/YourUsual.svelte';
	import PendingOrderBanner from '$lib/components/PendingOrderBanner.svelte';

	const UNDO_MS = 6000;
	const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

	let listEl;
	let mounted = $state(false);
	/** Rows in display order: {slug, removing?, frozenQty?, removed?: {qty, index, until}} */
	let rows = $state([]);
	let linkNote = $state(null); // {added: string, problems: string[]}
	let offer = $state(null);
	let offerNote = $state('');
	const undoTimers = new Map();

	const catalog = $derived.by(() => {
		$liveCatalog;
		return catalogForPricing();
	});
	const bySlug = $derived($liveCatalog.bySlug);
	const q = $derived(quote({ items: cartToItems($cart), catalog, settings: $liveCatalog.settings }));
	const issues = $derived(new Map(q.issues.map((i) => [i.slug, i])));

	const liveRows = $derived(rows.filter((r) => !r.removed));
	const undoRows = $derived(rows.filter((r) => r.removed));
	const showEmpty = $derived(mounted && liveRows.length === 0);

	const threshold = $derived(formatPaise(q.freeDeliveryThresholdPaise));
	const noteText = $derived(
		q.isFreeDelivery
			? 'Free delivery above ' + threshold + ' — yours is free!'
			: 'Free delivery above ' + threshold + ' — add ' + formatPaise(q.amountToFreeDeliveryPaise) + ' more'
	);
	const deliveryText = $derived(q.isFreeDelivery ? 'FREE' : formatPaise(q.deliveryPaise));

	function qtyOf(row) {
		return row.removing ? row.frozenQty : hasOwn($cart, row.slug) ? $cart[row.slug] : 0;
	}
	function capOf(slug) {
		return Math.min(bySlug[slug]?.maxPerOrder || 10, 20);
	}
	function unitPaise(slug) {
		return bySlug[slug]?.pricePaise ?? Math.round((productBySlug(slug)?.price || 0) * 100);
	}

	function setQty(slug, qty) {
		Cart.setQty(slug, Math.min(Math.max(1, parseInt(qty, 10) || 1), capOf(slug)));
	}

	function onQtyChange(e, slug) {
		const v = Math.min(Math.max(1, parseInt(e.target.value, 10) || 1), capOf(slug));
		e.target.value = v;
		setQty(slug, v);
	}

	/* ---------------- rows ⇄ bag (qty edits, top-up, other tabs) ---------------- */

	function syncRows(c) {
		let changed = false;
		const next = [];
		for (const r of rows) {
			const inBag = hasOwn(c, r.slug);
			if (r.removed && inBag) {
				// Undo, or another tab put it back: the row returns in its place.
				window.clearTimeout(undoTimers.get(r.slug));
				undoTimers.delete(r.slug);
				next.push({ slug: r.slug });
				changed = true;
			} else if (!r.removed && !r.removing && !inBag) {
				changed = true; // removed elsewhere (another tab): no undo offered here
			} else {
				next.push(r);
			}
		}
		for (const slug of Object.keys(c)) {
			if (!next.some((r) => r.slug === slug)) {
				next.push({ slug });
				changed = true;
			}
		}
		if (changed) rows = next;
	}

	$effect(() => {
		const c = $cart;
		if (!mounted) return;
		untrack(() => syncRows(c));
	});

	/* ---------------- remove + undo (S4) ---------------- */

	function removeRow(e, slug) {
		e.preventDefault();
		const rowEl = e.currentTarget.closest('[data-wf-row]');
		const row = rows.find((r) => r.slug === slug);
		if (!row || row.removing || row.removed) return;
		const qty = hasOwn($cart, slug) ? $cart[slug] : 0;
		const index = Object.keys($cart).indexOf(slug);
		row.frozenQty = qty;
		row.removing = true;
		Cart.remove(slug);
		const finish = async () => {
			const r = rows.find((x) => x.slug === slug);
			if (!r || !r.removing) return;
			r.removing = false;
			r.removed = { qty, index, name: productBySlug(slug)?.name || slug };
			undoTimers.set(
				slug,
				window.setTimeout(() => expireUndo(slug), UNDO_MS)
			);
			await tick();
			// Keyboard users keep their place: focus lands on this row's Undo.
			document.querySelector(`[data-wf-undo="${slug}"] button`)?.focus({ preventScroll: true });
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

	function expireUndo(slug) {
		undoTimers.delete(slug);
		// Focus was put on this Undo on purpose (removeRow). When the row goes and
		// focus is still on it, the keyboard user stays in the list: the next
		// line (or undo row), else the previous one, else the summary / empty-bag
		// heading. The 6 s window itself is the contract (cart.md S4).
		const el = listEl?.querySelector(`[data-wf-undo="${slug}"]`);
		const next = el?.nextElementSibling;
		const prev = el?.previousElementSibling;
		keepFocus(
			el,
			() => (rows = rows.filter((r) => !(r.slug === slug && r.removed))),
			() => [firstTabbable(next), firstTabbable(prev), ...bagHeadings()]
		);
	}

	/** Stable headings of the bag, most specific first (focus targets when a control goes away). */
	function bagHeadings() {
		return [listEl?.querySelector('.wf-summary-heading'), listEl?.querySelector('.wf-cart-empty h2'), document.querySelector('.wf-hero-stagger h1')];
	}

	async function undo(slug) {
		const r = rows.find((x) => x.slug === slug && x.removed);
		if (!r) return;
		Cart.restore(slug, r.removed.qty, r.removed.index); // the $cart effect turns the row back
		await tick();
		document.querySelector(`[data-wf-row="${slug}"] .wf-cart-remove`)?.focus({ preventScroll: true });
	}

	/* ---------------- empty state entrance ---------------- */

	let wasEmpty = false;
	$effect(() => {
		const empty = showEmpty;
		if (empty && !wasEmpty) {
			tick().then(() => {
				const el = listEl && listEl.querySelector('.wf-cart-empty');
				if (el && motionOK()) {
					// opacity, not autoAlpha: visibility:hidden would blur the Undo that
					// removeRow just focused inside the empty bag (focus → <body>).
					window.gsap.from(el, { y: 24, opacity: 0, duration: 0.7, ease: 'power3.out', clearProps: 'all' });
				}
			});
		}
		wasEmpty = empty;
	});

	/* ---------------- deep links: ?add= / &src= / ?offer= ---------------- */

	const REASON = {
		OUT_OF_STOCK: (n) => `${n} is out of stock right now`,
		UNKNOWN: (n) => `we couldn’t find “${n}”`,
		BAD_QTY: (n) => `the quantity for ${n} didn’t look right`,
		TOO_MANY: (n) => `${n} didn’t fit — a link can add up to 6 products`
	};

	function applyLink(params) {
		const add = params.get('add');
		if (add !== null) {
			const src = parseSrcParam(params.get('src')) || 'link';
			rememberSource(params.get('src')); // per tab, for the order's source (async, best-effort)
			const { lines, dropped } = parseAddParam(add, catalogForPricing());
			// "At least" merge: top the bag up to the linked quantities, so a
			// second open of the same link (or a refresh) adds nothing more.
			const bag = Cart.read();
			const want = lines.map((l) => ({ slug: l.slug, qty: l.qty - (hasOwn(bag, l.slug) ? bag[l.slug] : 0) })).filter((l) => l.qty > 0);
			const { added } = want.length ? Cart.addMany(want, { source: src }) : { added: [] };
			const name = (slug) => productBySlug(slug)?.name || slug;
			const problems = dropped.map((d) => (REASON[d.reason] || REASON.UNKNOWN)(d.name));
			const addedText = added.length
				? 'Added from your link: ' + added.map((l) => `${name(l.slug)} ×${l.qty}`).join(', ') + '.'
				: lines.length
					? 'Everything from your link is already in your bag.'
					: '';
			if (addedText || problems.length) linkNote = { added: addedText, problems };
		}
		const offerRaw = params.get('offer');
		if (add !== null || params.has('src') || offerRaw !== null) {
			const url = new URL(window.location.href);
			url.searchParams.delete('add');
			url.searchParams.delete('src');
			url.searchParams.delete('offer');
			try {
				replaceState(url, page.state);
			} catch (e) {
				// Before the router has started (dev only): keep SvelteKit's history state.
				history.replaceState(history.state, '', url);
			}
		}
	}

	/** Store ?offer= (if any), then show whatever offer is on file. */
	async function applyOffer(offerRaw) {
		if (offerRaw !== null && !(await saveOffer(offerRaw))) {
			offerNote = 'That offer link doesn’t look right — nothing was applied.';
		}
		offer = await readOffer();
	}

	function removeOffer(e) {
		e.preventDefault();
		// The chip (and its focused ×) unmounts: keyboard focus goes to the summary heading.
		keepFocus(
			e.currentTarget.closest('[data-wf-offer]'),
			() => {
				clearOffer();
				offer = null;
			},
			bagHeadings
		);
	}

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		applyLink(params);
		applyOffer(params.get('offer'));
		rows = Object.keys(Cart.read()).map((slug) => ({ slug }));
		mounted = true;
		loadLive();
		if (rows.length) {
			tick().then(() => {
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
		}
		// Leaving the page commits pending removals (nothing to write: the bag already changed).
		return () => undoTimers.forEach((t) => window.clearTimeout(t));
	});
</script>

<svelte:head>
	<title>Wefeasto — Your Bag</title>
</svelte:head>

{#snippet undoRow(r)}<div class="wf-cart-undo" data-wf-undo={r.slug}><p class="wf-cart-undo-text">Removed {r.removed.name}{r.removed.qty > 1 ? ' ×' + r.removed.qty : ''}</p><button type="button" class="wf-chip wf-cart-undo-btn" onclick={() => undo(r.slug)}>Undo</button></div>{/snippet}

<div class="page-wrapper">
<div class="section"><div class="container">
<PendingOrderBanner />
<div class="wf-hero-stagger"><div class="wf-chip">Your Bag</div><div class="divider"></div><h1 class="heading-2">Almost breakfast time.</h1></div>
<div class="divider _42px mobile-24px"></div>
<div id="wf-cart-list" aria-live="polite" bind:this={listEl}><noscript><p class="p-large">Your bag needs JavaScript to display. Meanwhile, head back to the <a href="/shop">shop</a>.</p></noscript>{#if mounted}{#if linkNote || offerNote}<div class="wf-cart-notes" role="status">{#if linkNote?.added}<p class="wf-form-note" data-wf-link-note>{linkNote.added}</p>{/if}{#if linkNote?.problems.length}<p class="wf-form-note" data-wf-link-dropped>Skipped: {linkNote.problems.join('; ')}.</p>{/if}{#if offerNote}<p class="wf-form-note" data-wf-offer-note>{offerNote}</p>{/if}</div>{/if}{#if showEmpty}<div class="wf-cart-empty">{#if undoRows.length}<div class="wf-cart-undo-stack">{#each undoRows as r (r.slug)}{@render undoRow(r)}{/each}</div>{/if}<h2 class="heading-2">Your bag is empty</h2><div class="divider _8px"></div><p class="p-large">Fill it with something crunchy, healthy and delicious — your mornings will thank you.</p><div class="divider _32px mobile-24px"></div><YourUsual variant="cart" /><div class="wf-cart-empty-actions"><a href="/shop" class="button w-inline-block"><div>Shop Breakfast</div></a></div></div>{:else}<div class="wf-cart-layout"><div class="wf-cart-rows">{#each rows as row (row.slug)}{#if row.removed}{@render undoRow(row)}{:else}{@const p = productBySlug(row.slug)}{@const n = qtyOf(row)}{@const issue = issues.get(row.slug)}<div class="wf-cart-row" data-wf-row={row.slug}><a class="wf-cart-thumb" href={p.url} aria-label="View {p.name}" tabindex="-1"><img src={p.image} loading="lazy" alt={p.name}></a><div class="wf-cart-info"><a class="wf-cart-name" href={p.url}>{p.name}</a><div class="wf-cart-unit">{formatPaise(unitPaise(row.slug))}{p.packSize ? ' · ' + p.packSize : ''}</div>{#if issue && !row.removing}<p class="wf-cart-issue" data-wf-issue={issue.code}>{checkoutErrorCopy(issue.code, issue)}</p>{/if}</div><div class="wf-cart-qty"><div class="wf-qty"><button type="button" class="wf-qty-btn" data-wf-qty-minus aria-label="Decrease quantity of {p.name}" onclick={(e) => { e.preventDefault(); setQty(row.slug, n - 1); }}>−</button><input class="wf-qty-input" id="wf-qty-{row.slug}" type="number" value={n} min="1" max={capOf(row.slug)} aria-label="Quantity of {p.name}" onchange={(e) => onQtyChange(e, row.slug)}><button type="button" class="wf-qty-btn" data-wf-qty-plus aria-label="Increase quantity of {p.name}" aria-disabled={n >= capOf(row.slug) ? 'true' : undefined} title={n >= capOf(row.slug) ? capOf(row.slug) + ' is the most per order' : undefined} onclick={(e) => { e.preventDefault(); if (n < capOf(row.slug)) setQty(row.slug, n + 1); }}>+</button></div></div><div class="wf-price wf-cart-line" data-wf-line>{formatPaise(unitPaise(row.slug) * n)}</div><button type="button" class="wf-cart-remove" aria-label="Remove {p.name} from bag" onclick={(e) => removeRow(e, row.slug)}>×</button></div>{/if}{/each}</div><div class="wf-summary" id="wf-cart-summary"><h3 class="wf-summary-heading">Order Summary</h3><div class="wf-summary-divider"></div><div class="wf-summary-row"><span>Subtotal</span><span data-wf-subtotal>{formatPaise(q.subtotalPaise)}</span></div><div class="wf-summary-row"><span>Delivery</span><span data-wf-delivery class:wf-free={q.isFreeDelivery}>{deliveryText}</span></div><div class="wf-summary-note" data-wf-note>{noteText}</div><TopUp bag={$cart} />{#if offer}<div class="wf-offer" data-wf-offer={offer.code}><p class="wf-offer-text"><span class="wf-chip wf-chip-small">Offer {offer.code}</span> <span>will be applied at checkout</span></p><button type="button" class="wf-offer-remove" aria-label="Remove offer {offer.code}" onclick={removeOffer}>×</button></div>{/if}<div class="wf-summary-divider"></div><div class="wf-summary-row wf-summary-total"><span>Total</span><span data-wf-total>{formatPaise(q.totalPaise)}</span></div><div class="wf-summary-actions"><a href="/checkout" class="button w-inline-block"><div>Proceed to Checkout</div></a><a href="/shop" class="button secondary w-inline-block"><div>Continue Shopping</div></a></div></div></div>{/if}{/if}</div>
</div></div>
</div>
