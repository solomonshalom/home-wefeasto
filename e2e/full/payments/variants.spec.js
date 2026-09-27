/*
 * The happy path under the conditions the SPEC calls out (roadmap M2 "Every page works with
 * localStorage throwing"; mobile at 390 px): a phone-sized full flow through the PDP, and the online
 * + COD happy paths with storage throwing, storage blocked and ?nofx=1.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/variants.spec.js
 */
import { test, expect } from '../fixtures.js';
import { modal, orderPage, expectOnlyEmails } from './helpers.js';

const ANDROID_CHROME_UA =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('mobile 390 px', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: ANDROID_CHROME_UA });

	test('PDP → bag → checkout (mobile total line, summary under the form) → tap Pay → modal → /order confirmed', async ({ page, shop, mock, admin, mailpit }) => {
		await shop.addToCart('muesli', 1);
		await shop.addToCart('cornflakes', 1);
		await shop.gotoCart();
		expect(await noSideScroll(page), '/cart has no sideways scroll').toBe(true);
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		await expect(page.locator('[data-wf-mobile-total]')).toHaveText('Total ₹474 (incl. ₹49 delivery)');
		await expect(page.locator('#wf-place-order')).toContainText('Pay ₹474 securely');
		const formBox = await page.locator('.wf-co-form').boundingBox();
		const sumBox = await page.locator('#wf-co-summary').boundingBox();
		expect(sumBox.y, 'the summary falls below the form').toBeGreaterThan(formBox.y + formBox.height - 1);
		expect(await noSideScroll(page), '/checkout has no sideways scroll').toBe(true);

		await page.locator('#wf-place-order').tap();
		await expect(modal.root(page)).toBeVisible();
		const box = await modal.root(page).boundingBox();
		expect(box.width).toBeLessThanOrEqual(390);
		await modal.pay(page).tap();
		const { number } = await orderPage(page);
		expect(await noSideScroll(page), '/order has no sideways scroll').toBe(true);
		expect((await admin.findOrder(number)).status).toBe('paid');
		await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
	});
});

for (const variant of ['storage-throws', 'storage-blocked', 'nofx']) {
	test.describe(`variant ${variant}`, () => {
		test.use({ variant });

		test('online UPI happy path → /order confirmed, paid, one email, bag emptied', async ({ page, shop, admin, mailpit }) => {
			const { number, form, view } = await shop.placeOnlineOrder({ items: { 'rolled-oats': 1, 'choco-flakes': 1 }, auto: 'success', method: 'upi' });
			expect(view).toBe('confirmed');
			await expect(page.locator('#wf-co-order-no')).toContainText(number);
			expect(await admin.findOrder(number)).toMatchObject({ status: 'paid', paymentStatus: 'captured' });
			await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
			await expect.poll(() => shop.cartCount()).toBe(0);
		});

		test('COD with "Save my details" ticked → /order confirmed (storage trouble never breaks the order)', async ({ page, shop, admin }) => {
			const { number, view } = await shop.placeCodOrder({ items: { muesli: 1 }, form: { save: true } });
			expect(view).toBe('confirmed');
			expect(await admin.findOrder(number)).toMatchObject({ status: 'cod_pending' });
			if (variant === 'nofx') expect(await page.evaluate(() => localStorage.getItem('wefeasto_checkout'))).not.toBeNull();
		});
	});
}
