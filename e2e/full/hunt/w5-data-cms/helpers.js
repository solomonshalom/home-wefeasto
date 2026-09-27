/*
 * Helpers for the wave-5 data-cms hunt specs (e2e/full/hunt/w5-data-cms/*.spec.js).
 */
import crypto from 'node:crypto';
import { checkoutForm } from '../../support/unique.js';

/**
 * A verified customer (created by the admin, so no email round-trip) signed in through the storefront
 * proxy → { email, id, headers } where `headers` carry the session cookie + the storefront Origin.
 */
export async function signedInCustomer({ stack, adminSession, unique }, { password = 'breakfast-club-2026', tag = 'w5dc' } = {}) {
	const email = unique.email(tag);
	const created = await adminSession.ok('POST', 'customers?depth=0', { body: { email, password, _verified: true, name: 'Asha Kumar' } });
	const res = await fetch(`${stack.sfUrl}/api/customers/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: stack.sfUrl },
		body: JSON.stringify({ email, password })
	});
	if (res.status !== 200) throw new Error(`customer login → ${res.status} ${await res.text()}`);
	const m = /payload-token=([^;]+)/.exec(res.headers.get('set-cookie') || '');
	if (!m) throw new Error('customer login: no payload-token cookie');
	return { email, id: (created.doc ?? created).id, headers: { cookie: `payload-token=${m[1]}`, origin: stack.sfUrl } };
}

/**
 * Quote + checkout through the storefront proxy with extra headers (a signed-in customer's cookie).
 * → { status, json, form }. Never throws on a refusal.
 */
export async function checkoutAs(stack, headers, { items = { muesli: 1 }, method = 'cod', form = {}, consent = false, couponCode } = {}) {
	const f = checkoutForm({ ...form, method });
	const lines = Object.entries(items).map(([slug, qty]) => ({ slug, qty }));
	const phone = f.phone.startsWith('+') ? f.phone : `+91${f.phone}`;
	const post = async (path, body, extra = {}) => {
		const res = await fetch(`${stack.sfUrl}/api/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers, ...extra },
			body: JSON.stringify(body)
		});
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text };
	};
	const quote = await post('store/quote', { items: lines, couponCode, email: f.email, pin: f.pin, method });
	if (quote.status !== 200) throw new Error(`quote → ${quote.status} ${quote.text.slice(0, 300)}`);
	const body = {
		items: lines,
		contact: { name: f.name, email: f.email, phone },
		address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
		method,
		expectedTotalPaise: quote.json.quote.totalPaise,
		consent: { marketing: !!consent },
		...(couponCode ? { couponCode } : {})
	};
	const r = await post('store/checkout', body, { 'idempotency-key': crypto.randomUUID() });
	return { ...r, form: { ...f, phone } };
}
