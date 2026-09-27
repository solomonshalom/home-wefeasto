/*
 * /account (roadmap S3; storefront-account.md §2; storefront-fixes.md §2): the orders
 * placed while signed in, newest first, with status chips, View (/order?no&t) and Buy
 * again (/cart?add=…&src=usual); nobody else's orders; details (name, phone
 * normalisation) persist.
 */
import { test, expect } from '../fixtures.js';
import { COPY, apiLogin, createCustomer, placeOrderAs, waitAccountReady } from './helpers.js';

const row = (page, number) => page.locator(`.wf-order-row[data-wf-order="${number}"]`);
const chip = (page, number) => row(page, number).locator('.wf-order-status');
const rupees = (paise) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

test.describe('account: orders', { tag: '@slow' }, () => {
	test.slow(); // seven orders through the real checkout

	test('orders placed while signed in: newest first, status chips, totals, View and Buy again', async ({ page, shop, stack, mailpit, unique, admin, api, mock }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'acct-orders', name: 'Neha Das' });
		await apiLogin(page, shop, email);

		const place = (items, method = 'cod') => placeOrderAs(page, shop, unique, { items, method, form: { email } });
		const codPending = await place({ muesli: 2, cornflakes: 1 });
		const paid = await place({ 'rolled-oats': 1 }, 'upi');
		expect((await mock.pay(paid.payment.razorpayOrderId, 'success', { method: 'upi' })).status).toBe(200);
		const failed = await place({ 'steel-cut-oats': 1 }, 'upi');
		expect((await mock.pay(failed.payment.razorpayOrderId, 'fail', { reason: 'card_declined' })).status).toBe(200);
		const waiting = await place({ 'choco-flakes': 1 }, 'upi');
		const cancelled = await place({ 'health-mix': 1 });
		const shipped = await place({ cornflakes: 2 });
		const delivered = await place({ muesli: 1, 'rolled-oats': 1, 'choco-flakes': 1, 'health-mix': 1 });

		await expect.poll(async () => (await api.status(paid.number, paid.token)).json?.status).toBe('paid');
		await expect.poll(async () => (await api.status(failed.number, failed.token)).json?.status).toBe('payment_failed');
		expect((await admin.cancelOrder(cancelled.number)).status).toBe(200);
		await admin.shipOrder(shipped.number);
		await admin.deliverOrder(delivered.number);

		await shop.visit('/account');
		await waitAccountReady(page);
		const want = [
			[delivered, 'cod_confirmed', 'Delivered', 'good'],
			[shipped, 'cod_confirmed', 'Shipped', 'good'],
			[cancelled, 'cancelled', 'Cancelled', 'bad'],
			[waiting, 'pending_payment', 'Waiting for payment', 'wait'],
			[failed, 'payment_failed', 'Payment didn’t go through', 'bad'],
			[paid, 'paid', 'Order confirmed', 'good'],
			[codPending, 'cod_pending', 'Order placed · pay on delivery', 'good'] // $shared isConfirmed(cod_pending)
		];
		// Newest first, exactly this customer's seven orders.
		await expect(page.locator('.wf-order-row')).toHaveCount(want.length);
		expect(await page.locator('.wf-order-row').evaluateAll((els) => els.map((e) => e.dataset.wfOrder))).toEqual(want.map(([o]) => o.number));
		for (const [o, status, label, tone] of want) {
			await expect(chip(page, o.number), o.number).toHaveAttribute('data-wf-status', status);
			await expect(chip(page, o.number), o.number).toHaveText(label);
			await expect(chip(page, o.number), o.number).toHaveAttribute('data-tone', tone);
			await expect(row(page, o.number).locator('[data-wf-order-total]')).toHaveText(rupees(o.totalPaise));
			await expect(row(page, o.number).locator('[data-wf-view-order]')).toHaveAttribute('href', `/order?no=${o.number}&t=${o.token}`);
		}
		await expect(row(page, codPending.number).locator('[data-wf-order-items]')).toHaveText('Muesli ×2 · Cornflakes');
		await expect(row(page, delivered.number).locator('[data-wf-order-items]')).toHaveText('Muesli · Rolled Oats · Choco\'s + 1 more');
		await expect(row(page, codPending.number)).toContainText(/Placed \d{1,2} \w{3,5} 20\d\d/);

		// View opens that order.
		await row(page, cancelled.number).locator('[data-wf-view-order]').click();
		expect(await shop.waitOrderView(['cancelled'])).toBe('cancelled');
		await expect(page.locator('#wf-co-order-no')).toHaveText(`Order ${cancelled.number}`);

		// Buy again → the bag holds that order's lines.
		await shop.visit('/account');
		await waitAccountReady(page);
		const again = row(page, codPending.number).locator('[data-wf-buy-again]');
		await expect(again).toHaveAttribute('href', '/cart?add=muesli:2,cornflakes:1&src=usual');
		await again.click();
		await page.waitForURL((u) => u.pathname === '/cart');
		await expect.poll(() => shop.readCart()).toEqual({ muesli: 2, cornflakes: 1 });
		await expect(page.locator('[data-wf-row="muesli"]')).toBeVisible();
	});

	test('S3 acceptance: signed in, an order placed through /checkout appears on /account and Buy again refills the bag', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'acct-ui' });
		await apiLogin(page, shop, email);
		const { number } = await shop.placeCodOrder({ items: { 'health-mix': 1, cornflakes: 2 }, form: { email } });
		await shop.visit('/account');
		await waitAccountReady(page);
		await expect(row(page, number)).toBeVisible();
		await expect(row(page, number).locator('[data-wf-order-items]')).toHaveText(/Health Mix|Cornflakes/);
		await expect.poll(() => shop.cartCount(), { message: 'the bag is empty after ordering' }).toBe(0);
		await row(page, number).locator('[data-wf-buy-again]').click();
		await page.waitForURL((u) => u.pathname === '/cart');
		await expect.poll(() => shop.readCart()).toEqual({ 'health-mix': 1, cornflakes: 2 });
	});

	test("another customer's orders and guest orders with the same email never show up", async ({ page, shop, stack, mailpit, unique, api, newContext }) => {
		const a = await createCustomer({ stack, mailpit, unique }, { tag: 'acct-a' });
		const b = await createCustomer({ stack, mailpit, unique }, { tag: 'acct-b' });
		await apiLogin(page, shop, a.email);
		const mine = await placeOrderAs(page, shop, unique, { items: { cornflakes: 1 }, form: { email: a.email } });
		// A guest order with A's email (not signed in): never back-linked.
		const guest = await api.placeOrder({ items: { muesli: 1 }, method: 'cod', form: { email: a.email } });

		const ctxB = await newContext();
		const pageB = await ctxB.newPage();
		await pageB.goto('/shop');
		await apiLogin(pageB, null, b.email);
		const theirs = await placeOrderAs(pageB, null, unique, { items: { 'rolled-oats': 1 } });

		await shop.visit('/account');
		await waitAccountReady(page);
		await expect(page.locator('.wf-order-row')).toHaveCount(1);
		await expect(row(page, mine.number)).toBeVisible();
		await expect(row(page, guest.number)).toHaveCount(0);
		await expect(row(page, theirs.number)).toHaveCount(0);
	});

	test('a customer with no orders sees the empty shelf with a Shop link', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'acct-empty' });
		await apiLogin(page, shop, email);
		await shop.visit('/account');
		await waitAccountReady(page);
		await expect(page.locator('[data-wf-orders-empty]')).toContainText('No orders yet');
		await expect(page.locator('[data-wf-orders-empty] a[href="/shop"]')).toBeVisible();
	});
});

