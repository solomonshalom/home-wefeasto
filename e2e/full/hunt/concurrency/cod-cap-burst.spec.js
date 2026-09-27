/*
 * HUNT-CONC-4 (cms-checkout, src/commerce/checkout/checkout.ts): the "at most codMaxOpenPerPhone open COD
 * orders per phone" cap (razorpay.md §13.62, checkout-backend.md §1.2) is counted by openCodCount() BEFORE
 * and OUTSIDE the checkout transaction, with nothing serialising two checkouts for the same phone. A burst of
 * parallel COD checkouts from one phone therefore all see "0 open" and all succeed — each one committing its
 * stock at once. Sequentially the cap works (2 × 201, then 422 COD_UNAVAILABLE TOO_MANY_OPEN).
 */
import crypto from 'node:crypto';
import { test, expect } from '../../fixtures.js';
import { cmsCall } from './helpers.js';

const SLUGS = ['rolled-oats', 'health-mix', 'steel-cut-oats', 'choco-flakes'];

test('parallel COD checkouts from one phone never exceed codMaxOpenPerPhone', async ({ stack, admin, unique }) => {
	const cap = (await admin.getSettings()).codMaxOpenPerPhone ?? 2;
	expect(cap).toBeLessThan(SLUGS.length);
	for (const slug of SLUGS) await admin.setStock(slug, 50); // restored after the test

	const phone = unique.phone({ e164: true });
	const bodies = [];
	for (const slug of SLUGS) {
		const items = [{ slug, qty: 1 }];
		const q = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method: 'cod' } });
		expect(q.status).toBe(200);
		bodies.push({
			items,
			contact: { name: 'Hunt Concurrency', email: unique.email('hunt-cap'), phone },
			address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
			method: 'cod',
			expectedTotalPaise: q.json.quote.totalPaise,
			consent: { marketing: false },
			source: 'web'
		});
	}

	const rs = await Promise.all(bodies.map((body) => cmsCall(stack, 'POST', 'store/checkout', { body, headers: { 'Idempotency-Key': crypto.randomUUID() } })));
	const placed = rs.filter((r) => r.status === 201).map((r) => r.json.order.number);
	try {
		expect(rs.map((r) => r.status).sort(), 'every refused checkout is a 422 COD_UNAVAILABLE').toEqual([...Array(cap).fill(201), ...Array(SLUGS.length - cap).fill(422)]);
		for (const r of rs.filter((x) => x.status === 422)) expect(r.json.error).toMatchObject({ code: 'COD_UNAVAILABLE', details: { reason: 'TOO_MANY_OPEN' } });
	} finally {
		for (const no of placed) await admin.cancelOrder(no); // give the committed stock back
	}
});
