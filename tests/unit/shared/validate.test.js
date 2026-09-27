import { describe, it, expect } from 'vitest';
import {
	normalizeINMobile,
	isValidPin,
	isPinBlocked,
	normalizePin,
	normalizeEmail,
	validateCheckoutForm,
	INDIAN_STATES,
	INDIAN_UNION_TERRITORIES,
	canonicalState,
	cleanText,
	isSlug,
	maskEmail,
	maskPhone,
	firstName,
	FIELD_LIMITS
} from '$shared/validate.js';
import { ch } from './_fixtures.js';

describe('normalizeINMobile', () => {
	it.each([
		'+91 98452 62777',
		'+919845262777',
		'+91-98452-62777',
		'(+91) 98452-62777',
		'+91 0 98452 62777',
		'09845262777',
		'0 98452 62777',
		'919845262777',
		'91 98452 62777',
		'0091 9845262777',
		'00919845262777',
		'091 9845262777',
		'9845262777',
		'98452 62777',
		'98452-62777',
		'98452.62777',
		' 9845262777 ',
		'9845262777' + ch(0xa0) // trailing NBSP from copy-paste
	])('%j → +919845262777', (raw) => {
		expect(normalizeINMobile(raw)).toBe('+919845262777');
	});

	it.each([
		['6000000000', '+916000000000'],
		['7012345678', '+917012345678'],
		['8123456789', '+918123456789'],
		['9198452627', '+919198452627'] // a 10-digit mobile that happens to start with 91
	])('%j → %s', (raw, out) => {
		expect(normalizeINMobile(raw)).toBe(out);
	});

	it.each([
		['5845262777', '5xxxxxxxxx is not a mobile series'],
		['1845262777', 'starts with 1'],
		['0845262777', 'starts with 0 after stripping nothing'],
		['011 2345 6789', 'Delhi landline'],
		['022 2345 6789', 'Mumbai landline'],
		['044-12345678', 'Chennai landline'],
		['+91 11 2345 6789', 'landline with country code'],
		['984526277', '9 digits'],
		['98452627770', '11 digits not starting with 0'],
		['098452627770', '12 digits starting with 0'],
		['9198452627777', '13 digits starting with 91'],
		['+1 415 555 2671', 'US number'],
		['+44 20 7946 0958', 'UK number'],
		['+9198452627', 'too short after +91'],
		['++919845262777', 'double plus'],
		['+91', 'code only'],
		['abcdefghij', 'letters'],
		['98452 6277a', 'letter inside'],
		['९८४५२६२७७७', 'Devanagari digits'],
		['９８４５２６２７７７', 'full-width digits'],
		['', 'empty'],
		['   ', 'blank'],
		['9'.repeat(40), 'absurdly long']
	])('rejects %j (%s)', (raw) => {
		expect(normalizeINMobile(raw)).toBeNull();
	});

	it.each([[9845262777], [null], [undefined], [{}], [[]], [true]])('rejects non-string %j', (raw) => {
		expect(normalizeINMobile(raw)).toBeNull();
	});
});

describe('PIN', () => {
	it.each(['560001', '110001', '400001', '999999', '100000'])('valid %s', (pin) => {
		expect(isValidPin(pin)).toBe(true);
		expect(isValidPin(pin, [])).toBe(true);
	});

	it.each([['060001'], ['56001'], ['5600011'], ['56 001'], [' 560001'], ['560001 '], ['56000a'], ['５６０００１'], [''], [560001], [null], [undefined]])(
		'invalid %j',
		(pin) => {
			expect(isValidPin(pin)).toBe(false);
		}
	);

	it('blocked prefixes', () => {
		expect(isValidPin('560001', ['56'])).toBe(false);
		expect(isValidPin('560001', ['5600'])).toBe(false);
		expect(isValidPin('560001', ['560001'])).toBe(false);
		expect(isValidPin('560001', ['561'])).toBe(true);
		expect(isValidPin('560001', [560])).toBe(false); // numeric prefix accepted
		expect(isValidPin('791001', ['79', '19'])).toBe(false);
	});

	it('ignores empty and junk prefixes (an empty prefix must never block everything)', () => {
		expect(isPinBlocked('560001', [''])).toBe(false);
		expect(isPinBlocked('560001', ['  ', 'ab', null, undefined, {}, -5, 1.5, '5600011'])).toBe(false);
		expect(isPinBlocked('560001', 'not-an-array')).toBe(false);
		expect(isPinBlocked(560001, ['56'])).toBe(false);
	});

	it('normalizePin strips whitespace, stringifies integers', () => {
		expect(normalizePin('560 001')).toBe('560001');
		expect(normalizePin(' 560001 ')).toBe('560001');
		expect(normalizePin(560001)).toBe('560001');
		expect(normalizePin(null)).toBe('');
		expect(normalizePin(5.5)).toBe('');
	});
});

