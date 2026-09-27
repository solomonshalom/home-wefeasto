<script>
	/*
	 * /order?no=WF-10001&t=<token> (roadmap M3). A prerendered shell: `no` and
	 * `t` are read from window.location in onMount (never url.searchParams —
	 * that throws while prerendering); `t` falls back to wefeasto_pending /
	 * wefeasto_last_order for the same number. <meta name="referrer"
	 * content="no-referrer"> keeps the token out of Referer headers.
	 *
	 * States (from GET /api/store/orders/status, $lib/checkout/order.js):
	 * - confirming: PeepWalk + Spinner, "Confirming with your bank… please
	 *   don't pay again." Polls every 2 s for 30 s, then every 5 s up to
	 *   2 min, paused while the tab is hidden; then "Still confirming — we'll
	 *   email you at a•••@…".
	 * - waiting: still unpaid, and this device knows its last payment window
	 *   closed with no money taken (wefeasto_pending `unpaid`: dismissed, never
	 *   opened) — e.g. /account → View after closing the window. "Waiting for
	 *   payment" with Pay now (and Pay on delivery instead, as on the failed
	 *   view), never "please don't pay again"; a slow look turns it confirmed
	 *   if it is paid elsewhere. Anywhere else (no such knowledge) an unpaid
	 *   order stays "confirming": a payment may be in flight.
	 * - confirmed ($shared isConfirmed only): "Order confirmed" + Squiggle,
	 *   drawn once per order. On first entry (guarded by wefeasto_seen_<no>,
	 *   so a refresh repeats none of it): last order written; then, only on
	 *   the device that placed the order (enterConfirmed, PI-ORD-3), its
	 *   pending entry dropped, the ordered quantities taken out of the bag
	 *   (Cart.subtractLines) and 'purchase' tracked.
	 * - failed / expired: "Payment didn't go through" — with "no money was
	 *   taken" only where that is certain (failedCopy). Try again (retry
	 *   endpoint → Razorpay). A redirect-mode arrival (&payment=failed&reason=)
	 *   lands here with the reason's copy. payment_failed isn't terminal (a
	 *   timed-out UPI payment can still be authorised), so while the order can
	 *   still settle the page keeps a slow look (every 8 s for 2 min, paused
	 *   while hidden, and once more on returning to the tab) and turns
	 *   confirmed when the money lands. "Pay on delivery instead"
	 *   (→ /checkout?pay=cod, the normal COD checkout, prefilled with the
	 *   details this tab placed the order with) shows only when the COD order
	 *   is sure to supersede this one (canSwitchToCod: same bag, last 25
	 *   minutes; or an expired order) and COD is available for the bag (the
	 *   server quote, cod-check.js).
	 * - not found: the same generic answer for a wrong token and an unknown
	 *   order, with WhatsApp help.
	 * - no answer yet (the status API down, 5xx, offline): the page knows
	 *   nothing about the order, so it claims nothing — "We can't reach
	 *   Wefeasto right now…" while it keeps looking (the confirming schedule,
	 *   then once more whenever the tab comes back into view).
	 * A Try again (failed view, or "Still confirming") that fails or is
	 * refused shows the flow's note in that view, focused.
	 * - kept (wefeasto_kept, this tab): a tap that never heard back had
	 *   already placed this order, and the checkout that found it landed here
	 *   instead of placing a second one (flow.js). The changes made since are
	 *   not in it, so the page says so and shows where it ships (the status
	 *   DTO has no street address).
	 */
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api.js';
	import { refresh } from '$lib/session.js';
	import { Cart, cart } from '$lib/cart.js';
	import { track } from '$lib/track.js';
	import { whatsappLink, orderHelpText } from '$lib/support.js';
	import { settings } from '$lib/data/settings.js';
	import { buildAddParam, cartSignature } from '$shared/cart-links.js';
	import { cartToItems } from '$shared/pricing.js';
	import { paymentReasonKind, paymentReasonCopy } from '$shared/errors.js';
	import { STATUS_LABELS } from '$shared/order-status.js';
	import { parseArrival, fetchStatus, nextView, createOrderWatcher, enterConfirmed, failedCopy, canSwitchToCod } from '$lib/checkout/order.js';
	import { tokenFor, readPendingForm, readKept, isUnpaidHere } from '$lib/checkout/storage.js';
	import { formatPaise } from '$shared/money.js';
	import { keptCopy } from '$lib/checkout/kept.js';
	import { recipeCardsFor } from '$lib/checkout/recipes.js';
	import { browserFlow, browserCodCheck, safeGoto } from '$lib/checkout/browser.js';
	import { BUSY, busyLabel } from '$lib/checkout/flow.js';
	import PeepWalk from '$lib/components/PeepWalk.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import Squiggle from '$lib/components/Squiggle.svelte';
	import OrderView from '$lib/components/OrderView.svelte';
	import RecipeListCard from '$lib/components/RecipeListCard.svelte';
	import CheckoutNote from '$lib/components/CheckoutNote.svelte';

	// "1 · 2 · 3 · 4+" — 4 stands for 4 or more (retention-backend contract).
	const HOUSEHOLD = [1, 2, 3, 4];

	let view = $state('loading'); // loading | confirming | slow | waiting | confirmed | failed | review | cancelled | refunded | notfound
	let no = $state(null);
	let token = null;
	let noToken = $state(false);
	let order = $state(null); // OrderStatusDTO
	let firstTime = $state(false); // the celebration plays (Squiggle draws) only on the first visit
	let failReason = $state(null);
	let household = $state(null);
	let householdState = $state('idle'); // idle | saving | saved | error
	let guest = $state(false);
	let lookup = $state('first'); // while view is 'loading': first | retrying (no answer yet) | stalled (stopped looking)
	let noteEl = $state(null);
	let kept = $state(null); // wefeasto_kept: an earlier tap had placed this order; the changes since aren't in it
	const keptNote = $derived(kept ? keptCopy(kept) : null);

	const help = $derived(whatsappLink(orderHelpText(no)));
	const buyAgain = $derived.by(() => {
		const add = order ? buildAddParam(order.items || []) : '';
		return add ? '/cart?add=' + add : null;
	});
	const cards = $derived(order ? recipeCardsFor((order.items || []).map((i) => i.slug)) : []);
	const promise = $derived(order?.shippingPromiseText || settings.shippingPromiseText || '');
	const failCopy = $derived(failedCopy(order, failReason));
	/*
	 * The page's one live region (WCAG 4.1.3): a visually hidden line that
	 * says only what changed ("Order confirmed", "Payment didn't go
	 * through…"). The views themselves are not live — a view flip would
	 * otherwise read out the receipt, the recipe cards and every button.
	 */
	const statusLine = $derived.by(() => {
		if (view === 'loading') return lookup === 'first' ? 'Looking up your order…' : lookup === 'retrying' ? 'We can’t reach Wefeasto right now — we’ll keep trying.' : 'We still can’t reach Wefeasto. This page looks again when you come back to it.';
		if (view === 'confirming') return 'Confirming your payment. Please don’t pay again.';
		if (view === 'slow') return 'Still confirming. We’ll email you the moment it lands — no need to pay again.';
		if (view === 'waiting') return 'Waiting for payment';
		if (view === 'confirmed' && order) return 'Order confirmed';
		if (view === 'failed') return failCopy.message;
		if (view === 'notfound') return 'We couldn’t find that order';
		return STATUS_LABELS[order?.status] || 'We’re checking your order';
	});
	const bagItems = $derived(cartToItems($cart));
	const bagSig = $derived(cartSignature(bagItems));
	const switchable = $derived((view === 'failed' || view === 'waiting') && !!order && canSwitchToCod(order, bagSig));
	const payNowLabel = $derived(Number.isSafeInteger(order?.totalPaise) && order.totalPaise > 0 ? `Pay ${formatPaise(order.totalPaise)} now` : 'Pay now');
	// …and COD must be available for the bag: one server quote per bag (+ the PIN this tab placed it with).
	const codCheck = browserCodCheck();
	let codPin = $state(null);
	let codAnswer = $state({ key: null, ok: false });
	const codKey = $derived(switchable ? bagSig + '|' + (codPin ?? '') : null);
	$effect(() => {
		const key = codKey;
		if (!key) return;
		codCheck.check(key, { items: bagItems, pin: codPin }).then((ok) => (codAnswer = { key, ok }));
	});
	const codSwitch = $derived(switchable && codAnswer.key === codKey && codAnswer.ok);

	const flow = browserFlow({
		// After a retry's payment the flow "goes to" this same order: look again instead.
		navigate: (url) => {
			const next = parseArrival(url.slice(url.indexOf('?')));
			if (url.startsWith('/order?') && next.no === no) {
				if (next.t) token = next.t;
				restart();
			} else safeGoto(url);
		}
	});
	const fstate = flow.state;
	const busy = $derived(BUSY.includes($fstate.phase));
	const flowNote = $derived.by(() => {
		const s = $fstate;
		if (s.phase === 'failed' && s.failure) return { code: s.failure.code, message: s.failure.message };
		if (s.phase === 'error' && s.error) return { code: s.error.code, message: s.error.message };
		return null;
	});
	// A failed or refused Try again: its note appears in the view on screen, and focus moves there.
	const noteKey = $derived(flowNote ? flowNote.code + '|' + flowNote.message : null);
	$effect(() => {
		if (!noteKey) return;
		tick().then(() => noteEl?.focus({ preventScroll: false }));
	});

	/** An answer from the status endpoint → what the page shows (the view it returns picks the schedule). */
	function apply(dto) {
		order = dto;
		// A failed (or "Still confirming") page stays put on a still-pending answer: only real news moves it.
		// Unpaid with nothing in flight (this device closed its window, no money taken): "waiting", not "confirming".
		const v = nextView(view, dto, { unpaid: isUnpaidHere(no) });
		if (v === 'confirmed' && view !== 'confirmed') {
			firstTime = enterConfirmed(dto, token, { cart: Cart, track }).first;
		}
		view = v;
		return v;
	}

	const watcher = createOrderWatcher({
		look: () => fetchStatus(api, no, token),
		apply,
		onNotFound: () => (view = 'notfound'),
		onSlow: () => {
			if (view === 'confirming') view = 'slow';
			else if (view === 'loading') lookup = 'stalled';
		},
		busy: () => busy,
		recheckOnReturn: () => view === 'failed' || view === 'slow' || view === 'waiting' || view === 'loading'
	});

	/** Look again from the top (after a retry's payment on this page). */
	function restart() {
		failReason = null;
		view = 'confirming';
		flow.reset(true);
		watcher.poll('confirming');
	}

	function tryAgain() {
		if (busy || !no || !token) return;
		// The bag the order holds (its items: what supersede keys on), so wefeasto_pending keeps it.
		const sig = order ? cartSignature((order.items || []).map((i) => ({ slug: i.slug, qty: i.qty }))) : '';
		flow.adopt({ number: no, token }, order?.requestedMethod === 'card' ? 'card' : 'upi', sig);
		flow.retry();
	}

	async function setHousehold(n) {
		if (householdState === 'saving') return;
		household = n;
		householdState = 'saving';
		const r = await api('/store/orders/household', { method: 'POST', body: { number: no, token, size: n }, timeoutMs: 8000 });
		householdState = r.ok ? 'saved' : 'error';
	}

	// Leaving /order while a Try again's window is still loading: it never opens over the next page.
	onMount(() => () => flow.detach());

	onMount(() => {
		const a = parseArrival(window.location.search);
		no = a.no;
		token = a.t || (a.no ? tokenFor(a.no) : null);
		codPin = no ? readPendingForm(no)?.pin || null : null;
		kept = no ? readKept(no) : null;
		if (!no || !token) {
			noToken = !!no;
			view = 'notfound';
			return;
		}
		if (a.failed) {
			const kind = paymentReasonKind(a.reason);
			// Redirect mode said the payment failed: don't claim "confirming" for a still-pending order.
			if (kind !== 'pending' && kind !== 'already_paid') {
				failReason = a.reason;
				view = 'failed';
			}
		}
		// First look; if /api can't answer yet, keep looking (confirming, or the failed page's slow look).
		// No answer says nothing about the order (it may be COD, paid, cancelled…): no "Confirming" claim.
		watcher.start(view === 'failed' ? 'failed' : 'confirming').then(() => {
			if (view === 'loading' && lookup === 'first') lookup = 'retrying';
		});
		// Signed in? ($lib/session.js: a browser that never logged in doesn't even ask the CMS.)
		refresh({ ifHinted: true }).then((r) => {
			guest = !r.user;
		});
		return () => watcher.stop();
	});
