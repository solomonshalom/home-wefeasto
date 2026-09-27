/*
 * HUNT a11y-motion (sf-checkout): payment-recovery controls drop keyboard focus to <body>
 * (WCAG 2.4.3), and the pending banner swaps its live region for a new node on every
 * state, so its "Checking…" / "hasn't come through" updates are inserted into live
 * regions that did not exist a moment earlier (screen readers commonly skip those).
 *
 *   - /order failed → "Try again" → the payment sheet is dismissed → the note appears but
 *     focus is left on <body> (/checkout focuses the same note: noteEl.focus()).
 *   - /order confirmed → "Breakfast for how many?" pill: every pill is `disabled` while
 *     saving, so the focused pill loses focus.
 *   - pending banner (/cart) → "Check status": the button is replaced by the "Checking…"
 *     paragraph → focus on <body>; the role=status node is replaced too.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/order-focus.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { expectFocusKept, keyboardActivate } from './helpers.js';

test('/order failed → Try again → payment dismissed: focus goes to the note, not <body>', async ({ page, shop, api, mock }) => {
	const o = await api.placeOrder({ items: { muesli: 1 }, method: 'upi' });
	await shop.visit(`/order?no=${o.number}&t=${o.token}&payment=failed&reason=BAD_REQUEST_ERROR`);
	await expect(page.locator('[data-wf-failed]')).toBeVisible();
	await mock.setAuto(page, { auto: 'dismiss' });
	await keyboardActivate(page.locator('[data-wf-failed] [data-wf-action="try-again"]'));
	await expect(page.locator('[data-wf-failed] .wf-co-note')).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('[data-wf-failed] [data-wf-action="try-again"]')).toBeEnabled();
	await expectFocusKept(page, '/order Try again dismissed', { ms: 300 });
});

test('/order confirmed: choosing a household size by keyboard keeps focus on the pill', async ({ page, shop, api }) => {
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	await shop.visit(`/order?no=${o.number}&t=${o.token}`);
	await shop.waitOrderView(['confirmed']);
	await keyboardActivate(page.locator('[data-wf-household="2"]'));
	await expect(page.locator('[data-wf-household-saved]')).toBeVisible();
	await expectFocusKept(page, 'household pill saved');
});

test.describe('pending banner on /cart', () => {
	/** An online order left open in the payment sheet → wefeasto_pending → /cart shows the banner. */
	async function bannerOnCart(page, shop, mock) {
		await shop.setCart({ cornflakes: 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_pending'))).not.toBeNull();
		await shop.visit('/cart');
		const b = page.locator('[data-wf-pending]');
		await expect(b).toHaveAttribute('data-wf-pending-view', 'idle');
		return b;
	}

	test('"Check status" by keyboard keeps focus in the banner', async ({ page, shop, mock }) => {
		const b = await bannerOnCart(page, shop, mock);
		await keyboardActivate(b.locator('[data-wf-pending-check]'));
		await expect(b).toHaveAttribute('data-wf-pending-view', 'checking');
		await expectFocusKept(page, 'pending banner Check status');
	});

	test('the banner keeps one live region across idle → checking → stuck', async ({ page, shop, mock }) => {
		test.setTimeout(60_000);
		const b = await bannerOnCart(page, shop, mock);
		await page.evaluate(() => (window.__wfLive = document.querySelector('[data-wf-pending] [role="status"], [data-wf-pending][role="status"]')));
		await b.locator('[data-wf-pending-check]').click();
		await expect(b).toHaveAttribute('data-wf-pending-view', 'stuck', { timeout: 30_000 });
		await expect(b).toContainText('hasn’t come through');
		const same = await page.evaluate(() => {
			const n = window.__wfLive;
			return !!n && n.isConnected && n.textContent.includes('hasn’t come through');
		});
		expect(same, 'the "hasn’t come through" update lands in the live region that was already on the page').toBe(true);
	});
});