describe('normalizeEmail', () => {
	it.each([
		['asha@example.com', 'asha@example.com'],
		['  Asha.K@Example.COM ', 'asha.k@example.com'],
		['a+tag@gmail.com', 'a+tag@gmail.com'],
		['first.last@sub.domain.co.in', 'first.last@sub.domain.co.in'],
		["o'brien@example.ie", "o'brien@example.ie"],
		['x@xn--80ak6aa92e.com', 'x@xn--80ak6aa92e.com'],
		['user@example.xn--p1ai', 'user@example.xn--p1ai'],
		['a@b.co', 'a@b.co'],
		['1234@123.in', '1234@123.in']
	])('%j → %j', (raw, out) => {
		expect(normalizeEmail(raw)).toBe(out);
	});

	it.each([
		['', 'empty'],
		['plainaddress', 'no @'],
		['@example.com', 'no local part'],
		['asha@', 'no domain'],
		['asha@@example.com', 'two @'],
		['a@b@example.com', 'two @ separated'],
		['asha@localhost', 'undotted domain'],
		['asha@example', 'no TLD'],
		['asha@example.c', '1-letter TLD'],
		['asha@example.123', 'numeric TLD'],
		['as ha@example.com', 'space in local'],
		['asha@exa mple.com', 'space in domain'],
		['.asha@example.com', 'leading dot'],
		['asha.@example.com', 'trailing dot'],
		['as..ha@example.com', 'double dot'],
		['asha@-example.com', 'label starts with hyphen'],
		['asha@example-.com', 'label ends with hyphen'],
		['asha@example..com', 'empty label'],
		['asha@.example.com', 'leading dot in domain'],
		['"asha"@example.com', 'quoted local part'],
		['asha@exämple.com', 'non-ASCII domain'],
		['ásha@example.com', 'non-ASCII local'],
		['asha@exa\nmple.com', 'newline inside'],
		['a'.repeat(65) + '@example.com', 'local part > 64'],
		['a@' + 'b'.repeat(250) + '.com', '> 254 chars'],
		['a@' + 'b'.repeat(64) + '.com', 'label > 63']
	])('rejects %j (%s)', (raw) => {
		expect(normalizeEmail(raw)).toBeNull();
	});

	it('a 254-char address is accepted, 255 is not', () => {
		const local = 'a'.repeat(64);
		const domainFor = (len) => {
			// labels of 63 chars joined by dots, ending in .com
			let d = 'com';
			while (d.length < len) d = 'b'.repeat(Math.min(63, len - d.length - 1)) + '.' + d;
			return d;
		};
		const ok = local + '@' + domainFor(254 - 65);
		expect(ok.length).toBe(254);
		expect(normalizeEmail(ok)).toBe(ok);
		const tooLong = local + '@' + domainFor(255 - 65);
		expect(tooLong.length).toBe(255);
		expect(normalizeEmail(tooLong)).toBeNull();
	});

	it.each([[null], [undefined], [42], [{}], [['a@b.co']]])('non-string %j → null', (v) => {
		expect(normalizeEmail(v)).toBeNull();
	});
});