</script>

<svelte:head>
	<title>Wefeasto — Your Order</title>
	<meta name="referrer" content="no-referrer">
	<meta name="robots" content="noindex">
</svelte:head>

{#snippet keptBlock()}{#if keptNote}<div class="wf-co-note wf-order-kept" data-wf-kept><p class="wf-co-note-text">{keptNote.lead}</p><p class="wf-co-note-text wf-order-kept-address" data-wf-kept-address>{keptNote.shipsTo}</p>{#each keptNote.extra as line (line)}<p class="wf-co-note-text">{line}</p>{/each}{#if help}<div class="wf-co-note-actions"><a class="wf-co-note-help" href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Message us on WhatsApp</a></div>{/if}</div>{/if}{/snippet}

<div class="page-wrapper">
<div class="section"><div class="container">
<h1 class="wf-sr-only">Your Wefeasto order</h1>
<p class="wf-sr-only" role="status" aria-live="polite" data-wf-order-status-line>{statusLine}</p>
<div class="wf-order" data-wf-order-view={view}>
{#if view === 'confirming' || view === 'slow' || view === 'confirmed'}<PeepWalk class="wf-order-peeps" />{/if}
{#if view === 'loading'}
<div class="wf-order-state" data-wf-lookup={lookup}><div class="wf-chip">{lookup !== 'first' && no ? 'Order ' + no : 'Your order'}</div><div class="divider"></div>{#if lookup === 'first'}<p class="p-large wf-order-wait"><Spinner /> Looking up your order…</p>{:else if lookup === 'retrying'}<p class="p-large wf-order-wait" data-wf-unreachable><Spinner /> We can’t reach Wefeasto right now — we’ll keep trying. Your order confirmation email has the details.</p>{:else}<p class="p-large" data-wf-unreachable>We still can’t reach Wefeasto. Your order confirmation email has the details — this page looks again when you come back to it.</p>{#if help}<div class="divider _24px"></div><p class="wf-form-note"><a href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Need help? WhatsApp us</a></p>{/if}{/if}<noscript><p class="p-large">This page needs JavaScript. Your order confirmation email has everything you need.</p></noscript></div>
{:else if view === 'confirming' || view === 'slow'}
<div class="wf-order-state" data-wf-confirming>{#if no}<div class="wf-chip" id="wf-co-order-no">Order {no}</div><div class="divider"></div>{/if}{#if view === 'confirming'}<h2 class="heading-2">Confirming your payment</h2><div class="divider _8px"></div><p class="p-large wf-order-wait"><Spinner /> Confirming with your bank… please don’t pay again.</p>{@render keptBlock()}{:else}<h2 class="heading-2">Still confirming</h2><div class="divider _8px"></div><p class="p-large" data-wf-still-confirming>We’ll email you{order?.contact?.emailMasked ? ' at ' + order.contact.emailMasked : ''} the moment it lands — no need to pay again.</p>{#if order?.canRetryPayment}<div class="divider _24px"></div><p class="wf-form-note">Didn’t finish paying? <button type="button" class="wf-link-btn" data-wf-action="try-again" disabled={busy || undefined} aria-busy={busy ? 'true' : undefined} onclick={tryAgain}>{busy ? busyLabel($fstate.phase, 'upi') : 'Try again'}</button></p>{/if}{#if flowNote}<div class="divider _24px"></div><CheckoutNote message={flowNote.message} code={flowNote.code} help={help} bind:element={noteEl} />{:else if help}<div class="divider _8px"></div><p class="wf-form-note"><a href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Need help? WhatsApp us</a></p>{/if}{/if}</div>
{:else if view === 'waiting'}
<div class="wf-order-state" data-wf-waiting>{#if no}<div class="wf-chip" id="wf-co-order-no">Order {no}</div><div class="divider"></div>{/if}<h2 class="heading-2">Waiting for payment</h2><div class="divider _8px"></div><p class="p-large" data-wf-waiting-copy>We haven’t received a payment for this order yet. If you’ve just paid, this page updates by itself as soon as your bank confirms.</p>{@render keptBlock()}<div class="divider _24px"></div><div class="wf-co-actions">{#if !order || order.canRetryPayment !== false}<button type="button" class="button w-button wf-pay-btn" data-wf-action="try-again" disabled={busy || undefined} aria-busy={busy ? 'true' : undefined} onclick={tryAgain}>{#if busy}<Spinner /><span>{busyLabel($fstate.phase, 'upi')}</span>{:else}{payNowLabel}{/if}</button>{/if}{#if codSwitch}<a href="/checkout?pay=cod" class="button secondary w-inline-block" data-wf-action="pay-on-delivery"><div>Pay on delivery instead</div></a>{/if}<a href="/cart" class="button secondary w-inline-block"><div>Back to your bag</div></a></div>{#if flowNote}<div class="divider _24px"></div><CheckoutNote message={flowNote.message} code={flowNote.code} help={help} bind:element={noteEl} />{:else if help}<div class="divider _24px"></div><p class="wf-form-note"><a href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Need help? WhatsApp us</a></p>{/if}</div>
{:else if view === 'confirmed' && order}
<div class="wf-co-thanks" id="wf-co-thanks" data-wf-confirmed={firstTime ? 'first' : 'again'}>
<h2 class="heading-2 wf-order-title">Order confirmed</h2>
<div class="wf-order-squiggle"><Squiggle draw={firstTime} width={220} /></div>
<div class="divider"></div>
<div class="wf-chip" id="wf-co-order-no">Order {order.number}</div>
<div class="divider"></div>
<p class="p-large">Thank you{order.contact?.firstName ? ', ' + order.contact.firstName : ''}! {order.paymentMethod === 'cod' ? 'We’ve got your order — pay when it arrives.' : 'Your payment is confirmed.'}{order.contact?.emailMasked ? ' A confirmation is on its way to ' + order.contact.emailMasked + '.' : ''}</p>
{#if promise}<p class="wf-form-note wf-order-promise" data-wf-promise>{promise}</p>{/if}
{@render keptBlock()}
<div class="divider _32px mobile-24px"></div>
<div class="wf-order-receipt"><OrderView {order} /></div>
<div class="divider _32px mobile-24px"></div>
<div class="wf-co-actions">{#if buyAgain}<a href={buyAgain} class="button w-inline-block" data-wf-buy-again><div>Buy again</div></a>{/if}<a href="/recipes" class="button secondary w-inline-block"><div>Browse recipes</div></a></div>
<div class="divider _42px"></div>
<div class="wf-household" role="group" aria-labelledby="wf-household-q"><p class="wf-household-q" id="wf-household-q">Breakfast for how many?</p><div class="wf-pay-pills wf-household-pills">{#each HOUSEHOLD as n (n)}<button type="button" class="wf-pay-pill wf-household-pill" aria-pressed={household === n ? 'true' : 'false'} data-wf-household={n} aria-disabled={householdState === 'saving' ? 'true' : undefined} onclick={() => setHousehold(n)}>{n === 4 ? '4+' : n}</button>{/each}</div>{#if householdState === 'saved'}<p class="wf-form-note" role="status" data-wf-household-saved>Thanks — we’ll time your refill reminder to match.</p>{:else if householdState === 'error'}<p class="wf-form-note" role="status">Couldn’t save that just now — no worries, it’s optional.</p>{:else}<p class="wf-form-note">So we can remind you before you run out. Optional.</p>{/if}</div>
{#if guest}<div class="divider _32px"></div><div class="wf-order-account" data-wf-account-cta><p class="p-large">Checking out again soon?</p><p class="wf-form-note">Create an account and your next orders are kept in one place, ready to reorder in a tap. This one stays in your confirmation email.</p><div class="divider _8px"></div><a href="/login?next=/account&signup=1" class="button secondary w-inline-block"><div>Create an account</div></a></div>{/if}
</div>
{#if cards.length}<div class="divider _42px"></div><div class="wf-order-recipes"><h3 class="wf-order-recipes-title">Make something with it</h3><div class="divider _24px"></div><div class="grid-6 _2 wf-order-recipe-grid">{#each cards as c (c.slug)}<RecipeListCard slug={c.slug} card={c.card} />{/each}</div></div>{/if}
{:else if view === 'failed'}
<div class="wf-order-state" data-wf-failed>{#if no}<div class="wf-chip" id="wf-co-order-no">Order {no}</div><div class="divider"></div>{/if}<h2 class="heading-2">Let’s try that again</h2><div class="divider _8px"></div><p class="p-large" data-wf-fail-copy={failCopy.certain ? 'certain' : 'unsure'}>{failCopy.message}</p>{@render keptBlock()}{#if failCopy.watching}<p class="wf-form-note wf-order-wait wf-order-late" data-wf-late-watch><Spinner /> Watching for a late confirmation from your bank — this page updates by itself.</p>{/if}{#if failReason && ['declined', 'auth_failed', 'risk', 'technical'].includes(paymentReasonKind(failReason))}<p class="wf-form-note" data-wf-fail-reason>{paymentReasonCopy(failReason)}</p>{/if}{#if order?.status === 'expired'}<p class="wf-form-note">The payment window for this order closed. Trying again reserves your items afresh.</p>{/if}<div class="divider _24px"></div><div class="wf-co-actions">{#if !order || order.canRetryPayment !== false}<button type="button" class="button w-button wf-pay-btn" data-wf-action="try-again" disabled={busy || undefined} aria-busy={busy ? 'true' : undefined} onclick={tryAgain}>{#if busy}<Spinner /><span>{busyLabel($fstate.phase, 'upi')}</span>{:else}Try again{/if}</button>{/if}{#if codSwitch}<a href="/checkout?pay=cod" class="button secondary w-inline-block" data-wf-action="pay-on-delivery"><div>Pay on delivery instead</div></a>{/if}<a href="/cart" class="button secondary w-inline-block"><div>Back to your bag</div></a></div>{#if flowNote}<div class="divider _24px"></div><CheckoutNote message={flowNote.message} code={flowNote.code} help={help} bind:element={noteEl} />{:else if help}<div class="divider _24px"></div><p class="wf-form-note"><a href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Need help? WhatsApp us</a></p>{/if}</div>
{:else if view === 'notfound'}
<div class="wf-order-state" data-wf-notfound><div class="wf-chip">Your order</div><div class="divider"></div><h2 class="heading-2">We couldn’t find that order</h2><div class="divider _8px"></div><p class="p-large">{noToken ? 'Open the link from your order email to see this order on this device.' : 'Check the link in your order email, or message us and we’ll look it up.'}</p><div class="divider _24px"></div><div class="wf-co-actions">{#if help}<a href={help} class="button w-inline-block" target="_blank" rel="noopener noreferrer" data-wf-whatsapp><div>WhatsApp us</div></a>{/if}<a href="/shop" class="button secondary w-inline-block"><div>Shop Breakfast</div></a></div></div>
{:else}
<div class="wf-order-state" data-wf-order-status={order?.status}>{#if no}<div class="wf-chip" id="wf-co-order-no">Order {no}</div><div class="divider"></div>{/if}<h2 class="heading-2">{STATUS_LABELS[order?.status] || 'We’re checking your order'}</h2><div class="divider _8px"></div><p class="p-large">{view === 'cancelled' ? 'This order was cancelled. If you think that’s a mistake, message us.' : view === 'refunded' ? 'This order was refunded. It can take 5–7 working days to reach your account.' : 'We’re taking a closer look at this order and will email you shortly. No need to pay again.'}</p>{#if help}<div class="divider _24px"></div><div class="wf-co-actions"><a href={help} class="button w-inline-block" target="_blank" rel="noopener noreferrer" data-wf-whatsapp><div>WhatsApp us</div></a></div>{/if}</div>
{/if}
</div>
</div></div>
</div>
