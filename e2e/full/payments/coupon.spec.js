/*
 * Offers by link (roadmap S6; checkout-backend.md §1.2 coupons): /cart?offer=CODE stores the offer,
 * /checkout's server quote applies it (discount row, discounted Razorpay amount, coupon consumed when
 * paid). An offer bound to another email is refused (chip + COUPON_INVALID note with Remove offer);
 * correcting the email clears the note, removing the offer pays full price.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/coupon.spec.js
 */
import { test, expect } from '../fixtures.js';
import { COPY, coNote, action, modal, recordCheckoutCalls, orderPage, quoteSettled, answered } from './helpers.js';

const offerChip = (page, code) => page.locator(`[data-wf-offer="${code}"]`);

/** /cart?offer=CODE with a bag, then /checkout. */
async function arriveWithOffer(page, shop, code, items) {
	await shop.setCart(items);
	await page.goto(`/cart?offer=${code}`);
	await shop.waitHydrated();
	await expect(page.locator('body')).toContainText(`Offer ${code}`);
	await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.has('offer')), { message: '?offer stripped' }).toBe(false);
	await shop.gotoCheckout();
}

test.describe('offer by link', () => {
	test('valid offer → applied at checkout → Razorpay asked for the discounted total → order carries the coupon, use consumed', async ({
		page,
		shop,
		admin,
		mock
	}) => {
		const coupon = await admin.createCoupon({ type: 'percent', value: 10 });
		await arriveWithOffer(page, shop, coupon.code, { muesli: 2 });
		await mock.clearAuto(page);
		await shop.fillCheckout({ method: 'upi' });
		await expect(offerChip(page, coupon.code)).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹50');
		await expect(page.locator('[data-wf-delivery]')).toHaveText('FREE');
		await expect(page.locator('[data-wf-total]')).toHaveText('₹450');
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();
		expect(calls[0].body.couponCode).toBe(coupon.code);
		expect((await mock.instances(page))[0].options.amount).toBe(45_000);
		await modal.pay(page).click();
		const { number } = await orderPage(page);
		const o = await admin.findOrder(number);
		expect(o).toMatchObject({ status: 'paid', totalPaise: 45_000, coupon: { code: coupon.code, discountPaise: 5_000 } });
		await expect.poll(async () => (await admin.getCoupon(coupon.code))?.usedCount).toBe(1);
	});

	test('offer bound to another email → chip says so, Pay → COUPON_INVALID note → correct the email → note clears → discounted order', async ({
		page,
		shop,
		admin,
		mock,
		unique
	}) => {
		const bound = unique.email('bound');
		const coupon = await admin.createCoupon({ type: 'fixed', value: 5_000, boundEmail: bound });
		await arriveWithOffer(page, shop, coupon.code, { 'health-mix': 1 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.fillCheckout({ method: 'upi' });
		await expect(offerChip(page, coupon.code)).toHaveAttribute('data-wf-offer-state', 'invalid');
		await expect(offerChip(page, coupon.code)).toContainText(COPY.emailMismatch);
		await expect(page.locator('[data-wf-discount]')).toHaveCount(0);

		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		const note = coNote(page, 'COUPON_INVALID');
		await expect(note).toContainText(COPY.emailMismatch);
		await expect(action(note, 'remove-offer')).toBeVisible();
		await answered(calls);
		expect(calls[0].status).toBe(422);

		await page.fill('#wf-co-email', bound);
		await quoteSettled(page);
		await expect(offerChip(page, coupon.code)).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(note, 'the refusal goes once the quote applies the offer').toHaveCount(0);
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹50');
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect(await admin.findOrder(number)).toMatchObject({ status: 'paid', totalPaise: 27_000 + 4_900 - 5_000, coupon: { code: coupon.code } });
	});

	test('offer bound to another email → Remove offer → pays full price, coupon untouched', async ({ page, shop, admin, mock, unique }) => {
		const coupon = await admin.createCoupon({ type: 'percent', value: 20, boundEmail: unique.email('bound') });
		await arriveWithOffer(page, shop, coupon.code, { cornflakes: 1 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.fillCheckout({ method: 'card' });
		await page.locator('#wf-place-order').click();
		const note = coNote(page, 'COUPON_INVALID');
		await action(note, 'remove-offer').click();
		await expect(offerChip(page, coupon.code)).toHaveCount(0);
		await expect(note).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_offer'))).toBeNull();
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		const o = await admin.findOrder(number);
		expect(o.totalPaise).toBe(17_500 + 4_900);
		expect(o.coupon?.code ?? null).toBeNull();
		expect((await admin.getCoupon(coupon.code)).usedCount).toBe(0);
	});

	test('first-order-only offer for a phone that already ordered → refused at Pay (FIRST_ORDER_ONLY) → Remove offer → full price', async ({
		page,
		shop,
		admin,
		api,
		mock,
		unique
	}) => {
		const phone = unique.phone();
		await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', form: { phone } });
		const coupon = await admin.createCoupon({ type: 'percent', value: 10, firstOrderOnly: true });
		await arriveWithOffer(page, shop, coupon.code, { 'choco-flakes': 1 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.fillCheckout({ method: 'upi', phone });
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		const note = coNote(page, 'COUPON_INVALID');
		await expect(note).toContainText('That offer is for your first order only.');
		await expect.poll(() => calls[0]?.json?.error?.details?.reason).toBe('FIRST_ORDER_ONLY');
		await action(note, 'remove-offer').click();
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).totalPaise).toBe(20_000 + 4_900);
	});
});
