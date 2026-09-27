/*
 * PIN → city/state prefill (roadmap S5). Static shards built from GeoNames
 * (CC BY 4.0; static/pin/CREDITS.txt): /pin/560.json = {"001": ["Bengaluru",
 * "Karnataka"], …}. A lookup never blocks checkout: an unknown PIN, a missing
 * shard or a failed fetch all resolve to null, silently.
 */
import { normalizePin, canonicalState } from '$shared/validate.js';
import { PIN_PREFIXES } from './pin-prefixes.js';

/** Autofill only for 1–8 (9xxxxx is the Army Postal Service). */
export const PIN_AUTOFILL_RE = /^[1-8]\d{5}$/;
export const PIN_BASE = '/pin/';

const shards = new Map(); // prefix → Promise<object | null>

function loadShard(prefix, fetchFn, base) {
	let p = shards.get(prefix);
	if (!p) {
		p = Promise.resolve()
			.then(() => fetchFn(base + prefix + '.json', { credentials: 'omit' }))
			.then((r) => (r.ok ? r.json() : r.status === 404 ? {} : null))
			.then((d) => (d && typeof d === 'object' && !Array.isArray(d) ? d : null))
			.catch(() => null);
		shards.set(prefix, p);
		p.then((d) => {
			if (d === null) shards.delete(prefix); // network trouble: try again next time
		});
	}
	return p;
}

/**
 * A prefix with no shard (a typo, an unassigned range) answers null without
 * fetching: /pin/<prefix>.json would 404 and log a console error (PI-PAY-4).
 * @param {unknown} pin
 * @param {{ fetch?: typeof fetch, base?: string, prefixes?: {has: (p: string) => boolean} | null }} [opts]
 *   prefixes: the prefixes that have a shard (generated pin-prefixes.js); null = try any
 * @returns {Promise<{city: string, state: string} | null>}
 */
export async function lookupPin(pin, { fetch: fetchFn = globalThis.fetch, base = PIN_BASE, prefixes = PIN_PREFIXES } = {}) {
	const p = normalizePin(pin);
	if (typeof p !== 'string' || !PIN_AUTOFILL_RE.test(p) || typeof fetchFn !== 'function') return null;
	if (prefixes && !prefixes.has(p.slice(0, 3))) return null;
	const data = await loadShard(p.slice(0, 3), fetchFn, base);
	const key = p.slice(3);
	const hit = data && Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
	if (!Array.isArray(hit)) return null;
	const city = typeof hit[0] === 'string' ? hit[0].trim().slice(0, 60) : '';
	const state = typeof hit[1] === 'string' ? canonicalState(hit[1]) || '' : '';
	return city || state ? { city, state } : null;
}

/**
 * What a PIN answer may write into City and State, field by field:
 * - a field the customer typed or picked (not empty, and not from an earlier
 *   answer) is never overwritten;
 * - a field the customer is in right now is HELD, not filled: a value set
 *   under their caret gets typed onto ("Mysuru" + "Mysore" → "MysuruMysore").
 *   The page fills a held value when they leave the field without typing in
 *   it, and drops it once they type.
 * @param {{city?: string, state?: string} | null} hit  lookupPin's answer
 * @param {{city?: string, state?: string}} form
 * @param {{city?: boolean, state?: boolean}} auto  fields an earlier answer filled, untouched since
 * @param {'city'|'state'|null} [focused]  the field the customer is in
 * @returns {{fill: {city?: string, state?: string}, hold: {city?: string, state?: string}}}
 */
export function planPinFill(hit, form, auto, focused = null) {
	const plan = { fill: {}, hold: {} };
	if (!hit || typeof hit !== 'object') return plan;
	for (const f of ['city', 'state']) {
		const v = typeof hit[f] === 'string' ? hit[f] : '';
		if (!v) continue;
		const cur = typeof form?.[f] === 'string' ? form[f].trim() : '';
		if (cur && !auto?.[f]) continue; // the customer's own
		if (cur === v) continue;
		if (focused === f) plan.hold[f] = v;
		else plan.fill[f] = v;
	}
	return plan;
}

/** Tests only. */
export function _resetPinCache() {
	shards.clear();
}
