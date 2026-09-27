/*
 * HUNT data-cms: the Coupons collection saves numbers that the shared coupon rules
 * ($shared/coupons.js isWellFormed: every limit null or a safe integer ≥ 0, fixed value a safe integer)
 * treat as a malformed record. The admin gets "Coupon successfully created", but every shopper who uses
 * the code is told COUPON_INVALID / INACTIVE ("This offer isn't active"), silently killing the campaign.
 * The admin form accepts decimals in these number inputs (e.g. ₹10.50 typed into a paise field).
 *
 * Correct behaviour: the CMS refuses such a coupon on save (400 on that field), or the coupon works.
 */
import { test, expect } from '../../fixtures.js';

const CASES = [
	{ field: 'maxDiscountPaise', coupon: { type: 'percent', value: 10, maxDiscountPaise: 1050.5 } },
	{ field: 'minSubtotalPaise', coupon: { type: 'percent', value: 10, minSubtotalPaise: 99.5 } },
	{ field: 'usageLimit', coupon: { type: 'percent', value: 10, usageLimit: 1.5 } },
	{ field: 'perCustomerLimit', coupon: { type: 'percent', value: 10, perCustomerLimit: 2.5 } },
	{ field: 'value (fixed, beyond safe integer)', coupon: { type: 'fixed', value: 1e20 } }
];

for (const { field, coupon } of CASES) {
	test(`coupon with a malformed ${field} is refused on save or usable at checkout`, async ({ admin, api, unique }) => {
		const code = unique.code('HNT');
		const r = await admin.request('POST', 'coupons?depth=0', { body: { code, active: true, ...coupon } });
		if (r.status >= 400) return; // refused on save: fine
		try {
			expect(r.status).toBe(201);
			const q = await api.quote({ items: [{ slug: 'muesli', qty: 2 }], couponCode: code, method: 'upi' });
			expect(q.status).toBe(200);
			expect(q.json.quote.couponError, `saved coupon ${JSON.stringify(coupon)} is dead at checkout`).toBeNull();
		} finally {
			await admin.request('DELETE', `coupons/${r.json.doc.id}`);
		}
	});
}