describe('INDIAN_STATES', () => {
	it('has 28 states + 8 union territories, unique, alphabetical', () => {
		expect(INDIAN_STATES).toHaveLength(36);
		expect(new Set(INDIAN_STATES).size).toBe(36);
		expect(INDIAN_UNION_TERRITORIES).toHaveLength(8);
		for (const ut of INDIAN_UNION_TERRITORIES) expect(INDIAN_STATES).toContain(ut);
		expect(INDIAN_STATES.filter((s) => !INDIAN_UNION_TERRITORIES.includes(s))).toHaveLength(28);
		expect([...INDIAN_STATES].sort((a, b) => a.localeCompare(b, 'en'))).toEqual([...INDIAN_STATES]);
	});

	it('uses current official names', () => {
		for (const name of ['Odisha', 'Puducherry', 'Uttarakhand', 'Telangana', 'Ladakh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Karnataka', 'Tamil Nadu', 'West Bengal']) {
			expect(INDIAN_STATES).toContain(name);
		}
		for (const old of ['Orissa', 'Pondicherry', 'Uttaranchal', 'Daman and Diu', 'Dadra and Nagar Haveli']) {
			expect(INDIAN_STATES).not.toContain(old);
		}
	});

	it('is frozen', () => {
		expect(Object.isFrozen(INDIAN_STATES)).toBe(true);
	});

	it.each([
		['Karnataka', 'Karnataka'],
		['karnataka', 'Karnataka'],
		['  TAMIL   NADU ', 'Tamil Nadu'],
		['Tamilnadu', 'Tamil Nadu'],
		['Jammu & Kashmir', 'Jammu and Kashmir'],
		['J&K', 'Jammu and Kashmir'],
		['Andaman & Nicobar Islands', 'Andaman and Nicobar Islands'],
		['Orissa', 'Odisha'],
		['Pondicherry', 'Puducherry'],
		['Uttaranchal', 'Uttarakhand'],
		['New Delhi', 'Delhi'],
		['NCT of Delhi', 'Delhi'],
		['Daman and Diu', 'Dadra and Nagar Haveli and Daman and Diu'],
		['Chattisgarh', 'Chhattisgarh']
	])('canonicalState(%j) → %s', (raw, out) => {
		expect(canonicalState(raw)).toBe(out);
	});

	it.each([['Bengaluru'], ['California'], [''], ['Kerala!'], [null], [42]])('canonicalState(%j) → null', (raw) => {
		expect(canonicalState(raw)).toBeNull();
	});

	it('every listed name is its own canonical form', () => {
		for (const s of INDIAN_STATES) expect(canonicalState(s)).toBe(s);
	});
});

describe('cleanText', () => {
	it('strips control, bidi and zero-width characters; keeps ZWJ/ZWNJ and unicode', () => {
		expect(cleanText('Asha' + ch(0x202e) + 'Kumar')).toBe('AshaKumar');
		expect(cleanText('a' + ch(0x200b) + 'b' + ch(0xfeff))).toBe('ab');
		expect(cleanText('line1\nline2\r\n\tline3')).toBe('line1 line2 line3');
		expect(cleanText('x' + ch(0) + 'y' + ch(0x7f) + 'z' + ch(0x85) + 'w')).toBe('x y z w');
		expect(cleanText('a' + ch(0x2028) + 'b')).toBe('a b');
		const namaste = 'न' + ch(0x92e) + ch(0x94d) + ch(0x200d) + 'ते';
		expect(cleanText(namaste)).toBe(namaste.normalize('NFC'));
		expect(cleanText('Chennai 🏖️')).toBe('Chennai 🏖️');
	});

	it('NFC-normalises and collapses whitespace', () => {
		expect(cleanText('Cafe' + ch(0x301))).toBe('Café');
		expect(cleanText('  a   b  ')).toBe('a b');
	});

	it('drops lone surrogates', () => {
		expect(cleanText('a' + String.fromCharCode(0xd800) + 'b')).toBe('ab');
		expect(cleanText('a' + String.fromCharCode(0xdc00) + 'b')).toBe('ab');
		expect(cleanText('😀')).toBe('😀');
	});

	it('non-strings → empty', () => {
		expect(cleanText(null)).toBe('');
		expect(cleanText(42)).toBe('');
	});
});

