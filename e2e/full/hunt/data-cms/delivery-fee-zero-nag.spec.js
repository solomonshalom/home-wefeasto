/*
 * HUNT data-cms (round 2): Store settings "Delivery fee below the threshold" = 0 (free delivery for
 * everyone, threshold left at ₹499). The CMS accepts it and nobody pays delivery, but $shared pricing
 * judges `isFreeDelivery` only by the threshold, so the bag and checkout show "Delivery ₹0" (not FREE)
 * and keep urging "Free delivery above ₹499 — add ₹249 more" for a delivery that already costs nothing.
 *
 * Correct behaviour: with a ₹0 fee every non-empty bag is free delivery (FREE, no "add ₹… more").
 */
import { test, expect } from '../../fixtures.js';

test('delivery fee ₹0: the bag says FREE and does not ask for more to get free delivery', async ({ page, shop, admin, api }) => {
	await admin.updateSettings({ deliveryFeePaise: 0 }); // threshold unchanged (₹499); restored after the test
	const q = (await api.quote({ items: [{ slug: 'muesli', qty: 1 }], method: 'upi' })).json.quote;
	expect(q.deliveryPaise, 'nobody pays delivery').toBe(0);

	await shop.setCart({ muesli: 1 });
	await shop.gotoCart();
	const delivery = page.locator('#wf-cart-summary [data-wf-delivery]');
	const note = page.locator('#wf-cart-summary [data-wf-note]');
	await expect(delivery).toHaveText(/₹0|FREE/);
	const shown = { delivery: await delivery.innerText(), note: await note.innerText() };
	expect(shown, 'cart summary with a ₹0 delivery fee').toEqual({ delivery: 'FREE', note: expect.not.stringMatching(/add ₹[\d,]+ more/) });
});
