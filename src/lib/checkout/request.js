/*
 * The checkout form → the POST /api/store/checkout body (SPEC §6), plus the
 * pieces the Idempotency-Key is derived from. Client validation is the same
 * $shared validateCheckoutForm the server runs (the server also checks PIN
 * serviceability, which needs its settings).
 */
import { validateCheckoutForm } from '$shared/validate.js';
import { cartSignature } from '$shared/cart-links.js';
import { fieldErrorCopy } from '$shared/errors.js';

/** validateCheckoutForm field → input id on /checkout. */
export const FIELD_IDS = Object.freeze({
	name: 'wf-co-name',
	phone: 'wf-co-phone',
	email: 'wf-co-email',
	line1: 'wf-co-address',
	pin: 'wf-co-pin',
	city: 'wf-co-city',
	state: 'wf-co-state'
});

/** DOM order of the fields: the first invalid one in this order gets focus. */
export const FIELD_ORDER = Object.freeze(['name', 'phone', 'email', 'line1', 'pin', 'city', 'state']);

/** Page form state ({name, phone, email, address, city, state, pin}) → validateCheckoutForm input. */
export function formInput(form) {
	const f = form || {};
	return { name: f.name, email: f.email, phone: f.phone, line1: f.address, city: f.city, state: f.state, pin: f.pin };
}

/**
 * Field errors as {field: message}, in FIELD_ORDER, from a {field: code} map
 * (validateCheckoutForm, or the server's VALIDATION details.fields). Codes may
 * also arrive as {code}. Unknown fields are ignored.
 * @param {Record<string, unknown> | null | undefined} codes
 */
export function fieldMessages(codes) {
	const out = {};
	if (!codes || typeof codes !== 'object') return out;
	for (const field of FIELD_ORDER) {
		if (!Object.prototype.hasOwnProperty.call(codes, field)) continue;
		const raw = codes[field];
		const code = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof raw.code === 'string' ? raw.code : 'INVALID';
		out[field] = fieldErrorCopy(field, code);
	}
	return out;
}

/**
 * @returns {{ok: boolean, value: any, errors: Record<string, string>, first: string | null}}
 */
export function checkForm(form) {
	const r = validateCheckoutForm(formInput(form));
	const errors = fieldMessages(r.errors);
	return { ok: r.ok, value: r.value, errors, first: FIELD_ORDER.find((f) => f in errors) || null };
}

/**
 * A `supersede` ref ({number, token}) when both look right, else null. The
 * quote and the checkout body both carry it (quote.js supersedeFor).
 */
export function supersedeRef(ref) {
	if (!ref || typeof ref !== 'object') return null;
	const { number, token } = ref;
	return typeof number === 'string' && number.trim() && typeof token === 'string' && token ? { number: number.trim(), token } : null;
}

/**
 * The request body. `value` is validateCheckoutForm's normalised output
 * (E.164 phone, lowercased email, canonical state, 6-digit pin).
 * `supersede` ({number, token}, SUP-PHONE-1): the same ref the quote carried
 * (quote.js supersedeFor): the unpaid online order this checkout of the same
 * bag replaces. The server cancels that order (the token proves it's this
 * customer's) even when the phone was changed, as the quote priced it. Left
 * out when missing or malformed; never part of the attempt (attemptOf).
 */
export function buildCheckoutBody({ value, items, method, couponCode = null, expectedTotalPaise, marketing = false, source = 'web', supersede = null }) {
	const body = {
		items: (items || []).map(({ slug, qty }) => ({ slug, qty })),
		contact: { name: value.name, email: value.email, phone: value.phone },
		address: { line1: value.line1, city: value.city, state: value.state, pin: value.pin },
		method,
		expectedTotalPaise,
		consent: { marketing: marketing === true },
		source: source || 'web'
	};
	if (couponCode) body.couponCode = couponCode;
	const ref = supersedeRef(supersede);
	if (ref) body.supersede = ref;
	return body;
}

/** JSON with object keys sorted at every level (a stable hash input). */
export function stableStringify(v) {
	if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
	if (v && typeof v === 'object') {
		return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
	}
	return JSON.stringify(v ?? null);
}

/** cyrb53: a fast 53-bit string hash (not cryptographic; it only has to tell attempts apart). */
export function hash53(str, seed = 0) {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * What the Idempotency-Key is tied to: the bag (order-insensitive signature)
 * and a hash of everything else in the body (details, method, offer, consent,
 * source and the total the customer saw) — except `supersede`: which older
 * order the attempt replaces isn't part of what's being ordered (the server's
 * requestHash leaves it out too), and it comes and goes with wefeasto_pending
 * (a reload after the first tap sees that order's own pending entry), so it
 * must not turn a replay into a second order.
 */
export function attemptOf(body) {
	const rest = { ...body };
	delete rest.items;
	delete rest.supersede;
	return { cartSig: cartSignature(body.items), formHash: hash53(stableStringify(rest)) };
}
