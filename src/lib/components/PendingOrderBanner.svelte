<script>
	/*
	 * Pending-order recovery (roadmap M2 §11), on /cart and /checkout: when
	 * wefeasto_pending holds an online order from the last 7 days, one line at
	 * the top of the page — "Your order WF-10423 is waiting for payment ·
	 * [Check status]". Check status polls GET /api/store/orders/status (every
	 * 3 s, 5 times):
	 *   confirmed            → /order?no=&t= (which does the bag subtraction)
	 *   still pending/failed → [Retry payment] (a fresh Razorpay order for the
	 *                          same order) — plus [Pay on delivery instead]
	 *                          when a COD checkout is sure to supersede it
	 *                          (canSwitchToCod: same bag, last 25 minutes, or
	 *                          an expired order; checkout-backend.md §1.2) AND
	 *                          COD is available for the bag (`codAvailable`
	 *                          from the host page, else the server quote via
	 *                          cod-check.js). On /checkout that switches the
	 *                          form (`onpayondelivery`), elsewhere it links to
	 *                          /checkout?pay=cod, which prefills the details
	 *                          the order was placed with (same phone).
	 *   cancelled / refunded / unknown order or token → forgotten, banner gone
	 *   needs_review         → a link to /order
	 * Client-only; with storage unavailable it never shows (recovery is then
	 * the confirmation email).
	 * "Not now" (stuck view) only hides the banner on this page: the order
	 * stays in wefeasto_pending. × hides it on this device for good
	 * (quietPending) but keeps the entry as the supersede ref: it is the
	 * device's only proof the unpaid order is the customer's (SUP-OWN-1), so
	 * checking the same bag out again replaces that order instead of being
	 * refused "That offer is for your first order only" over their own order.
	 */
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api.js';
	import { cart } from '$lib/cart.js';
	import { cartSignature } from '$shared/cart-links.js';
	import { cartToItems } from '$shared/pricing.js';
	import { readPending, clearPending, quietPending, readPendingForm } from '$lib/checkout/storage.js';
	import { fetchStatus, viewFor, orderUrl, canSwitchToCod } from '$lib/checkout/order.js';
	import { browserFlow, browserCodCheck, safeGoto, preloadOrderPage } from '$lib/checkout/browser.js';
	import { BUSY, busyLabel } from '$lib/checkout/flow.js';
	import { whatsappLink, orderHelpText } from '$lib/support.js';
	import { keepFocus, focusLost, focusWithin } from '$lib/focus.js';
	import Spinner from '$lib/components/Spinner.svelte';
	import CheckoutNote from '$lib/components/CheckoutNote.svelte';

	const CHECK_POLLS = 5;
	const CHECK_EVERY_MS = 3000;

	/**
	 * hideNo: hide the banner for this order number (the checkout page's own order).
	 * onpayondelivery: the checkout page's own "switch to COD" (null → a link to /checkout?pay=cod).
	 * codAvailable: the host page's own COD answer for the bag (/checkout knows it); null → ask the server.
	 */
	let { hideNo = null, onpayondelivery = null, codAvailable = null } = $props();

	let pending = $state(null);
	let view = $state('idle'); // idle | checking | stuck | review | leaving
	let lastStatus = $state(null);
	let lastDto = $state(null);
	let hidden = $state(false); // "Pay on delivery instead" or "Not now" picked on this page
	let el = $state(null);
	let noteEl = $state(null);
	let alive = true;

	const flow = browserFlow();
	const fs = flow.state;
	const busy = $derived(BUSY.includes($fs.phase));
	const shown = $derived(!!pending && pending.no !== hideNo && !hidden);
	const bagItems = $derived(cartToItems($cart));
	const bagSig = $derived(cartSignature(bagItems));
	const switchable = $derived(view === 'stuck' && !!lastDto && canSwitchToCod(lastDto, bagSig));
	// COD for this bag? The host page's answer, else one server quote per bag (+ the PIN this tab knows).
	const codCheck = browserCodCheck();
	let codAnswer = $state({ key: null, ok: false });
	const codPin = $derived(pending ? readPendingForm(pending.no)?.pin || null : null);
	const codKey = $derived(switchable && codAvailable === null ? bagSig + '|' + (codPin ?? '') : null);
	$effect(() => {
		const key = codKey;
		if (!key) return;
		codCheck.check(key, { items: bagItems, pin: codPin }).then((ok) => {
			if (alive) codAnswer = { key, ok };
		});
	});
	const codSwitch = $derived(switchable && (codAvailable !== null ? codAvailable : codAnswer.key === codKey && codAnswer.ok));
	const help = $derived(pending ? whatsappLink(orderHelpText(pending.no)) : null);

	const wait = (ms) => new Promise((r) => setTimeout(r, ms));

	async function check() {
		if (!pending || view !== 'idle') return; // checking / leaving: the button stays (aria-disabled), a press does nothing
		view = 'checking';
		const { no, t } = pending;
		for (let i = 0; i < CHECK_POLLS && alive; i++) {
			const s = await fetchStatus(api, no, t);
			if (!alive) return;
			if (s.ok) {
				lastStatus = s.dto.status;
				lastDto = s.dto;
				const v = viewFor(s.dto);
				if (v === 'confirmed') {
					view = 'leaving';
					safeGoto(orderUrl(no, t)); // a paid order: a network blip must not land on the error page
					return;
				}
				if (v === 'cancelled' || v === 'refunded') return forget();
				if (v === 'review') {
					moveTo('review', '[data-wf-pending-review]');
					return;
				}
				if (v === 'failed') break; // no point waiting: offer the retry now
			} else if (s.code === 'NOT_FOUND') {
				return forget(); // unknown order or wrong token: same answer, nothing to recover
			}
			if (i < CHECK_POLLS - 1) await wait(CHECK_EVERY_MS);
		}
		if (alive) moveTo('stuck', '[data-wf-action="retry-payment"]');
	}

	/*
	 * One live region for every view (WCAG 4.1.3): the role=status line below
	 * stays mounted and only its text changes, so "Checking…" and "hasn't come
	 * through" land in a region the screen reader already knows. Check status
	 * stays mounted (aria-disabled) while checking, so keyboard focus stays on
	 * it; when the view replaces it (stuck, review), focus moves to the new
	 * view's first action, as /checkout moves it to its note (WCAG 2.4.3).
	 */
	const moveTo = (next, target) => keepFocus(el, () => (view = next), () => [el?.querySelector(target), el]);

	function retry() {
		if (!pending || busy) return;
		flow.adopt({ number: pending.no, token: pending.t }, 'upi', pending.cartSig);
		flow.retry();
	}

	function payOnDelivery() {
		hidden = true; // the order stays in wefeasto_pending until a COD order supersedes it
		onpayondelivery();
	}

	/** Nothing left to recover (cancelled, refunded, unknown order or token): the entry goes. */
	function forget() {
		goAway(() => {
			clearPending();
			pending = null;
			view = 'idle';
		});
	}

	/** The banner is going: keyboard focus on it moves to the page's heading, not <body>. */
	function goAway(change) {
		keepFocus(el, change, () => [document.querySelector('h1')]);
	}

	/** "Not now": out of the way on this page; the order stays recoverable (and replaceable). */
	function notNow() {
		goAway(() => (hidden = true));
	}

	/** ×: never shown again on this device, still named by the next checkout of the bag (supersede). */
	function dismiss() {
		goAway(() => {
			if (pending) quietPending(pending.no);
			pending = null;
			view = 'idle';
		});
	}

	onMount(() => {
		const p = readPending();
		pending = p && !p.quiet ? p : null;
		if (pending) preloadOrderPage(); // Check status may find it paid: /order must open even on a bad network
		return () => {
			alive = false;
			flow.detach(); // a Retry payment window that hasn't opened yet never opens over the next page
		};
	});

	const flowNote = $derived.by(() => {
		const s = $fs;
		if (s.phase === 'failed' && s.failure) return { code: s.failure.code, message: s.failure.message };
		if (s.phase === 'error' && s.error) return { code: s.error.code, message: s.error.message };
		return null;
	});
	// A Retry payment that fails or is refused: its note takes the focus the disabled button lost (as on /order).
	const noteKey = $derived(flowNote ? flowNote.code + '|' + flowNote.message : null);
	$effect(() => {
		if (!noteKey) return;
		tick().then(() => {
			if (noteEl && (focusLost() || focusWithin(el))) noteEl.focus({ preventScroll: true });
		});
	});
