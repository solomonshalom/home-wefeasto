/*
 * Hunt round 3 (client-ux): wefeasto_kept and the /order notice for an order an earlier, unheard
 * tap had already placed (kept.js, storage.js).
 */
import { describe, it, expect } from 'vitest';
import { keptRecord, keptCopy, keptAddress, showPhone } from '$lib/checkout/kept.js';
import { writeKept, readKept, KEPT_KEY } from '$lib/checkout/storage.js';
import { makeEnv, blockedEnv } from './_helpers.js';

const WAS = {
	items: [{ slug: 'choco-flakes', qty: 1 }],
	contact: { name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777' },
	address: { line1: 'Flat 4B, 12 MG Raod, Ashok Nagr', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
	method: 'cod',
	couponCode: 'WELCOME10'
};

describe('keptRecord: what the kept order holds and what changed since', () => {
	it('nothing changed → no changes', () => {
		expect(keptRecord('WF-10001', WAS, WAS).changed).toEqual([]);
	});
	it('each kind of change is named once (case and spacing aside)', () => {
		const now = {
			...WAS,
			items: [...WAS.items, { slug: 'muesli', qty: 1 }],
			contact: { ...WAS.contact, phone: '+919845200000', email: ' ASHA@example.com ' },
			address: { ...WAS.address, line1: 'Flat 4B, 12 MG Road, Ashok Nagar' },
			method: 'upi',
			couponCode: null
		};
		expect(keptRecord('WF-10001', WAS, now).changed).toEqual(['address', 'phone', 'method', 'items', 'offer']);
		expect(keptRecord('WF-10001', WAS, { ...WAS, method: 'cod' }).changed).toEqual([]);
		expect(keptRecord('WF-10001', { ...WAS, method: 'upi' }, { ...WAS, method: 'card' }).changed).toEqual([]); // both online
	});
	it('carries the kept order’s own details (never the new ones)', () => {
		const r = keptRecord('WF-10001', WAS, { ...WAS, address: { ...WAS.address, line1: 'new' } });
		expect(r).toMatchObject({ no: 'WF-10001', name: 'Asha Kumar', phone: '+919845262777', line1: 'Flat 4B, 12 MG Raod, Ashok Nagr', city: 'Bengaluru', state: 'Karnataka', pin: '560001', method: 'cod' });
	});
});

describe('keptCopy: the /order notice', () => {
	it('says the later changes are not in it and where it ships (street address, city, state, PIN, name, phone)', () => {
		const c = keptCopy(keptRecord('WF-10001', WAS, { ...WAS, address: { ...WAS.address, line1: 'x' } }));
		expect(c.lead).toMatch(/already placed this order.*changes you made after it aren’t in it/);
		expect(c.shipsTo).toBe('Delivering to Flat 4B, 12 MG Raod, Ashok Nagr, Bengaluru, Karnataka 560001 (Asha Kumar, +91 98452 62777).');
		expect(c.extra.at(-1)).toMatch(/Message us/);
	});
	it('a method switch and a top-up are spelled out', () => {
		const c = keptCopy(keptRecord('WF-10001', WAS, { ...WAS, method: 'upi', items: [{ slug: 'choco-flakes', qty: 2 }] }));
		expect(c.extra).toContain('It’s a Pay on delivery order — nothing to pay online.');
		expect(c.extra).toContain('Anything you added since is still in your bag.');
	});
	it('helpers: phone and address formatting', () => {
		expect(showPhone('+919845262777')).toBe('+91 98452 62777');
		expect(showPhone('12345')).toBe('12345');
		expect(keptAddress({ line1: 'A', city: '', state: 'Kerala', pin: '682001' })).toBe('A, Kerala 682001');
	});
});

describe('wefeasto_kept storage (this tab only)', () => {
	it('round-trips for its own order number only; junk and blocked storage never throw', () => {
		const env = makeEnv();
		expect(writeKept(keptRecord('WF-10001', WAS, WAS), env)).toBe(true);
		expect(env.sessionStore.getItem(KEPT_KEY)).toContain('WF-10001');
		expect(env.localStore.getItem(KEPT_KEY)).toBeNull();
		expect(readKept('WF-10001', env)).toMatchObject({ no: 'WF-10001', line1: WAS.address.line1, changed: [] });
		expect(readKept('WF-10002', env)).toBeNull();
		env.sessionStore.setItem(KEPT_KEY, '{nope');
		expect(readKept('WF-10001', env)).toBeNull();
		expect(writeKept({ no: 'nope' }, env)).toBe(false);
		const b = blockedEnv(0);
		expect(writeKept(keptRecord('WF-10001', WAS, WAS), b)).toBe(false);
		expect(readKept('WF-10001', b)).toBeNull();
	});
});
