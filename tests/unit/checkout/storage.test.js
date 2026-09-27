/*
 * Checkout / order Web Storage helpers: wefeasto_pending, wefeasto_last_order,
 * wefeasto_seen_<no>, wefeasto_checkout (S1) and the Idempotency-Key record —
 * including storage that throws and garbage left in storage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	readPending,
	writePending,
	clearPending,
	PENDING_KEY,
	PENDING_MAX_AGE_MS,
	DAY,
	readLastOrderRef,
	writeLastOrder,
	LAST_ORDER_KEY,
	tokenFor,
	isSeen,
	markSeen,
	SEEN_PREFIX,
	_resetSeenMemory,
	readSaved,
	writeSaved,
	clearSaved,
	SAVED_KEY,
	idempotencyKeyFor,
	forgetIdempotencyKey,
	IDEM_KEY,
	itemsMap,
	isToken
} from '$lib/checkout/storage.js';
import { readLastOrder } from '$lib/components/YourUsual.svelte';
import { makeEnv, blockedEnv, memStorage, throwingStorage, TOKEN, TOKEN2, fakeUuid } from './_helpers.js';

beforeEach(() => _resetSeenMemory());

describe('wefeasto_pending', () => {
	it('round-trips {no, t, at, cartSig} and stamps `at` from the clock', () => {
		const env = makeEnv();
		expect(writePending({ no: 'WF-10001', t: TOKEN, cartSig: 'cornflakes:2' }, env)).toBe(true);
		expect(JSON.parse(env.localStore.getItem(PENDING_KEY))).toEqual({ no: 'WF-10001', t: TOKEN, at: env.t, cartSig: 'cornflakes:2' });
		expect(readPending(env)).toEqual({ no: 'WF-10001', t: TOKEN, at: env.t, cartSig: 'cornflakes:2' });
	});

	it('is kept for 7 days, then dropped (and removed from storage)', () => {
		const env = makeEnv();
		writePending({ no: 'WF-10001', t: TOKEN }, env);
		env.t += PENDING_MAX_AGE_MS;
		expect(readPending(env)?.no).toBe('WF-10001');
		env.t += 1;
		expect(readPending(env)).toBeNull();
		expect(env.localStore.getItem(PENDING_KEY)).toBeNull();
	});

	it.each([
		['not JSON', '{nope'],
		['an array', '[1,2]'],
		['bad number', JSON.stringify({ no: 'WF-1', t: TOKEN, at: 1_800_000_000_000 })],
		['missing token', JSON.stringify({ no: 'WF-10001', at: 1_800_000_000_000 })],
		['junk token', JSON.stringify({ no: 'WF-10001', t: 'a b', at: 1_800_000_000_000 })],
		['string at', JSON.stringify({ no: 'WF-10001', t: TOKEN, at: '2027-01-01' })],
		['from the future', JSON.stringify({ no: 'WF-10001', t: TOKEN, at: 1_800_000_000_000 + 2 * DAY })]
	])('garbage (%s) → null and removed', (_, raw) => {
		const env = makeEnv({ local: memStorage({ [PENDING_KEY]: raw }) });
		expect(readPending(env)).toBeNull();
		expect(env.localStore.getItem(PENDING_KEY)).toBeNull();
	});

	it('refuses to write a malformed number or token', () => {
		const env = makeEnv();
		expect(writePending({ no: 'order-1', t: TOKEN }, env)).toBe(false);
		expect(writePending({ no: 'WF-10001', t: '' }, env)).toBe(false);
		expect(env.localStore.length).toBe(0);
	});

	it('storage throwing: write false, read null, clear silent', () => {
		for (const env of [blockedEnv(), makeEnv({ local: throwingStorage() })]) {
			expect(writePending({ no: 'WF-10001', t: TOKEN }, env)).toBe(false);
			expect(readPending(env)).toBeNull();
			expect(() => clearPending(env)).not.toThrow();
		}
	});
});

describe('wefeasto_last_order', () => {
	it('writes the contract YourUsual reads ({no, t, items:{slug:qty}, at})', () => {
		const env = makeEnv();
		writeLastOrder({ no: 'WF-10001', t: TOKEN, items: [{ slug: 'cornflakes', qty: 2, name: 'Cornflakes' }, { slug: 'muesli', qty: 1 }] }, env);
		const stored = JSON.parse(env.localStore.getItem(LAST_ORDER_KEY));
		expect(stored).toEqual({ no: 'WF-10001', t: TOKEN, items: { cornflakes: 2, muesli: 1 }, at: env.t });
		// the reader that powers "Your usual" accepts it as-is
		expect(readLastOrder(env.t, undefined, stored)).toEqual({ no: 'WF-10001', t: TOKEN, items: { cornflakes: 2, muesli: 1 }, at: env.t });
		expect(readLastOrderRef(env)).toEqual({ no: 'WF-10001', t: TOKEN });
	});

	it('itemsMap sums duplicates and skips junk', () => {
		expect(itemsMap([{ slug: 'a', qty: 1 }, { slug: 'a', qty: 2 }, { slug: 'b', qty: 0 }, { slug: '', qty: 1 }, null, { slug: 'c', qty: 1.5 }, { slug: 'd', qty: '2' }])).toEqual({ a: 3, d: 2 });
		expect(itemsMap(null)).toEqual({});
	});
});

describe('tokenFor (the /order fallback when the link has no t)', () => {
	it('prefers the pending order, then the last order, for the same number only', () => {
		const env = makeEnv();
		expect(tokenFor('WF-10001', env)).toBeNull();
		writeLastOrder({ no: 'WF-10001', t: TOKEN, items: [] }, env);
		expect(tokenFor('WF-10001', env)).toBe(TOKEN);
		writePending({ no: 'WF-10001', t: TOKEN2 }, env);
		expect(tokenFor('WF-10001', env)).toBe(TOKEN2);
		expect(tokenFor('WF-10002', env)).toBeNull();
		expect(tokenFor('nope', env)).toBeNull();
		expect(tokenFor(' WF-10001 ', env)).toBe(TOKEN2);
	});

	it('storage throwing → null', () => {
		expect(tokenFor('WF-10001', blockedEnv())).toBeNull();
	});
});

describe('wefeasto_seen_<no>', () => {
	it('marks and reads 1', () => {
		const env = makeEnv();
		expect(isSeen('WF-10001', env)).toBe(false);
		expect(markSeen('WF-10001', env)).toBe(true);
		expect(env.localStore.getItem(SEEN_PREFIX + 'WF-10001')).toBe('1');
		expect(isSeen('WF-10001', env)).toBe(true);
		expect(isSeen('WF-10002', env)).toBe(false);
	});

	it('storage throwing: remembered for this page session', () => {
		const env = blockedEnv();
		expect(isSeen('WF-10001', env)).toBe(false);
		expect(markSeen('WF-10001', env)).toBe(false);
		expect(isSeen('WF-10001', env)).toBe(true);
	});

	it('only the value 1 counts', () => {
		const env = makeEnv({ local: memStorage({ [SEEN_PREFIX + 'WF-10001']: '"yes"' }) });
		expect(isSeen('WF-10001', env)).toBe(false);
	});
});

describe('wefeasto_checkout (S1 save my details)', () => {
	const details = { name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' };

	it('round-trips every field', () => {
		const env = makeEnv();
		expect(writeSaved(details, env)).toBe(true);
		expect(readSaved(env)).toEqual(details);
		clearSaved(env);
		expect(env.localStore.getItem(SAVED_KEY)).toBeNull();
		expect(readSaved(env)).toBeNull();
	});

	it('validates each field: a partial / old-schema object keeps what still looks right', () => {
		const env = makeEnv({
			local: memStorage({ [SAVED_KEY]: { name: '  Asha  ', phone: 98452, email: 'x'.repeat(300), state: 'orissa', pin: '5600', city: ['x'], legacyField: 'z' } })
		});
		const r = readSaved(env);
		expect(r.name).toBe('Asha');
		expect(r.phone).toBe('');
		expect(r.email.length).toBe(254);
		expect(r.state).toBe('Odisha'); // canonical name
		expect(r.pin).toBe('');
		expect(r.city).toBe('');
		expect(r).not.toHaveProperty('legacyField');
	});

	it('an unknown state is dropped', () => {
		const env = makeEnv({ local: memStorage({ [SAVED_KEY]: { name: 'A', state: 'Atlantis' } }) });
		expect(readSaved(env).state).toBe('');
	});

	it('nothing usable / not an object → null and removed', () => {
		for (const raw of ['{}', '[1]', '"x"', '{bad', JSON.stringify({ name: 5, phone: null })]) {
			const env = makeEnv({ local: memStorage({ [SAVED_KEY]: raw }) });
			expect(readSaved(env)).toBeNull();
			expect(env.localStore.getItem(SAVED_KEY)).toBeNull();
		}
	});

	it('storage throwing: nothing saved, nothing read, no throw', () => {
		const env = blockedEnv();
		expect(writeSaved(details, env)).toBe(false);
		expect(readSaved(env)).toBeNull();
		expect(() => clearSaved(env)).not.toThrow();
	});
});

describe('Idempotency-Key per (cart signature + form hash)', () => {
	it('same attempt → same key (double tap, reload); change either → new key', () => {
		const env = makeEnv();
		const k1 = idempotencyKeyFor({ cartSig: 'cornflakes:2', formHash: 'f1' }, { newKey: fakeUuid, env });
		expect(idempotencyKeyFor({ cartSig: 'cornflakes:2', formHash: 'f1' }, { newKey: fakeUuid, env })).toBe(k1);
		expect(JSON.parse(env.sessionStore.getItem(IDEM_KEY))).toEqual({ sig: 'cornflakes:2', form: 'f1', k: k1 });
		const k2 = idempotencyKeyFor({ cartSig: 'cornflakes:3', formHash: 'f1' }, { newKey: fakeUuid, env });
		expect(k2).not.toBe(k1);
		const k3 = idempotencyKeyFor({ cartSig: 'cornflakes:3', formHash: 'f2' }, { newKey: fakeUuid, env });
		expect(k3).not.toBe(k2);
		// going back to an earlier attempt is a new attempt too (one record per tab)
		expect(idempotencyKeyFor({ cartSig: 'cornflakes:2', formHash: 'f1' }, { newKey: fakeUuid, env })).not.toBe(k1);
	});

	it('survives a reload (a fresh module read of sessionStorage)', () => {
		const session = memStorage();
		const k = idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env: makeEnv({ session }) });
		expect(idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env: makeEnv({ session }) })).toBe(k);
	});

	it('forgetIdempotencyKey → next attempt gets a fresh key', () => {
		const env = makeEnv();
		const k = idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env });
		forgetIdempotencyKey(env);
		expect(env.sessionStore.getItem(IDEM_KEY)).toBeNull();
		expect(idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env })).not.toBe(k);
	});

	it('a tampered record (not a uuid v4) is replaced', () => {
		const env = makeEnv({ session: memStorage({ [IDEM_KEY]: { sig: 's', form: 'f', k: 'not-a-uuid' } }) });
		const k = idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env });
		expect(k).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('sessionStorage throwing: the key is kept in memory for the page session', () => {
		const env = blockedEnv();
		forgetIdempotencyKey(env);
		const k = idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env });
		expect(idempotencyKeyFor({ cartSig: 's', formHash: 'f' }, { newKey: fakeUuid, env })).toBe(k);
		expect(idempotencyKeyFor({ cartSig: 's2', formHash: 'f' }, { newKey: fakeUuid, env })).not.toBe(k);
	});
});

describe('isToken', () => {
	it('accepts base64url tokens, rejects junk', () => {
		expect(isToken(TOKEN)).toBe(true);
		expect(isToken('short')).toBe(false);
		expect(isToken('has space in it')).toBe(false);
		expect(isToken('<script>alert(1)</script>')).toBe(false);
		expect(isToken(null)).toBe(false);
		expect(isToken('x'.repeat(257))).toBe(false);
	});
});

describe('wefeasto_placed_<no> and clearPendingFor (PI-ORD-3)', () => {
	it('markPlaced / consumePlaced: answers once; junk numbers never match; another order’s marker is separate', async () => {
		const s = await import('$lib/checkout/storage.js');
		s._resetSeenMemory();
		const env = makeEnv();
		expect(s.markPlaced('WF-10001', env)).toBe(true);
		expect(env.localStore.getItem(s.PLACED_PREFIX + 'WF-10001')).toBe(String(env.t));
		expect(s.consumePlaced('WF-10002', env)).toBe(false);
		expect(s.consumePlaced(' WF-10001 ', env)).toBe(true);
		expect(s.consumePlaced('WF-10001', env)).toBe(false);
		expect(s.markPlaced('nope', env)).toBe(false);
		expect(s.consumePlaced(undefined, env)).toBe(false);
		// Another page load, same device: storage alone remembers.
		s.markPlaced('WF-10003', env);
		s._resetSeenMemory();
		expect(s.consumePlaced('WF-10003', env)).toBe(true);
	});

	it('storage blocked: the page-session copy still answers; nothing throws', async () => {
		const s = await import('$lib/checkout/storage.js');
		s._resetSeenMemory();
		const env = blockedEnv();
		expect(s.markPlaced('WF-10001', env)).toBe(false);
		expect(s.consumePlaced('WF-10001', env)).toBe(true);
		expect(s.consumePlaced('WF-10001', env)).toBe(false);
	});

	it('clearPendingFor drops the pending entry only when it names that order', async () => {
		const s = await import('$lib/checkout/storage.js');
		const env = makeEnv();
		s.writePending({ no: 'WF-10001', t: 'dGVzdC10b2tlbi1mb3I', cartSig: 'muesli:1' }, env);
		s.clearPendingFor('WF-10002', env);
		expect(s.readPending(env)).toMatchObject({ no: 'WF-10001' });
		s.clearPendingFor('WF-10001', env);
		expect(s.readPending(env)).toBeNull();
		expect(() => s.clearPendingFor('WF-10001', blockedEnv())).not.toThrow();
	});
});