</script>


{#if shown}<div class="wf-pending" bind:this={el} data-wf-pending={pending.no} data-wf-pending-view={view}>
<div class={['wf-pending-main', view === 'stuck' && 'wf-pending-stuck']}><p class="wf-pending-text"><span class="wf-pending-status" role="status" aria-live="polite" data-wf-pending-status>{#if view === 'idle'}Your order <strong>{pending.no}</strong> is waiting for payment{:else if view === 'checking' || view === 'leaving'}<Spinner /> Checking order {pending.no}…{:else if view === 'review'}We’re checking order <strong>{pending.no}</strong>{:else}Payment for <strong>{pending.no}</strong> hasn’t come through{lastStatus === 'payment_failed' || lastStatus === 'expired' ? '' : ' yet'}. If you already paid, we’ll email you as soon as it’s confirmed.{/if}</span>{#if view === 'idle' || view === 'checking' || view === 'leaving'}<span aria-hidden="true">·</span><button type="button" class="wf-link-btn" data-wf-pending-check aria-disabled={view === 'idle' ? undefined : 'true'} onclick={check}>Check status</button>{:else if view === 'review'}<span aria-hidden="true">·</span><a href={orderUrl(pending.no, pending.t)} data-wf-pending-review>View order</a>{/if}</p>
{#if view === 'stuck'}<div class="wf-co-note-actions"><button type="button" class="wf-chip wf-co-note-btn" data-wf-action="retry-payment" disabled={busy || undefined} onclick={retry}>{#if busy}<Spinner /> {busyLabel($fs.phase, 'upi')}{:else}Retry payment{/if}</button>{#if codSwitch}{#if onpayondelivery}<button type="button" class="wf-chip wf-co-note-btn" data-wf-action="pay-on-delivery" disabled={busy || undefined} onclick={payOnDelivery}>Pay on delivery instead</button>{:else}<a class="wf-chip wf-co-note-btn" href="/checkout?pay=cod" data-wf-action="pay-on-delivery">Pay on delivery instead</a>{/if}{/if}<button type="button" class="wf-chip wf-co-note-btn" data-wf-action="forget" onclick={notNow}>Not now</button>{#if help}<a class="wf-co-note-help" href={help} target="_blank" rel="noopener noreferrer">Need help? WhatsApp us</a>{/if}</div>{#if flowNote}<CheckoutNote message={flowNote.message} code={flowNote.code} role="status" bind:element={noteEl} />{/if}{/if}</div>
{#if view === 'idle'}<button type="button" class="wf-pending-close" aria-label="Hide order {pending.no} on this device" title="Hide this order on this device" onclick={dismiss}>×</button>{/if}</div>{/if}
