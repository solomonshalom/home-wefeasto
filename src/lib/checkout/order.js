/*
 * /order?no=&t= (roadmap M3) — the parts that are not markup: reading the
 * arrival, fetching GET /api/store/orders/status, mapping a status to what
 * the page shows, the polling schedules (and the watcher that switches
 * between them), the failed-state copy, when "Pay on delivery instead" is
 * safe, and the once-per-order side effects.
 */
import { isConfirmed, isOrderNumber } from '$shared/order-status.js';
import { paymentReasonKind } from '$shared/errors.js';
import { cartSignature } from '$shared/cart-links.js';
import { isToken, isSeen, markSeen, writeLastOrder, readPending, clearPendingFor, consumePlaced, placedAt, itemsMap, browserEnv } from './storage.js';
import { NO_MONEY_TAKEN, MONEY_UNSURE, mayAuthoriseLate } from './errors.js';

/** /order link for an order (the token rides in the query; the page sets no-referrer). */
export function orderUrl(no, t) {
	return '/order?no=' + encodeURIComponent(no) + '&t=' + encodeURIComponent(t);
}

/**
 * What the URL says: `no`, `t`, and a redirect-mode failure
 * (`&payment=failed&reason=<razorpay error.reason>` from the CMS callback).
 * Anything malformed reads as missing.
 * @param {string} search  window.location.search
 */
export function parseArrival(search) {
	let q;
	try {
		q = new URLSearchParams(typeof search === 'string' ? search : '');
	} catch (e) {
		q = new URLSearchParams();
	}
	const no = q.get('no');
	const t = q.get('t');
	const reason = (q.get('reason') || '').trim().toLowerCase();
	return {
		no: isOrderNumber(no) ? no.trim() : null,
		t: isToken(t) ? t : null,
		failed: q.get('payment') === 'failed',
		reason: /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null
	};
}

/** A usable OrderStatusDTO (SPEC §6)? */
export function isOrderDTO(d) {
	return !!d && typeof d === 'object' && isOrderNumber(d.number) && typeof d.status === 'string';
}

/**
 * GET /api/store/orders/status. Accepts the DTO bare or as {order}.
 * @returns {Promise<{ok: true, dto: any} | {ok: false, code: string, status: number}>}
 */
export async function fetchStatus(api, no, t, opts = {}) {
	const res = await api('/store/orders/status?no=' + encodeURIComponent(no) + '&t=' + encodeURIComponent(t), {
		timeoutMs: 8000,
		...opts
	});
	if (res.ok) {
		const dto = res.data && typeof res.data === 'object' && res.data.order ? res.data.order : res.data;
		return isOrderDTO(dto) ? { ok: true, dto } : { ok: false, code: 'BAD_RESPONSE', status: res.status };
	}
	return { ok: false, code: res.error?.code || 'INTERNAL', status: res.status };
}

/**
 * @typedef {'confirming'|'waiting'|'confirmed'|'failed'|'review'|'cancelled'|'refunded'} OrderView
 * The page may say "Order confirmed" only when $shared isConfirmed(status).
 * An unpaid order is "confirming" (a payment may be in flight: please don't pay again) unless
 * `unpaid`: this device knows its last payment window closed with no money taken
 * (storage.js isUnpaidHere) and the server has no authorised / captured payment for it. Then
 * it is 'waiting' ("Waiting for payment", with a way to pay).
 * @param {any} dto
 * @param {{ unpaid?: boolean }} [opts]
 * @returns {OrderView}
 */
export function viewFor(dto, { unpaid = false } = {}) {
	if (isConfirmed(dto?.status)) return 'confirmed';
	switch (dto?.status) {
		case 'pending_payment':
			return unpaid && !moneyMoved(dto) ? 'waiting' : 'confirming';
		case 'payment_failed':
		case 'expired':
			return 'failed';
		case 'cancelled':
			return 'cancelled';
		case 'refunded':
			return 'refunded';
		default:
			return 'review'; // needs_review, or a status this build doesn't know
	}
}

/** The server has seen money for it (authorised or captured). */
const moneyMoved = (dto) => dto?.paymentStatus === 'authorized' || dto?.paymentStatus === 'captured';

