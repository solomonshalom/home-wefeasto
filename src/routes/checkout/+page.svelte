<script>
	/*
	 * Checkout (roadmap M2, S1, S5, S12). Same grid and classes as before;
	 * card and UPI-ID inputs are gone for good — Razorpay's window collects
	 * payment details, never this form.
	 *
	 * - Summary (#wf-co-summary) is the SERVER quote (debounced POST
	 *   /api/store/quote with the bag, the link offer, PIN, email and method);
	 *   until it answers, or if /api can't, the $shared quote over the live
	 *   catalog stands in, and the server's PRICE_CHANGED catches any gap.
	 *   Sold-out / over-limit lines show inline with remove / reduce and
	 *   block Pay. COD is off (with the reason) when the quote says so.
	 * - Pay: "Pay ₹X securely" / "Place order · Pay ₹X on delivery"; the
	 *   amount is expectedTotalPaise. While the bag is blocked, empty or not
	 *   read yet (prerendered, pre-hydration) the label has no amount — never
	 *   "Pay ₹0" — and when every line is sold out (quoteView allBlocked) the
	 *   ₹0 money rows hide and COD isn't blamed for the "empty" quote. $lib/checkout/flow.js does the rest:
	 *   Idempotency-Key per cart + form, wefeasto_pending before the modal,
	 *   checkout.js on demand, verify → /order, dismiss/failure → one note
	 *   with Try again / Pay on delivery instead. The bag is never cleared
	 *   here (/order subtracts the ordered quantities once confirmed).
	 * - S1: opt-in "Save my details on this device" (wefeasto_checkout),
	 *   written when an order is created; "Not you? Forget me" clears it.
	 * - S5: a valid PIN prefills City and State from /pin/<3>.json (GeoNames),
	 *   never over something the customer typed, and never into the field
	 *   they are in (held until they leave it untouched); both stay editable.
	 * - An API refusal's note goes once a newer server quote (for a changed
	 *   ask) has fixed what it complained about (errors.js resolvedByQuote).
	 * - A failed payment's note (Try again = pay the order already placed) goes
	 *   when the bag changes under it (top-up, another tab): Pay then places
	 *   the bag on screen. Its Try again pays that order only while the bag
	 *   AND the details on screen are that order's; corrected details are
	 *   placed as Pay would (a new order that supersedes the unpaid one).
	 * - A tap that never heard back (lost answer, reload mid-request,
	 *   wefeasto_placing): after a reload its details come back with a note.
	 *   Online: its order is asked for quietly (flow.recall) and named from
	 *   then on (quote + checkout `supersede`), so its offer and last packs
	 *   are this bag's own and changed details replace it. COD: the next tap
	 *   resolves it (flow.js) — never a second order; if the details changed
	 *   since, /order says the earlier order was kept and where it ships.
	 * - The fix controls (Reduce to N, Remove, the offer's ×, the note's
	 *   Remove offer) hand keyboard focus on when they go ($lib/focus.js).
	 * - A form filled before hydration (slow network, autofill) keeps every
	 *   value, State included; a PIN already there fills City / State.
	 * - ?pay=cod preselects Cash on Delivery (from the pending banner / /order).
	 *   The form is prefilled with the details the pending online order was
	 *   placed with in this tab (wefeasto_pending_form, sessionStorage), then
	 *   saved details. The checkout names that order (`supersede`, the ref the
	 *   quote carries), so the backend supersedes (cancels) it for the same bag
	 *   even if the phone was changed (SUP-PHONE-1). If the UPI app paid it
	 *   meanwhile, the server answers ALREADY_PAID and the flow opens that order.
	 * - Status messages (WCAG 4.1.3): once the summary settles after a change
	 *   (a top-up add, an offer that starts or stops applying, fees, sold-out
	 *   lines), one polite live region says what changed and the new total
	 *   ($lib/checkout/announce.js).
	 * - Leaving the page stops a payment window that hasn't opened yet
	 *   (flow.detach); /order's page code is fetched on mount, so reaching it
	 *   after a payment needs no request at a bad moment (browser.js safeGoto).
	 * - PIN: "560 001", the way it's printed, fits (maxlength 7) and the space
	 *   is dropped as it's typed or pasted.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { Cart, cart, readOffer, clearOffer, readSource } from '$lib/cart.js';
	import { productBySlug } from '$lib/data/products.js';
	import { liveCatalog, loadLive, catalogForPricing } from '$lib/live.js';
	import { quote as localQuote, cartToItems } from '$shared/pricing.js';
	import { formatPaise } from '$shared/money.js';
	import { INDIAN_STATES, normalizeEmail, normalizePin, isValidPin } from '$shared/validate.js';
	import { checkoutErrorCopy, codReasonCopy, couponReasonCopy } from '$shared/errors.js';
	import { cartSignature } from '$shared/cart-links.js';
	import { motionOK } from '$lib/fx.js';
	import { track } from '$lib/track.js';
	import { api } from '$lib/api.js';
	import { whatsappLink } from '$lib/support.js';
	import { browserFlow, preloadOrderPage } from '$lib/checkout/browser.js';
	import { BUSY, busyLabel as busyLabelFor } from '$lib/checkout/flow.js';
	import { createQuoter, quoteBody, quoteKey, isQuote, quoteView, supersedeFor, payLabel as payLabelFor } from '$lib/checkout/quote.js';
	import { checkForm, buildCheckoutBody, attemptOf, FIELD_IDS } from '$lib/checkout/request.js';
	import { keepFocus, focusFirst, focusLost, focusWithin } from '$lib/focus.js';
	import { readSaved, writeSaved, clearSaved, readPending, readPendingForm, writePendingForm, clearPendingForm, readPlacing } from '$lib/checkout/storage.js';
	import { orderUrl } from '$lib/checkout/order.js';
	import { lookupPin, planPinFill } from '$lib/checkout/pin.js';
	import { resolvedByQuote } from '$lib/checkout/errors.js';
	import { summarySnapshot, bagChanges, summaryChanges, pinFillMessage } from '$lib/checkout/announce.js';
	import TopUp from '$lib/components/TopUp.svelte';
	import PayButton from '$lib/components/PayButton.svelte';
	import CheckoutNote from '$lib/components/CheckoutNote.svelte';
	import PendingOrderBanner from '$lib/components/PendingOrderBanner.svelte';

	const EMPTY_FORM = { name: '', phone: '', email: '', address: '', city: '', state: '', pin: '' };
	/** Page field → validateCheckoutForm field. */
	const VFIELD = { name: 'name', phone: 'phone', email: 'email', address: 'line1', city: 'city', state: 'state', pin: 'pin' };

	let mounted = $state(false);
	// State starts undefined, not '': on hydration the <select> binding then adopts what the prerendered
	// form already holds (picked or autofilled while the page's JS loaded) instead of resetting it to
	// "Choose your state" (Svelte keeps a changed text input, but a bound <select> is written over
	// unless its value is undefined). It is '' or a state from the first render on.
	let form = $state({ ...EMPTY_FORM, state: undefined });
	let marketing = $state(false);
	let saveDetails = $state(false);
	let savedShown = $state(false);
	let method = $state('upi');
	let errors = $state({}); // validateCheckoutForm field → message
	let offer = $state(null); // {code, at}
	let source = 'web';
	let codBlock = $state(null); // {reason, message}: a server-only COD refusal (e.g. TOO_MANY_OPEN)
	let pinAuto = $state({ city: false, state: false });
	let pageNote = $state(null); // {code, message, actions?}
	let switchedFrom = $state(null); // the pending order ?pay=cod replaces: its banner steps aside
	let preparing = $state(false); // between the tap and flow.submit (quote flush)
	let refused = $state.raw(null); // {error, key}: the API refusal on show and the quote ask it was made against
	let noteEl = $state(null);
	let summaryEl;
	let attempted = false;

	const help = whatsappLink('Hi Wefeasto, I need help with checkout.');

	const flow = browserFlow({ onOrder: rememberDetails });
	const fstate = flow.state;
	const quoter = createQuoter({ api });
	const qstate = quoter.state;

	/* ---------------- the quote ---------------- */

	const catalog = $derived.by(() => {
		$liveCatalog;
		return catalogForPricing();
	});
	const items = $derived(cartToItems($cart));
	const empty = $derived(items.length === 0);
	const emailOk = $derived(normalizeEmail(form.email));
	const pinOk = $derived.by(() => {
		const p = normalizePin(form.pin);
		return isValidPin(p) ? p : null;
	});
	const cartSig = $derived(cartSignature(items));
	// PI-SF-1: the unpaid online order a checkout of this bag would supersede (wefeasto_pending, re-read on
	// every flow step: the flow writes it before a payment window opens, and drops it once a newer order
	// for the bag is placed). The server quote then counts what that order holds (its last packs, a
	// single-use offer) as this bag's own. Only for the same bag: a changed bag re-quotes without it.
	let pendingRef = $state.raw(null);
	$effect(() => {
		$fstate;
		if (mounted) pendingRef = readPending();
	});
	const supersede = $derived(mounted ? supersedeFor(pendingRef, cartSig, { order: $fstate.order, method: $fstate.method, cartSig: flow.cartSig }) : null);
	const qBody = $derived(quoteBody({ items, couponCode: offer?.code ?? null, email: emailOk, pin: pinOk, method, supersede }));
	const qKey = $derived(quoteKey(qBody));
	const clientQ = $derived(localQuote({ items, catalog, settings: $liveCatalog.settings, method, context: pinOk ? { pin: pinOk } : {} }));
	// The server's answer to exactly this ask…
	const serverQ = $derived($qstate.status === 'ok' && $qstate.key === qKey ? $qstate.quote : null);
	// …or, while a new ask (method, PIN, email, offer) is in flight, its last answer for the same bag
	// (dimmed), so the total doesn't flip to the local quote (which can't price the offer) and back.
	const staleQ = $derived(!serverQ && $qstate.quote && $qstate.body && cartSignature($qstate.body.items) === cartSig ? $qstate.quote : null);
	const shownServerQ = $derived(serverQ ?? staleQ);
	const q = $derived(shownServerQ ?? clientQ);
	const quoting = $derived(mounted && !empty && $qstate.status === 'loading');
	const qv = $derived(quoteView(q));
	// A line (or the order) needs a fix before paying: Pay is off, its label has no amount.
	const bagBlocked = $derived(mounted && !empty && qv.bagBlocked);
	const settings = $derived($liveCatalog.settings);

	$effect(() => {
		const body = qBody;
		if (!mounted || empty) return;
		quoter.request(body);
	});

	const rows = $derived.by(() => {
		const lines = new Map(q.lines.map((l) => [l.slug, l]));
		const issues = new Map(q.issues.map((i) => [i.slug, i]));
		return items.map(({ slug, qty }) => {
			const line = lines.get(slug) || null;
			const issue = issues.get(slug) || null;
			return { slug, qty, line, issue, name: line?.name || (issue && issue.name !== slug ? issue.name : null) || productBySlug(slug)?.name || slug };
		});
	});

	const threshold = $derived(formatPaise(q.freeDeliveryThresholdPaise));
	const noteText = $derived(
		q.isFreeDelivery
			? 'Free delivery above ' + threshold + ' — yours is free!'
			: 'Free delivery above ' + threshold + ' — add ' + formatPaise(q.amountToFreeDeliveryPaise) + ' more'
	);
	const couponState = $derived(!offer ? null : shownServerQ?.coupon ? 'applied' : shownServerQ?.couponError ? 'invalid' : 'pending');

	/* ---------------- COD ---------------- */

	const codOk = $derived(qv.codAvailable && !codBlock);
	const codReason = $derived.by(() => {
		if (empty) return null;
		if (codBlock) return codBlock.message;
		if (qv.codAvailable) return null;
		const notAllowed = q.lines.find((l) => l.codAllowed === false);
		return codReasonCopy(q.codUnavailableReason, {
			name: notAllowed?.name,
			codMaxPaise: settings.codMaxPaise,
			codMinSubtotalPaise: settings.codMinSubtotalPaise
		});
	});
	// COD picked, then the bag or PIN made it unavailable: back to UPI (the reason shows under the pills).
	$effect(() => {
		if (mounted && !empty && method === 'cod' && !codOk) method = 'upi';
	});

	/* ---------------- pay button ---------------- */

	const phase = $derived($fstate.phase);
	const busy = $derived(preparing || BUSY.includes(phase));
	const blocked = $derived(!mounted || empty || q.issues.length > 0 || !!q.orderError || (method === 'cod' && !codOk));
	// No amount until the bag is read (the prerendered page, before hydration) or while it's empty or blocked.
	const payLabel = $derived(payLabelFor(method, q.totalPaise, !mounted || empty || bagBlocked));
	// The method of the order being placed / paid (the flow's), not the pill on screen: "Opening payment…"
	// for an online order even if a pill changed meanwhile (the form is locked while busy, below).
	const busyLabel = $derived(busyLabelFor(phase, BUSY.includes(phase) ? ($fstate.method ?? method) : method));
	const mobileTotal = $derived(
		'Total ' +
			formatPaise(q.totalPaise) +
			(q.deliveryPaise > 0 ? ` (incl. ${formatPaise(q.deliveryPaise)} delivery)` : q.subtotalPaise > 0 ? ' (free delivery)' : '')
	);

	/* ---------------- notes (errors, failed payments) ---------------- */

	// The refusal on show, answered since by the server quote for a changed ask (the email corrected
	// for a bound offer, a served PIN, the bag back in stock / within limits): back to idle, note gone.
	const refusalResolved = $derived(
		!!refused && $fstate.phase === 'error' && $fstate.error === refused.error && !!serverQ && qKey !== refused.key && resolvedByQuote(refused.error, serverQ)
	);
	$effect(() => {
		if (!refusalResolved) return;
		refused = null;
		flow.reset();
	});

	const note = $derived.by(() => {
		const s = $fstate;
		if (s.phase === 'failed' && s.failure) {
			if (s.failure.pending && s.order) {
				return { code: s.failure.code, message: s.failure.message, actions: [{ id: 'check-status', label: 'Check status', href: orderUrl(s.order.number, s.order.token) }] };
			}
			const actions = [{ id: 'try-again', label: 'Try again', onclick: retryFromNote }];
			if (codOk && !empty) actions.push({ id: 'pay-on-delivery', label: 'Pay on delivery instead', onclick: switchToCod });
			return { code: s.failure.code, message: s.failure.message, actions, help };
		}
		if (s.phase === 'error' && s.error) {
			const e = s.error;
			const actions = [];
			if (e.actions.includes('remove-offer') && offer) actions.push({ id: 'remove-offer', label: 'Remove offer', onclick: removeOfferFromNote });
			if (e.actions.includes('offer-cod') && codOk && !empty) actions.push({ id: 'pay-on-delivery', label: 'Pay on delivery instead', onclick: switchToCod });
			return { code: e.code, message: e.message, actions, help: e.kind === 'generic' || e.kind === 'network' ? help : null };
		}
		// "Switched to Cash on Delivery…" only while COD is still what's picked.
		if (pageNote?.code === 'COD_SWITCH' && method !== 'cod') return null;
		return pageNote;
	});

	/* ---------------- status messages (WCAG 4.1.3) ---------------- */

	let live = $state(''); // what the live region says now
	let liveSeq = 0;
	let liveSnap = null; // the last settled summary spoken against
	let liveBag = null; // …and the bag it was for
	let offerRead = $state(false); // the link offer is known: the first settle after it is the baseline, never news

	const nameOf = (slug) => catalog.find((p) => p.slug === slug)?.name || productBySlug(slug)?.name || slug;
	// The summary has settled: the server's answer to exactly this ask, or the local quote when /api can't answer.
	const settledQ = $derived(
		!mounted || empty || quoting || !offerRead ? null : (serverQ ?? ($qstate.status === 'error' && $qstate.key === qKey ? clientQ : null))
	);

	// A message the next one (within 2 s) keeps in front of it: the PIN fill, then the summary the new
	// PIN re-quoted, are both read rather than the second cutting the first off.
	let liveLead = null; // {msg, until}
	const LIVE_LEAD_MS = 2000;

	function say(msg, { lead = false } = {}) {
		const my = ++liveSeq;
		const now = Date.now();
		const before = liveLead && liveLead.until > now ? liveLead.msg + ' ' : '';
		liveLead = lead ? { msg: before + msg, until: now + LIVE_LEAD_MS } : null;
		const text = before + msg;
		live = ''; // cleared first, so the same words twice are still spoken twice
		tick().then(() => {
			if (my === liveSeq) live = text;
		});
	}

	$effect(() => {
		const sq = settledQ;
		if (!sq) return;
		const bag = $cart;
		untrack(() => {
			const snap = summarySnapshot(sq, { offerCode: offer?.code ?? null, method, nameOf });
			const parts = liveSnap ? [...bagChanges(liveBag, bag, nameOf), ...summaryChanges(liveSnap, snap)] : [];
			liveSnap = snap;
			liveBag = { ...bag };
			if (parts.length) say(parts.join(' '));
		});
	});

	// The last line went (Remove, another tab): no summary will settle, so say it now.
	$effect(() => {
		if (!mounted || !empty) return;
		untrack(() => {
			if (!liveBag) return;
			const parts = bagChanges(liveBag, {}, nameOf);
			liveSnap = null;
			liveBag = null;
			say([...parts, 'Your bag is empty.'].join(' '));
		});
	});

	/* ---------------- actions ---------------- */

	function focusField(field) {
		const el = field && document.getElementById(FIELD_IDS[field]);
		if (el) {
			el.focus();
			el.scrollIntoView?.({ block: 'center' });
		}
	}

	async function focusNote() {
		await tick();
		noteEl?.focus({ preventScroll: false });
	}

	function revalidate(pageField) {
		const field = VFIELD[pageField];
		if (!attempted || !errors[field]) return;
		const c = checkForm(form);
		if (c.errors[field]) errors[field] = c.errors[field];
		else {
			const next = { ...errors };
			delete next[field];
			errors = next;
		}
	}

	function switchToCod() {
		method = 'cod';
		flow.reset();
		pageNote = { code: 'COD_SWITCH', message: 'Switched to Cash on Delivery — tap “Place order” to confirm.', actions: [] };
		tick().then(() => document.getElementById('wf-place-order')?.focus());
	}

	/**
	 * Are the details on screen (contact, address, method, offer, consent, total) still the ones the
	 * flow's order was placed with? An order this page adopted has none to compare: yes.
	 */
	function detailsUnchanged() {
		const placed = flow.attempt;
		if (!placed) return true;
		const check = checkForm(form);
		return check.ok && attemptOf(bodyFor(check.value)).formHash === placed.formHash;
	}

	/** The failure note's Try again: a refusal (e.g. sold out since the reservation lapsed) re-quotes the bag like Pay's. */
	async function retryFromNote() {
		// Try again pays the order already placed: only while the bag AND the details on screen are still
		// that order's. A corrected address or phone is a new attempt, as Pay makes it (flow.submit): the
		// details on screen are placed and replace the unpaid order (supersede) — never the old ones paid.
		if ((flow.cartSig && flow.cartSig !== cartSig) || !detailsUnchanged()) {
			flow.reset();
			document.getElementById('wf-checkout-form')?.requestSubmit();
			return;
		}
		const askKey = qKey;
		const r = await flow.retry();
		if (r && r.error) {
			refused = { error: r.error, key: askKey };
			handleError(r.error);
		}
	}

	/* The controls that fix the order go away with what they fixed (WCAG 2.4.3, $lib/focus.js). */
	const payBtn = () => document.getElementById('wf-place-order');
	const summaryHeading = () => summaryEl?.querySelector('.wf-summary-heading');
	const issueBtn = (slug) => (slug ? summaryEl?.querySelector(`.wf-co-issue[data-wf-co-line="${CSS.escape(slug)}"] .wf-co-issue-btn`) : null);

	/**
	 * Run `change` (a fix that unmounts the focused control); if keyboard focus was in the form and
	 * falls to <body>, move it to the first usable of `candidates()` — once the DOM has updated, and
	 * again once the re-quote the fix asked for has landed (the row it was in may only go then).
	 * Nothing moves when focus was elsewhere.
	 */
	async function fixKeepingFocus(change, candidates) {
		const formEl = document.getElementById('wf-checkout-form');
		if (!focusWithin(formEl)) return change();
		await keepFocus(formEl, change, candidates);
		await quoter.flush();
		await tick();
		if (focusLost()) focusFirst(candidates());
	}

	function dropOffer() {
		clearOffer();
		offer = null;
		flow.reset();
		pageNote = null;
	}

	/** The offer chip's ×: focus stays in the summary. */
	function removeOffer() {
		return fixKeepingFocus(dropOffer, () => [summaryHeading(), payBtn()]);
	}

	/** The failure note's "Remove offer": the note goes; focus moves to Pay, just below it. */
	function removeOfferFromNote() {
		return fixKeepingFocus(dropOffer, () => [payBtn(), summaryHeading()]);
	}

	function rememberDetails(order) {
		if (saveDetails) writeSaved({ ...form });
		else clearSaved();
		// An online order may end in "Pay on delivery instead": keep its details for this tab (same phone → supersede).
		if (method !== 'cod' && order?.number) writePendingForm({ no: order.number, form: { ...form } });
		// A COD order: the details go with the online order they belong to, unless it is still pending here
		// (the flow keeps an order the server didn't replace, SUP-PHONE-1).
		else {
			const still = readPending();
			if (!still || !readPendingForm(still.no)) clearPendingForm();
		}
	}

	function forgetMe() {
		clearSaved();
		clearPendingForm();
		form = { ...EMPTY_FORM };
		saveDetails = false;
		savedShown = false;
		pinAuto = { city: false, state: false };
		pinHeld = {};
		pinSeq++;
		errors = {};
		tick().then(() => focusField('name'));
	}

	/** Remove on a refused line: focus goes to the next refused line's control, else Pay, else the summary. */
	function removeLine(slug) {
		const lines = [...(summaryEl?.querySelectorAll('.wf-co-issue[data-wf-co-line]') ?? [])].map((el) => el.getAttribute('data-wf-co-line'));
		const at = lines.indexOf(slug);
		const next = at < 0 ? lines : lines.slice(at + 1).concat(lines.slice(0, at));
		return fixKeepingFocus(
			() => {
				Cart.remove(slug);
				flow.reset();
			},
			() => [...next.map(issueBtn), payBtn(), summaryHeading()]
		);
	}

	/** Reduce to N: focus stays on that line (its other control, else the row itself), else Pay, else the summary. */
	function reduceLine(slug, qty) {
		return fixKeepingFocus(
			() => {
				Cart.setQty(slug, qty);
				flow.reset();
			},
			() => [issueBtn(slug), summaryEl?.querySelector(`[data-wf-co-line="${CSS.escape(slug)}"]`), payBtn(), summaryHeading()]
		);
	}

	/* ---------------- S5: PIN → city / state ---------------- */

	const PIN_FIELDS = { 'wf-co-city': 'city', 'wf-co-state': 'state' };
	let pinSeq = 0;
	let pinHeld = {}; // a PIN answer held back while the customer was in City / State

	/** City / State: their error, and the "Filled in from your PIN" hint while the PIN's value is in it. */
	const describedBy = (f) => [errors[f] ? `wf-co-${f}-err` : null, pinAuto[f] ? 'wf-co-pin-hint' : null].filter(Boolean).join(' ') || undefined;

	/** Write what the PIN answered into City / State, and say so (only what actually changed). */
	function applyPinFill(fill) {
		const changed = {};
		for (const f of ['city', 'state']) {
			if (!fill[f]) continue;
			if (form[f] !== fill[f]) changed[f] = fill[f];
			form[f] = fill[f];
			pinAuto[f] = true;
			revalidate(f);
		}
		const msg = pinFillMessage(changed);
		if (msg) say(msg, { lead: true });
	}

	/**
	 * "560 001", the way PINs are printed: maxlength 7 leaves room for the space, and it goes as it's
	 * typed or pasted (the value is then the 6 digits `pattern` and the placeholder show), the caret
	 * staying where it was.
	 */
	function dropPinSpaces(el) {
		const raw = form.pin;
		if (!/\s/.test(raw)) return;
		const at = el && typeof el.selectionStart === 'number' ? raw.slice(0, el.selectionStart).replace(/\s+/g, '').length : null;
		form.pin = raw.replace(/\s+/g, '');
		if (at === null) return;
		tick().then(() => {
			try {
				if (document.activeElement === el) el.setSelectionRange(at, at);
			} catch (e) {
				/* not a text control any more */
			}
		});
	}

	async function onPinInput(e) {
		dropPinSpaces(e?.currentTarget);
		codBlock = null; // a server-only COD refusal was for the old phone / PIN
		revalidate('pin');
		const my = ++pinSeq; // an answer for an older PIN is dropped
		pinHeld = {};
		const p = normalizePin(form.pin);
		if (!/^\d{6}$/.test(p)) return;
		const hit = await lookupPin(p);
		if (my !== pinSeq || !hit) return;
		// Never under the caret: the field the customer is in (they may have tapped City while the
		// shard loaded) waits until they leave it untouched — else their typing lands after our value.
		const plan = planPinFill(hit, form, pinAuto, PIN_FIELDS[document.activeElement?.id] ?? null);
		pinHeld = plan.hold;
		applyPinFill(plan.fill);
	}

	/** Leaving City / State without typing in it: fill what a PIN answer held back for it. */
	function onPinFieldBlur(field) {
		const v = pinHeld[field];
		if (!v) return;
		pinHeld = { ...pinHeld, [field]: undefined };
		applyPinFill(planPinFill({ [field]: v }, form, pinAuto).fill);
	}

	/** The customer typed / picked in City or State: it's theirs, and a held answer is dropped. */
	function onPinFieldEdit(field) {
		pinAuto[field] = false;
		pinHeld = { ...pinHeld, [field]: undefined };
		revalidate(field);
	}

	/* ---------------- submit ---------------- */

	function handleError(ui) {
		if (!ui) return;
		if (ui.actions.includes('use-quote') && isQuote(ui.quote)) quoter.setQuote(ui.quote, qBody);
		if (ui.actions.includes('refresh-quote') || (ui.actions.includes('use-quote') && !isQuote(ui.quote))) {
			quoter.invalidate();
			quoter.request(qBody);
		}
		if (ui.actions.includes('disable-cod')) {
			codBlock = { reason: ui.reason, message: ui.message };
			if (method === 'cod') method = 'upi';
		}
		if (ui.actions.includes('focus-field') && ui.fields && Object.keys(ui.fields).length) {
			errors = ui.fields;
			attempted = true;
			tick().then(() => focusField(Object.keys(ui.fields)[0]));
			return;
		}
		focusNote();
	}

	async function onSubmit(e) {
		e.preventDefault();
		if (busy || blocked) return;
		attempted = true;
		const shownTotal = q.totalPaise;
		track('pay_click', { method, value: shownTotal / 100 });
		pageNote = null;
		const check = checkForm(form);
		if (!check.ok) {
			errors = check.errors;
			focusField(check.first);
			return;
		}
		errors = {};
		const had = document.activeElement;
		if (had && had !== document.body && e.currentTarget?.contains?.(had)) focusBeforeBusy = had;
		preparing = true;
		// Pay exactly what was on the button: the latest server quote first.
		await quoter.flush();
		await tick();
		preparing = false;
		if (q.issues.length || q.orderError || (method === 'cod' && !codOk)) return;
		if (q.totalPaise !== shownTotal) {
			pageNote = { code: 'TOTAL_CHANGED', message: `Your total is now ${formatPaise(q.totalPaise)} — please check it and tap again.`, actions: [] };
			focusNote();
			return;
		}
		const askKey = qKey;
		const sentMethod = method;
		const r = await flow.submit(bodyFor(check.value));
		if (r && r.error) {
			refused = { error: r.error, key: askKey };
			handleError(r.error);
			// An online tap that never heard back (a lost answer): its order may exist, holding this bag's
			// offer and last packs. Ask for it quietly, so the quote and the next tap name it (flow.recall).
			if (sentMethod !== 'cod' && readPlacing()) recallUnheard();
		}
		else if ($fstate.phase === 'failed') focusNote();
	}

	/** The checkout request for the form's validated `value` and what's on screen now. */
	function bodyFor(value) {
		return buildCheckoutBody({
			value,
			items,
			method,
			couponCode: offer?.code ?? null,
			expectedTotalPaise: q.totalPaise,
			marketing,
			source,
			// The order the quote priced this bag as replacing: the server cancels it, whatever the phone
			// (SUP-PHONE-1), and the flow drops its pending entry only then.
			supersede
		});
	}

	/** flow.recall for the bag on screen; an unpaid order found is named by the quote from now on. */
	function recallUnheard(sig = cartSig) {
		return flow.recall(sig).then((o) => {
			pendingRef = readPending();
			return o;
		});
	}

	// The bag changed under a failed payment's note (the summary's top-up, an edit in another tab): its
	// Try again would pay the OLD order, for the old items and total. The note goes; Pay places the bag
	// on screen (flow.submit: a new cart signature is a new order). A "please don't pay twice" note stays.
	$effect(() => {
		const s = $fstate;
		const sig = cartSig;
		if (!mounted || s.phase !== 'failed' || !s.order || s.failure?.pending) return;
		const orderSig = flow.cartSig;
		if (orderSig && orderSig !== sig) flow.reset();
	});

	// Locking the form while busy (the fieldset below) drops keyboard focus from the field Enter was
	// pressed in, or from Pay, to <body>. Once the page is idle again and nothing else has taken focus
	// (the note, a field error), it goes back where it was (WCAG 2.4.3).
	let focusBeforeBusy = null;
	$effect(() => {
		if (busy || !focusBeforeBusy) return;
		const el = focusBeforeBusy;
		focusBeforeBusy = null;
		tick().then(() => {
			if (focusLost()) focusFirst([el]);
		});
	});

	// A failed / dismissed payment surfaces its note: move focus there.
	let lastPhase = 'idle';
	$effect(() => {
		const p = phase;
		if (p === 'failed' && lastPhase !== 'failed') focusNote();
		lastPhase = p;
	});

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		const toCod = params.get('pay') === 'cod';
		if (toCod) method = 'cod';
		// The pending online order's own details first (this tab placed it: same phone → the COD order supersedes it),
		// then saved details for anything still empty.
		const pending = readPending();
		const pendingForm = pending ? readPendingForm(pending.no) : null;
		if (pendingForm) for (const k of Object.keys(EMPTY_FORM)) if (!form[k] && pendingForm[k]) form[k] = pendingForm[k];
		// A tap for this bag that never heard back (the page reloaded mid-request): it may have gone through.
		// Its details come back. COD: the next tap resolves it rather than placing a second order. Online:
		// its order is asked for now (flow.recall), so the quote counts the offer and last packs it holds as
		// this bag's own, and Pay either pays it (same details) or replaces it (changed ones).
		const bagSig = cartSignature(cartToItems(Cart.read()));
		const placing = readPlacing();
		if (placing && placing.sig === bagSig) {
			const b = placing.body;
			const was = { name: b.contact?.name, phone: String(b.contact?.phone ?? '').replace(/^\+91/, ''), email: b.contact?.email, address: b.address?.line1, city: b.address?.city, state: b.address?.state, pin: b.address?.pin };
			for (const k of Object.keys(EMPTY_FORM)) if (!form[k] && typeof was[k] === 'string' && was[k]) form[k] = was[k];
			if (b.consent?.marketing === true) marketing = true;
			if (b.method === 'cod') {
				method = 'cod';
				pageNote = { code: 'PLACING', message: 'Your last “Place order” may already have gone through. Tap it again — if it did, we’ll show you that order instead of placing a second one.', actions: [] };
			} else {
				if (b.method === 'upi' || b.method === 'card') method = b.method;
				recallUnheard(bagSig).then((o) => {
					if (o && pendingRef?.no === o.number) {
						pageNote = { code: 'PLACING', message: `Your last tap on Pay placed order ${o.number} — it’s waiting for payment. Tap Pay to finish; if you change your details first, they replace it.`, actions: [] };
					} else if (readPlacing()) {
						pageNote = { code: 'PLACING', message: 'Your last tap on Pay may already have placed your order. Tap Pay again — if it did, we’ll pick it up instead of starting a second one.', actions: [] };
					}
				});
			}
		}
		const saved = readSaved();
		if (saved) {
			for (const k of Object.keys(EMPTY_FORM)) if (!form[k] && saved[k]) form[k] = saved[k];
			saveDetails = true;
			savedShown = true;
		}
		if (toCod && pending && pending.cartSig && pending.cartSig === cartSignature(cartToItems(Cart.read()))) {
			switchedFrom = pending.no;
			pageNote = {
				code: 'COD_SWITCH',
				message: `Switched to Cash on Delivery — tap “Place order” to confirm. It replaces your unpaid order ${pending.no}.`,
				actions: []
			};
		}
		// A PIN typed (or autofilled) before the page's JS ran: its City / State prefill runs now, as on input.
		if (isValidPin(normalizePin(form.pin)) && (!form.city || !form.state)) onPinInput();
		readOffer()
			.then((o) => (offer = o))
			.catch(() => {})
			.finally(() => (offerRead = true));
		readSource().then((s) => (source = s || 'web'));
		mounted = true;
		loadLive();
		if (Object.keys(Cart.read()).length) {
			track('begin_checkout', { items: Object.values(Cart.read()).reduce((a, b) => a + b, 0) });
			tick().then(() => {
				if (motionOK() && summaryEl) {
					window.gsap.from(summaryEl.children, { y: 12, autoAlpha: 0, duration: 0.5, ease: 'power3.out', stagger: 0.03, clearProps: 'all' });
				}
			});
		}
		preloadOrderPage(); // after a payment (or Place order) /order must open even if the network blips
		return () => {
			quoter.destroy();
			flow.detach(); // a payment window still loading never opens over the page they went to
		};
	});
