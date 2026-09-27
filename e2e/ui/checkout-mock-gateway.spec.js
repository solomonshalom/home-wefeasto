/*
 * /checkout with the gateway agent's REAL mock checkout.js (rendered from
 * cms/src/payments/mockCheckoutScript.ts, served as PaymentInit.checkoutScript
 * = '/api/payments/mock/checkout.js' like PAYMENTS_MODE=mock does). Only
 * /api is stubbed (e2e/ui/checkout-fixtures.js), including
 * POST /api/payments/mock/pay. This checks that the options the page passes
 * work with that modal, that its markup counts as "rendered" for the
 * watchdog, and the dismiss / fail / lost / silent paths end in the right
 * place.
 */
import { test, expect } from '@playwright/test';
import { renderMockCheckoutScript } from '../../cms/src/payments/mockCheckoutScript.ts';
import { mockBackend, seedBag, checkoutReady, fillForm, payButton, note } from './checkout-fixtures.js';

const KEY = 'rzp_test_MockWefeasto01';
const SCRIPT = renderMockCheckoutScript({ keyId: KEY, payPath: '/api/payments/mock/pay' });

function backend() {
	const b = mockBackend({
		checkoutScript: '/api/payments/mock/checkout.js',
		keyId: KEY,
		hooks: {
			'/payments/mock/checkout.js': () => ({ status: 200, contentType: 'application/javascript; charset=utf-8', body: SCRIPT }),
			'/payments/mock/pay': ({ body }) => {
				const o = b.byRazorpayOrder(body.razorpayOrderId);
				if (!o) return { status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown order' } }) };
				const payment_id = 'pay_Mock' + Date.now().toString(36).padStart(14, '0');
				if (body.outcome === 'success') {
					o.status = 'paid'; // what the webhook would do
					o.paymentStatus = 'captured';
					return {
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify({ ok: true, response: { razorpay_payment_id: payment_id, razorpay_order_id: body.razorpayOrderId, razorpay_signature: 'f'.repeat(64) }, paymentId: payment_id, paymentStatus: 'captured', webhooks: 3 })
					};
				}
				return {
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						ok: false,
						error: { code: 'BAD_REQUEST_ERROR', description: 'Declined', source: 'bank', step: 'payment_authorization', reason: body.reason || 'card_declined', metadata: { order_id: body.razorpayOrderId, payment_id } },
						paymentId: payment_id,
						paymentStatus: 'failed',
						webhooks: 1
					})
				};
			}
		}
	});
	return b;
}

async function open(page, auto = null) {
	const b = backend();
	await page.addInitScript(() => {
		window.dataLayer = [];
	});
	if (auto) await page.addInitScript((a) => (window.__WF_MOCK_RZP__ = a), auto);
	await b.install(page);
	await seedBag(page, { muesli: 1, cornflakes: 1 });
	await page.goto('/checkout');
	await checkoutReady(page);
	await fillForm(page);
	return b;
}

const modal = (page) => page.getByRole('dialog', { name: 'Wefeasto' });
const instances = (page) => page.evaluate(() => window.__wfMockRzpInstances || []);

test('pay in the mock modal → verify → /order confirmed; options as documented', async ({ page }) => {
	const b = await open(page);
	await payButton(page).click();
	await expect(modal(page)).toBeVisible();
	const [inst] = await instances(page);
	expect(inst.options).toMatchObject({
		key: KEY,
		order_id: 'order_E2E10001',
		amount: 47400,
		currency: 'INR',
		prefill: { method: 'upi', contact: '+919845262777', email: 'asha@example.com' },
		modal: { confirm_close: true },
		retry: { enabled: true },
		config: { display: { hide: [{ method: 'upi', flows: ['collect'] }] } }
	});
	await modal(page).getByRole('button', { name: /^Pay ₹474/ }).click();
	await page.waitForURL(/\/order\?no=WF-10001&t=/);
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
	expect(b.count('/store/checkout/verify')).toBe(1);
});

test('"Fail payment" (stays open, tracked) then Pay → confirmed', async ({ page }) => {
	await open(page);
	await payButton(page).click();
	await modal(page).getByRole('button', { name: 'Fail payment' }).click();
	await expect(modal(page)).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.dataLayer.filter((e) => e.event === 'payment_failed').map((e) => e.code))).toEqual(['card_declined']);
	await modal(page).getByRole('button', { name: /^Pay ₹474/ }).click();
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
});

test('Cancel → "Yes, cancel" → our note, bag intact', async ({ page }) => {
	await open(page);
	await payButton(page).click();
	await modal(page).getByRole('button', { name: 'Cancel' }).click();
	await modal(page).getByRole('button', { name: 'Yes, cancel' }).click();
	await expect(note(page)).toContainText('Payment didn’t go through — no money was taken.');
	await expect(note(page)).toHaveAttribute('data-wf-co-note', 'DISMISSED');
	await expect(payButton(page)).toBeEnabled();
});

test('auto "lost" (paid, window closes, no callback) → "closed before we heard back" → Check status → confirmed', async ({ page }) => {
	const b = await open(page, { auto: 'lost', delayMs: 300 });
	b.statusSeq.set('WF-10001', ['pending_payment', 'paid']); // the webhook lands after the page's quiet look
	await payButton(page).click();
	await expect(note(page)).toHaveAttribute('data-wf-co-note', 'CLOSED', { timeout: 10_000 });
	await expect(note(page)).toContainText('please don’t pay twice');
	await expect.poll(() => b.count('/store/orders/status')).toBe(1);
	await note(page).locator('[data-wf-action="check-status"]').click();
	await page.waitForURL(/\/order\?no=WF-10001&t=/);
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
});

test('auto "silent" (bad key: nothing renders) → watchdog note after 15 s, Pay on delivery works', async ({ page }) => {
	test.setTimeout(60_000);
	await open(page, { auto: 'silent' });
	await payButton(page).click();
	await expect(payButton(page)).toHaveAttribute('aria-busy', 'true');
	await expect(note(page)).toHaveAttribute('data-wf-co-note', 'OPEN_FAILED', { timeout: 20_000 });
	await expect(note(page)).toContainText('The payment window didn’t open. Retry, or choose Pay on delivery.');
	await note(page).locator('[data-wf-action="pay-on-delivery"]').click();
	await payButton(page).click();
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
});