/**
 * The view after an answer, given the view on screen. Once the page has said
 * the payment didn't go through (a redirect-mode failure, or the webhook's
 * payment_failed), or "Still confirming", a still-pending answer doesn't flip
 * it back to "Confirming…": only real news (paid, cancelled, …) changes it —
 * or, for "Still confirming", this device learning that no money was taken
 * (a Try again closed unpaid): then it is waiting for payment.
 * @param {string} current
 * @param {any} dto
 * @param {{ unpaid?: boolean }} [opts]  see viewFor
 * @returns {OrderView | 'slow'}
 */
export function nextView(current, dto, opts = {}) {
	const v = viewFor(dto, opts);
	if (v === 'confirming' && (current === 'failed' || current === 'slow')) return current;
	if (v === 'waiting' && current === 'failed') return current;
	return v;
}

/**
 * Could this unpaid online order still turn paid by itself? payment_failed is
 * not terminal on the server: a timed-out UPI payment can be authorised
 * minutes later (webhook / status pull → paid), and a redirect-mode failure
 * may arrive while the order is still pending_payment.
 */
export function mayStillSettle(dto) {
	return !!dto && dto.paymentMethod !== 'cod' && (dto.status === 'payment_failed' || dto.status === 'pending_payment');
}

/** Reason kinds that rule out money having moved (the customer cancelled, the bank said no). */
const NO_MONEY_KINDS = ['cancelled', 'declined', 'auth_failed', 'risk'];

/**
 * The failed view's first line, and whether to say the page is still
 * watching. "No money was taken" is claimed only where it is certain: a
 * Razorpay reason that rules money out (not a timeout — those can still
 * authorise late), or an order the server gave up on (expired: no payment
 * found). A failure with no reason (the webhook said payment_failed), a
 * timeout or a technical error says what happens if money did move instead.
 * @param {any} dto  OrderStatusDTO (or null before the first answer)
 * @param {string | null} reason  redirect-mode `reason`, if any
 * @returns {{ message: string, certain: boolean, watching: boolean }}
 */
export function failedCopy(dto, reason) {
	const settles = mayStillSettle(dto);
	const certain = reason ? !mayAuthoriseLate(reason) && NO_MONEY_KINDS.includes(paymentReasonKind(reason)) : !!dto && !settles;
	return { message: certain ? NO_MONEY_TAKEN : MONEY_UNSURE, certain, watching: !certain && settles };
}

/**
 * checkout-backend.md §1.2 supersede: a new checkout for the same bag (cart
 * signature) and phone cancels that phone's still-unpaid online orders from
 * the last max(reservationMinutes, 30) minutes — and refunds any money that
 * lands on them later. 25 minutes leaves room for clock skew.
 */
export const COD_SWITCH_WINDOW_MS = 25 * 60 * 1000;

/**
 * May a page offer "Pay on delivery instead" (→ /checkout?pay=cod) for this
 * order? Only for an online order with no authorised / captured payment when
 * the bag on this device is exactly its items, and:
 * - still unpaid (`pending_payment` / `payment_failed`): created in the last
 *   25 minutes, so the COD order that follows is sure to supersede it
 *   (cancel it, and refund any money that lands on it later);
 * - `expired`: any age. There is nothing left to supersede: the server
 *   asked the gateway before expiring it (no payment), its stock and coupon
 *   are released, and the COD order is simply the same bag again.
 * (The phone is the customer's to keep the same — checkout-backend.md §11;
 * /checkout?pay=cod prefills it from wefeasto_pending_form.) Whether COD is
 * available for the bag is a separate, server-side answer (cod-check.js).
 *
 * The age never mixes clocks: on the device that placed the order it is
 * device time since wefeasto_placed_<no> (a phone set hours ahead — a UTC
 * zone with the time moved to IST — would otherwise never be offered the
 * switch, and one set behind would be offered it for orders the server no
 * longer supersedes); elsewhere the server's createdAt against this clock.
 * @param {any} dto  OrderStatusDTO
 * @param {string} bagSig  cartSignature of the bag on this device
 * @param {number} [now]  this device's clock
 * @param {number | null} [placed]  when this device placed the order (its clock), if it did
 */
export function canSwitchToCod(dto, bagSig, now = Date.now(), placed = placedAt(dto?.number)) {
	if (!dto || typeof dto !== 'object' || dto.paymentMethod === 'cod') return false;
	if (dto.paymentStatus === 'authorized' || dto.paymentStatus === 'captured') return false;
	const expired = dto.status === 'expired';
	if (!expired) {
		if (!mayStillSettle(dto)) return false;
		const since = typeof placed === 'number' && Number.isFinite(placed) ? placed : Date.parse(dto.createdAt);
		if (!Number.isFinite(since) || now - since > COD_SWITCH_WINDOW_MS) return false;
	}
	const sig = cartSignature((Array.isArray(dto.items) ? dto.items : []).map((i) => ({ slug: i?.slug, qty: i?.qty })));
	return !!sig && sig === bagSig;
}

