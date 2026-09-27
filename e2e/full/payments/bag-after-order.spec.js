/*
 * The bag after an order (roadmap M2 acceptance "The cart is cleared only after paid or COD-placed,
 * and only by the ordered quantities"; edge case "Cart edited in another tab mid-payment"): the bag
 * is untouched while paying, loses exactly the ordered units once /order sees the order confirmed,
 * and a second visit to the same /order link doesn't subtract again.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/bag-after-order.spec.js
 */
import { test, expect, addToCart, readCart } from '../fixtures.js';
import { modal, coNote, orderPage } from './helpers.js';

test.describe('the bag after an order', () => {
	test('another tab adds to the bag mid-payment → after paying only the ordered units leave it', async ({ page, shop, mock }) => {
		await shop.setCart({ muesli: 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();

		const tab2 = await page.context().newPage();
		await addToCart(tab2, 'cornflakes', 2);
		await addToCart(tab2, 'muesli', 1);
		expect(await readCart(tab2)).toEqual({ muesli: 2, cornflakes: 2 });

		await modal.pay(page).click();
		await orderPage(page);
		await expect.poll(() => shop.readCart(), { message: 'muesli −1, the other tab’s additions kept' }).toEqual({ muesli: 1, cornflakes: 2 });
		await tab2.reload();
		await expect.poll(() => readCart(tab2)).toEqual({ muesli: 1, cornflakes: 2 });
	});

	test('a dismissed or failed payment never empties the bag', async ({ page, shop }) => {
		await shop.placeOnlineOrder({ items: { 'rolled-oats': 2, 'health-mix': 1 }, auto: 'dismiss', expect: null });
		await expect(coNote(page, 'DISMISSED')).toBeVisible({ timeout: 20_000 });
		expect(await shop.readCart()).toEqual({ 'rolled-oats': 2, 'health-mix': 1 });
		await shop.gotoCart();
		expect(await shop.readCart()).toEqual({ 'rolled-oats': 2, 'health-mix': 1 });
	});

	test('opening the same /order link again (e.g. from the email) does not subtract a second time', async ({ page, shop }) => {
		const { number, token } = await shop.placeCodOrder({ items: { 'choco-flakes': 1 } });
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'first');
		await expect.poll(() => shop.readCart()).toEqual({});
		await shop.addToCart('choco-flakes', 1);
		await shop.visit(`/order?no=${number}&t=${token}`);
		await orderPage(page);
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'again');
		expect(await shop.readCart()).toEqual({ 'choco-flakes': 1 });
	});
});
