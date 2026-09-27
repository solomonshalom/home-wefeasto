/*
 * Customer-input validation shared by the checkout form (instant feedback) and
 * the CMS checkout endpoint (the authority). Unicode names and addresses are
 * welcome; control characters, bidi overrides and zero-width junk are not.
 */

/** Product slug: lowercase ASCII words joined by single hyphens, ≤ 64 chars. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 64;
/** Indian PIN: six digits, never starting with 0. */
export const PIN_RE = /^[1-9][0-9]{5}$/;

/** Field length limits (Unicode code points, after cleaning). */
export const FIELD_LIMITS = Object.freeze({
	name: { min: 2, max: 80 },
	email: { max: 254 },
	line1: { min: 5, max: 200 },
	city: { min: 2, max: 60 }
});

/**
 * @param {unknown} s
 * @returns {s is string}
 */
export function isSlug(s) {
	return typeof s === 'string' && s.length <= SLUG_MAX && SLUG_RE.test(s);
}

/* ---------- text cleaning ---------- */

// C0/C1 controls and line breaks become spaces; invisible format characters
// (zero-width space, LRM/RLM, bidi embeddings/overrides/isolates, word joiner,
// BOM) are removed. ZWJ/ZWNJ (U+200C/D) stay: Indic scripts and emoji need them.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const INVISIBLE_RE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Normalise free text: NFC, strip control/bidi/zero-width characters and lone
 * surrogates, collapse whitespace runs to one space, trim. Non-strings → ''.
 * @param {unknown} v
 * @returns {string}
 */
export function cleanText(v) {
	if (typeof v !== 'string') return '';
	let s = dropLoneSurrogates(v);
	s = s.normalize('NFC').replace(CONTROL_RE, ' ').replace(INVISIBLE_RE, '');
	return s.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} s
 * @returns {string}
 */
function dropLoneSurrogates(s) {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += s[i] + s[i + 1];
				i++;
			}
			continue; // unpaired high surrogate
		}
		if (c >= 0xdc00 && c <= 0xdfff) continue; // unpaired low surrogate
		out += s[i];
	}
	return out;
}

/** Length in Unicode code points (an emoji counts once, not twice). @type {(s: string) => number} */
const cpLength = (s) => Array.from(s).length;

/* ---------- phone ---------- */

/**
 * Indian mobile → E.164 '+91XXXXXXXXXX', or null.
 * Accepts spaces, dashes, dots and brackets plus the usual prefixes:
 * '+91 98452 62777', '(+91) 98452-62777', '919845262777', '09845262777',
 * '0091 9845262777', '091 9845262777', '9845262777'.
 * The 10-digit number must start with 6–9, so landlines like '011 2345 6789'
 * and 5xxxxxxxxx numbers are rejected. (Landlines whose STD code starts with
 * 7/8/9, e.g. Bengaluru 080, are indistinguishable from mobiles by syntax.)
 * Only ASCII digits; foreign country codes → null.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeINMobile(input) {
	if (typeof input !== 'string' || input.length > 32) return null;
	const s = input.replace(/[\s\-().]/g, '');
	let d;
	if (/^\+[0-9]+$/.test(s)) {
		if (!s.startsWith('+91')) return null;
		d = s.slice(3);
		if (d.length === 11 && d[0] === '0') d = d.slice(1); // '+91 0 98452 62777'
	} else if (/^[0-9]+$/.test(s)) {
		if (s.length === 14 && s.startsWith('0091')) d = s.slice(4);
		else if (s.length === 13 && s.startsWith('091')) d = s.slice(3);
		else if (s.length === 12 && s.startsWith('91')) d = s.slice(2);
		else if (s.length === 11 && s[0] === '0') d = s.slice(1);
		else d = s;
	} else return null;
	return /^[6-9][0-9]{9}$/.test(d) ? '+91' + d : null;
}

/* ---------- PIN ---------- */

