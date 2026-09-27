/*
 * Checkout and /order client state in Web Storage (roadmap F4). Every access
 * is wrapped: storage may be missing or throw (Safari with storage blocked,
 * private modes, quota), and then these features degrade — recovery relies on
 * the order email — but nothing here ever throws.
 *
 *   localStorage   wefeasto_pending       {no, t, at, cartSig, quiet?, unpaid?}   online order waiting for payment (≤ 7 days);
 *                                                                 quiet: × on the banner (never shown again, still the
 *                                                                 supersede ref); unpaid: its last payment window closed
 *                                                                 with no money taken (/order says "waiting", not "confirming")
 *   localStorage   wefeasto_last_order    {no, t, items:{slug:qty}, at}   the last confirmed order ("Your usual")
 *   localStorage   wefeasto_seen_<no>     1                      side effects + celebration done for <no>
 *   localStorage   wefeasto_placed_<no>   <at>                   this device placed <no> (flow.js); /order's
 *                                                                 bag subtraction + 'purchase' run only here
 *   localStorage   wefeasto_checkout      {name, phone, email, address, city, state, pin}   S1, opt-in only
 *   sessionStorage wefeasto_idem          {sig, form, k, no?}    Idempotency-Key for this cart + form; `no`: the order
 *                                                                 it made (retired once that order is seen confirmed)
 *   sessionStorage wefeasto_placing       {k, sig, body, at}     a "Place order" / Pay tap that hasn't heard back yet
 *   sessionStorage wefeasto_kept          {no, name, phone, …}   the order an unheard tap had placed, kept instead of the
 *                                                                 changed attempt that found it (/order says where it ships)
 *   sessionStorage wefeasto_pending_form  {no, form:{…}}         the details the pending online order was placed
 *                                                                 with (this tab only), so "Pay on delivery instead"
 *                                                                 prefills the SAME phone and the COD order supersedes it
 *
 * Every function takes an optional `env` ({local, session, now}) so tests can
 * swap the storages and the clock; the default is the browser's.
 * Contract: SCRATCH/contracts/storefront-checkout.md.
 */
import { isOrderNumber } from '$shared/order-status.js';
import { canonicalState } from '$shared/validate.js';

export const PENDING_KEY = 'wefeasto_pending';
export const LAST_ORDER_KEY = 'wefeasto_last_order';
export const SEEN_PREFIX = 'wefeasto_seen_';
export const SAVED_KEY = 'wefeasto_checkout';
export const IDEM_KEY = 'wefeasto_idem';
export const PENDING_FORM_KEY = 'wefeasto_pending_form';
export const PLACED_PREFIX = 'wefeasto_placed_';
export const PLACING_KEY = 'wefeasto_placing';
export const KEPT_KEY = 'wefeasto_kept';

export const DAY = 86400000;
export const PENDING_MAX_AGE_MS = 7 * DAY;

