/*
 * One-shot link tokens (the emailed /login?verify=… and /reset-password?token=…
 * links), kept for this tab until they have done their job.
 *
 * Both pages drop the token from the address bar on mount, so it never lingers
 * in history, bookmarks or a shared screenshot. On its own that strands the
 * customer: a reload before the token is used (pull-to-refresh, Android
 * discarding the tab while they are in their password manager) finds nothing,
 * and a verify request lost to a network blip leaves "try again" with nothing
 * to retry. So the token also goes to sessionStorage (this tab only, gone when
 * the tab closes) and is read back when the address has none. It is dropped
 * once used, on a definitive RESET_INVALID / VERIFY_INVALID, and after KEEP_MS
 * (a reset link works for one hour).
 *
 * Storage can be missing or throw (private modes, blocked site data): then the
 * pages simply behave as before.
 */
import { isAuthToken } from '$lib/session.js';

export const LINK_TOKEN_KEYS = Object.freeze({ reset: 'wefeasto_reset_token', verify: 'wefeasto_verify_token' });
export const KEEP_MS = 60 * 60_000;

function store() {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

/** Keep `token` for this tab (kind: 'reset' | 'verify'). Returns whether it was stored. */
export function keepLinkToken(kind, token, now = Date.now()) {
	const key = LINK_TOKEN_KEYS[kind];
	if (!key || !isAuthToken(token)) return false;
	try {
		const s = store();
		if (!s) return false;
		s.setItem(key, JSON.stringify({ t: token, at: now }));
		return true;
	} catch {
		return false;
	}
}

/** The token kept for this tab, or null (none, malformed or older than KEEP_MS — those are dropped). */
export function keptLinkToken(kind, now = Date.now()) {
	const key = LINK_TOKEN_KEYS[kind];
	if (!key) return null;
	let raw = null;
	try {
		raw = store()?.getItem(key) ?? null;
	} catch {
		return null;
	}
	if (raw === null) return null;
	let v = null;
	try {
		v = JSON.parse(raw);
	} catch {
		v = null;
	}
	const fresh = !!v && isAuthToken(v.t) && Number.isFinite(v.at) && Math.abs(now - v.at) < KEEP_MS;
	if (!fresh) {
		dropLinkToken(kind);
		return null;
	}
	return v.t;
}

/** Forget the token kept for this tab. */
export function dropLinkToken(kind) {
	const key = LINK_TOKEN_KEYS[kind];
	if (!key) return;
	try {
		store()?.removeItem(key);
	} catch {
		/* storage blocked: nothing was kept */
	}
}

/** This document came from a reload or a history step (back/forward, a restored tab), not a fresh link. */
export function wasReloaded() {
	try {
		const type = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type;
		return type === 'reload' || type === 'back_forward';
	} catch {
		return false;
	}
}
