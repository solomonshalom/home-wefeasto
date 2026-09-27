/*
 * HUNT data-cms (round 2): Store settings → Server only → "Most open (unconfirmed) COD orders allowed per
 * phone number" = 0.
 *
 * The CMS accepts 0 (integerIn(0, 1000)). The quote still offers cash on delivery (codAvailable: true, the
 * pill is enabled), and placing the order is refused with COD_UNAVAILABLE reason TOO_MANY_OPEN
 * (checkout.ts: openCodCount(phone) >= 0 is always true), which the storefront shows as "You already have
 * cash-on-delivery orders on the way — please pay online for this one." to a first-time customer who has
 * no order at all.
 *
 * Correct behaviour: 0 is refused on save, or treated as "no cap", or COD is reported unavailable up front
 * with a truthful reason — never TOO_MANY_OPEN for a phone with no open COD order.
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';

test('cap of 0 open COD orders: a first-time customer is not told they already have COD orders', async ({ admin, api, unique }) => {
	try {
		await admin.updateSettings({ codMaxOpenPerPhone: 0 }); // restored after the test
	} catch (e) {
		if (/→ 400/.test(String(e?.message))) return; // refused on save: fine
		throw e;
	}
	const f = unique.form({ method: 'cod' });
	const q = await api.quote({ items: [{ slug: 'muesli', qty: 1 }], method: 'cod', email: f.email, pin: f.pin });
	expect(q.status).toBe(200);
	const r = await api.checkout(
		{
			items: [{ slug: 'muesli', qty: 1 }],
			contact: { name: f.name, email: f.email, phone: `+91${f.phone}` },
			address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
			method: 'cod',
			expectedTotalPaise: q.json.quote.totalPaise,
			consent: { marketing: false },
			source: 'web'
		},
		{ idempotencyKey: crypto.randomUUID() }
	);
	if (r.status === 201 || r.status === 200) return; // 0 = no cap: fine (the admin fixture leaves the order)
	const reason = r.json?.error?.details?.reason ?? r.json?.error?.reason ?? r.json?.reason;
	expect(
		{ quoteCodAvailable: q.json.quote.codAvailable, refusal: `${r.json?.error?.code ?? r.json?.code}:${reason}` },
		`quote offered COD; checkout → ${r.status} ${r.text.slice(0, 200)}`
	).not.toMatchObject({ refusal: expect.stringMatching(/TOO_MANY_OPEN/) });
});
