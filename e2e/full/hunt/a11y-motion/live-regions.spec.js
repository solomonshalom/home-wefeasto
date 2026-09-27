/*
 * HUNT a11y-motion (sf-checkout): /order wraps the whole page body in `<div class="wf-order" aria-live="polite">`,
 *   so when the view flips (loading → confirming → confirmed / failed) a screen reader
 *   queues the entire new subtree: the receipt table, "Buy again", "Browse recipes", the
 *   four household buttons, the account CTA and every recipe card, as one announcement.
 *   A live region should hold only the status message (heading + one line).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/live-regions.spec.js
 */
import { test, expect } from '../../fixtures.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

test('/order confirmed: the live region holds the status, not the receipt and every control', async ({ page, shop, api }) => {
	const o = await api.placeOrder({ items: { cornflakes: 1, muesli: 1 }, method: 'cod' });
	await shop.visit(`/order?no=${o.number}&t=${o.token}`);
	await shop.waitOrderView(['confirmed']);
	const regions = await page.evaluate(() =>
		[...document.querySelectorAll('[aria-live]:not([aria-live="off"])')]
			.filter((el) => el.closest('.page-wrapper'))
			.map((el) => ({
				cls: String(el.className),
				controls: el.querySelectorAll('a[href], button, input, select, textarea').length,
				receipt: !!el.querySelector('.wf-order-receipt, .wf-summary'),
				text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)
			}))
	);
	// The status change itself must still be announced …
	expect(regions.some((r) => /Order confirmed/.test(r.text)), 'a live region announces "Order confirmed"').toBe(true);
	// … but not the whole page with it.
	for (const r of regions) {
		expect(r, `live region .${r.cls} on /order`).toMatchObject({ controls: 0, receipt: false });
	}
});