/**
 * Strip whitespace from a typed PIN ('560 001' → '560001'). Numbers are
 * stringified. Does not validate.
 * @param {unknown} v
 * @returns {string}
 */
export function normalizePin(v) {
	if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
	return typeof v === 'string' ? v.replace(/\s+/g, '') : '';
}

/**
 * True when `pin` starts with any digit prefix in `prefixes`. Empty or
 * non-digit prefixes are ignored (an empty prefix must never block every PIN).
 * @param {string} pin
 * @param {ReadonlyArray<string|number>} [prefixes]
 * @returns {boolean}
 */
export function isPinBlocked(pin, prefixes) {
	if (typeof pin !== 'string' || !Array.isArray(prefixes)) return false;
	for (const raw of prefixes) {
		const p = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
		if (typeof p === 'string' && /^[0-9]{1,6}$/.test(p) && pin.startsWith(p)) return true;
	}
	return false;
}

/**
 * Valid Indian PIN (a 6-char string /^[1-9][0-9]{5}$/) that is not blocked by
 * prefix. Numbers and padded strings are NOT valid here — run normalizePin first.
 * @param {unknown} pin
 * @param {ReadonlyArray<string|number>} [blockedPrefixes]
 * @returns {boolean}
 */
export function isValidPin(pin, blockedPrefixes) {
	return typeof pin === 'string' && PIN_RE.test(pin) && !isPinBlocked(pin, blockedPrefixes);
}

/* ---------- email ---------- */

const EMAIL_LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Trim + lowercase, then validate a practical subset of RFC 5321:
 * ≤ 254 chars, exactly one '@', dot-atom local part ≤ 64, a dotted ASCII
 * domain (punycode allowed) with a real TLD, no whitespace. → string | null.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeEmail(input) {
	if (typeof input !== 'string') return null;
	const s = input.trim().toLowerCase();
	if (!s || s.length > 254 || /\s/.test(s)) return null;
	const at = s.indexOf('@');
	if (at <= 0 || at !== s.lastIndexOf('@')) return null;
	const local = s.slice(0, at);
	const domain = s.slice(at + 1);
	if (local.length > 64 || !EMAIL_LOCAL_RE.test(local)) return null;
	if (!domain || domain.length > 253) return null;
	const labels = domain.split('.');
	if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL_RE.test(l))) return null;
	if (!TLD_RE.test(labels[labels.length - 1])) return null;
	return s;
}

/* ---------- states ---------- */

/** The 8 union territories (official names, First Schedule). */
export const INDIAN_UNION_TERRITORIES = Object.freeze([
	'Andaman and Nicobar Islands',
	'Chandigarh',
	'Dadra and Nagar Haveli and Daman and Diu',
	'Delhi',
	'Jammu and Kashmir',
	'Ladakh',
	'Lakshadweep',
	'Puducherry'
]);

/** All 28 states and 8 union territories, alphabetical — the checkout <select>. */
export const INDIAN_STATES = Object.freeze([
	'Andaman and Nicobar Islands',
	'Andhra Pradesh',
	'Arunachal Pradesh',
	'Assam',
	'Bihar',
	'Chandigarh',
	'Chhattisgarh',
	'Dadra and Nagar Haveli and Daman and Diu',
	'Delhi',
	'Goa',
	'Gujarat',
	'Haryana',
	'Himachal Pradesh',
	'Jammu and Kashmir',
	'Jharkhand',
	'Karnataka',
	'Kerala',
	'Ladakh',
	'Lakshadweep',
	'Madhya Pradesh',
	'Maharashtra',
	'Manipur',
	'Meghalaya',
	'Mizoram',
	'Nagaland',
	'Odisha',
	'Puducherry',
	'Punjab',
	'Rajasthan',
	'Sikkim',
	'Tamil Nadu',
	'Telangana',
	'Tripura',
	'Uttar Pradesh',
	'Uttarakhand',
	'West Bengal'
]);

