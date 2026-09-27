/*
 * HUNT-CONC-R3-2 (cms-checkout: src/commerce/checkout/retry.ts retakeReleased → coupons.ts recheckReleasedUse):
 * "Try again" on an EXPIRED order re-takes its released first-order-only offer (e.g. the HELLO-XXXX welcome
 * code) after counting the customer's other first-order claims, but without the per-customer serialisation
 * a checkout takes for the same rule (advisory locks `first-order:<email>` / `first-order:<phone>`, db.ts
 * lockKeys). A checkout of the same customer with ANOTHER first-order code (a store-wide FIRST10) that runs at
 * the same time counts the retry's claim as still released, and the retry counts the checkout's as absent:
 * both are granted, so one customer holds two first-order discounts (and can pay both orders).
 *
 * Production stack, no gates: the retry and the checkout are simply sent together, a few times.
 * Deterministic in-process version: cms/tests/int/hunt-concurrency-r3-first-order.int.spec.ts.
 */
import { test, expect } from '../../fixtures.js';
import { checkoutBody, expireNow, freshContact, place, postCheckout, postRetry } from './lib/r3.js';

test('a retry and a checkout of one customer never both get a first-order offer', async ({ stack, db, cron, admin }) => {
	test.setTimeout(180_000);
	const both = [];
	for (let trial = 0; trial < 12 && both.length === 0; trial++) {
		const welcome = await admin.createCoupon({ type: 'fixed', value: 3000, firstOrderOnly: true });
		const first10 = await admin.createCoupon({ type: 'fixed', value: 2000, firstOrderOnly: true });
		const contact = freshContact('hunt-fo');
		const a = await place(stack, { items: [{ slug: 'rolled-oats', qty: 1 }], contact, couponCode: welcome.code });
		await expireNow(db, cron, a.number);
		const bBody = await checkoutBody(stack, { items: [{ slug: 'health-mix', qty: 1 }], contact, couponCode: first10.code });

		const [retry, b] = await Promise.all([postRetry(stack, a), new Promise((r) => setTimeout(r, trial % 4)).then(() => postCheckout(stack, bBody))]);
		const held = await db.query(
			`select r.code, o.number, r.status from coupon_redemptions r join orders o on o.id = r.order_id
			  where o.contact_email = $1 and r.status in ('reserved', 'consumed') order by o.number`,
			[contact.email]
		);
		if (held.length > 1) both.push({ trial, retry: retry.status, checkout: b.status, held });
		for (const n of [a.number, b.json?.order?.number].filter(Boolean)) await admin.cancelOrder(n);
	}
	expect(both, 'one customer holding two first-order offers at once').toEqual([]);
});