/** Guest order token as the CMS issues it (base64url HMAC); lenient on length. */
export const TOKEN_RE = /^[A-Za-z0-9_.~=-]{8,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @typedef {{ local: () => Storage, session: () => Storage, now: () => number }} StorageEnv */

/** @type {StorageEnv} */
export const browserEnv = {
	local: () => window.localStorage, // the getter itself may throw: callers catch
	session: () => window.sessionStorage,
	now: () => Date.now()
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parsed JSON: the value, null when absent, undefined when unavailable or corrupt. */
export function getJSON(store, key) {
	try {
		const raw = store().getItem(key);
		return raw === null ? null : JSON.parse(raw);
	} catch (e) {
		return undefined;
	}
}

/** false when storage is unavailable (or full). */
export function setJSON(store, key, value) {
	try {
		store().setItem(key, JSON.stringify(value));
		return true;
	} catch (e) {
		return false;
	}
}

export function removeKey(store, key) {
	try {
		store().removeItem(key);
	} catch (e) {
		/* unavailable: nothing to remove */
	}
}

export const isToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/* ------------------------------------------------ wefeasto_pending */

/**
 * The online order waiting for payment, or null. Malformed, future-dated or
 * older than 7 days → removed and null.
 * @param {StorageEnv} [env]
 * @returns {{no: string, t: string, at: number, cartSig: string} | null}
 */
export function readPending(env = browserEnv) {
	const v = getJSON(env.local, PENDING_KEY);
	if (v === null) return null;
	const now = env.now();
	const ok =
		isObj(v) &&
		isOrderNumber(v.no) &&
		isToken(v.t) &&
		typeof v.at === 'number' &&
		Number.isFinite(v.at) &&
		v.at <= now + DAY &&
		now - v.at <= PENDING_MAX_AGE_MS;
	if (!ok) {
		removeKey(env.local, PENDING_KEY);
		return null;
	}
	const out = { no: v.no.trim(), t: v.t, at: v.at, cartSig: typeof v.cartSig === 'string' ? v.cartSig : '' };
	if (v.quiet === true) out.quiet = true;
	if (v.unpaid === true) out.unpaid = true;
	return out;
}

/**
 * Written BEFORE the payment window opens (a fresh entry: in flight, shown by the banner).
 * `unpaid`: nothing is taking money for it (placed while payments were down, PAYMENTS_UNAVAILABLE).
 */
export function writePending({ no, t, cartSig = '', unpaid = false }, env = browserEnv) {
	if (!isOrderNumber(no) || !isToken(t)) return false;
	const rec = { no, t, at: env.now(), cartSig: String(cartSig) };
	if (unpaid === true) rec.unpaid = true;
	return setJSON(env.local, PENDING_KEY, rec);
}

/** Set flags on the entry for order `no` (another order's entry, or none, is left alone). */
function flagPending(no, flags, env) {
	const p = readPending(env);
	if (!p || typeof no !== 'string' || p.no !== no.trim()) return false;
	return setJSON(env.local, PENDING_KEY, { ...p, ...flags });
}

/**
 * × on the banner ("hide this order on this device"): the banner never shows it again, but the entry
 * stays as this device's only proof that the unpaid order is the customer's own (SUP-OWN-1). The next
 * checkout of the same bag still names it as `supersede`, so it can't hold their first-order offer or
 * the last packs against them. Dropped by the same rules as any entry (7 days, confirmed, superseded).
 */
export function quietPending(no, env = browserEnv) {
	return flagPending(no, { quiet: true }, env);
}

/**
 * The payment window for order `no` closed with no money taken (dismissed with no failure that could
 * still authorise, never opened, script failed): nothing is in flight, so /order says "Waiting for
 * payment" and offers to pay rather than "Confirming with your bank… don't pay again". The next window
 * (pay() → writePending) clears it.
 */
export function markPendingUnpaid(no, env = browserEnv) {
	return flagPending(no, { unpaid: true }, env);
}

/** Does this device know that nothing is paying order `no` right now (see markPendingUnpaid)? */
export function isUnpaidHere(no, env = browserEnv) {
	const p = readPending(env);
	return !!p && p.unpaid === true && typeof no === 'string' && p.no === no.trim();
}

export function clearPending(env = browserEnv) {
	removeKey(env.local, PENDING_KEY);
}

/** Drop wefeasto_pending only when it names order `no`: another order's entry is left alone. */
export function clearPendingFor(no, env = browserEnv) {
	const p = readPending(env);
	if (p && typeof no === 'string' && p.no === no.trim()) clearPending(env);
}

/* --------------------------------------------- wefeasto_last_order */

/** {slug: qty} from order items ([{slug, qty}]); duplicates summed, junk skipped. */
export function itemsMap(items) {
	const out = {};
	for (const it of Array.isArray(items) ? items : []) {
		if (!it || typeof it.slug !== 'string' || !it.slug) continue;
		const q = Number(it.qty);
		if (!Number.isSafeInteger(q) || q < 1) continue;
		out[it.slug] = (Object.prototype.hasOwnProperty.call(out, it.slug) ? out[it.slug] : 0) + q;
	}
	return out;
}

/** {no, t} of the last confirmed order (token fallback for /order), or null. */
export function readLastOrderRef(env = browserEnv) {
	const v = getJSON(env.local, LAST_ORDER_KEY);
	return isObj(v) && isOrderNumber(v.no) && isToken(v.t) ? { no: v.no.trim(), t: v.t } : null;
}

/** The contract cart.md §3 "YourUsual" reads: {no, t, items: {slug: qty}, at}. */
export function writeLastOrder({ no, t, items }, env = browserEnv) {
	return setJSON(env.local, LAST_ORDER_KEY, { no, t, items: itemsMap(items), at: env.now() });
}

/** Token for an order number from what this device remembers (pending first). */
export function tokenFor(no, env = browserEnv) {
	if (!isOrderNumber(no)) return null;
	const n = no.trim();
	const p = readPending(env);
	if (p && p.no === n) return p.t;
	const last = readLastOrderRef(env);
	if (last && last.no === n) return last.t;
	return null;
}

/* ----------------------------------------------- wefeasto_seen_<no> */

/* The session copy: with storage unavailable, a client-side revisit in the
   same page session still never repeats the side effects. */
const seenMemory = new Set();

export function isSeen(no, env = browserEnv) {
	if (seenMemory.has(no)) return true;
	return getJSON(env.local, SEEN_PREFIX + no) === 1;
}

export function markSeen(no, env = browserEnv) {
	seenMemory.add(no);
	return setJSON(env.local, SEEN_PREFIX + no, 1);
}

/* --------------------------------------------- wefeasto_placed_<no> */

/* The session copy, as for seen: with storage unavailable, the /order page
   reached by goto() from this checkout still knows this device placed it. */
const placedMemory = new Map(); // no → when (this device's clock)

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * This device just placed order `no` (written when /store/checkout returns
 * it). A replay of the same order keeps the first time: placedAt is when the
 * order was made, on this device's clock.
 */
export function markPlaced(no, env = browserEnv) {
	if (!isOrderNumber(no)) return false;
	const n = no.trim();
	const now = env.now();
	const prev = getJSON(env.local, PLACED_PREFIX + n);
	const at = isTime(prev) && prev <= now ? prev : placedMemory.get(n) ?? now;
	placedMemory.set(n, at);
	return setJSON(env.local, PLACED_PREFIX + n, at);
}

/**
 * When this device placed order `no`, on its own clock (null: not placed
 * here, or already consumed). Lets an age check compare device time with
 * device time instead of the server's createdAt with a clock that may be
 * hours off (order.js canSwitchToCod).
 */
export function placedAt(no, env = browserEnv) {
	if (!isOrderNumber(no)) return null;
	const n = no.trim();
	const v = getJSON(env.local, PLACED_PREFIX + n);
	if (isTime(v)) return v;
	return placedMemory.get(n) ?? null;
}

/** Did this device place order `no`? Answers once: the marker is removed. */
export function consumePlaced(no, env = browserEnv) {
	if (!isOrderNumber(no)) return false;
	const n = no.trim();
	const mem = placedMemory.delete(n);
	const v = getJSON(env.local, PLACED_PREFIX + n);
	if (v !== null && v !== undefined) removeKey(env.local, PLACED_PREFIX + n);
	return mem || (v !== null && v !== undefined);
}

/** Tests only (seen and placed session copies). */
export function _resetSeenMemory() {
	seenMemory.clear();
	placedMemory.clear();
}

/* ------------------------------------------- wefeasto_checkout (S1) */

export const SAVED_FIELDS = Object.freeze({ name: 80, phone: 32, email: 254, address: 200, city: 60, state: 60, pin: 10 });

const cleanField = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Saved details (opt-in), each field validated on its own: a partial or
 * old-schema object keeps what still looks right. A state that isn't on the
 * list is dropped. Nothing usable → removed and null.
 * @returns {{name: string, phone: string, email: string, address: string, city: string, state: string, pin: string} | null}
 */
export function readSaved(env = browserEnv) {
	const v = getJSON(env.local, SAVED_KEY);
	if (v === null) return null;
	if (!isObj(v)) {
		removeKey(env.local, SAVED_KEY);
		return null;
	}
	const out = {};
	for (const [field, max] of Object.entries(SAVED_FIELDS)) out[field] = cleanField(v[field], max);
	out.state = out.state ? canonicalState(out.state) || '' : '';
	out.pin = /^\d{6}$/.test(out.pin.replace(/\s+/g, '')) ? out.pin.replace(/\s+/g, '') : '';
	if (!Object.values(out).some(Boolean)) {
		removeKey(env.local, SAVED_KEY);
		return null;
	}
	return /** @type {any} */ (out);
}

export function writeSaved(details, env = browserEnv) {
	if (!isObj(details)) return false;
	const out = {};
	for (const [field, max] of Object.entries(SAVED_FIELDS)) out[field] = cleanField(details[field], max);
	return setJSON(env.local, SAVED_KEY, out);
}

export function clearSaved(env = browserEnv) {
	removeKey(env.local, SAVED_KEY);
}

/* ------------------------- wefeasto_pending_form (sessionStorage) */

/**
 * The checkout form an online order was placed with, kept for this tab only
 * (sessionStorage: gone when the tab closes, never shared across tabs). It
 * exists because supersede keys on the phone (checkout-backend.md §1.2) and
 * the status DTO only carries masked contact details: "Pay on delivery
 * instead" (banner, /order) → /checkout?pay=cod prefills from it, so the COD
 * order carries the same phone and cancels the unpaid online one — also for
 * a customer who didn't tick "Save my details".
 * @param {{no: string, form: object}} rec
 */
export function writePendingForm({ no, form }, env = browserEnv) {
	if (!isOrderNumber(no) || !isObj(form)) return false;
	const out = {};
	for (const [field, max] of Object.entries(SAVED_FIELDS)) out[field] = cleanField(form[field], max);
	return setJSON(env.session, PENDING_FORM_KEY, { no: no.trim(), form: out });
}

/**
 * The details for order `no`, or null (another order's, malformed or none).
 * Fields are cleaned like saved details (unknown state dropped, PIN 6 digits).
 */
export function readPendingForm(no, env = browserEnv) {
	const v = getJSON(env.session, PENDING_FORM_KEY);
	if (!isObj(v) || !isOrderNumber(no) || v.no !== no.trim() || !isObj(v.form)) return null;
	const out = {};
	for (const [field, max] of Object.entries(SAVED_FIELDS)) out[field] = cleanField(v.form[field], max);
	out.state = out.state ? canonicalState(out.state) || '' : '';
	out.pin = /^\d{6}$/.test(out.pin.replace(/\s+/g, '')) ? out.pin.replace(/\s+/g, '') : '';
	return Object.values(out).some(Boolean) ? /** @type {any} */ (out) : null;
}

export function clearPendingForm(env = browserEnv) {
	removeKey(env.session, PENDING_FORM_KEY);
}

/* ---------------------------------- Idempotency-Key (sessionStorage) */

let idemMemory = null; // the session copy when sessionStorage is unavailable

function readIdem(env) {
	const stored = getJSON(env.session, IDEM_KEY);
	return stored === undefined ? idemMemory : stored;
}

function writeIdem(rec, env) {
	idemMemory = rec;
	setJSON(env.session, IDEM_KEY, rec);
	return rec.k;
}

/**
 * The Idempotency-Key for this exact attempt: the same cart signature and
 * form hash give the same key (a double tap or a reload replays the same
 * order on the server); any change to the bag or the details gives a new one.
 * A key whose order has since been seen confirmed on this device
 * (wefeasto_seen_<no>) is retired: ordering the same bag again ("Buy again",
 * "Your usual") is a NEW order, never a replay of the finished one.
 * @param {{cartSig: string, formHash: string}} attempt
 * @param {{newKey: () => string, env?: StorageEnv}} opts
 */
export function idempotencyKeyFor({ cartSig, formHash }, { newKey, env = browserEnv }) {
	const cur = readIdem(env);
	if (isObj(cur) && cur.sig === cartSig && cur.form === formHash && typeof cur.k === 'string' && UUID_RE.test(cur.k)) {
		const done = typeof cur.no === 'string' && isOrderNumber(cur.no) && isSeen(cur.no.trim(), env);
		if (!done) return cur.k;
	}
	return writeIdem({ sig: cartSig, form: formHash, k: newKey() }, env);
}

/** Use key `k` for this attempt from now on (the key of an earlier tap that never heard back). */
export function adoptIdempotencyKey({ cartSig, formHash }, k, env = browserEnv) {
	return writeIdem({ sig: cartSig, form: formHash, k }, env);
}

/** Key `k` made order `no` (the server answered with it): the key retires once `no` is seen confirmed. */
export function noteIdempotentOrder(k, no, env = browserEnv) {
	const cur = readIdem(env);
	if (!isObj(cur) || cur.k !== k || !isOrderNumber(no)) return false;
	writeIdem({ ...cur, no: no.trim() }, env);
	return true;
}

/** Drop the key (after IDEMPOTENCY_MISMATCH / NOT_RETRYABLE): the next attempt gets a fresh one. */
export function forgetIdempotencyKey(env = browserEnv) {
	idemMemory = null;
	removeKey(env.session, IDEM_KEY);
}

/* ------------------------------ wefeasto_placing (sessionStorage) */

/** How long a tap that never heard back is worth resolving (the supersede window's order of size). */
export const PLACING_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * A checkout tap in flight (COD or online): written just before POST
 * /store/checkout, removed once the server answers (an order, or a refusal
 * that made none). If the page reloads (or the answer is lost) in between,
 * the order may exist although this tab never heard of it. A COD order can't
 * be superseded, so a second one would ship twice; an unpaid online one holds
 * the bag's last packs and its offer, and since SUP-OWN-1 only a checkout that
 * names it (its {number, token}) replaces it. So the next checkout resolves
 * this tap first (flow.js place() / recall()).
 * @param {{k: string, sig: string, body: any}} rec  body: the exact request body sent
 */
export function writePlacing({ k, sig, body }, env = browserEnv) {
	if (typeof k !== 'string' || !UUID_RE.test(k) || typeof sig !== 'string' || !sig || !isObj(body)) return false;
	return setJSON(env.session, PLACING_KEY, { k, sig, body, at: env.now() });
}

/** The tap still waiting for an answer, or null (none, malformed, or older than 30 minutes → removed). */
export function readPlacing(env = browserEnv) {
	const v = getJSON(env.session, PLACING_KEY);
	if (v === null || v === undefined) return null;
	const now = env.now();
	const ok =
		isObj(v) &&
		typeof v.k === 'string' &&
		UUID_RE.test(v.k) &&
		typeof v.sig === 'string' &&
		!!v.sig &&
		isObj(v.body) &&
		Array.isArray(v.body.items) &&
		typeof v.body.method === 'string' &&
		isTime(v.at) &&
		v.at <= now + DAY &&
		now - v.at <= PLACING_MAX_AGE_MS;
	if (!ok) {
		removeKey(env.session, PLACING_KEY);
		return null;
	}
	return { k: v.k, sig: v.sig, body: v.body, at: v.at };
}

export function clearPlacing(env = browserEnv) {
	removeKey(env.session, PLACING_KEY);
}

/* -------------------------------- wefeasto_kept (sessionStorage) */

const keptField = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The order an earlier tap that never heard back had already placed, which
 * the flow kept instead of the changed attempt that found it (a COD order
 * can't be superseded; one money reached is never replaced). The status DTO
 * never carries the street address, so /order shows where it ships from this.
 * `changed`: what the customer had changed since (address, phone, name,
 * email, method, items, offer).
 * @param {{no: string, name?: string, phone?: string, line1?: string, city?: string, state?: string, pin?: string, method?: string, changed?: string[]}} rec
 */
export function writeKept(rec, env = browserEnv) {
	if (!isObj(rec) || !isOrderNumber(rec.no)) return false;
	const out = { no: rec.no.trim(), at: env.now() };
	for (const [f, max] of Object.entries({ name: 80, phone: 32, line1: 200, city: 60, state: 60, pin: 10, method: 8 })) out[f] = keptField(rec[f], max);
	out.changed = Array.isArray(rec.changed) ? rec.changed.filter((c) => typeof c === 'string').slice(0, 10) : [];
	return setJSON(env.session, KEPT_KEY, out);
}

/** The kept-order record for order `no` (this tab), or null. */
export function readKept(no, env = browserEnv) {
	const v = getJSON(env.session, KEPT_KEY);
	if (!isObj(v) || !isOrderNumber(no) || v.no !== no.trim() || typeof v.line1 !== 'string') return null;
	const out = { no: v.no };
	for (const f of ['name', 'phone', 'line1', 'city', 'state', 'pin', 'method']) out[f] = typeof v[f] === 'string' ? v[f] : '';
	out.changed = Array.isArray(v.changed) ? v.changed.filter((c) => typeof c === 'string') : [];
	return out;
}