// Former names and common spellings people type (or older saved details carry).
const STATE_ALIASES = {
	orissa: 'Odisha',
	pondicherry: 'Puducherry',
	uttaranchal: 'Uttarakhand',
	'new delhi': 'Delhi',
	'nct of delhi': 'Delhi',
	'national capital territory of delhi': 'Delhi',
	'j and k': 'Jammu and Kashmir',
	'andaman and nicobar': 'Andaman and Nicobar Islands',
	'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
	'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
	tamilnadu: 'Tamil Nadu',
	chattisgarh: 'Chhattisgarh'
};

/** @type {(s: string) => string} */
const stateKey = (s) =>
	cleanText(s)
		.toLowerCase()
		.replace(/\s*&\s*/g, ' and ')
		.replace(/\./g, '')
		.replace(/\s+/g, ' ')
		.trim();

const STATE_LOOKUP = new Map([
	...INDIAN_STATES.map((n) => /** @type {[string, string]} */ ([stateKey(n), n])),
	...Object.entries(STATE_ALIASES)
]);

/**
 * Canonical state/UT name for a typed or selected value (case-, '&'- and
 * whitespace-insensitive, a few former names accepted), or null.
 * @param {unknown} input
 * @returns {string | null}
 */
export function canonicalState(input) {
	if (typeof input !== 'string') return null;
	return STATE_LOOKUP.get(stateKey(input)) ?? null;
}

/* ---------- checkout form ---------- */

/**
 * @typedef {object} CheckoutFormInput
 * @property {unknown} [name]
 * @property {unknown} [email]
 * @property {unknown} [phone]
 * @property {unknown} [line1]
 * @property {unknown} [city]
 * @property {unknown} [state]
 * @property {unknown} [pin]
 */

/**
 * @typedef {object} CheckoutFormValue
 * @property {string} name
 * @property {string} email   lowercased
 * @property {string} phone   E.164 (+91…) when valid
 * @property {string} line1
 * @property {string} city
 * @property {string} state   canonical INDIAN_STATES name when valid
 * @property {string} pin     6 digits when valid
 */

/** @typedef {'REQUIRED'|'INVALID'|'TOO_SHORT'|'TOO_LONG'|'UNSERVICEABLE'} FieldErrorCode */

/**
 * Validate and normalise the checkout contact + address form.
 * Every field is required. `value` always holds the cleaned input (so the UI
 * can re-display it) but is only trustworthy when `ok` is true.
 * Field errors: REQUIRED | INVALID | TOO_SHORT | TOO_LONG, plus UNSERVICEABLE
 * for a PIN that matches `options.blockedPinPrefixes` (server-side setting).
 * Finite numbers are accepted for phone/pin; other non-strings are INVALID.
 * @param {CheckoutFormInput} input
 * @param {{ blockedPinPrefixes?: ReadonlyArray<string|number> }} [options]
 * @returns {{ ok: boolean, value: CheckoutFormValue, errors: Partial<Record<keyof CheckoutFormValue, FieldErrorCode>> }}
 */
