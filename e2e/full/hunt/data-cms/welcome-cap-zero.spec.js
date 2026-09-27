/*
 * HUNT data-cms: Store settings → Welcome offer → "Largest discount" = 0.
 *
 * The CMS accepts 0 (integerIn(0)). The two halves of the welcome flow read it differently:
 *   - the welcome email (cms/src/email/retention/welcome.ts) treats 0 as "no cap":
 *     `maxDiscountPaise ? ' (up to ₹…)' : ''` → "10% off your first order." with no limit;
 *   - checkout ($shared/coupons.js evaluateCoupon) treats 0 as a ₹0 cap: Math.min(raw, 0) = 0.
 * So the subscriber is promised 10% off, the code is accepted at checkout (no couponError, chip
 * "applied"), the discount is ₹0, and the single-use code is used up by that order.
 *
 * Correct behaviour: the CMS refuses a ₹0 cap (400 on welcomeOffer.maxDiscountPaise), or the code
 * gives what the email promised (a non-zero 10% discount on a ₹1,000 bag).
 */
import { test, expect } from '../../fixtures.js';
import { subscribeAndConfirm } from '../../accounts/helpers.js';

test('welcome offer with a ₹0 cap: the email promises 10% off, checkout gives ₹0 and burns the code', async ({ admin, api, mailpit, unique }) => {
	const s = await admin.getSettings();
	try {
		await admin.updateSettings({ welcomeOffer: { ...s.welcomeOffer, maxDiscountPaise: 0 } }); // restored after the test
	} catch (e) {
		if (/→ 400/.test(String(e?.message))) return; // refused on save: fine
		throw e;
	}

	const { email, code, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'cap0' });
	expect(code).toMatch(/^HELLO-/);
	const text = `${welcome.Text}`;
	expect(text).toContain(`${s.welcomeOffer.percent}% off your first order.`); // no "(up to …)"

	const q = await api.quote({ items: [{ slug: 'muesli', qty: 4 }], couponCode: code, email, method: 'cod', pin: '560001' });
	expect(q.status).toBe(200);
	expect(q.json.quote.couponError, 'the code is accepted').toBeNull();
	expect(q.json.quote.discountPaise, `email: "${text.match(/\d+% off your first order[^\n]*/)?.[0]}" — quote discount`).toBe(
		Math.floor((q.json.quote.subtotalPaise * s.welcomeOffer.percent) / 100 / 100) * 100
	);
});
