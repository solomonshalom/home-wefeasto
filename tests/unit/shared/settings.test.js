import { describe, it, expect } from 'vitest';
import {
	resolveSettings,
	publicSettings,
	PUBLIC_SETTINGS_DEFAULTS,
	SERVER_SETTINGS_DEFAULTS,
	PUBLIC_SETTINGS_KEYS,
	SERVER_SETTINGS_KEYS
} from '$shared/settings.js';

const CANONICAL_PUBLIC = {
	freeDeliveryThresholdPaise: 49900,
	deliveryFeePaise: 4900,
	codEnabled: true,
	codMaxPaise: 200000,
	codFeePaise: 0,
	codMinSubtotalPaise: 0,
	maxOrderPaise: 5000000,
	topUpDiscoveryBiasPaise: 5000,
	shippingPromiseText: 'Ships in 1–2 days · delivered in 3–7 days',
	announcement: { enabled: false, text: '', href: '' },
	supportWhatsappE164: '+919845262777',
	legal: { entityName: '', address: '', fssaiLicence: '', gstin: '', grievanceOfficer: { name: '', designation: '', email: '', phone: '' } },
	welcomeOffer: { percent: 10, maxDiscountPaise: 7500, validDays: 30 }
};
const CANONICAL_SERVER = { reservationMinutes: 30, blockedPinPrefixes: [], codBlockedPinPrefixes: [], codMaxOpenPerPhone: 2 };

describe('settings defaults', () => {
	it('public defaults are exactly the canonical keys and values', () => {
		expect(PUBLIC_SETTINGS_DEFAULTS).toEqual(CANONICAL_PUBLIC);
		expect([...PUBLIC_SETTINGS_KEYS].sort()).toEqual(Object.keys(CANONICAL_PUBLIC).sort());
	});

	it('server defaults are exactly the canonical keys and values', () => {
		expect(SERVER_SETTINGS_DEFAULTS).toEqual(CANONICAL_SERVER);
		expect([...SERVER_SETTINGS_KEYS].sort()).toEqual(Object.keys(CANONICAL_SERVER).sort());
	});

	it('public and server keys are disjoint', () => {
		for (const k of SERVER_SETTINGS_KEYS) expect(PUBLIC_SETTINGS_KEYS).not.toContain(k);
	});

	it('defaults are deeply frozen', () => {
		expect(Object.isFrozen(PUBLIC_SETTINGS_DEFAULTS)).toBe(true);
		expect(Object.isFrozen(PUBLIC_SETTINGS_DEFAULTS.legal.grievanceOfficer)).toBe(true);
		expect(Object.isFrozen(SERVER_SETTINGS_DEFAULTS.blockedPinPrefixes)).toBe(true);
	});
});

describe('resolveSettings', () => {
	it('empty / junk input → all defaults', () => {
		for (const raw of [undefined, null, {}, 'x', 42, []]) {
			expect(resolveSettings(raw)).toEqual({ ...CANONICAL_PUBLIC, ...CANONICAL_SERVER });
		}
	});

	it('keeps valid overrides', () => {
		const s = resolveSettings({
			freeDeliveryThresholdPaise: 59900,
			deliveryFeePaise: 0,
			codEnabled: false,
			codFeePaise: 2500,
			topUpDiscoveryBiasPaise: 0,
			announcement: { enabled: true, text: 'Diwali', href: '/shop' },
			legal: { fssaiLicence: '12345678901234', grievanceOfficer: { name: 'R. Rao' } },
			welcomeOffer: { percent: 15 },
			reservationMinutes: 45,
			blockedPinPrefixes: ['79', 190],
			codBlockedPinPrefixes: [{ prefix: '744', id: 'row1' }],
			codMaxOpenPerPhone: 0
		});
		expect(s.freeDeliveryThresholdPaise).toBe(59900);
		expect(s.deliveryFeePaise).toBe(0);
		expect(s.codEnabled).toBe(false);
		expect(s.codFeePaise).toBe(2500);
		expect(s.topUpDiscoveryBiasPaise).toBe(0);
		expect(s.announcement).toEqual({ enabled: true, text: 'Diwali', href: '/shop' });
		expect(s.legal.fssaiLicence).toBe('12345678901234');
		expect(s.legal.grievanceOfficer).toEqual({ name: 'R. Rao', designation: '', email: '', phone: '' });
		expect(s.welcomeOffer).toEqual({ percent: 15, maxDiscountPaise: 7500, validDays: 30 });
		expect(s.reservationMinutes).toBe(45);
		expect(s.blockedPinPrefixes).toEqual(['79', '190']);
		expect(s.codBlockedPinPrefixes).toEqual(['744']);
		expect(s.codMaxOpenPerPhone).toBe(0);
	});

	it('falls back to defaults for malformed money and flags', () => {
		const s = resolveSettings({
			freeDeliveryThresholdPaise: 499.5,
			deliveryFeePaise: -4900,
			codEnabled: 'yes',
			codMaxPaise: '200000',
			maxOrderPaise: Infinity,
			topUpDiscoveryBiasPaise: NaN,
			shippingPromiseText: 42,
			welcomeOffer: { percent: 150, validDays: 0, maxDiscountPaise: 1.5 },
			reservationMinutes: 0,
			blockedPinPrefixes: ['', 'ab', '1234567', null, 56],
			codMaxOpenPerPhone: -1
		});
		expect(s.freeDeliveryThresholdPaise).toBe(49900);
		expect(s.deliveryFeePaise).toBe(4900);
		expect(s.codEnabled).toBe(true);
		expect(s.codMaxPaise).toBe(200000);
		expect(s.maxOrderPaise).toBe(5000000);
		expect(s.topUpDiscoveryBiasPaise).toBe(5000);
		expect(s.shippingPromiseText).toBe(CANONICAL_PUBLIC.shippingPromiseText);
		expect(s.welcomeOffer).toEqual({ percent: 10, maxDiscountPaise: 7500, validDays: 30 });
		expect(s.reservationMinutes).toBe(30);
		expect(s.blockedPinPrefixes).toEqual(['56']); // '' would block every PIN — dropped
		expect(s.codMaxOpenPerPhone).toBe(2);
	});

	it('drops unknown keys and never aliases the input', () => {
		const raw = { blockedPinPrefixes: ['11'], secretThing: 1 };
		const s = resolveSettings(raw);
		expect('secretThing' in s).toBe(false);
		s.blockedPinPrefixes.push('22');
		expect(raw.blockedPinPrefixes).toEqual(['11']);
	});

	it('is idempotent', () => {
		const once = resolveSettings({ deliveryFeePaise: 3900, blockedPinPrefixes: ['79'] });
		expect(resolveSettings(once)).toEqual(once);
	});
});

describe('publicSettings', () => {
	it('never leaks server-only keys', () => {
		const p = publicSettings({ reservationMinutes: 10, blockedPinPrefixes: ['79'], codBlockedPinPrefixes: ['1'], codMaxOpenPerPhone: 5, deliveryFeePaise: 3900 });
		expect(Object.keys(p).sort()).toEqual([...PUBLIC_SETTINGS_KEYS].sort());
		for (const k of SERVER_SETTINGS_KEYS) expect(k in p).toBe(false);
		expect(p.deliveryFeePaise).toBe(3900);
	});

	it('defaults equal the canonical public settings (what snapshot.settings must contain)', () => {
		expect(publicSettings()).toEqual(CANONICAL_PUBLIC);
		expect(JSON.parse(JSON.stringify(publicSettings()))).toEqual(CANONICAL_PUBLIC);
	});
});