export function validateCheckoutForm(input, options = {}) {
	const src = input && typeof input === 'object' ? input : {};
	/** @type {Partial<Record<keyof CheckoutFormValue, FieldErrorCode>>} */
	const errors = {};
	/** @type {any} */
	const value = {};

	/** raw → cleaned string, or null when the type is unusable
	 * @type {(v: unknown, allowNumber?: boolean) => string | null} */
	const text = (v, allowNumber = false) => {
		if (v === undefined || v === null) return '';
		if (typeof v === 'string') return cleanText(v);
		if (allowNumber && typeof v === 'number' && Number.isFinite(v)) return String(v);
		return null;
	};

	/** @type {(field: keyof CheckoutFormValue, s: string, lim: {min?: number, max?: number}) => void} */
	const lengthCheck = (field, s, { min = 0, max = Infinity }) => {
		const n = cpLength(s);
		if (n > max) errors[field] = 'TOO_LONG';
		else if (n < min) errors[field] = 'TOO_SHORT';
	};

	// name
	{
		const s = text(src.name);
		value.name = s ?? '';
		if (s === null) errors.name = 'INVALID';
		else if (!s) errors.name = 'REQUIRED';
		else {
			lengthCheck('name', s, FIELD_LIMITS.name);
			if (!errors.name && !/\p{L}/u.test(s)) errors.name = 'INVALID';
		}
	}
	// email
	{
		const s = text(src.email);
		const trimmed = s ?? '';
		const norm = normalizeEmail(trimmed);
		value.email = norm ?? trimmed.toLowerCase();
		if (s === null) errors.email = 'INVALID';
		else if (!s) errors.email = 'REQUIRED';
		else if (s.length > FIELD_LIMITS.email.max) errors.email = 'TOO_LONG';
		else if (!norm) errors.email = 'INVALID';
	}
	// phone
	{
		const s = text(src.phone, true);
		const norm = s ? normalizeINMobile(s) : null;
		value.phone = norm ?? (s ?? '');
		if (s === null) errors.phone = 'INVALID';
		else if (!s) errors.phone = 'REQUIRED';
		else if (!norm) errors.phone = 'INVALID';
	}
	// line1
	{
		const s = text(src.line1);
		value.line1 = s ?? '';
		if (s === null) errors.line1 = 'INVALID';
		else if (!s) errors.line1 = 'REQUIRED';
		else lengthCheck('line1', s, FIELD_LIMITS.line1);
	}
	// city
	{
		const s = text(src.city);
		value.city = s ?? '';
		if (s === null) errors.city = 'INVALID';
		else if (!s) errors.city = 'REQUIRED';
		else {
			lengthCheck('city', s, FIELD_LIMITS.city);
			if (!errors.city && !/\p{L}/u.test(s)) errors.city = 'INVALID';
		}
	}
	// state
	{
		const s = text(src.state);
		const canon = s ? canonicalState(s) : null;
		value.state = canon ?? (s ?? '');
		if (s === null) errors.state = 'INVALID';
		else if (!s) errors.state = 'REQUIRED';
		else if (!canon) errors.state = 'INVALID';
	}
	// pin
	{
		const raw = src.pin;
		const usable = raw === undefined || raw === null || typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw));
		const s = usable ? normalizePin(raw === null ? '' : raw) : null;
		value.pin = s ?? '';
		if (s === null) errors.pin = 'INVALID';
		else if (!s) errors.pin = 'REQUIRED';
		else if (!PIN_RE.test(s)) errors.pin = 'INVALID';
		else if (isPinBlocked(s, options.blockedPinPrefixes)) errors.pin = 'UNSERVICEABLE';
	}

	return { ok: Object.keys(errors).length === 0, value, errors };
}

/* ---------- masking (order status DTOs, "we'll email you at …") ---------- */

/**
 * 'asha.k@gmail.com' → 'a•••@gmail.com'. Invalid input → ''.
 * @param {unknown} email
 * @returns {string}
 */
export function maskEmail(email) {
	const e = normalizeEmail(email);
	if (!e) return '';
	const at = e.indexOf('@');
	return e[0] + '•••' + e.slice(at);
}

/**
 * '+919845262777' → '+91 ••••• ••777'. Invalid input → ''.
 * @param {unknown} phone
 * @returns {string}
 */
export function maskPhone(phone) {
	const p = normalizeINMobile(typeof phone === 'string' ? phone : '');
	if (!p) return '';
	return '+91 ••••• ••' + p.slice(-3);
}

/**
 * First word of a cleaned name ('  Asha  Kumar ' → 'Asha'), for greetings.
 * @param {unknown} name
 * @returns {string}
 */
export function firstName(name) {
	return cleanText(name).split(' ')[0] || '';
}
