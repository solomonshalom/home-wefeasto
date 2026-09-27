/*
 * Redirect mode (razorpay.md §4.3, §13 D.38/D.39; checkout-backend.md §1.5): on iPhone Safari and in
 * Instagram's in-app browser checkout.js form-POSTs the result to callback_url (the CMS), which
 * verifies and 303s to /order?no=&t= (success) or …&payment=failed&reason=<error.reason> (failure).
 * No handler, no /verify call, no cookies. The /order page shows the reason copy.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/redirect-mode.spec.js
 */
import { test, expect, placeOnlineOrder, waitOrderView, orderFromUrl, setMockAuto } from '../fixtures.js';
import { IPHONE_UA, INSTAGRAM_UA, COPY, expectOnlyEmails, waitOrderStatus } from './helpers.js';

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** A context with a mobile UA; records every callback POST and /verify call it makes. */
async function mobileContext(newContext, userAgent) {
	const ctx = await newContext({ ...PHONE, userAgent });
	const page = await ctx.newPage();
	const seen = { callbacks: [], verify: 0 };
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (r.method() !== 'POST') return;
		if (u.pathname === '/api/payments/razorpay/callback') seen.callbacks.push({ origin: u.origin, body: r.postData() ?? '', type: r.headers()['content-type'] });
		if (u.pathname === '/api/store/checkout/verify') seen.verify++;
	});
	return { ctx, page, seen };
}

for (const [label, ua] of [
	['iPhone Safari', IPHONE_UA],
	['Instagram in-app', INSTAGRAM_UA]
]) {
	test.describe(`redirect mode · ${label}`, () => {
		test('success → form POST to the CMS callback → 303 → /order confirmed (paidVia callback)', async ({ newContext, stack, admin, mailpit }) => {
			const { page, seen } = await mobileContext(newContext, ua);
			const { number, form, view } = await placeOnlineOrder(page, { items: { muesli: 1 }, auto: 'success' });
			expect(view).toBe('confirmed');
			expect(page.url()).not.toContain('payment=failed');
			expect(seen.callbacks).toHaveLength(1);
			expect(seen.callbacks[0].origin).toBe(new URL(stack.cmsUrl).origin);
			expect(seen.callbacks[0].type).toContain('application/x-www-form-urlencoded');
			expect(seen.callbacks[0].body).toMatch(/razorpay_payment_id=pay_/);
			expect(seen.verify, 'redirect mode never calls the handler / verify').toBe(0);
			expect(await admin.findOrder(number)).toMatchObject({ status: 'paid', paidVia: 'callback' });
			await expectOnlyEmails(mailpit, form.email, [`Order ${number} confirmed`]);
		});
	});
}

test.describe('redirect mode · failures', () => {
	test('iPhone: card declined → /order failed with the declined reason copy ("no money was taken")', async ({ newContext, admin }) => {
		const { page, seen } = await mobileContext(newContext, IPHONE_UA);
		await placeOnlineOrder(page, { items: { cornflakes: 1 }, auto: 'fail', reason: 'card_declined', method: 'card', expect: ['failed'] });
		const u = new URL(page.url());
		expect(u.searchParams.get('payment')).toBe('failed');
		expect(u.searchParams.get('reason')).toBe('card_declined');
		expect(seen.callbacks[0].body).toContain('error%5Breason%5D=card_declined');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveAttribute('data-wf-fail-copy', 'certain');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveText(COPY.noMoneyTaken);
		await expect(page.locator('[data-wf-fail-reason]')).toHaveText(COPY.declined);
		await expect(page.locator('[data-wf-failed] [data-wf-action="try-again"]')).toBeVisible();
		const { number } = orderFromUrl(page.url());
		const o = await waitOrderStatus(admin, number, 'payment_failed');
		expect(o.razorpay.payments.find((p) => p.status === 'failed')?.errorReason).toBe('card_declined');
	});

	test('Instagram: bank technical error → /order failed (money unsure, watching) → Try again (redirect again) → confirmed', async ({
		newContext,
		admin
	}) => {
		test.slow();
		const { page, seen } = await mobileContext(newContext, INSTAGRAM_UA);
		await placeOnlineOrder(page, { items: { 'choco-flakes': 1 }, auto: 'fail', reason: 'bank_technical_error', expect: ['failed'] });
		expect(new URL(page.url()).searchParams.get('reason')).toBe('bank_technical_error');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveAttribute('data-wf-fail-copy', 'unsure');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveText(COPY.moneyUnsure);
		await expect(page.locator('[data-wf-fail-reason]')).toHaveText(COPY.technical);
		await expect(page.locator('[data-wf-late-watch]')).toBeVisible();
		const { number } = orderFromUrl(page.url());

		await setMockAuto(page, { auto: 'success' });
		await page.locator('[data-wf-failed] [data-wf-action="try-again"]').click();
		await page.waitForURL((url) => url.pathname === '/order' && !url.searchParams.has('payment'), { timeout: 30_000 });
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
		expect(seen.callbacks).toHaveLength(2);
		const o = await admin.findOrder(number);
		expect(o).toMatchObject({ status: 'paid', paidVia: 'callback' });
		expect(o.razorpay.attempts).toHaveLength(2);
	});

	test('a forged failure POST (unsigned error fields for someone else’s payment) never marks the order failed', async ({ api, stack, admin }) => {
		const o = await api.placeOrder({ items: { 'rolled-oats': 1 }, method: 'upi' });
		const res = await fetch(o.payment.callbackUrl, {
			method: 'POST',
			redirect: 'manual',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				'error[code]': 'BAD_REQUEST_ERROR',
				'error[description]': 'Payment failed',
				'error[source]': 'customer',
				'error[step]': 'payment_authorization',
				'error[reason]': 'card_declined',
				'error[metadata]': JSON.stringify({ order_id: o.payment.razorpayOrderId, payment_id: 'pay_Forged00000001' })
			}).toString()
		});
		expect(res.status).toBe(303);
		const loc = new URL(res.headers.get('location'));
		expect(loc.origin).toBe(new URL(stack.sfUrl).origin);
		expect(loc.pathname).toBe('/order');
		expect(loc.searchParams.get('no')).toBe(o.number);
		const doc = await admin.findOrder(o.number);
		expect(doc.status, 'unsigned error fields are not trusted').toBe('pending_payment');
		expect(doc.razorpay.payments ?? []).toHaveLength(0);
	});
});
