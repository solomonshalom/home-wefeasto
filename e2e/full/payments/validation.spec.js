/*
 * Checkout form validation (roadmap M2 §2–3; razorpay.md §13 B.18–B.19): bad phone / PIN / email /
 * state → every bad field marked (aria-invalid + a described error), focus on the first one, nothing
 * sent; fixing a field clears its error. A PIN the server refuses (blocked prefix) lands on the PIN
 * field too. Phone and email are normalised before they are stored.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/validation.spec.js
 */
import { test, expect } from '../fixtures.js';
import { recordCheckoutCalls, orderPage, quoteSettled } from './helpers.js';

const field = (page, id) => page.locator(`#${id}`);

async function expectInvalid(page, id, text) {
	const el = field(page, id);
	await expect(el).toHaveAttribute('aria-invalid', 'true');
	await expect(el).toHaveAttribute('aria-describedby', `${id}-err`);
	await expect(page.locator(`#${id}-err`)).toHaveText(text);
}

async function expectValid(page, id) {
	await expect(field(page, id)).not.toHaveAttribute('aria-invalid', 'true');
	await expect(page.locator(`#${id}-err`)).toHaveCount(0);
}

test.describe('checkout field validation', () => {
	test('bad phone, email, PIN and no state → all marked, focus on the first (phone), nothing sent; fixing clears each', async ({ page, shop, unique, admin }) => {
		await shop.setCart({ muesli: 1 });
		await shop.gotoCheckout();
		await shop.payReady();
		const calls = recordCheckoutCalls(page);
		const email = unique.email('val');
		await field(page, 'wf-co-name').fill('Asha Kumar');
		await field(page, 'wf-co-phone').fill('12345');
		await field(page, 'wf-co-email').fill('asha@');
		await field(page, 'wf-co-address').fill('Flat 4B, 12 MG Road, Ashok Nagar');
		await field(page, 'wf-co-pin').fill('012345');
		await field(page, 'wf-co-city').fill('Bengaluru');
		await page.locator('label.wf-pay-pill:has(input[value="cod"])').click();
		await page.locator('#wf-place-order').click();

		await expect(field(page, 'wf-co-phone')).toBeFocused();
		await expectInvalid(page, 'wf-co-phone', 'Enter a valid 10-digit Indian mobile number.');
		await expectInvalid(page, 'wf-co-email', 'Enter a valid email, like name@example.com.');
		await expectInvalid(page, 'wf-co-pin', 'Enter a valid 6-digit PIN code.');
		await expectInvalid(page, 'wf-co-state', 'Choose your state.');
		await expectValid(page, 'wf-co-name');
		await expectValid(page, 'wf-co-address');
		await expectValid(page, 'wf-co-city');
		expect(calls, 'nothing sent').toHaveLength(0);

		// A landline / a first digit outside 6–9 is still not a mobile.
		await field(page, 'wf-co-phone').fill('5123456789');
		await expectInvalid(page, 'wf-co-phone', 'Enter a valid 10-digit Indian mobile number.');
		const phone = unique.phone();
		await field(page, 'wf-co-phone').fill(phone);
		await expectValid(page, 'wf-co-phone');
		await expectInvalid(page, 'wf-co-email', 'Enter a valid email, like name@example.com.');

		await page.locator('#wf-place-order').click();
		await expect(field(page, 'wf-co-email'), 'focus moves to the first field still wrong').toBeFocused();
		await field(page, 'wf-co-email').fill(email);
		await field(page, 'wf-co-pin').fill('560001');
		await page.selectOption('#wf-co-state', 'Karnataka');
		for (const id of ['wf-co-email', 'wf-co-pin', 'wf-co-state']) await expectValid(page, id);
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect(calls).toHaveLength(1);
		expect(await admin.findOrder(number)).toMatchObject({ status: 'cod_pending', contact: { phone: `+91${phone}`, email } });
	});

	test('empty form → every required field marked, focus on Full Name', async ({ page, shop }) => {
		await shop.setCart({ cornflakes: 1 });
		await shop.gotoCheckout();
		await shop.payReady();
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		await expect(field(page, 'wf-co-name')).toBeFocused();
		await expectInvalid(page, 'wf-co-name', 'Enter your name.');
		await expectInvalid(page, 'wf-co-phone', 'Enter your mobile number.');
		await expectInvalid(page, 'wf-co-email', 'Enter your email.');
		await expectInvalid(page, 'wf-co-address', 'Enter your address.');
		await expectInvalid(page, 'wf-co-pin', 'Enter your PIN code.');
		await expectInvalid(page, 'wf-co-state', 'Choose your state.');
		expect(calls).toHaveLength(0);
	});

	test('messy phone / email formats are normalised (+91 E.164, lower-case) before the order is stored', async ({ page, shop, unique, admin, mock }) => {
		const email = unique.email('norm');
		const digits = unique.phone();
		await shop.setCart({ 'rolled-oats': 1 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi', email: `  ${email.toUpperCase()} `, phone: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` });
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).contact).toMatchObject({ phone: `+91${digits}`, email });
	});

	test('a PIN the server does not deliver to → 422 → PIN field marked + focused; a served PIN clears it @stateful', async ({ page, shop, admin, mock }) => {
		await admin.updateSettings({ blockedPinPrefixes: ['5600'] });
		await shop.setCart({ 'steel-cut-oats': 1 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		await expect.poll(() => calls[0]?.status).toBe(422);
		expect(calls[0].json.error.code).toBe('PIN_UNSERVICEABLE');
		await expect(field(page, 'wf-co-pin')).toBeFocused();
		await expectInvalid(page, 'wf-co-pin', 'Sorry, we don’t deliver to 560001 yet.');

		await field(page, 'wf-co-pin').fill('400001');
		await field(page, 'wf-co-city').fill('Mumbai');
		await page.selectOption('#wf-co-state', 'Maharashtra');
		await quoteSettled(page);
		await expectValid(page, 'wf-co-pin');
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).shippingAddress).toMatchObject({ pin: '400001', city: 'Mumbai', state: 'Maharashtra' });
	});
});