export const POLL_FAST_MS = 2000;
export const POLL_FAST_FOR_MS = 30000;
export const POLL_SLOW_MS = 5000;
export const POLL_MAX_MS = 120000;

/** A failed payment that could still settle: a slow look for a late authorisation. */
export const POLL_FAILED_MS = 8000;
export const POLL_FAILED_FOR_MS = 120000;

/** Delay before the next poll given the (visible) time already spent polling; null = give up. */
export function nextPollDelay(elapsedMs) {
	if (elapsedMs < POLL_FAST_FOR_MS) return POLL_FAST_MS;
	if (elapsedMs < POLL_MAX_MS) return POLL_SLOW_MS;
	return null;
}

/** The failed view's schedule: every 8 s for 2 minutes (15 looks). */
export function nextFailedPollDelay(elapsedMs) {
	return elapsedMs < POLL_FAILED_FOR_MS ? POLL_FAILED_MS : null;
}

/**
 * Which schedule fits what the page now shows: 'confirming' (fast, then
 * slow; "Still confirming" when it runs out), 'failed' (slow, while the order
 * could still be paid late — also for "Waiting for payment": paid elsewhere,
 * it turns confirmed) or null (nothing will change by itself).
 * @returns {'confirming' | 'failed' | null}
 */
export function pollModeFor(view, dto) {
	if (view === 'confirming') return 'confirming';
	if ((view === 'failed' || view === 'waiting') && mayStillSettle(dto)) return 'failed';
	return null;
}

/**
 * Polls `tick` on the schedule above, paused while the tab is hidden (the
 * hidden time doesn't count). `tick` resolves to 'stop' to end polling;
 * `ondone` runs when the schedule runs out.
 * @param {{ tick: () => Promise<any>, ondone?: () => void, delay?: (elapsed: number) => number | null,
 *           timers?: {setTimeout: Function, clearTimeout: Function}, doc?: Document | null }} opts
 */
export function createPoller({ tick, ondone = () => {}, delay = nextPollDelay, timers = globalThis, doc = typeof document !== 'undefined' ? document : null }) {
	let elapsed = 0;
	let timer = null;
	let wait = 0;
	let stopped = false;
	let inFlight = false;

	function schedule() {
		if (stopped) return;
		const d = delay(elapsed);
		if (d === null) {
			stop();
			ondone();
			return;
		}
		wait = d;
		if (doc && doc.hidden) return; // resumes on visibilitychange
		timer = timers.setTimeout(run, d);
	}

	async function run() {
		timer = null;
		if (stopped || inFlight) return;
		elapsed += wait;
		inFlight = true;
		let r;
		try {
			r = await tick();
		} catch (e) {
			r = null;
		}
		inFlight = false;
		if (r === 'stop') stop();
		else schedule();
	}

	function onVisibility() {
		if (stopped) return;
		if (doc.hidden) {
			if (timer) timers.clearTimeout(timer);
			timer = null;
		} else if (!timer && !inFlight) {
			timer = timers.setTimeout(run, 0); // look straight away on return
		}
	}

	function stop() {
		stopped = true;
		if (timer) timers.clearTimeout(timer);
		timer = null;
		doc?.removeEventListener('visibilitychange', onVisibility);
	}

	doc?.addEventListener('visibilitychange', onVisibility);
	schedule();
	return { stop, get elapsed() { return elapsed; }, get stopped() { return stopped; } };
}

/**
 * Keeps /order in step with the server. Each answer goes through `apply`
 * (which returns the view it now shows) and picks the schedule with
 * pollModeFor: 'confirming' → nextPollDelay, then `onSlow`; 'failed' →
 * nextFailedPollDelay (a late authorisation turns the page confirmed);
 * anything else stops. Paused while the tab is hidden, looking at once on
 * return; and once a failed or "Still confirming" page has stopped, coming
 * back to the tab (from the UPI app, say) looks once more — restarting the
 * failed schedule while the order can still settle. No look while `busy()`
 * (a retry's payment window is open: its callbacks decide).
 * @param {{
 *   look: () => Promise<{ok: true, dto: any} | {ok: false, code: string}>,
 *   apply: (dto: any) => string,
 *   onNotFound?: () => void,
 *   onSlow?: () => void,
 *   busy?: () => boolean,
 *   recheckOnReturn?: () => boolean,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   doc?: Document | null
 * }} deps
 */
