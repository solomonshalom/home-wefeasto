/*
 * Hunt (client-ux, round 3): after a dismissed payment the note offers "Try again". The customer
 * notices a typo in the address ("MG Raod, Ashok Nagr"), corrects it in the form — the note stays
 * — and taps the note's "Try again". retryFromNote() only checks that the BAG is unchanged
 * (flow.cartSig, the round-2 fix for "Try again charges the old order after the bag changed"),
 * so it pays the order already placed, with the OLD details: the order is paid and ships to the
 * typo'd address while the form on screen shows the corrected one. /order doesn't show the
 * address, so nothing tells the customer. (Pay, the other button on the same screen, does the
 * right thing: a changed form is a new attempt that supersedes the unpaid order.)
 *
 * Correct: once the details on screen differ from the order's, "Try again" doesn't pay the old
 * order as is — it places the details on screen (as Pay does) or the note goes (as it does for a
 * bag change) — so the paid order ships to the corrected address.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/try-again-ignores-corrected-address.spec.js
 */
import { test, expect, setMockAuto } from '../../fixtures.js';

const TYPO = 'Flat 4B, 12 MG Raod, Ashok Nagr';
const FIXED = 'Flat 4B, 12 MG Road, Ashok Nagar';

test('dismissed payment → correct the address → note "Try again": the paid order ships to the corrected address', async ({ page, shop, admin }) => {
	await shop.setCart({ muesli: 1 });
	await setMockAuto(page, { auto: 'dismiss' });
	await shop.gotoCheckout();
	const f = await shop.fillCheckout({ method: 'upi', address: TYPO });
	await page.locator('#wf-place-order').click();
	const note = page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]');
	await expect(note).toBeVisible({ timeout: 20_000 });

	await page.fill('#wf-co-address', FIXED);
	await setMockAuto(page, { auto: 'success' });
	const tryAgain = note.getByRole('button', { name: 'Try again' });
	if (await tryAgain.isVisible()) await tryAgain.click();
	else await page.locator('#wf-place-order').click(); // the note went with the edit: Pay places what's on screen
	expect(await shop.waitOrderView(['confirmed'])).toBe('confirmed');

	const paid = (await admin.ordersByEmail(f.email)).filter((o) => o.status === 'paid');
	expect(paid, 'one paid order').toHaveLength(1);
	expect(paid[0].shippingAddress?.line1, 'the address the customer corrected on screen').toBe(FIXED);
});
