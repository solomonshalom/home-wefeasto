/*
 * Hunt (client-ux): after a dismissed payment, /checkout's note offers "Try again", which
 * retries the ORDER ALREADY PLACED (flow.retry → /checkout/retry). If the bag changes while the
 * note is up — the summary's own top-up "+ Add" (or an edit in another tab) — the summary and the
 * Pay button move to the new bag and total, but the note stays and "Try again" still opens the
 * payment window for the old order: the customer pays ₹299 for Muesli alone while the page says
 * ₹520 for Muesli + Health Mix, and the added pack is left in the bag. (Pay itself is right:
 * flow.submit sees the new cart signature and places a new order.)
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/try-again-after-bag-change.spec.js
 */
import { test, expect } from '../../fixtures.js';

const rupeesToPaise = (s) => Math.round(Number(String(s).replace(/[^\d.]/g, '')) * 100);

test('dismissed → top-up "+ Add" in the summary → the next payment is for the bag on screen, not the old order', async ({ page, shop, mock, admin }) => {
	const r = await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'dismiss', expect: null });
	await expect(page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });

	await page.locator('.wf-topup-add').click();
	await expect.poll(() => shop.cartCount()).toBe(2);
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready');
	await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.classList.contains('wf-loading'));
	const shownPaise = rupeesToPaise(await page.locator('[data-wf-total]').textContent());
	const bag = await shop.readCart();

	// Whatever the page offers now — the note's Try again, or (note gone) Pay — pay what it shows.
	await mock.setAuto(page, { auto: 'success' });
	const before = (await mock.instances(page)).length; // the dismissed window is instance #1
	const tryAgain = page.locator('.wf-co-note [data-wf-action="try-again"]');
	if (await tryAgain.isVisible()) await tryAgain.click();
	else await page.locator('#wf-place-order').click();
	await expect.poll(async () => (await mock.instances(page)).length, { timeout: 20_000 }).toBeGreaterThan(before);
	const inst = (await mock.instances(page)).at(-1);
	expect(inst.options.amount, 'the payment window asks for the total on screen').toBe(shownPaise);

	await shop.waitOrderView(['confirmed']);
	const paid = (await admin.ordersByEmail(r.form.email)).find((o) => o.status === 'paid');
	const items = Object.fromEntries(paid.items.map((i) => [i.slug, i.qty]));
	expect(items, 'the paid order holds the bag that was on screen').toEqual(bag);
});
