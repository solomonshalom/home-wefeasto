/*
 * Form → POST /api/store/checkout body, client validation messages, and the
 * attempt identity the Idempotency-Key hangs on.
 */
import { describe, it, expect } from 'vitest';
import { checkForm, buildCheckoutBody, attemptOf, fieldMessages, FIELD_IDS, FIELD_ORDER, stableStringify, hash53, formInput, supersedeRef } from '$lib/checkout/request.js';
import { supersedeRef as quoteSupersedeRef } from '$lib/checkout/quote.js';

const GOOD = { name: 'Asha Kumar', phone: '98452 62777', email: ' Asha@Example.com ', address: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'karnataka', pin: '560 001' };

describe('checkForm', () => {
	it('a good form normalises like the server will', () => {
		const r = checkForm(GOOD);
		expect(r.ok).toBe(true);
		expect(r.first).toBeNull();
		expect(r.value).toEqual({ name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777', line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
	});

	it('empty form: every field required, first invalid in DOM order is the name', () => {
		const r = checkForm({});
		expect(r.ok).toBe(false);
		expect(Object.keys(r.errors)).toEqual(FIELD_ORDER);
		expect(r.first).toBe('name');
		expect(r.errors.phone).toBe('Enter your mobile number.');
	});

	it('first invalid follows the page order (phone before pin before state)', () => {
		expect(checkForm({ ...GOOD, phone: '12345', pin: '0123', state: '' }).first).toBe('phone');
		expect(checkForm({ ...GOOD, pin: '0123', state: '' }).first).toBe('pin');
		expect(checkForm({ ...GOOD, state: 'Atlantis' }).first).toBe('state');
	});

	it.each([
		['landline', { phone: '011 2345 6789' }, 'phone', 'Enter a valid 10-digit Indian mobile number.'],
		['email', { email: 'asha@' }, 'email', 'Enter a valid email, like name@example.com.'],
		['short address', { address: 'Flat' }, 'line1', 'Add a little more detail to your address.'],
		['pin', { pin: '56001' }, 'pin', 'Enter a valid 6-digit PIN code.'],
		['pin starting 0', { pin: '060001' }, 'pin', 'Enter a valid 6-digit PIN code.']
	])('%s', (_, patch, field, message) => {
		const r = checkForm({ ...GOOD, ...patch });
		expect(r.errors[field]).toBe(message);
	});

	it('every validate field maps to an input id', () => {
		for (const f of FIELD_ORDER) expect(FIELD_IDS[f]).toMatch(/^wf-co-/);
		expect(formInput({ address: 'x' }).line1).toBe('x');
	});
});

describe('fieldMessages (server VALIDATION details.fields)', () => {
	it('accepts {field: code} and {field: {code}}, ignores unknown fields, keeps page order', () => {
		expect(fieldMessages({ pin: 'UNSERVICEABLE', name: { code: 'TOO_SHORT' }, bogus: 'REQUIRED' })).toEqual({
			name: 'Enter your full name.',
			pin: 'Sorry, we don’t deliver to this PIN code yet.'
		});
		expect(Object.keys(fieldMessages({ state: 'REQUIRED', email: 'INVALID', name: 'REQUIRED' }))).toEqual(['name', 'email', 'state']);
		expect(fieldMessages(null)).toEqual({});
		expect(fieldMessages({ phone: 42 }).phone).toBe('Enter a valid 10-digit Indian mobile number.');
		expect(fieldMessages({ __proto__: 'x' })).toEqual({});
	});
});

describe('buildCheckoutBody', () => {
	const value = checkForm(GOOD).value;

	it('matches SPEC §6', () => {
		const body = buildCheckoutBody({ value, items: [{ slug: 'muesli', qty: 1, extra: 'x' }], method: 'upi', couponCode: 'WELCOME10', expectedTotalPaise: 47400, marketing: true, source: 'email' });
		expect(body).toEqual({
			items: [{ slug: 'muesli', qty: 1 }],
			contact: { name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777' },
			address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
			method: 'upi',
			expectedTotalPaise: 47400,
			consent: { marketing: true },
			source: 'email',
			couponCode: 'WELCOME10'
		});
	});

	it('no coupon → no couponCode key; consent is strictly boolean; source defaults to web', () => {
		const body = buildCheckoutBody({ value, items: [], method: 'cod', expectedTotalPaise: 100, marketing: 'yes', source: null });
		expect(body).not.toHaveProperty('couponCode');
		expect(body.consent).toEqual({ marketing: false });
		expect(body.source).toBe('web');
	});

	it('SUP-PHONE-1: carries the supersede ref the quote carried ({number, token}, trimmed)', () => {
		const body = buildCheckoutBody({ value, items: [{ slug: 'muesli', qty: 2 }], method: 'cod', expectedTotalPaise: 45000, supersede: { number: ' WF-10010 ', token: 'tok_abcdefgh', extra: 1 } });
		expect(body.supersede).toEqual({ number: 'WF-10010', token: 'tok_abcdefgh' });
		// the rest of the body is exactly what it was without it
		const plain = buildCheckoutBody({ value, items: [{ slug: 'muesli', qty: 2 }], method: 'cod', expectedTotalPaise: 45000 });
		const { supersede, ...rest } = body;
		expect(supersede).toBeTruthy();
		expect(rest).toEqual(plain);
	});

	it.each([
		['none', undefined],
		['null', null],
		['no token', { number: 'WF-10010' }],
		['empty token', { number: 'WF-10010', token: '' }],
		['blank number', { number: '  ', token: 'tok_abcdefgh' }],
		['not an object', 'WF-10010'],
		['numbers', { number: 10010, token: 12345678 }]
	])('no usable supersede ref (%s) → no supersede key', (_, supersede) => {
		const body = buildCheckoutBody({ value, items: [{ slug: 'muesli', qty: 1 }], method: 'cod', expectedTotalPaise: 100, supersede });
		expect(body).not.toHaveProperty('supersede');
	});

	it('supersedeRef is one function for the quote and the checkout body', () => {
		expect(quoteSupersedeRef).toBe(supersedeRef);
	});
});

describe('attempt identity (what the Idempotency-Key is tied to)', () => {
	const value = checkForm(GOOD).value;
	const base = { value, items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 2 }], method: 'upi', expectedTotalPaise: 47400 };

	it('same body → same attempt; bag order does not matter', () => {
		const a = attemptOf(buildCheckoutBody(base));
		const b = attemptOf(buildCheckoutBody({ ...base, items: [...base.items].reverse() }));
		expect(a).toEqual(b);
		expect(a.cartSig).toBe('cornflakes:2,muesli:1');
	});

	it.each([
		['quantity', { items: [{ slug: 'muesli', qty: 2 }, { slug: 'cornflakes', qty: 2 }] }, 'cartSig'],
		['method', { method: 'cod' }, 'formHash'],
		['total', { expectedTotalPaise: 47500 }, 'formHash'],
		['coupon', { couponCode: 'X10' }, 'formHash'],
		['consent', { marketing: true }, 'formHash'],
		['address', { value: { ...value, line1: 'Flat 5B, 12 MG Road' } }, 'formHash']
	])('changing the %s changes the %s', (_, patch, part) => {
		const a = attemptOf(buildCheckoutBody(base));
		const b = attemptOf(buildCheckoutBody({ ...base, ...patch }));
		expect(b[part]).not.toBe(a[part]);
	});

	it('the supersede ref is not part of the attempt: the same tap with or without it keeps its Idempotency-Key', () => {
		const a = attemptOf(buildCheckoutBody(base));
		const b = attemptOf(buildCheckoutBody({ ...base, supersede: { number: 'WF-10010', token: 'tok_abcdefgh' } }));
		const c = attemptOf(buildCheckoutBody({ ...base, supersede: { number: 'WF-10011', token: 'tok_zyxwvuts' } }));
		expect(b).toEqual(a);
		expect(c).toEqual(a);
	});
});

describe('stableStringify / hash53', () => {
	it('key order never matters, undefined keys are skipped', () => {
		expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
		expect(stableStringify(null)).toBe('null');
	});

	it('hash53 is deterministic and spreads', () => {
		expect(hash53('abc')).toBe(hash53('abc'));
		expect(hash53('abc')).not.toBe(hash53('abd'));
		expect(hash53('abc')).toMatch(/^[0-9a-f]{14}$/);
		const seen = new Set();
		for (let i = 0; i < 2000; i++) seen.add(hash53('attempt-' + i));
		expect(seen.size).toBe(2000);
	});
});