</script>

<svelte:head>
	<title>Wefeasto — Checkout</title>
	<link rel="preconnect" href="https://checkout.razorpay.com">
</svelte:head>

{#snippet fieldError(field)}{#if errors[field]}<p class="wf-field-error" id="{FIELD_IDS[field]}-err">{errors[field]}</p>{/if}{/snippet}

<div class="page-wrapper">
<div class="section"><div class="container">
<PendingOrderBanner hideNo={$fstate.order?.number ?? switchedFrom} onpayondelivery={switchToCod} codAvailable={mounted && codOk && !empty} />
<div class="wf-hero-stagger" id="wf-co-header"><div class="wf-chip">Checkout</div><div class="divider"></div><h1 class="heading-2">Where should breakfast go?</h1></div>
<div class="divider _42px mobile-24px"></div>
<form id="wf-checkout-form" class="wf-co-grid" novalidate onsubmit={onSubmit}>
<div class="wf-co-form">
<fieldset class="wf-co-fields" disabled={busy || undefined} data-wf-co-fields>
{#if savedShown}<p class="wf-form-note wf-co-saved" data-wf-saved>Welcome back — we filled in your saved details. <button type="button" class="wf-link-btn" data-wf-forget onclick={forgetMe}>Not you? Forget me</button></p>{/if}
<div class="wf-field"><label class="wf-label" for="wf-co-name">Full Name</label><input class="wf-input" id="wf-co-name" name="fullName" type="text" placeholder="Asha Kumar" autocomplete="name" required maxlength="80" bind:value={form.name} oninput={() => revalidate('name')} aria-invalid={errors.name ? 'true' : undefined} aria-describedby={errors.name ? 'wf-co-name-err' : undefined}>{@render fieldError('name')}</div>
<div class="wf-field"><label class="wf-label" for="wf-co-phone">Phone</label><input class="wf-input" id="wf-co-phone" name="phone" type="tel" inputmode="tel" placeholder="98765 43210" autocomplete="tel" required maxlength="20" bind:value={form.phone} oninput={() => { codBlock = null; revalidate('phone'); }} aria-invalid={errors.phone ? 'true' : undefined} aria-describedby={errors.phone ? 'wf-co-phone-err' : undefined}>{@render fieldError('phone')}</div>
<div class="wf-field"><label class="wf-label" for="wf-co-email">Email</label><input class="wf-input" id="wf-co-email" name="email" type="email" inputmode="email" placeholder="asha@example.com" autocomplete="email" required maxlength="254" bind:value={form.email} oninput={() => revalidate('email')} aria-invalid={errors.email ? 'true' : undefined} aria-describedby={errors.email ? 'wf-co-email-err' : undefined}>{@render fieldError('email')}<label class="wf-check wf-form-note" for="wf-co-consent"><input type="checkbox" id="wf-co-consent" name="marketing" bind:checked={marketing}><span>Send me refill reminders &amp; recipes. Unsubscribe anytime.</span></label></div>
<div class="wf-field"><label class="wf-label" for="wf-co-address">Address</label><textarea class="wf-textarea" id="wf-co-address" name="address" rows="3" placeholder="Flat, street, landmark" autocomplete="street-address" required maxlength="200" bind:value={form.address} oninput={() => revalidate('address')} aria-invalid={errors.line1 ? 'true' : undefined} aria-describedby={errors.line1 ? 'wf-co-address-err' : undefined}></textarea>{@render fieldError('line1')}</div>
<div class="wf-co-two">
<div class="wf-field"><label class="wf-label" for="wf-co-pin">PIN Code</label><input class="wf-input" id="wf-co-pin" name="pin" type="text" inputmode="numeric" pattern={'[0-9]{6}'} maxlength="7" placeholder="560001" autocomplete="postal-code" title="6-digit PIN code" required bind:value={form.pin} oninput={onPinInput} aria-invalid={errors.pin ? 'true' : undefined} aria-describedby={errors.pin ? 'wf-co-pin-err' : undefined}>{@render fieldError('pin')}</div>
<div class="wf-field"><label class="wf-label" for="wf-co-city">City</label><input class="wf-input" id="wf-co-city" name="city" type="text" placeholder="Bengaluru" autocomplete="address-level2" required maxlength="60" bind:value={form.city} oninput={() => onPinFieldEdit('city')} onblur={() => onPinFieldBlur('city')} aria-invalid={errors.city ? 'true' : undefined} aria-describedby={describedBy('city')}>{@render fieldError('city')}</div>
</div>
{#if pinAuto.city || pinAuto.state}<p class="wf-form-note wf-pin-hint" id="wf-co-pin-hint" data-wf-pin-hint>Filled in from your PIN — change it if it’s not right. <span class="wf-pin-credit">PIN data © <a href="https://www.geonames.org" target="_blank" rel="noopener noreferrer">GeoNames</a> (CC BY 4.0)</span></p>{/if}
<div class="wf-field"><label class="wf-label" for="wf-co-state">State</label><select class="wf-select" id="wf-co-state" name="state" autocomplete="address-level1" required bind:value={form.state} onchange={() => onPinFieldEdit('state')} onblur={() => onPinFieldBlur('state')} aria-invalid={errors.state ? 'true' : undefined} aria-describedby={describedBy('state')}><option value="">Choose your state</option>{#each INDIAN_STATES as s (s)}<option value={s}>{s}</option>{/each}</select>{@render fieldError('state')}</div>
<label class="wf-check wf-form-note wf-co-save" for="wf-co-save"><input type="checkbox" id="wf-co-save" name="saveDetails" bind:checked={saveDetails}><span>Save my details on this device for faster checkout</span></label>
<div class="divider _8px"></div>
<h3 class="wf-co-subhead">Payment</h3>
<div class="wf-pay-pills" role="radiogroup" aria-label="Payment method">
<label class="wf-pay-pill"><input type="radio" name="wf-pay" value="upi" bind:group={method} onchange={() => flow.reset()}>UPI</label>
<label class="wf-pay-pill"><input type="radio" name="wf-pay" value="card" bind:group={method} onchange={() => flow.reset()}>Card</label>
<label class="wf-pay-pill" class:wf-pill-off={!codOk && !empty}><input type="radio" name="wf-pay" value="cod" bind:group={method} disabled={(!codOk && !empty) || undefined} aria-describedby={codReason ? 'wf-co-cod-reason' : undefined} onchange={() => flow.reset()}>Cash on Delivery</label>
</div>
{#if codReason}<p class="wf-form-note wf-co-cod-reason" id="wf-co-cod-reason" data-wf-cod-reason>{codReason}</p>{/if}
</fieldset>
<p class="wf-form-note wf-co-trust" data-wf-trust><span>Secure payments by Razorpay · UPI · Cards · NetBanking</span>{#if help} <span aria-hidden="true">·</span> <a href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Questions? WhatsApp us</a>{/if}</p>
<div class="divider _32px mobile-24px"></div>
{#if note}<CheckoutNote message={note.message} actions={note.actions || []} help={note.help || null} code={note.code} bind:element={noteEl} />{/if}
<noscript><p class="wf-form-note">Checkout needs JavaScript — please turn it on to place your order.</p></noscript>
{#if bagBlocked}<p class="wf-form-note wf-co-blocked" data-wf-blocked>Something in your bag needs a quick fix before you can pay — see <a href="#wf-co-summary">your order summary</a>.</p>{/if}
{#if mounted && !empty && !qv.allBlocked}<p class="wf-co-mobile-total" data-wf-mobile-total>{mobileTotal}</p>{/if}
<PayButton label={payLabel} {busy} {busyLabel} disabled={blocked} />
</div>
<div class="wf-summary" id="wf-co-summary" class:wf-loading={quoting} aria-busy={quoting ? 'true' : undefined} bind:this={summaryEl}>
<h3 class="wf-summary-heading">Order Summary</h3>
<div class="wf-summary-divider"></div>
{#if !mounted}
<p class="p-large">Loading your bag…</p>
{:else if empty}
<p class="p-large">Your bag is empty — add something tasty first.</p>
<div class="divider"></div>
<a href="/shop" class="button secondary w-inline-block"><div>Browse the Shop</div></a>
{:else}
{#each rows as r (r.slug)}{#if r.issue}<div class="wf-co-issue" data-wf-co-issue={r.issue.code} data-wf-co-line={r.slug}><div class="wf-summary-row"><span>{r.name} × {r.qty}</span><span class="wf-co-issue-mark">—</span></div><p class="wf-cart-issue">{checkoutErrorCopy(r.issue.code, { ...r.issue, name: r.name })}</p><div class="wf-co-issue-actions">{#if r.issue.suggestedQty > 0 && r.issue.suggestedQty < r.qty}<button type="button" class="wf-chip wf-chip-small wf-co-issue-btn" data-wf-reduce={r.slug} onclick={() => reduceLine(r.slug, r.issue.suggestedQty)}>Reduce to {r.issue.suggestedQty}</button>{/if}<button type="button" class="wf-chip wf-chip-small wf-co-issue-btn" data-wf-remove={r.slug} onclick={() => removeLine(r.slug)}>Remove</button></div></div>{:else if r.line}<div class="wf-summary-row" data-wf-co-line={r.slug}><span>{r.name} × {r.line.qty}</span><span>{formatPaise(r.line.lineTotalPaise)}</span></div>{/if}{/each}
{#if !qv.allBlocked}
<div class="wf-summary-divider"></div>
<div class="wf-summary-row"><span>Subtotal</span><span data-wf-subtotal>{formatPaise(q.subtotalPaise)}</span></div>
<div class="wf-summary-row"><span>Delivery</span><span data-wf-delivery class:wf-free={q.isFreeDelivery}>{q.isFreeDelivery ? 'FREE' : formatPaise(q.deliveryPaise)}</span></div>
{#if method === 'cod' && q.codFeePaise > 0}<div class="wf-summary-row"><span>Cash on delivery fee</span><span data-wf-cod-fee>{formatPaise(q.codFeePaise)}</span></div>{/if}
{#if q.discountPaise > 0}<div class="wf-summary-row wf-co-discount"><span>Discount{shownServerQ?.coupon?.code ? ' (' + shownServerQ.coupon.code + ')' : ''}</span><span data-wf-discount>−{formatPaise(q.discountPaise)}</span></div>{/if}
{/if}
{#if offer}<div class="wf-offer" data-wf-offer={offer.code} data-wf-offer-state={couponState}><p class="wf-offer-text"><span class="wf-chip wf-chip-small">Offer {offer.code}</span> <span>{couponState === 'applied' ? 'applied' : couponState === 'invalid' ? couponReasonCopy(shownServerQ.couponError.reason, { minSubtotalPaise: shownServerQ.couponError.minSubtotalPaise, subtotalPaise: q.subtotalPaise }) : 'will be applied when you pay'}</span></p><button type="button" class="wf-offer-remove" aria-label="Remove offer {offer.code}" disabled={busy || undefined} onclick={removeOffer}>×</button></div>{/if}
{#if !qv.allBlocked}
<div class="wf-summary-note" data-wf-note>{noteText}</div>
<fieldset class="wf-co-fields" disabled={busy || undefined}><TopUp bag={$cart} /></fieldset>
<div class="wf-summary-divider"></div>
<div class="wf-summary-row wf-summary-total"><span>Total</span><span data-wf-total>{formatPaise(q.totalPaise)}</span></div>
{/if}
{#if q.orderError && q.orderError.code !== 'EMPTY_CART'}<p class="wf-cart-issue" data-wf-order-error={q.orderError.code}>{checkoutErrorCopy(q.orderError.code, q.orderError)}</p>{/if}
{/if}
</div>
</form>
{#if mounted}<p class="wf-sr-only" role="status" aria-live="polite" aria-atomic="true" data-wf-co-live>{live}</p>{/if}
</div></div>
</div>
