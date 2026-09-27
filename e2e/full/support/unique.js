/*
 * Unique test data. Emails are registered with the running test so the mailpit fixture
 * can delete their messages afterwards (Mailpit is shared by every slot and suite).
 */
import crypto from 'node:crypto';
import { test } from '@playwright/test';
import { SLOT } from './env.js';

const RUN = Date.now().toString(36).slice(-5);
const WORKER = process.env.TEST_WORKER_INDEX ?? 'x';
let seq = 0;

/** testInfo → Set of addresses created during that test. */
const EMAILS = new WeakMap();

function currentTestInfo() {
	try {
		return test.info();
	} catch {
		return null;
	}
}

/** Remember an address for the current test's mail cleanup (no-op outside a test). */
export function trackEmail(email) {
	const info = currentTestInfo();
	if (!info) return email;
	let set = EMAILS.get(info);
	if (!set) EMAILS.set(info, (set = new Set()));
	set.add(String(email).toLowerCase());
	return email;
}

/** Addresses tracked for a testInfo. */
export const trackedEmails = (info) => [...(EMAILS.get(info) || [])];

/** A fresh address, unique per slot/worker/run: `<tag>-<run><worker><n>-s<slot>@e2e.wefeasto.test`. */
export function uniqueEmail(tag = 'e2e') {
	seq += 1;
	const t = String(tag).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'e2e';
	return trackEmail(`${t}-${RUN}${WORKER}${seq}-s${SLOT}@e2e.wefeasto.test`);
}

const usedPhones = new Set();
/**
 * A fresh Indian mobile (10 digits, starts with 9, passes $shared normalizeINMobile).
 * Unique per call: supersede, the open-COD cap and first-order checks key on the phone.
 * `{ e164: true }` → '+91…' (what the checkout API stores).
 */
export function phone({ e164 = false } = {}) {
	let p;
	do p = '9' + String(SLOT) + String(crypto.randomInt(0, 1e8)).padStart(8, '0');
	while (usedPhones.has(p));
	usedPhones.add(p);
	return e164 ? `+91${p}` : p;
}

/** A serviceable PIN whose city/state match DEFAULT_ADDRESS (Bengaluru, Karnataka). */
export const pin = () => '560001';

export const DEFAULT_ADDRESS = Object.freeze({
	name: 'Asha Kumar',
	address: 'Flat 4B, 12 MG Road, Ashok Nagar',
	pin: '560001',
	city: 'Bengaluru',
	state: 'Karnataka'
});

/**
 * Checkout form values: DEFAULT_ADDRESS + a unique email and phone, then `overrides`.
 * Keys: name, phone, email, address, pin, city, state, method ('upi'|'card'|'cod'),
 * consent (bool, optional), save (bool, optional).
 */
export function checkoutForm(overrides = {}) {
	return { ...DEFAULT_ADDRESS, email: uniqueEmail('co'), phone: phone(), method: 'upi', ...overrides };
}

/** A unique uppercase code for coupons: `E2E<slot><random>`. */
export function uniqueCode(prefix = 'E2E') {
	return `${prefix}${SLOT}${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 32);
}
