/*
 * HUNT data-cms (round 2): money settings that are not whole rupees.
 *
 * Product prices must be whole rupees because "the storefront displays whole rupees; a price like
 * ₹175.50 would show as ₹176" (snapshot-schema.md rule 5), and percent discounts are floored to whole
 * rupees "so the rupee-rounded summary rows always add up" ($shared/coupons.js). But Store settings
 * deliveryFeePaise / codFeePaise (and a coupon's fixed value / maxDiscountPaise, whose admin hint even
 * says "₹10.50 is 1050") accept any integer paise. The server then charges e.g. ₹299.40 while /checkout,
 * the Pay button, /order and the emails (formatPaise → Math.round) show "₹299".
 *
 * Correct behaviour: the CMS refuses a fee that isn't whole rupees (400), or /checkout shows the total
 * that will actually be charged.
 */
import { test, expect } from '../../fixtures.js';

const rupeesShown = (text) => Number(String(text).replace(/[^\d.]/g, ''));

test('delivery fee ₹49.40: the checkout total shown equals the amount charged', async ({ page, shop, admin, api }) => {
	try {
		await admin.updateSettings({ deliveryFeePaise: 4940 }); // restored after the test
	} catch (e) {
		if (/→ 400/.test(String(e?.message))) return; // refused on save: fine
		throw e;
	}
	const q = await api.quote({ items: [{ slug: 'muesli', qty: 1 }], method: 'upi', pin: '560001' });
	expect(q.status).toBe(200);
	const charged = q.json.quote.totalPaise; // what Razorpay is asked for (order.totalPaise)
	expect(q.json.quote.deliveryPaise).toBe(4940);

	await shop.setCart({ muesli: 1 });
	await shop.gotoCheckout();
	await shop.fillCheckout({ method: 'upi' });
	const shown = await page.locator('[data-wf-total]').innerText();
	const deliveryShown = await page.locator('[data-wf-delivery]').innerText();
	expect(
		rupeesShown(shown) * 100,
		`/checkout shows Delivery ${deliveryShown}, Total ${shown}; the order is charged ${charged} paise`
	).toBe(charged);
});
