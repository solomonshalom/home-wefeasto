/*
 * The checkout flow (roadmap M2), as a small state machine with every side
 * effect injected — the page, the pending-order banner and /order all drive
 * one of these, and the unit tests drive it with a fake API and a fake
 * Razorpay.
 *
 *   idle ─submit→ submitting ─COD→ leaving (/order)
 *                    │ online
 *                    ▼
 *                 opening (pending written, checkout.js loaded) → paying (modal open)
 *                    │                                               │ handler
 *                    │ script/open failure, nothing shown in 15 s,   ▼
 *                    │ window gone 3 s with no callback
 *                    ▼                               verifying → leaving (/order polls)
 *                 failed ◀── dismissed (after any in-modal payment.failed)
 *                    │ retry (POST /checkout/retry → new Razorpay order) → opening …
 *   error: the API refused (field errors, price changed, sold out, …) — see errors.js
 *
 * Guarantees:
 * - one request in flight: a double tap is ignored while busy;
 * - the Idempotency-Key is tied to the cart + form (storage.js), so a
 *   replayed tap after a timeout or a reload gets the same order back;
 * - wefeasto_pending is written BEFORE the payment window opens;
 * - a tap that never heard back (wefeasto_placing, COD or online) is resolved
 *   before anything else is placed for that bag: never a second order for
 *   one tap, never a checkout refused over the customer's own unseen order
 *   (place(), recall());
 * - the bag is never touched here (the /order page subtracts on confirmed);
 * - after `handler` fires we always go to /order, even if verify failed:
 *   the payment may be real, and /order polls the server's truth.
 */
import { writable, get } from 'svelte/store';
import { isConfirmed } from '$shared/order-status.js';
import { paymentReasonKind, paymentReasonCopy } from '$shared/errors.js';
import { describeError, NO_MONEY_TAKEN, MONEY_UNSURE, mayAuthoriseLate } from './errors.js';
import { attemptOf } from './request.js';
import {
	idempotencyKeyFor,
	adoptIdempotencyKey,
	noteIdempotentOrder,
	forgetIdempotencyKey,
	writePlacing,
	readPlacing,
	clearPlacing,
	writePending,
	readPending,
	clearPending,
	markPendingUnpaid,
	writeKept,
	tokenFor,
	markPlaced,
	browserEnv
} from './storage.js';
import { keptRecord } from './kept.js';
import { buildRazorpayOptions, isPaymentInit, WATCHDOG_MS } from './razorpay.js';
import { orderUrl, fetchStatus } from './order.js';

export { NO_MONEY_TAKEN, MONEY_UNSURE };
export const SCRIPT_FAILED = 'Couldn’t load payments. Retry, or choose Pay on delivery.';
export const OPEN_FAILED = 'The payment window didn’t open. Retry, or choose Pay on delivery.';
export const CLOSED_UNHEARD = 'The payment window closed before we heard back. If you paid, it will show as confirmed in a moment — please don’t pay twice.';

/** How often the open window is checked; how long it may be gone (no callback) before we say so. */
export const MONITOR_MS = 1000;
export const CLOSED_GRACE_MS = 3000;

/** Phases where a new tap must be ignored. */
export const BUSY = Object.freeze(['submitting', 'opening', 'paying', 'verifying', 'leaving']);

/**
 * The busy Pay / Try again label for a flow phase (storefront-checkout.md §4).
 * 'leaving' after an online payment (verify answered, a quiet look found it
 * paid, ALREADY_PAID) is on its way to /order: it keeps saying the payment is
 * being confirmed — never "Opening payment…" to someone who has just paid.
 * @param {string} phase
 * @param {string | null} method
 */
export function busyLabel(phase, method) {
	if (phase === 'verifying') return 'Confirming your payment…';
	if (method === 'cod') return 'Placing your order…';
	if (phase === 'leaving') return 'Confirming your payment…';
	if (phase === 'paying') return 'Waiting for payment…';
	return 'Opening payment…';
}

