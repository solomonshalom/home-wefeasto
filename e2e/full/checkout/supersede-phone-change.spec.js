/*
 * SUP-PHONE-1, end to end: an online payment is dismissed, the customer taps "Pay on delivery instead"
 * and fixes their mobile number before placing the COD order. The quote priced the bag as replacing the
 * unpaid online order (its `supersede: {number, token}` ref, PI-SF-1), and the checkout now names that
 * order too, so the CMS cancels it whatever the phone, just as the quote assumed:
 *
 *  - the last pack, held by the online order, goes on delivery (no 409 sold-out loop);
 *  - a single-use offer reserved by the online order stays applied (no COUPON_INVALID loop);
 *  - late money on the replaced online order is refunded, not a second paid order;
 *  - wefeasto_pending is forgotten only because that order really was cancelled.
 *
 * Run: E2E_SLOT=1 npx playwright test --project=full e2e/full/checkout/supersede-phone-change.spec.js
 */
import { test, expect, waitOrderView, orderFromUrl, setMockAuto } from '../fixtures.js';
import { coNote, action, pendingOrder, quoteSettled, recordCheckoutCalls, answered, readPending, waitOrderStatus } from '../payments/helpers.js';

/** The page state that matters here: line issues, the Pay button, the offer chip. */
const snapshot = (page) =>
	page.evaluate(() => ({
		issues: [...document.querySelectorAll('[data-wf-co-issue]')].map((e) => e.getAttribute('data-wf-co-issue')),
		pay: document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state'),
		offer: [...document.querySelectorAll('[data-wf-offer]')].map((e) => e.getAttribute('data-wf-offer-state'))
	}));

/** On /checkout after a dismissed online order: "Pay on delivery instead", then a different mobile number. */
async function switchToCodWithNewPhone(page, unique) {
	const note = coNote(page, 'DISMISSED');
	await expect(note).toBeVisible({ timeout: 20_000 });
	const online = await pendingOrder(page);
	await action(note, 'pay-on-delivery').click();
	await expect(page.locator('input[name="wf-pay"][value="cod"]')).toBeChecked();
	const phoneB = unique.phone();
	await page.fill('#wf-co-phone', phoneB);
	await page.locator('#wf-co-phone').blur();
	await quoteSettled(page);
	return { online, phoneB };
}

/** Place the COD order: ONE checkout call, 201, naming the online order; → /order confirmed. */
async function placeCod(page, online, phoneB) {
	const calls = recordCheckoutCalls(page);
	await page.locator('#wf-place-order').click();
	await answered(calls, 1);
	expect(calls[0].status, JSON.stringify(calls[0].json)).toBe(201);
	expect(calls[0].body).toMatchObject({ method: 'cod', contact: { phone: `+91${phoneB}` }, supersede: { number: online.number, token: online.token } });
	expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
	const cod = orderFromUrl(page.url());
	expect(cod.number).not.toBe(online.number);
	expect(calls).toHaveLength(1);
	return cod;
}

async function expectReplaced(page, admin, online, cod, phoneB) {
	expect(await admin.findOrder(cod.number)).toMatchObject({ status: 'cod_pending', paymentMethod: 'cod', contact: { phone: `+91${phoneB}` } });
	await waitOrderStatus(admin, online.number, 'cancelled');
	await expect.poll(() => readPending(page), { message: 'the cancelled order is forgotten on this device' }).toBeNull();
}

test.describe('SUP-PHONE-1: Pay on delivery with a changed phone replaces the dismissed online order', () => {
	test('the last pack, held by the online order, goes on delivery', async ({ page, shop, admin, unique }) => {
		const slug = 'rolled-oats';
		await admin.setStock(slug, 1);
		await shop.placeOnlineOrder({ items: { [slug]: 1 }, auto: 'dismiss', expect: null });
		const { online, phoneB } = await switchToCodWithNewPhone(page, unique);
		expect(await snapshot(page)).toMatchObject({ issues: [], pay: 'ready' });

		const cod = await placeCod(page, online, phoneB);
		await expectReplaced(page, admin, online, cod, phoneB);
		// The online order's pack went back and the COD order holds it: one pack, one order.
		expect((await admin.getProduct(slug)).stock).toBe(0);
	});

	test('a single-use offer, reserved by the online order, stays applied', async ({ page, shop, admin, unique }) => {
		const email = unique.email('welcome');
		const coupon = await admin.createCoupon({ type: 'percent', value: 10, usageLimit: 1, perCustomerLimit: 1, firstOrderOnly: true, boundEmail: email });
		await shop.setCart({ muesli: 2 });
		await shop.visit(`/cart?offer=${coupon.code}`);
		await setMockAuto(page, { auto: 'dismiss' });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi', email });
		await expect(page.locator('[data-wf-offer]')).toHaveAttribute('data-wf-offer-state', 'applied');
		await page.locator('#wf-place-order').click();
		const { online, phoneB } = await switchToCodWithNewPhone(page, unique);
		expect(await snapshot(page)).toMatchObject({ issues: [], pay: 'ready', offer: ['applied'] });

		const cod = await placeCod(page, online, phoneB);
		await expectReplaced(page, admin, online, cod, phoneB);
		const codDoc = await admin.findOrder(cod.number);
		expect(codDoc.coupon?.code).toBe(coupon.code);
		expect(codDoc.coupon?.discountPaise).toBeGreaterThan(0);
	});

	test('late money on the replaced online order is refunded, never a second paid order', async ({ page, shop, admin, mock, unique }) => {
		await shop.placeOnlineOrder({ items: { 'health-mix': 1 }, auto: 'dismiss', expect: null });
		const { online, phoneB } = await switchToCodWithNewPhone(page, unique);
		const cod = await placeCod(page, online, phoneB);
		await expectReplaced(page, admin, online, cod, phoneB);

		// The customer's UPI app completes the dismissed payment after all.
		const rzp = (await admin.findOrder(online.number)).razorpay.attempts.at(-1).orderId;
		const paid = await mock.pay(rzp, 'success', { method: 'upi', webhook: true });
		expect(paid.status).toBeLessThan(300);
		await expect.poll(async () => (await admin.findOrder(online.number))?.razorpay?.paymentId ?? null, { timeout: 20_000 }).not.toBeNull();
		await expect.poll(async () => (await admin.findOrder(online.number))?.refunds?.length ?? 0, { timeout: 20_000, message: 'the late payment is refunded' }).toBeGreaterThan(0);
		const after = await admin.findOrder(online.number);
		expect(after.status, 'the replaced order must not become a second paid order').not.toBe('paid');
		expect((await admin.findOrder(cod.number)).status).toBe('cod_pending');
	});
});
