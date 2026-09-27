/*
 * Shared helpers for the payments-security hunt specs (e2e/full/hunt/payments-security/*.spec.js).
 * Everything goes through the storefront's same-origin /api proxy (the way a browser — or an attacker
 * with curl — reaches the CMS), except the mock gateway's /pay, which the fixture calls on the CMS.
 */
import crypto from 'node:crypto';
import { checkoutForm } from '../../support/unique.js';

/** POST /api/store/quote then /api/store/checkout; never throws → { status, json, form, quote }. */
export async function tryCheckout(api, { items = { muesli: 1 }, method = 'upi', form = {}, couponCode } = {}) {
	const f = checkoutForm({ ...form, method });
	const lines = Object.entries(items).map(([slug, qty]) => ({ slug, qty }));
	const phone = f.phone.startsWith('+') ? f.phone : `+91${f.phone}`;
	const quote = await api.quote({ items: lines, couponCode, email: f.email, pin: f.pin, method });
	if (quote.status !== 200) throw new Error(`quote → ${quote.status} ${quote.text.slice(0, 300)}`);
	const body = {
		items: lines,
		contact: { name: f.name, email: f.email, phone },
		address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
		method,
		expectedTotalPaise: quote.json.quote.totalPaise,
		consent: { marketing: false },
		...(couponCode ? { couponCode } : {})
	};
	const r = await api.checkout(body, { idempotencyKey: crypto.randomUUID() });
	return { status: r.status, json: r.json, text: r.text, form: { ...f, phone }, quote: quote.json.quote };
}

/**
 * Pay a Razorpay order with the mock gateway (no webhooks) and confirm it through the client verify
 * endpoint, exactly like Checkout's handler → { status, order }.
 */
export async function payAndVerify(api, mock, { number, token, razorpayOrderId }) {
	const paid = await mock.pay(razorpayOrderId, 'success', { webhook: false });
	if (paid.status !== 200 || !paid.json?.ok) throw new Error(`mock.pay → ${paid.status} ${JSON.stringify(paid.json)}`);
	const v = await api.post('store/checkout/verify', { number, token, ...paid.json.response });
	return { status: v.status, order: v.json?.order ?? null };
}

/**
 * A verified customer (created by the admin, so no email round-trip) signed in through the storefront
 * proxy → { email, id, headers } where `headers` carry the session cookie + the storefront Origin.
 */
export async function signedInCustomer({ stack, adminSession, unique }, { password = 'breakfast-club-2026' } = {}) {
	const email = unique.email('hps');
	const created = await adminSession.ok('POST', 'customers?depth=0', { body: { email, password, _verified: true } });
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