/**
 * An online checkout replayed (same Idempotency-Key) onto an order in one of
 * these states answers `payment: null`: nothing is left to pay on it (the
 * reservation lapsed, or a newer order for the bag cancelled it). Sending the
 * customer to its /order page would show "failed" with a Try again that lands
 * back here, so the flow drops the key and places a new order instead. Any
 * other replay without a payment (paid, COD, a payment still settling, under
 * review, refunded) goes to /order, which shows the truth.
 */
export const DEAD_REPLAY = Object.freeze(['expired', 'cancelled']);

/**
 * An unheard ONLINE tap's order in one of these states can be replaced by the next checkout of the
 * bag (supersede: still unpaid, or already dead). Any other (money reached it, under review) is kept.
 */
export const REPLACEABLE = Object.freeze(['pending_payment', 'payment_failed', 'expired', 'cancelled']);

/**
 * The order a checkout answer names ({number, token, status, totalPaise}): the order itself, or
 * the one 503 PAYMENTS_UNAVAILABLE kept. Null when there is none.
 * @param {{ok: boolean, data: any, error: any}} res
 */
export function orderOf(res) {
	const o = res?.ok ? res.data?.order : res?.error?.code === 'PAYMENTS_UNAVAILABLE' ? res.error.details?.order : null;
	return o && typeof o.number === 'string' && o.number && typeof o.token === 'string' && o.token ? o : null;
}

/**
 * Must the attempt for bag `a` (body `body`) resolve the unheard tap `p` (wefeasto_placing) first?
 * - the same bag: always (the same details replay; other details find the order it made);
 * - a COD tap and a bag sharing a product with it (a top-up after the lost answer): its order may
 *   exist and can't be superseded, so this tap must not become a second shipment of that bag.
 * An online tap for another bag is left alone (supersede keys on the exact bag; it expires).
 * @param {{sig: string, body: any} | null} p
 * @param {{cartSig: string}} a
 * @param {any} body
 */
export function mustResolve(p, a, body) {
	if (!p || !a) return false;
	if (p.sig === a.cartSig) return true;
	if (p.body?.method !== 'cod') return false;
	const had = new Set((p.body.items || []).map((i) => i && i.slug));
	return (body?.items || []).some((i) => i && had.has(i.slug));
}

/**
 * Did the checkout `body` (just accepted) make the server cancel `prev`, the
 * wefeasto_pending order for the same bag? Only then may the device forget
 * it. A guest checkout supersedes an unpaid online order of the same bag only
 * when it names it (`supersede` {number, token}, the ref the quote carried):
 * the token proves it's the customer's own, whatever the phone (SUP-PHONE-1).
 * The same phone alone replaces nothing any more (SUP-OWN-1: a phone is no
 * secret), so without the ref that order stays payable and its "waiting for
 * payment" banner stays. (A signed-in customer's own order the server did
 * cancel keeps its entry until the banner's status check drops it.)
 * @param {{no: string, t: string}} prev
 * @param {any} body  buildCheckoutBody's output
 */
export function supersedes(prev, body) {
	const ref = body && body.supersede;
	return !!ref && ref.number === prev.no && ref.token === prev.t;
}

/**
 * @param {{
 *   api: (path: string, opts?: any) => Promise<{ok: boolean, status: number, data: any, error: any}>,
 *   loadScript: (src: string) => Promise<any>,
 *   navigate: (url: string) => void,
 *   track?: (name: string, props?: any) => void,
 *   newKey: () => string,
 *   env?: any,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   watchRender?: () => {rendered: () => boolean, stop: () => void},
 *   watchdogMs?: number,
 *   onOrder?: (order: any) => void,
 * }} deps
 */
