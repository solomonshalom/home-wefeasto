/*
 * "Pay on delivery instead" from the pending banner and /order's failed view:
 * - cod-check.js: COD availability for the bag (server quote with method
 *   'cod', local $shared quote when /api can't answer), one look per ask;
 * - storage.js wefeasto_pending_form: the details the pending online order
 *   was placed with (sessionStorage), so /checkout?pay=cod prefills the same
 *   phone and the COD order supersedes it.
 */
import { describe, it, expect, vi } from 'vitest';
import { codAvailableFor, createCodCheck } from '$lib/checkout/cod-check.js';
import { writePendingForm, readPendingForm, clearPendingForm, PENDING_FORM_KEY } from '$lib/checkout/storage.js';
import { quote } from '$shared/pricing.js';
import { resolveSettings } from '$shared/settings.js';
import { makeEnv, blockedEnv, memStorage } from './_helpers.js';

const CATALOG = [
	{ slug: 'muesli', name: 'Muesli', pricePaise: 25000, inStock: true, maxPerOrder: 10, codAllowed: true },
	{ slug: 'health-mix', name: 'Health Mix', pricePaise: 45000, inStock: true, maxPerOrder: 10, codAllowed: true },
	{ slug: 'gift-box', name: 'Gift Box', pricePaise: 30000, inStock: true, maxPerOrder: 10, codAllowed: false },
	{ slug: 'oats', name: 'Oats', pricePaise: 20000, inStock: false, maxPerOrder: 10, codAllowed: true }
];
const SETTINGS = resolveSettings({});
const q = (items, over = {}) => quote({ items, catalog: CATALOG, settings: { ...SETTINGS, ...over }, method: 'cod' });
const ok = (data) => ({ ok: true, status: 200, data, error: null });
const down = { ok: false, status: 0, data: null, error: { code: 'NETWORK', message: 'x', details: null } };

describe('codAvailableFor()', () => {
	const items = [{ slug: 'muesli', qty: 1 }];

	it('asks POST /store/quote with method cod (and a valid PIN only) and reads its COD answer', async () => {
		const api = vi.fn(async () => ok({ quote: q(items) }));
		expect(await codAvailableFor({ items, pin: '560001' }, { api })).toBe(true);
		expect(api).toHaveBeenCalledWith('/store/quote', { method: 'POST', body: { items, pin: '560001', method: 'cod' }, timeoutMs: 8000 });
		await codAvailableFor({ items, pin: '5600' }, { api });
		expect(api.mock.calls[1][1].body).toEqual({ items, method: 'cod' });
	});

	it('the server says no (disabled, above the cap, an item not allowed) → false', async () => {
		for (const answer of [q(items, { codEnabled: false }), q([{ slug: 'health-mix', qty: 10 }]), q([{ slug: 'gift-box', qty: 1 }])]) {
			expect(answer.codAvailable).toBe(false);
			expect(await codAvailableFor({ items }, { api: async () => ok({ quote: answer }) })).toBe(false);
		}
	});

	it('stock is not COD’s to judge: an all-sold-out quote (EMPTY) does not rule COD out', async () => {
		const answer = q([{ slug: 'oats', qty: 1 }]);
		expect(answer.codUnavailableReason).toBe('EMPTY');
		expect(await codAvailableFor({ items: [{ slug: 'oats', qty: 1 }] }, { api: async () => ok({ quote: answer }) })).toBe(true);
	});

	it('a bare quote body is accepted too', async () => {
		expect(await codAvailableFor({ items }, { api: async () => ok(q(items)) })).toBe(true);
	});

	it('/api can’t answer (offline, 5xx, junk, a throwing stub) → the local quote decides', async () => {
		const local = vi.fn(() => q(items));
		for (const api of [async () => down, async () => ({ ok: false, status: 500, data: null, error: { code: 'INTERNAL' } }), async () => ok({ quote: { nope: 1 } }), async () => { throw new Error('boom'); }]) {
			expect(await codAvailableFor({ items }, { api, localQuote: local })).toBe(true);
		}
		expect(await codAvailableFor({ items }, { api: async () => down, localQuote: () => q(items, { codEnabled: false }) })).toBe(false);
	});

	it('no answer anywhere, or an empty bag → false (never offer what may not go through)', async () => {
		expect(await codAvailableFor({ items }, { api: async () => down })).toBe(false);
		expect(await codAvailableFor({ items }, { api: async () => down, localQuote: () => { throw new Error('x'); } })).toBe(false);
		const api = vi.fn();
		expect(await codAvailableFor({ items: [] }, { api })).toBe(false);
		expect(await codAvailableFor({ items: null }, { api })).toBe(false);
		expect(api).not.toHaveBeenCalled();
	});
});

describe('createCodCheck()', () => {
	it('one request per ask key; a new key asks again; the local quote gets the items and PIN', async () => {
		const api = vi.fn(async () => down);
		const localQuote = vi.fn((items) => q(items));
		const c = createCodCheck({ api, localQuote });
		const ask = { items: [{ slug: 'muesli', qty: 1 }], pin: '560001' };
		const [a, b] = await Promise.all([c.check('muesli:1|560001', ask), c.check('muesli:1|560001', ask)]);
		expect([a, b]).toEqual([true, true]);
		expect(api).toHaveBeenCalledTimes(1);
		expect(localQuote).toHaveBeenCalledWith(ask.items, '560001');
		await c.check('muesli:2|', { items: [{ slug: 'muesli', qty: 2 }] });
		expect(api).toHaveBeenCalledTimes(2);
	});
});

describe('wefeasto_pending_form (sessionStorage)', () => {
	const FORM = { name: ' Asha Kumar ', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'karnataka', pin: '560 001' };

	it('round-trips the form for that order only, cleaned like saved details, in sessionStorage', () => {
		const env = makeEnv();
		expect(writePendingForm({ no: 'WF-10001', form: FORM }, env)).toBe(true);
		expect(env.localStore.map.size).toBe(0); // never localStorage
		expect(JSON.parse(env.sessionStore.getItem(PENDING_FORM_KEY)).no).toBe('WF-10001');
		expect(readPendingForm('WF-10001', env)).toEqual({ name: 'Asha Kumar', phone: '98452 62777', email: 'asha@example.com', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
		expect(readPendingForm('WF-10002', env)).toBeNull();
		expect(readPendingForm(null, env)).toBeNull();
		clearPendingForm(env);
		expect(readPendingForm('WF-10001', env)).toBeNull();
	});

	it('refuses junk on write and reads junk as nothing', () => {
		const env = makeEnv();
		expect(writePendingForm({ no: 'nope', form: FORM }, env)).toBe(false);
		expect(writePendingForm({ no: 'WF-10001', form: null }, env)).toBe(false);
		for (const junk of ['{', '"x"', '[]', JSON.stringify({ no: 'WF-10001' }), JSON.stringify({ no: 'WF-10001', form: { name: 42, state: 'Atlantis', pin: 'abc' } })]) {
			env.sessionStore = memStorage({ [PENDING_FORM_KEY]: junk });
			expect(readPendingForm('WF-10001', env)).toBeNull();
		}
	});

	it('storage that throws: nothing stored, nothing read, nothing thrown', () => {
		const env = blockedEnv(1);
		expect(writePendingForm({ no: 'WF-10001', form: FORM }, env)).toBe(false);
		expect(readPendingForm('WF-10001', env)).toBeNull();
		expect(() => clearPendingForm(env)).not.toThrow();
	});
});
