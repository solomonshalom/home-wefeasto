/*
 * src/routes/login/link-token.js — the emailed one-shot tokens (?verify=, /reset-password?token=)
 * are kept for this tab until used (hunt client-ux: one-shot-links-stranded).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.js', () => ({ api: vi.fn() }));
vi.mock('$lib/track.js', () => ({ track: vi.fn() }));

const { keepLinkToken, keptLinkToken, dropLinkToken, wasReloaded, LINK_TOKEN_KEYS, KEEP_MS } = await import('../../../src/routes/login/link-token.js');

const TOKEN = '1707d8f866934bf96b9f200be9e52b47b0fb242d';
const OTHER = '1ebab832cf75df7fbeb9923f414bea0d903d62d7';

function memoryStorage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		dump: () => Object.fromEntries(m)
	};
}

let storage;
beforeEach(() => {
	storage = memoryStorage();
	vi.stubGlobal('sessionStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

describe('keep / read back / drop', () => {
	it('a kept token reads back for the same kind only, under its own key', () => {
		expect(keepLinkToken('reset', TOKEN, 1000)).toBe(true);
		expect(keptLinkToken('reset', 2000)).toBe(TOKEN);
		expect(keptLinkToken('verify', 2000)).toBeNull();
		expect(Object.keys(storage.dump())).toEqual([LINK_TOKEN_KEYS.reset]);
		expect(LINK_TOKEN_KEYS).toEqual({ reset: 'wefeasto_reset_token', verify: 'wefeasto_verify_token' });
	});

	it('a newer link replaces the kept one; drop forgets it', () => {
		keepLinkToken('verify', TOKEN, 1000);
		keepLinkToken('verify', OTHER, 1500);
		expect(keptLinkToken('verify', 2000)).toBe(OTHER);
		dropLinkToken('verify');
		expect(keptLinkToken('verify', 2000)).toBeNull();
	});

	it('never keeps a malformed token or an unknown kind', () => {
		for (const bad of ['', null, undefined, 'not a token!', '../../customers/me', 'a'.repeat(600)]) expect(keepLinkToken('reset', bad)).toBe(false);
		expect(keepLinkToken('login', TOKEN)).toBe(false);
		expect(storage.dump()).toEqual({});
	});

	it('expires after KEEP_MS (one hour, the reset link lifetime) and is then dropped', () => {
		expect(KEEP_MS).toBe(60 * 60_000);
		keepLinkToken('reset', TOKEN, 0);
		expect(keptLinkToken('reset', KEEP_MS - 1)).toBe(TOKEN);
		expect(keptLinkToken('reset', KEEP_MS)).toBeNull();
		expect(storage.dump()).toEqual({});
	});

	it('tampered or garbled storage reads as nothing (and is cleaned up)', () => {
		for (const raw of ['{', '"x"', JSON.stringify({ t: 'bad token!', at: 1 }), JSON.stringify({ t: TOKEN }), JSON.stringify({ t: TOKEN, at: 'soon' })]) {
			storage.setItem(LINK_TOKEN_KEYS.reset, raw);
			expect(keptLinkToken('reset', 2), raw).toBeNull();
			expect(storage.getItem(LINK_TOKEN_KEYS.reset), raw).toBeNull();
		}
	});
});

describe('storage blocked or missing', () => {
	it('every call is a harmless no-op', () => {
		const boom = () => {
			throw new DOMException('denied', 'SecurityError');
		};
		vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });
		expect(keepLinkToken('reset', TOKEN)).toBe(false);
		expect(keptLinkToken('reset')).toBeNull();
		expect(() => dropLinkToken('reset')).not.toThrow();
		vi.stubGlobal('sessionStorage', undefined);
		expect(keepLinkToken('verify', TOKEN)).toBe(false);
		expect(keptLinkToken('verify')).toBeNull();
	});
});

describe('wasReloaded', () => {
	const nav = (type) => vi.stubGlobal('performance', { getEntriesByType: (t) => (t === 'navigation' && type ? [{ type }] : []) });
	it('reload and back/forward count; a fresh link or no timing API does not', () => {
		nav('reload');
		expect(wasReloaded()).toBe(true);
		nav('back_forward');
		expect(wasReloaded()).toBe(true);
		nav('navigate');
		expect(wasReloaded()).toBe(false);
		nav(null);
		expect(wasReloaded()).toBe(false);
		vi.stubGlobal('performance', undefined);
		expect(wasReloaded()).toBe(false);
	});
});