export function createOrderWatcher({
	look,
	apply,
	onNotFound = () => {},
	onSlow = () => {},
	busy = () => false,
	recheckOnReturn = () => false,
	timers = globalThis,
	doc = typeof document !== 'undefined' ? document : null
}) {
	let poller = null;
	let mode = null;
	let stopped = false;
	let looking = false;
	let listening = false;

	function poll(m) {
		const old = poller;
		poller = null;
		mode = null;
		old?.stop();
		if (!m || stopped) return;
		mode = m;
		const me = (poller = createPoller({
			tick: once,
			delay: m === 'failed' ? nextFailedPollDelay : nextPollDelay,
			ondone: () => {
				if (poller !== me) return;
				poller = null;
				mode = null;
				if (m === 'confirming') onSlow();
			},
			timers,
			doc
		}));
	}

	/** One look. 'stop' ends the calling poller (the answer switched or ended the schedule). */
	async function once() {
		if (stopped) return 'stop';
		if (looking || busy()) return null;
		looking = true;
		let s;
		try {
			s = await look();
		} finally {
			looking = false;
		}
		if (stopped) return 'stop';
		if (s && s.ok) {
			const want = pollModeFor(apply(s.dto), s.dto);
			if (want && want === mode) return null;
			poll(want);
			return 'stop';
		}
		if (s && s.code === 'NOT_FOUND') {
			poll(null);
			onNotFound();
			return 'stop';
		}
		return null; // offline, 5xx: the schedule tries again
	}

	function onVisibility() {
		if (stopped || doc.hidden || mode || busy() || !recheckOnReturn()) return;
		once();
	}

	/**
	 * First look. With no answer (offline, 5xx) keep looking on `fallback`'s
	 * schedule ('confirming', or 'failed' for a redirect-mode failure).
	 */
	async function start(fallback = 'confirming') {
		if (doc && !listening) {
			doc.addEventListener('visibilitychange', onVisibility);
			listening = true;
		}
		const r = await once();
		if (r !== 'stop' && !mode && !stopped) poll(fallback);
	}

	function stop() {
		stopped = true;
		poll(null);
		if (listening) doc.removeEventListener('visibilitychange', onVisibility);
		listening = false;
	}

	return {
		start,
		poll,
		lookNow: once,
		stop,
		get mode() {
			return mode;
		}
	};
}

/**
 * Entering "confirmed": exactly once per order on this device (guarded by
 * wefeasto_seen_<no>, plus an in-memory copy when storage is unavailable):
 * mark seen first, then write wefeasto_last_order ("Your usual" learns it on
 * any device). The rest happens only on the device that PLACED the order
 * (flow.js marked it wefeasto_placed_<no>, or its wefeasto_pending names it):
 * drop that pending entry (never another order's), subtract the ordered
 * quantities from the bag (never a wipe: anything added since survives) and
 * track 'purchase'. The emailed link opened on another device leaves that
 * device's bag, its own pending order and the analytics alone (PI-ORD-3).
 * A redirect-mode return in a browser that didn't place the order therefore
 * doesn't subtract the bag. Returns {first, here}.
 * @param {any} dto  OrderStatusDTO
 * @param {string} token
 * @param {{ cart: {subtractLines: Function}, track: Function, env?: any }} deps
 */
export function enterConfirmed(dto, token, { cart, track, env = browserEnv }) {
	const no = dto.number;
	if (isSeen(no, env)) return { first: false };
	markSeen(no, env);
	const items = itemsMap(dto.items);
	writeLastOrder({ no, t: token, items: dto.items }, env);
	const here = consumePlaced(no, env) || readPending(env)?.no === no;
	if (!here) return { first: true, here: false };
	clearPendingFor(no, env);
	try {
		cart.subtractLines(items);
	} catch (e) {
		/* the bag is best-effort */
	}
	track('purchase', {
		number: no,
		value: Number.isSafeInteger(dto.totalPaise) ? dto.totalPaise / 100 : undefined,
		currency: 'INR',
		method: dto.paymentMethod === 'cod' ? 'cod' : 'online'
	});
	return { first: true, here: true };
}