describe('isSlug', () => {
	it.each(['cornflakes', 'steel-cut-oats', 'a', 'a1-b2', 'x'.repeat(64)])('%s ok', (s) => expect(isSlug(s)).toBe(true));
	it.each(['', 'Cornflakes', '__proto__', 'with space', '-a', 'a-', 'a--b', 'a_b', 'a b', 'x'.repeat(65), 'é', null, 5])(
		'%j rejected',
		(s) => expect(isSlug(s)).toBe(false)
	);
});

const VALID = {
	name: 'Asha Kumar',
	email: 'Asha@Example.com',
	phone: '98452 62777',
	line1: 'Flat 4B, 12 MG Road',
	city: 'Bengaluru',
	state: 'Karnataka',
	pin: '560 001'
};

describe('validateCheckoutForm', () => {
	it('accepts and normalises a valid form', () => {
		const r = validateCheckoutForm(VALID);
		expect(r).toEqual({
			ok: true,
			errors: {},
			value: {
				name: 'Asha Kumar',
				email: 'asha@example.com',
				phone: '+919845262777',
				line1: 'Flat 4B, 12 MG Road',
				city: 'Bengaluru',
				state: 'Karnataka',
				pin: '560001'
			}
		});
	});

	it('accepts unicode names and addresses', () => {
		const r = validateCheckoutForm({ ...VALID, name: 'श्रेया शर्मा', line1: 'फ्लैट 4, एमजी रोड', city: 'बेंगलुरु', state: 'karnataka' });
		expect(r.ok).toBe(true);
		expect(r.value.state).toBe('Karnataka');
		expect(validateCheckoutForm({ ...VALID, name: 'Zoë O’Brien-Nair' }).ok).toBe(true);
		expect(validateCheckoutForm({ ...VALID, name: 'அனு' }).ok).toBe(true);
	});

	it('everything missing → REQUIRED everywhere', () => {
		const r = validateCheckoutForm({});
		expect(r.ok).toBe(false);
		expect(r.errors).toEqual({ name: 'REQUIRED', email: 'REQUIRED', phone: 'REQUIRED', line1: 'REQUIRED', city: 'REQUIRED', state: 'REQUIRED', pin: 'REQUIRED' });
	});

	it('non-object input is treated as empty', () => {
		for (const v of [null, undefined, 'x', 42]) {
			expect(validateCheckoutForm(v).errors.name).toBe('REQUIRED');
		}
	});

	it('whitespace/control-only values are REQUIRED', () => {
		const r = validateCheckoutForm({ ...VALID, name: '   ', city: '\n\t', line1: ch(0x200b) + ch(0x202e) });
		expect(r.errors).toEqual({ name: 'REQUIRED', city: 'REQUIRED', line1: 'REQUIRED' });
	});

	it.each([
		['name', 'A', 'TOO_SHORT'],
		['name', 'A'.repeat(81), 'TOO_LONG'],
		['name', '12345', 'INVALID'],
		['name', '!!!', 'INVALID'],
		['email', 'not-an-email', 'INVALID'],
		['email', 'a'.repeat(250) + '@x.com', 'TOO_LONG'],
		['phone', '12345', 'INVALID'],
		['phone', '011 2345 6789', 'INVALID'],
		['line1', 'abc', 'TOO_SHORT'],
		['line1', 'x'.repeat(201), 'TOO_LONG'],
		['city', 'B', 'TOO_SHORT'],
		['city', 'B'.repeat(61), 'TOO_LONG'],
		['city', '560001', 'INVALID'],
		['state', 'California', 'INVALID'],
		['pin', '06000', 'INVALID'],
		['pin', '060001', 'INVALID'],
		['pin', 'abcdef', 'INVALID'],
		['name', { first: 'A' }, 'INVALID'],
		['email', ['a@b.co'], 'INVALID'],
		['pin', true, 'INVALID'],
		['pin', 5600.1, 'INVALID']
	])('%s = %j → %s', (field, v, code) => {
		const r = validateCheckoutForm({ ...VALID, [field]: v });
		expect(r.ok).toBe(false);
		expect(r.errors).toEqual({ [field]: code });
	});

	it('counts code points, not UTF-16 units, for length limits', () => {
		const emojiName = 'A' + '😀'.repeat(79); // 80 code points, 159 UTF-16 units
		expect(validateCheckoutForm({ ...VALID, name: emojiName }).errors.name).toBeUndefined();
		expect(validateCheckoutForm({ ...VALID, name: emojiName + '😀' }).errors.name).toBe('TOO_LONG');
		expect(FIELD_LIMITS.name.max).toBe(80);
	});

	it('limits are inclusive', () => {
		expect(validateCheckoutForm({ ...VALID, name: 'Al' }).ok).toBe(true);
		expect(validateCheckoutForm({ ...VALID, line1: '12 MG' }).ok).toBe(true);
		expect(validateCheckoutForm({ ...VALID, line1: 'x'.repeat(200) }).ok).toBe(true);
		expect(validateCheckoutForm({ ...VALID, city: 'x'.repeat(60) }).ok).toBe(true);
	});

	it('numbers are accepted for phone and pin', () => {
		const r = validateCheckoutForm({ ...VALID, phone: 9845262777, pin: 560001 });
		expect(r.ok).toBe(true);
		expect(r.value.phone).toBe('+919845262777');
		expect(r.value.pin).toBe('560001');
	});

	it('strips control and bidi characters from stored values', () => {
		const r = validateCheckoutForm({ ...VALID, name: 'Asha' + ch(0x202e) + ' Kumar', line1: 'Flat 4B\n12 MG Road' + ch(0) });
		expect(r.ok).toBe(true);
		expect(r.value.name).toBe('Asha Kumar');
		expect(r.value.line1).toBe('Flat 4B 12 MG Road');
	});

	it('blocked PIN prefixes → UNSERVICEABLE (server option)', () => {
		const r = validateCheckoutForm(VALID, { blockedPinPrefixes: ['5600'] });
		expect(r.errors).toEqual({ pin: 'UNSERVICEABLE' });
		expect(validateCheckoutForm(VALID, { blockedPinPrefixes: [''] }).ok).toBe(true);
	});

	it('value keeps cleaned input for re-display even when invalid', () => {
		const r = validateCheckoutForm({ ...VALID, email: '  Not An Email ', phone: ' 12 34 ' });
		expect(r.value.email).toBe('not an email');
		expect(r.value.phone).toBe('12 34');
	});

	it('ignores unknown fields', () => {
		const r = validateCheckoutForm({ ...VALID, isAdmin: true, __proto__: { polluted: 1 } });
		expect(r.ok).toBe(true);
		expect(Object.keys(r.value).sort()).toEqual(['city', 'email', 'line1', 'name', 'phone', 'pin', 'state']);
	});
});

describe('masking helpers', () => {
	it('maskEmail', () => {
		expect(maskEmail('Asha.K@Gmail.com')).toBe('a•••@gmail.com');
		expect(maskEmail('x@y.in')).toBe('x•••@y.in');
		expect(maskEmail('nope')).toBe('');
		expect(maskEmail(null)).toBe('');
	});
	it('maskPhone', () => {
		expect(maskPhone('+919845262777')).toBe('+91 ••••• ••777');
		expect(maskPhone('98452 62777')).toBe('+91 ••••• ••777');
		expect(maskPhone('123')).toBe('');
		expect(maskPhone(9845262777)).toBe('');
	});
	it('firstName', () => {
		expect(firstName('  Asha   Kumar ')).toBe('Asha');
		expect(firstName('श्रेया शर्मा')).toBe('श्रेया');
		expect(firstName('')).toBe('');
		expect(firstName(null)).toBe('');
	});
});