export function createCheckoutFlow(deps) {
	const {
		api,
		loadScript,
		navigate,
		track = () => {},
		newKey,
		env = browserEnv,
		timers = globalThis,
		watchRender = () => ({ rendered: () => false, stop() {} }),
		watchdogMs = WATCHDOG_MS,
		onOrder = () => {}
	} = deps;

	/** @type {import('svelte/store').Writable<{phase: string, error: any, failure: any, order: any, method: string | null}>} */
	const state = writable({ phase: 'idle', error: null, failure: null, order: null, method: null });
	const set = (patch) => state.update((s) => ({ ...s, ...patch }));

	let order = null; // {number, token, totalPaise?}
	let attempt = null; // {cartSig, formHash} of the order above
	let method = null;
	let cartSig = '';
	let session = 0; // bumps per payment window: callbacks from an older one are ignored
	let detached = false; // the page driving this flow is gone (detach())
	let recalling = null; // a recall() in flight
	let recalled = null; // {number, token, sig}: the unpaid online order recall() found for bag `sig`

	const busy = () => BUSY.includes(get(state).phase);

	function fail(failure) {
		set({ phase: 'failed', failure, error: null });
	}

	/**
	 * The order a 'goto-order' refusal is about when this flow placed none itself: a checkout that
	 * named this bag's unpaid order (the supersede ref, e.g. /checkout?pay=cod from the pending banner
	 * or /order) after the UPI app paid it meanwhile answers 409 ALREADY_PAID {order: DTO}. Its token
	 * is the one this device holds for that number — the ref the checkout sent, else wefeasto_pending /
	 * the last order. None known → null (the plain note stays).
	 * @param {any} res
	 * @param {any} [body]
	 */
	function namedOrder(res, body) {
		const no = res.error?.details?.order?.number;
		if (typeof no !== 'string' || !no) return null;
		const ref = body && body.supersede;
		if (ref && ref.number === no && typeof ref.token === 'string' && ref.token) return { number: no, token: ref.token };
		const t = tokenFor(no, env);
		return t ? { number: no, token: t } : null;
	}

	function refuse(res, stage, body = null) {
		const ui = describeError(res.error?.code, res.error?.details, { stage, status: res.status });
		// Try again refused for the bag itself (the reservation lapsed and the stock went: OUT_OF_STOCK,
		// QTY_LIMIT, UNAVAILABLE): that order is done. Forget it and its key, so the next tap places a NEW
		// order — even for the same bag once stock is back — instead of replaying the expired one.
		const orderDone = stage === 'retry' && ui.kind === 'lines';
		if (ui.actions.includes('new-key') || orderDone) forgetIdempotencyKey(env);
		if (orderDone) {
			order = null;
			attempt = null;
		}
		if (ui.kind === 'payments') track('payment_failed', { code: ui.code });
		const target = ui.actions.includes('goto-order') ? order || namedOrder(res, body) : null;
		if (target) {
			set({ phase: 'leaving', error: null });
			navigate(orderUrl(target.number, target.token));
			return { error: ui, order: target };
		}
		set({ phase: 'error', error: ui, failure: null });
		return { error: ui };
	}

	/**
	 * Place the order. `body` is request.js buildCheckoutBody's output.
	 * If this exact attempt already made an order whose payment didn't go
	 * through, this is a retry of that order instead (a fresh Razorpay order).
	 */
	async function submit(body) {
		if (busy()) return { ignored: true };
		const a = attemptOf(body);
		if (order && attempt && a.cartSig === attempt.cartSig && a.formHash === attempt.formHash && get(state).phase === 'failed') {
			return retry();
		}
		method = body.method;
		cartSig = a.cartSig;
		set({ phase: 'submitting', error: null, failure: null, method });
		return place(body, a, false);
	}

	const post = (b, key) => api('/store/checkout', { method: 'POST', body: b, headers: { 'Idempotency-Key': key }, timeoutMs: 20000 });

	/** A body built before recall() found this bag's unpaid order names it (the page's ref comes a step later). */
	function namePending(body, a) {
		if (body.supersede || !recalled || recalled.sig !== a.cartSig) return body;
		return { ...body, supersede: { number: recalled.number, token: recalled.token } };
	}

	/**
	 * An online tap on bag `sig` that never heard back (wefeasto_placing: the answer was lost, or the
	 * page reloaded mid-request): ask for its order again — that tap's own request under its key, which
	 * the server replays (or places, if the tap never arrived: the order that tap asked for). Nothing
	 * opens. An unpaid order found becomes this bag's wefeasto_pending, so the quote and the next
	 * checkout name it (`supersede`): its offer and last packs count as this bag's own, and a checkout
	 * with changed details replaces it. COD taps are never recalled (a replay would commit and email an
	 * order the customer may be about to correct): the next tap resolves them (place()).
	 * Resolves to the order found ({number, token, status}) or null.
	 * @param {string} sig  the bag on screen
	 */
	function recall(sig) {
		if (recalling) return recalling;
		const p = readPlacing(env);
		if (!p || p.body.method === 'cod' || !sig || p.sig !== sig) return Promise.resolve(null);
		recalling = (async () => {
			const res = await post(p.body, p.k);
			const o = orderOf(res);
			const still = readPlacing(env)?.k === p.k; // a tap may have moved on meanwhile: its record is its own
			if (!o) {
				// Refused outright (not a clash of keys, not a rate limit): that request made no order.
				const none = res.status >= 400 && res.status < 500 && res.status !== 429 && res.error?.code !== 'IDEMPOTENCY_MISMATCH';
				if (none && still) clearPlacing(env);
				return null;
			}
			if (still) clearPlacing(env);
			noteIdempotentOrder(p.k, o.number, env);
			markPlaced(o.number, env);
			if (o.status === 'pending_payment' || o.status === 'payment_failed') {
				recalled = { number: o.number, token: o.token, sig: p.sig };
				// Its answer never arrived, so no window ever opened for it here: nothing is paying it.
				writePending({ no: o.number, t: o.token, cartSig: p.sig, unpaid: true }, env);
			}
			return { number: o.number, token: o.token, status: o.status };
		})().finally(() => {
			recalling = null;
		});
		return recalling;
	}

	/**
	 * POST /store/checkout; `fresh`: this is the one new-key try after a dead replay.
	 *
	 * A tap on this bag that never heard back (wefeasto_placing: the page reloaded mid-request, the
	 * answer was lost) may have made an order this tab doesn't know about. So this attempt goes under
	 * THAT tap's key first: the server replays the order it made (same details), places this one (it
	 * never arrived), or answers IDEMPOTENCY_MISMATCH (it made an order, details changed since). Then
	 * that tap's own request, replayed under its key, names the order, and:
	 * - an unpaid online order is REPLACED: this checkout names it (`supersede`, the only proof a guest
	 *   has since SUP-OWN-1) under a key of its own, so its offer and last packs are this checkout's
	 *   own and it is cancelled — never "first order only" / "just sold out" over the customer's own
	 *   unseen order;
	 * - a COD order (supersede never replaces one) or one money reached is KEPT: the customer lands on
	 *   it, and /order says what it holds (wefeasto_kept) — the changes made since are not in it.
	 * Never a second order for one tap.
	 */
	async function place(body, a, fresh) {
		if (recalling) await recalling; // a recall() in flight may name this bag's order (below)
		const earlier = fresh ? null : readPlacing(env);
		const inflight = mustResolve(earlier, a, body) ? earlier : null;
		body = namePending(body, a);
		let key = inflight ? adoptIdempotencyKey(a, inflight.k, env) : idempotencyKeyFor(a, { newKey, env });
		if (!inflight) writePlacing({ k: key, sig: a.cartSig, body }, env);
		let res = await post(body, key);
		if (!res.ok && inflight && res.error?.code === 'IDEMPOTENCY_MISMATCH') {
			const was = await post(inflight.body, key);
			const o = orderOf(was);
			if (!o) return refuse(was, 'checkout', body); // not heard: the tap stays open for the next one
			if (inflight.body.method !== 'cod' && inflight.sig === a.cartSig && REPLACEABLE.includes(o.status)) {
				writePending({ no: o.number, t: o.token, cartSig: inflight.sig }, env);
				body = { ...body, supersede: { number: o.number, token: o.token } };
				forgetIdempotencyKey(env);
				key = idempotencyKeyFor(a, { newKey, env });
				writePlacing({ k: key, sig: a.cartSig, body }, env);
				res = await post(body, key);
			} else {
				writeKept(keptRecord(o.number, inflight.body, body), env);
				body = inflight.body;
				a = attemptOf(body);
				method = body.method;
				cartSig = a.cartSig; // the bag that order holds (a top-up since is not in it)
				adoptIdempotencyKey(a, key, env);
				set({ method });
				res = was;
			}
		}
		// Heard back: an order, or a refusal that made none (4xx), or the kept order of PAYMENTS_UNAVAILABLE.
		// A network failure or another 5xx leaves it open: the order may exist.
		if (res.ok || (res.status >= 400 && res.status < 500) || res.error?.code === 'PAYMENTS_UNAVAILABLE') clearPlacing(env);
		if (!res.ok) {
			if (res.error?.code === 'PAYMENTS_UNAVAILABLE' && body.method !== 'cod') keep(res.error.details?.order, a, key);
			return refuse(res, 'checkout', body);
		}
		const o = res.data && res.data.order;
		if (!o || typeof o.number !== 'string' || typeof o.token !== 'string') {
			set({ phase: 'error', error: describeError('INTERNAL', null, { stage: 'checkout' }) });
			return { error: get(state).error };
		}
		const payment = res.data.payment;
		if (body.method !== 'cod' && !payment && DEAD_REPLAY.includes(o.status)) {
			// The key replayed an order nothing can be paid on any more: never its failed /order view.
			forgetIdempotencyKey(env);
			order = null;
			attempt = null;
			if (!fresh) return place(body, a, true);
			const ui = { ...describeError('NOT_RETRYABLE', null, { stage: 'checkout' }), actions: ['new-key', 'refresh-quote'] };
			set({ phase: 'error', error: ui, failure: null });
			return { error: ui };
		}
		order = { number: o.number, token: o.token, totalPaise: o.totalPaise };
		attempt = a;
		if (recalled && body.supersede?.number === recalled.number) recalled = null; // named, so replaced
		noteIdempotentOrder(key, order.number, env); // the key retires once this order is seen confirmed
		markPlaced(order.number, env); // /order runs the bag subtraction + 'purchase' only on this device
		// A wefeasto_pending for another order of this same bag goes only when the server just cancelled it
		// (this checkout named it: SUP-OWN-1). Otherwise it’s still payable: keep its banner.
		const prev = readPending(env);
		if (prev && prev.no !== order.number && prev.cartSig && prev.cartSig === a.cartSig && supersedes(prev, body)) clearPending(env);
		set({ order });
		try {
			onOrder(order);
		} catch (e) {
			/* saving details is best-effort */
		}
		if (body.method === 'cod' || !payment) {
			set({ phase: 'leaving' });
			navigate(orderUrl(order.number, order.token));
			return { cod: body.method === 'cod', order };
		}
		return pay(payment);
	}

	/**
	 * 503 PAYMENTS_UNAVAILABLE: the gateway was down, but the order was placed and is kept (stock held,
	 * no Razorpay order yet). It is this bag's unpaid online order like any other: wefeasto_pending names
	 * it, so "Pay on delivery instead" sends it as the supersede ref (since SUP-OWN-1 the only proof a
	 * guest checkout has that it's theirs to replace) and the banner can still find it; Pay again replays
	 * the key onto it.
	 */
	function keep(o, a, key) {
		if (!o || typeof o.number !== 'string' || !o.number || typeof o.token !== 'string' || !o.token) return;
		order = { number: o.number, token: o.token, totalPaise: o.totalPaise };
		attempt = a;
		noteIdempotentOrder(key, order.number, env);
		markPlaced(order.number, env);
		// No payment window will open for it until Pay again: nothing is taking money (/order: "waiting").
		writePending({ no: order.number, t: order.token, cartSig: a.cartSig, unpaid: true }, env);
		set({ order });
		try {
			onOrder(order);
		} catch (e) {
			/* saving details is best-effort */
		}
	}

	/** Pay an existing order again (banner, /order "Try again", the failure note). */
	async function retry() {
		if (busy() || !order) return { ignored: true };
		set({ phase: 'submitting', error: null, failure: null });
		const res = await api('/store/checkout/retry', {
			method: 'POST',
			body: { number: order.number, token: order.token },
			timeoutMs: 20000
		});
		if (!res.ok) return refuse(res, 'retry');
		const o = res.data && res.data.order;
		if (o && typeof o.token === 'string') order = { ...order, token: o.token };
		return pay(res.data && res.data.payment);
	}

	/**
	 * Start from an order this page didn't create (pending banner, /order). `sig`: the bag the order
	 * holds; without one, wefeasto_pending's for the same order is kept — pay() rewrites that entry, and
	 * an empty signature would lose which bag the unpaid order holds (supersede, PI-SF-1).
	 */
	function adopt({ number, token }, m = 'upi', sig = '') {
		order = { number, token };
		attempt = null;
		method = m;
		const prev = sig ? null : readPending(env);
		cartSig = sig || (prev && prev.no === number ? prev.cartSig : '');
		set({ order, method });
	}

	async function pay(payment) {
		const my = ++session;
		if (!isPaymentInit(payment)) {
			track('payment_failed', { code: 'BAD_PAYMENT_INIT' });
			fail({ code: 'OPEN_FAILED', message: OPEN_FAILED });
			return { failed: 'OPEN_FAILED' };
		}
		// Before anything opens: if the tab dies mid-payment, the banner and /order can still find it.
		// A fresh entry: a payment may be in flight from here on (/order says "confirming").
		writePending({ no: order.number, t: order.token, cartSig }, env);
		// Once a window is known to have taken no money (never opened, dismissed with nothing that could
		// still authorise), /order says "Waiting for payment" and offers to pay instead.
		const payingNo = order.number;
		const noMoney = () => markPendingUnpaid(payingNo, env);
		// The page left while the order was being placed: it stays payable (the banner finds it), but no
		// window opens over whatever page the customer is on now.
		if (detached) {
			noMoney();
			set({ phase: 'idle', error: null, failure: null });
			return { stale: true };
		}
		set({ phase: 'opening', error: null, failure: null });
		let Razorpay;
		try {
			Razorpay = await loadScript(payment.checkoutScript);
		} catch (e) {
			if (my !== session) return { stale: true };
			noMoney();
			track('payment_failed', { code: 'SCRIPT_LOAD' });
			fail({ code: 'SCRIPT_LOAD', message: SCRIPT_FAILED });
			return { failed: 'SCRIPT_LOAD' };
		}
		if (my !== session) return { stale: true };

		let settled = false;
		let lastFailure = null;
		let watchdog = null;
		let watch = null;
		const settle = () => {
			if (settled || my !== session) return false;
			settled = true;
			if (watchdog) timers.clearTimeout(watchdog);
			watch?.stop();
			return true;
		};
		const current = { ...order };

		const handler = async (resp) => {
			if (!settle()) return;
			set({ phase: 'verifying' });
			const r = resp || {};
			await api('/store/checkout/verify', {
				method: 'POST',
				body: {
					number: current.number,
					token: current.token,
					razorpay_order_id: r.razorpay_order_id,
					razorpay_payment_id: r.razorpay_payment_id,
					razorpay_signature: r.razorpay_signature
				},
				timeoutMs: 20000
			});
			// Whatever verify said: the webhook is the source of truth and /order polls it.
			set({ phase: 'leaving' });
			navigate(orderUrl(current.number, current.token));
		};

		// They may have finished in their UPI app before the window went away: one quiet look.
		const quietLook = () =>
			fetchStatus(api, current.number, current.token).then((s) => {
				if (s.ok && isConfirmed(s.dto.status) && my === session && get(state).phase === 'failed') {
					set({ phase: 'leaving' });
					navigate(orderUrl(current.number, current.token));
				}
			});

		const onDismiss = () => {
			if (!settle()) return;
			track('checkout_dismissed', { number: current.number });
			const kind = paymentReasonKind(lastFailure?.reason);
			if (kind === 'already_paid') {
				set({ phase: 'leaving' });
				navigate(orderUrl(current.number, current.token));
				return;
			}
			if (kind === 'pending') {
				fail({ code: 'PENDING', message: paymentReasonCopy(lastFailure.reason), pending: true });
			} else {
				// A timed-out UPI payment can still be authorised late: don't promise "no money was taken".
				const message = mayAuthoriseLate(lastFailure?.reason) ? MONEY_UNSURE : NO_MONEY_TAKEN;
				if (message === NO_MONEY_TAKEN) noMoney();
				fail({ code: lastFailure ? 'FAILED' : 'DISMISSED', message, reason: lastFailure?.reason || null });
			}
			quietLook();
		};

		let rzp;
		try {
			rzp = new Razorpay(buildRazorpayOptions(payment, { method, handler, onDismiss }));
			// A failed attempt keeps the modal open for an in-modal retry on the same order.
			rzp.on('payment.failed', (resp) => {
				const e = (resp && resp.error) || {};
				lastFailure = { code: e.code || null, reason: e.reason || null };
				track('payment_failed', { code: e.reason || e.code || 'unknown' });
			});
			watch = watchRender();
			rzp.open();
		} catch (e) {
			watch?.stop();
			settled = true;
			noMoney();
			track('payment_failed', { code: 'OPEN_FAILED' });
			fail({ code: 'OPEN_FAILED', message: OPEN_FAILED });
			return { failed: 'OPEN_FAILED' };
		}
		if (!settled) set({ phase: 'paying' });
		// The window must show up within watchdogMs (a bad key renders nothing and fires nothing), and a
		// window that showed and then went away without any callback must not leave the page waiting.
		let waited = 0;
		let everShown = false;
		let goneFor = 0;
		const monitor = () => {
			watchdog = null;
			if (settled || my !== session) return;
			waited += MONITOR_MS;
			if (watch.rendered()) {
				everShown = true;
				goneFor = 0;
			} else if (everShown || watch.seen?.()) {
				everShown = true;
				goneFor += MONITOR_MS;
				if (goneFor >= CLOSED_GRACE_MS) {
					settle();
					track('payment_failed', { code: 'CLOSED' });
					fail({ code: 'CLOSED', message: CLOSED_UNHEARD, pending: true });
					quietLook();
					return;
				}
			} else if (waited >= watchdogMs) {
				settle();
				try {
					rzp.close();
				} catch (e) {
					/* nothing on screen anyway */
				}
				noMoney(); // nothing ever rendered: no way to have paid
				track('payment_failed', { code: 'WATCHDOG' });
				fail({ code: 'OPEN_FAILED', message: OPEN_FAILED });
				return;
			}
			watchdog = timers.setTimeout(monitor, MONITOR_MS);
		};
		watchdog = timers.setTimeout(monitor, MONITOR_MS);
		return { opened: true };
	}

	/**
	 * Back to idle (the customer edits the form after an error, or picks another
	 * method). Ignored while busy unless `force` (a page that stays put after
	 * 'leaving', e.g. /order looking again after a retry's payment).
	 */
	function reset(force = false) {
		if (busy() && !force) return;
		if (force) session++; // callbacks from a window still open are ignored from here on
		set({ phase: 'idle', error: null, failure: null });
	}

	/**
	 * The page driving this flow went away (the customer left /checkout, the bag, /order). A payment
	 * window that hasn't opened yet never will — once checkout.js lands it would pop up over whatever
	 * page they're on now, for an amount (and maybe a bag) that page doesn't show; an order still being
	 * placed stops before its window too. The order stays recoverable: wefeasto_pending is written
	 * before the script loads (the banner, the order email). A window already open stays live — they
	 * may be mid-payment, and its callbacks still go to /order — and so does a flow already verifying
	 * or leaving for /order. A COD order placed by the tap still shows (/order): that is the order they
	 * asked for, not a request for money. A dismissed window's quiet look no longer navigates.
	 */
	function detach() {
		detached = true;
		const p = get(state).phase;
		if (p !== 'paying' && p !== 'verifying' && p !== 'leaving') session++;
	}

	return {
		state: { subscribe: state.subscribe },
		submit,
		retry,
		recall,
		adopt,
		reset,
		detach,
		busy,
		get order() {
			return order;
		},
		/** {cartSig, formHash} the flow's order was placed with (null: none, or adopted). */
		get attempt() {
			return order ? attempt : null;
		},
		/** The cart signature of the order above (the bag it was placed / adopted for). */
		get cartSig() {
			return order ? cartSig : '';
		}
	};
}
