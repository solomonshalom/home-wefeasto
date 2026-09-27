/*
 * Hunt (client-ux, sf-checkout): the checkout form stays live while Pay is busy ("Opening payment…",
 * several seconds on mobile data: the checkout request, then checkout.js). A customer who, right
 * after tapping Pay, switches to "Cash on Delivery" or fixes a typo in the address sees:
 *   - the button change to "Placing your order…" (the COD wording) — then
 *   - the ONLINE payment window open anyway, for the order placed a moment earlier with the OLD
 *     address, while the form underneath shows Cash on Delivery and the corrected address.
 * Paying it ships to the old address; /order shows only city/state, so nothing tells them.
 *
 * Correct: what is on screen when a payment window opens is what that order holds — either the
 * form (method pills, fields) can't change while an order is being placed, or a change is honoured.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/edits-while-opening-payment-ignored.spec.js
 */
import { test, expect, setMockAuto, mockModal } from '../../fixtures.js';
import { recordPayLabels, payLabels } from './helpers.js';

test('switching to Cash on Delivery and correcting the address during "Opening payment…" is not silently ignored', async ({ page, shop, admin }) => {
	await shop.setCart({ muesli: 1 });
	await setMockAuto(page, null); // leave the payment window open
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'upi' });
	const corrected = 'Flat 9Z, 4th Cross, Indiranagar';
	// A mobile-data checkout request: ~3 s before the order comes back.
	await page.route('**/api/store/checkout', async (r) => {
		await new Promise((x) => setTimeout(x, 3000));
		await r.continue();
	});
	await recordPayLabels(page);
	await page.locator('#wf-place-order').click();
	await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'busy');
	// "Oh — I'll pay cash" / "that's the wrong flat number" while the spinner shows.
	await page.locator('label.wf-pay-pill:has(input[value="cod"])').click({ timeout: 2000 }).catch(() => {});
	await page.locator('#wf-co-address').fill(corrected, { timeout: 2000 }).catch(() => {});

	await Promise.race([mockModal(page).waitFor({ timeout: 20_000 }), page.waitForURL(/\/order\?/, { timeout: 20_000 })]);
	const screen = await page.evaluate(() => ({
		method: document.querySelector('input[name="wf-pay"]:checked')?.value ?? null,
		address: document.querySelector('#wf-co-address')?.value ?? null
	}));
	const o = (await admin.ordersByEmail(f.email))[0];
	const held = { method: o.paymentMethod === 'cod' ? 'cod' : o.requestedMethod, address: o.shippingAddress?.line1 };
	expect.soft(await payLabels(page), 'never "Placing your order…" while an online payment is opening').not.toContain('Placing your order…');
	expect.soft(screen.method === 'cod' ? 'cod' : 'online', `the method on screen (${screen.method}) is the order's (${held.method})`).toBe(held.method === 'cod' ? 'cod' : 'online');
	expect(screen.address, 'the address on screen is the one the order ships to').toBe(held.address);
});