test.describe('account: details', () => {
	test('name + phone save (phone normalised to +91…, shown grouped) and persist; bad phone / empty name are refused', async ({ page, shop, stack, mailpit, unique, admin }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'acct-details', name: 'Old Name' });
		await apiLogin(page, shop, email);
		await shop.visit('/account');
		await waitAccountReady(page);
		await expect(page.locator('#wf-acct-name')).toHaveValue('Old Name');
		await expect(page.locator('#wf-acct-email')).toHaveAttribute('readonly', '');

		const digits = unique.phone(); // 10 digits
		const typed = `0${digits.slice(0, 5)}-${digits.slice(5)}`; // leading 0 + a dash, as people type it
		const shown = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
		await page.fill('#wf-acct-name', '  Priya  Shah ');
		await page.fill('#wf-acct-phone', typed);
		await page.click('#wf-account-form button[type="submit"]');
		await expect(page.locator('#wf-acct-note')).toHaveText(COPY.SAVED);
		await expect(page.locator('#wf-acct-phone')).toHaveValue(shown);
		const saved = await admin.findCustomer(email);
		expect(saved.phone).toBe(`+91${digits}`);
		expect(saved.name.trim().replace(/\s+/g, ' ')).toBe('Priya Shah');

		await page.reload();
		await waitAccountReady(page);
		await expect(page.locator('#wf-acct-phone')).toHaveValue(shown);
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Priya.');

		await page.fill('#wf-acct-phone', '12345');
		await page.click('#wf-account-form button[type="submit"]');
		await expect(page.locator('#wf-acct-note')).toHaveText(COPY.PHONE_INVALID);
		await expect(page.locator('#wf-acct-phone')).toHaveAttribute('aria-invalid', 'true');
		await expect(page.locator('#wf-acct-phone')).toBeFocused();

		await page.fill('#wf-acct-phone', '');
		await page.fill('#wf-acct-name', '   ');
		await page.click('#wf-account-form button[type="submit"]');
		await expect(page.locator('#wf-acct-note')).toHaveText(COPY.NAME_REQUIRED);
		await expect(page.locator('#wf-acct-name')).toHaveAttribute('aria-invalid', 'true');
		expect((await admin.findCustomer(email)).phone, 'nothing saved by the refused attempts').toBe(`+91${digits}`);

		await page.fill('#wf-acct-name', 'Priya Shah');
		await page.click('#wf-account-form button[type="submit"]');
		await expect(page.locator('#wf-acct-note')).toHaveText(COPY.SAVED);
		await expect.poll(async () => (await admin.findCustomer(email)).phone ?? null, { message: 'an empty phone clears it' }).toBeNull();
	});
});
