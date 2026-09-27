/*
 * /checkout (roadmap M2, S1, S5, S12) against a stubbed /api (the real
 * $shared rules in e2e/ui/checkout-fixtures.js) and a stubbed checkout.js:
 * success, in-modal failure → success, dismiss → Try again, COD,
 * PRICE_CHANGED, OUT_OF_STOCK, PAYMENTS_UNAVAILABLE → COD, double click,
 * checkout.js blocked, empty bag, validation focus, server field errors,
 * S1 save/forget, S5 PIN autofill (and its race with the customer's own
 * typing), COD limits, link offers (a refusal's note goes once fixed), the
 * pending banner, reload idempotency, phone layout, no "Pay ₹0" before
 * hydration — the main flow also under ?nofx=1 and with Web Storage throwing.
 */
import { test, expect } from '@playwright/test';
import {
	mockBackend,
	stubRazorpay,
	setScenarios,
	rzpInstances,
	seedBag,
	readLS,
	breakStorage,
	checkoutReady,
	hydrated,
	quoteSettled,
	fillForm,
	payButton,
	note,
	pageErrors,
	FORM,
	RZP_SRC
} from './checkout-fixtures.js';
import { expectNoHorizontalOverflow } from './helpers.js';

const BAG = { muesli: 1, cornflakes: 1 }; // ₹250 + ₹175 = ₹425 + ₹49 delivery = ₹474

/**
 * @param {import('@playwright/test').Page} page
 * @param {{bag?: object, backend?: ReturnType<typeof mockBackend>, scenarios?: string[], url?: string, variant?: 'normal'|'nofx'|'storage', extra?: object}} [o]
 */
async function open(page, { bag = BAG, backend = mockBackend(), scenarios = ['success'], url = '/checkout', variant = 'normal', extra = {} } = {}) {
	if (variant === 'storage') await page.addInitScript(breakStorage);
	await page.addInitScript(() => {
		window.dataLayer = [];
	});
	await backend.install(page);
	await stubRazorpay(page, scenarios);
	if (variant === 'storage') {
		// No storage: the bag lives in memory for the page session, so fill it on
		// another page and arrive by a client-side navigation, as a shopper would.
		await page.goto('/shop');
		await hydrated(page);
		await page.evaluate(
			({ b, url }) => {
				Object.entries(b).forEach(([s, q]) => window.WefeastoCart.add(s, q));
				const a = document.createElement('a');
				a.href = url;
				a.id = 'wf-test-go';
				a.textContent = 'go';
				document.querySelector('.page-wrapper').appendChild(a);
			},
			{ b: bag, url }
		);
		await page.click('#wf-test-go');
		await page.waitForURL((u) => u.pathname === new URL(url, 'http://x').pathname);
		await checkoutReady(page);
		return backend;
	}
	await seedBag(page, bag, extra);
	const sep = url.includes('?') ? '&' : '?';
	await page.goto(url + (variant === 'nofx' ? sep + 'nofx=1' : ''));
	await checkoutReady(page);
	return backend;
}

const events = (page) => page.evaluate(() => window.dataLayer.map((e) => e.event));

async function expectConfirmed(page, number = 'WF-10001') {
	await page.waitForURL(new RegExp(`/order\\?no=${number}&t=`));
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
	await expect(page.locator('#wf-co-thanks h2')).toHaveText('Order confirmed');
	await expect(page.locator('#wf-co-order-no')).toHaveText(`Order ${number}`);
}

for (const variant of ['normal', 'nofx', 'storage']) {
	test.describe(`main flow (${variant})`, () => {
		test('UPI: pay → Razorpay (documented options) → verify → /order confirmed, bag reconciled', async ({ page }) => {
			const errors = pageErrors(page);
			const b = await open(page, { variant });
			await fillForm(page);
			await quoteSettled(page);
			await expect(page.locator('[data-wf-total]')).toHaveText('₹474');
			await expect(page.locator('[data-wf-delivery]')).toHaveText('₹49');
			await expect(payButton(page)).toHaveText('Pay ₹474 securely');
			await payButton(page).click();
			await expectConfirmed(page);

			const req = b.last('/store/checkout');
			expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(req.body).toEqual({
				items: [{ slug: 'muesli', qty: 1 }, { slug: 'cornflakes', qty: 1 }],
				contact: { name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777' },
				address: { line1: FORM.address, city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
				method: 'upi',
				expectedTotalPaise: 47400,
				consent: { marketing: false },
				source: 'web'
			});
			const [rzp] = await rzpInstances(page);
			expect(rzp.options).toMatchObject({
				key: 'rzp_test_e2e',
				order_id: 'order_E2E10001',
				amount: 47400,
				currency: 'INR',
				name: 'Wefeasto',
				prefill: { name: 'Asha Kumar', email: 'asha@example.com', contact: '+919845262777', method: 'upi' },
				readonly: { contact: true },
				theme: { color: '#333333' },
				modal: { ondismiss: '[fn]', confirm_close: true },
				retry: { enabled: true },
				timeout: 900,
				config: { display: { hide: [{ method: 'upi', flows: ['collect'] }] } },
				handler: '[fn]'
			});
			expect(rzp.options.callback_url).toContain('/api/payments/razorpay/callback?no=WF-10001&t=');
			expect(b.count('/store/checkout/verify')).toBe(1);
			expect(await events(page)).toEqual(expect.arrayContaining(['begin_checkout', 'pay_click', 'purchase']));
			if (variant !== 'storage') {
				expect(await readLS(page, 'wefeasto_cart')).toEqual({});
				expect(await readLS(page, 'wefeasto_pending')).toBeNull();
				expect(await readLS(page, 'wefeasto_last_order')).toMatchObject({ no: 'WF-10001', items: { muesli: 1, cornflakes: 1 } });
				expect(await readLS(page, 'wefeasto_seen_WF-10001')).toBe(1);
			} else {
				expect(await page.evaluate(() => window.WefeastoCart.read())).toEqual({});
			}
			expect(errors).toEqual([]);
		});

		test('COD: place order → /order confirmed; Razorpay never loads', async ({ page }) => {
			const rzpRequests = [];
			page.on('request', (r) => r.url().includes('razorpay') && rzpRequests.push(r.url()));
			const b = await open(page, { variant });
			await fillForm(page);
			await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
			await quoteSettled(page);
			await expect(payButton(page)).toHaveText('Place order · Pay ₹474 on delivery');
			await payButton(page).click();
			await expectConfirmed(page);
			await expect(page.locator('[data-wf-order-method="cod"]')).toHaveText('Pay ₹474 on delivery — cash or UPI.');
			expect(b.last('/store/checkout').body.method).toBe('cod');
			expect(rzpRequests).toEqual([]);
		});
	});
}

test.describe('payment outcomes', () => {
	test('fails in the modal, retried in the modal, succeeds', async ({ page }) => {
		await open(page, { scenarios: ['fail_then_success'] });
		await fillForm(page);
		await payButton(page).click();
		await expectConfirmed(page);
		expect((await rzpInstances(page)).length).toBe(1);
		const dl = await page.evaluate(() => window.dataLayer);
		expect(dl).toContainEqual({ event: 'payment_failed', code: 'insufficient_funds' });
	});

	test('dismissed → one note, form and bag intact → Try again (new Razorpay order) → success', async ({ page }) => {
		const b = await open(page, { scenarios: ['dismiss', 'success'] });
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toContainText('Payment didn’t go through — no money was taken.');
		await expect(note(page)).toBeFocused();
		await expect(note(page).locator('[data-wf-action="try-again"]')).toBeVisible();
		await expect(note(page).locator('[data-wf-action="pay-on-delivery"]')).toHaveText('Pay on delivery instead');
		expect(await readLS(page, 'wefeasto_cart')).toEqual(BAG);
		expect(await readLS(page, 'wefeasto_pending')).toMatchObject({ no: 'WF-10001', cartSig: 'cornflakes:1,muesli:1' });
		await expect(page.locator('#wf-co-name')).toHaveValue(FORM.name);
		await expect(payButton(page)).toBeEnabled();
		expect(await events(page)).toContain('checkout_dismissed');
		await note(page).locator('[data-wf-action="try-again"]').click();
		await expectConfirmed(page);
		expect(b.count('/store/checkout')).toBe(1);
		expect(b.count('/store/checkout/retry')).toBe(1);
		expect((await rzpInstances(page)).map((i) => i.options.order_id)).toEqual(['order_E2E10001', 'order_E2E10001_a2']);
	});

	test('dismissed → the Pay button again retries the same order (no second order)', async ({ page }) => {
		const b = await open(page, { scenarios: ['dismiss', 'success'] });
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toBeVisible();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(b.orders.size).toBe(1);
		expect(b.count('/store/checkout/retry')).toBe(1);
	});

	test('dismissed → Pay on delivery instead → COD order', async ({ page }) => {
		await open(page, { scenarios: ['fail_then_dismiss'] });
		await fillForm(page);
		await payButton(page).click();
		await note(page).locator('[data-wf-action="pay-on-delivery"]').click();
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		await expect(note(page)).toContainText('Switched to Cash on Delivery');
		await expect(payButton(page)).toBeFocused();
		await expect(payButton(page)).toHaveText('Place order · Pay ₹474 on delivery');
		await payButton(page).click();
		await expectConfirmed(page, 'WF-10002');
	});

	test('double click → one /checkout request, one payment window', async ({ page }) => {
		const b = await open(page, { scenarios: ['success'] });
		await fillForm(page);
		await quoteSettled(page);
		await payButton(page).dblclick();
		await payButton(page).click({ force: true, noWaitAfter: true }).catch(() => {});
		await expectConfirmed(page);
		expect(b.count('/store/checkout')).toBe(1);
		expect((await rzpInstances(page)).length).toBe(1);
	});

	test('busy state: spinner + "Opening payment…" while the order is created', async ({ page }) => {
		let release;
		const gate = new Promise((r) => (release = r));
		const b = mockBackend({ hooks: { '/store/checkout': async () => void (await gate) } });
		await open(page, { backend: b });
		await fillForm(page);
		await payButton(page).click();
		await expect(payButton(page)).toHaveAttribute('aria-busy', 'true');
		await expect(payButton(page)).toContainText('Opening payment…');
		await expect(payButton(page).locator('svg.wf-spinner')).toBeVisible();
		await expect(payButton(page)).toBeDisabled();
		release();
		await expectConfirmed(page);
	});

	test('while an order is being placed the form is locked: no pill or field can drift from the order; focus comes back', async ({ page }) => {
		let release;
		const gate = new Promise((r) => (release = r));
		const b = mockBackend({ hooks: { '/store/checkout': async () => void (await gate) } });
		await open(page, { backend: b, scenarios: ['dismiss'] });
		await fillForm(page);
		await page.locator('#wf-co-address').focus();
		await page.locator('#wf-co-name').press('Enter'); // submit from a field
		await expect(payButton(page)).toHaveAttribute('aria-busy', 'true');
		await expect(page.locator('[data-wf-co-fields]')).toHaveAttribute('disabled', '');
		await expect(page.locator('input[value="cod"]')).toBeDisabled();
		await expect(page.locator('#wf-co-address')).not.toBeEditable();
		await page.locator('label.wf-pay-pill', { hasText: 'Cash on Delivery' }).click({ force: true });
		await expect(page.locator('input[value="upi"]')).toBeChecked();
		await expect(payButton(page)).toContainText('Opening payment…'); // the order's method, never "Placing your order…"
		release();
		await expect(note(page)).toBeVisible(); // dismissed: the form is back
		await expect(page.locator('[data-wf-co-fields]')).not.toHaveAttribute('disabled');
		await expect(page.locator('#wf-co-address')).toBeEditable();
		expect(b.last('/store/checkout').body.method).toBe('upi');
		expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
	});

	test('checkout.js blocked → "Couldn’t load payments…" → Pay on delivery works', async ({ page }) => {
		await open(page);
		await page.route(RZP_SRC, (r) => r.abort());
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toContainText('Couldn’t load payments. Retry, or choose Pay on delivery.');
		expect(await page.evaluate(() => window.dataLayer)).toContainEqual({ event: 'payment_failed', code: 'SCRIPT_LOAD' });
		await note(page).locator('[data-wf-action="pay-on-delivery"]').click();
		await payButton(page).click();
		await expectConfirmed(page, 'WF-10002');
	});

	test('checkout.js blocked, then allowed: Try again loads it and pays', async ({ page }) => {
		await open(page);
		let block = true;
		await page.route(RZP_SRC, (r) => (block ? r.abort() : r.fallback()));
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toContainText('Couldn’t load payments');
		block = false;
		await note(page).locator('[data-wf-action="try-again"]').click();
		await expectConfirmed(page);
	});

	test('reload after a dismissed payment: the same Idempotency-Key replays the same order', async ({ page }) => {
		const b = await open(page, { scenarios: ['dismiss'] });
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toBeVisible();
		const key1 = b.last('/store/checkout').headers['idempotency-key'];
		await page.reload();
		await checkoutReady(page);
		await expect(page.locator('[data-wf-pending="WF-10001"]')).toBeVisible();
		await fillForm(page);
		await setScenarios(page, ['success']);
		await payButton(page).click();
		await expectConfirmed(page);
		expect(b.last('/store/checkout').headers['idempotency-key']).toBe(key1);
		// The page now names its own pending order as the one to supersede: that never changes the key.
		expect(b.last('/store/checkout').body.supersede).toMatchObject({ number: 'WF-10001' });
		expect(b.orders.size).toBe(1);
	});
});

test.describe('server refusals', () => {
	test('PRICE_CHANGED → new total shown, one more tap confirms', async ({ page }) => {
		const b = await open(page);
		await fillForm(page);
		await quoteSettled(page);
		b.catalogOver.muesli = { pricePaise: 26000 }; // the price moved after the quote
		await payButton(page).click();
		await expect(note(page)).toContainText('Prices changed since you opened your bag — please check the new total.');
		await expect(page.locator('[data-wf-total]')).toHaveText('₹484');
		await expect(payButton(page)).toHaveText('Pay ₹484 securely');
		expect(b.orders.size).toBe(0);
		await payButton(page).click();
		await expectConfirmed(page);
		const bodies = b.calls.filter((c) => c.path === '/store/checkout').map((c) => c.body.expectedTotalPaise);
		expect(bodies).toEqual([47400, 48400]);
		const keys = b.calls.filter((c) => c.path === '/store/checkout').map((c) => c.headers['idempotency-key']);
		expect(keys[0]).not.toBe(keys[1]);
	});

	test('sold out at quote time: inline issue with Remove, Pay disabled until fixed', async ({ page }) => {
		const b = mockBackend({ catalog: { cornflakes: { inStock: false } } });
		await open(page, { backend: b });
		await fillForm(page);
		await quoteSettled(page);
		const issue = page.locator('[data-wf-co-issue="OUT_OF_STOCK"]');
		await expect(issue).toContainText('Cornflakes just sold out — remove it to continue.');
		await expect(payButton(page)).toBeDisabled();
		await expect(page.locator('[data-wf-blocked]')).toBeVisible();
		await expect(page.locator('[data-wf-total]')).toHaveText('₹299');
		await expect(payButton(page)).toHaveText('Pay securely'); // no amount while the bag is blocked
		await payButton(page).click({ force: true });
		expect(b.count('/store/checkout')).toBe(0);
		await issue.locator('[data-wf-remove="cornflakes"]').click();
		await quoteSettled(page);
		await expect(issue).toHaveCount(0);
		await expect(page.locator('[data-wf-blocked]')).toHaveCount(0);
		await expect(payButton(page)).toBeEnabled();
		await expect(payButton(page)).toHaveText('Pay ₹299 securely');
		expect(await readLS(page, 'wefeasto_cart')).toEqual({ muesli: 1 });
	});

	test('W2V-5: the last pack sells out while you type (every line blocked): no ₹0 summary, COD not blamed, "Pay securely"', async ({ page }) => {
		const b = await open(page, { bag: { cornflakes: 1 } });
		await fillForm(page);
		await quoteSettled(page);
		await expect(payButton(page)).toHaveText('Pay ₹224 securely');
		b.catalogOver.cornflakes = { inStock: false }; // another shopper got the last one
		await payButton(page).click();
		await expect(note(page)).toContainText('Cornflakes just sold out — remove it to continue.');
		const issue = page.locator('[data-wf-co-issue="OUT_OF_STOCK"]');
		await expect(issue).toContainText('Cornflakes just sold out — remove it to continue.');
		await quoteSettled(page);
		await expect(payButton(page)).toBeDisabled();
		await expect(payButton(page)).toHaveText('Pay securely');
		await expect(page.locator('[data-wf-cod-reason]')).toHaveCount(0); // never "Add something to your bag first."
		await expect(page.getByText('Add something to your bag first.')).toHaveCount(0);
		await expect(page.locator('input[value="cod"]')).toBeEnabled();
		for (const sel of ['[data-wf-subtotal]', '[data-wf-delivery]', '[data-wf-total]', '[data-wf-note]', '[data-wf-mobile-total]']) await expect(page.locator(sel)).toHaveCount(0);
		await expect(page.locator('#wf-co-summary')).not.toContainText('₹0');
		await expect(page.locator('[data-wf-blocked]')).toBeVisible();
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		await expect(payButton(page)).toHaveText('Place order · Pay on delivery');
		await expect(payButton(page)).toBeDisabled();
		expect(b.orders.size).toBe(0);
		await issue.locator('[data-wf-remove="cornflakes"]').click();
		await expect(page.locator('#wf-co-summary')).toContainText('Your bag is empty');
	});

	test('only some left: "Reduce to N"', async ({ page }) => {
		const b = mockBackend({ catalog: { muesli: { stock: 1 } } });
		await open(page, { backend: b, bag: { muesli: 3 } });
		await quoteSettled(page);
		const issue = page.locator('[data-wf-co-issue="OUT_OF_STOCK"]');
		await expect(issue).toContainText('Only 1 pack of Muesli left — reduce the quantity to continue.');
		await issue.locator('[data-wf-reduce="muesli"]').click();
		await quoteSettled(page);
		await expect(issue).toHaveCount(0);
		expect(await readLS(page, 'wefeasto_cart')).toEqual({ muesli: 1 });
	});

	test('sells out between quote and Pay: OUT_OF_STOCK note + the line flagged', async ({ page }) => {
		const b = await open(page);
		await fillForm(page);
		await quoteSettled(page);
		b.catalogOver.cornflakes = { inStock: false };
		await payButton(page).click();
		await expect(note(page)).toContainText('Cornflakes just sold out — remove it to continue.');
		await expect(page.locator('[data-wf-co-issue="OUT_OF_STOCK"]')).toBeVisible();
		await expect(payButton(page)).toBeDisabled();
	});

	test('PAYMENTS_UNAVAILABLE → "Pay on delivery instead" → COD order', async ({ page }) => {
		const b = mockBackend({
			hooks: {
				'/store/checkout': ({ body }) =>
					body.method !== 'cod'
						? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PAYMENTS_UNAVAILABLE', message: 'x' } }) }
						: undefined
			}
		});
		await open(page, { backend: b });
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toContainText('Payments are temporarily unavailable. Try again, or choose Cash on Delivery.');
		await note(page).locator('[data-wf-action="pay-on-delivery"]').click();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(await page.evaluate(() => window.dataLayer)).toContainEqual({ event: 'payment_failed', code: 'PAYMENTS_UNAVAILABLE' });
	});

	test('PIN_UNSERVICEABLE → PIN field marked and focused', async ({ page }) => {
		const b = mockBackend({ settings: { blockedPinPrefixes: ['1941'] } });
		await open(page, { backend: b });
		await fillForm(page, { ...FORM, pin: '194101', city: 'Leh', state: 'Ladakh' });
		await payButton(page).click();
		const pin = page.locator('#wf-co-pin');
		await expect(pin).toBeFocused();
		await expect(pin).toHaveAttribute('aria-invalid', 'true');
		await expect(pin).toHaveAttribute('aria-describedby', 'wf-co-pin-err');
		await expect(page.locator('#wf-co-pin-err')).toHaveText('Sorry, we don’t deliver to 194101 yet.');
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'PIN_UNSERVICEABLE');
		await quoteSettled(page);
		await expect(note(page)).toBeVisible(); // the quote for the refused PIN agrees: the note stays
		await page.fill('#wf-co-pin', '560001'); // a PIN we deliver to: the served quote clears the stale note
		await quoteSettled(page);
		await expect(note(page)).toHaveCount(0);
		await expect(page.locator('#wf-co-pin-err')).toHaveCount(0);
		await payButton(page).click();
		await expectConfirmed(page);
	});

	test('COD_UNAVAILABLE (open-orders cap) → COD pill off with the reason, back on UPI', async ({ page }) => {
		const b = mockBackend({
			hooks: {
				'/store/checkout': ({ body }) =>
					body.method === 'cod'
						? { status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'COD_UNAVAILABLE', message: 'x', details: { reason: 'TOO_MANY_OPEN' } } }) }
						: undefined
			}
		});
		await open(page, { backend: b, url: '/checkout?pay=cod' });
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		await fillForm(page);
		await payButton(page).click();
		await expect(page.locator('input[value="cod"]')).toBeDisabled();
		await expect(page.locator('input[value="upi"]')).toBeChecked();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveText('You already have cash-on-delivery orders on the way — please pay online for this one.');
		await page.fill('#wf-co-phone', '98765 43210'); // a different phone: COD is back on offer
		await expect(page.locator('input[value="cod"]')).toBeEnabled();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveCount(0);
	});

	test('RATE_LIMITED → calm note, nothing else changes', async ({ page }) => {
		const b = mockBackend({ hooks: { '/store/checkout': () => ({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'x' } }) }) } });
		await open(page, { backend: b });
		await fillForm(page);
		await payButton(page).click();
		await expect(note(page)).toContainText('Too many attempts — please wait a minute and try again.');
		await expect(payButton(page)).toBeEnabled();
	});
});

test.describe('form', () => {
	test('empty bag: the existing empty state, Pay disabled, nothing is ever sent', async ({ page }) => {
		const b = await open(page, { bag: {} });
		await expect(page.locator('#wf-co-summary')).toContainText('Your bag is empty — add something tasty first.');
		await expect(page.locator('#wf-co-summary a[href="/shop"]')).toBeVisible();
		await expect(payButton(page)).toBeDisabled();
		await expect(payButton(page)).toHaveText('Pay securely'); // never "Pay ₹0"
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await expect(payButton(page)).toHaveText('Place order · Pay on delivery');
		await fillForm(page);
		await payButton(page).click({ force: true });
		await page.locator('#wf-checkout-form').evaluate((f) => f.requestSubmit());
		await page.waitForTimeout(400);
		expect(b.count('/store/checkout')).toBe(0);
		expect(b.count('/store/quote')).toBe(0);
	});

	test('validation: first invalid field focused, aria wiring, errors clear as fixed', async ({ page }) => {
		const b = await open(page);
		await payButton(page).click();
		const name = page.locator('#wf-co-name');
		await expect(name).toBeFocused();
		await expect(name).toHaveAttribute('aria-invalid', 'true');
		await expect(name).toHaveAttribute('aria-describedby', 'wf-co-name-err');
		await expect(page.locator('#wf-co-name-err')).toHaveText('Enter your name.');
		await expect(page.locator('.wf-field-error')).toHaveCount(7);
		await name.fill('Asha Kumar');
		await expect(page.locator('#wf-co-name-err')).toHaveCount(0);
		await expect(name).not.toHaveAttribute('aria-invalid', 'true');
		await fillForm(page, { ...FORM, phone: '011 2345 6789' });
		await payButton(page).click();
		await expect(page.locator('#wf-co-phone')).toBeFocused();
		await expect(page.locator('#wf-co-phone-err')).toHaveText('Enter a valid 10-digit Indian mobile number.');
		expect(b.count('/store/checkout')).toBe(0);
	});

	test('no card or UPI-ID inputs exist', async ({ page }) => {
		await open(page);
		await expect(page.locator('input[name*="card" i], input[name*="upi" i], input[type="password"], #wf-pay-card, #wf-pay-upi')).toHaveCount(0);
		await expect(page.locator('[data-wf-trust]')).toContainText('Secure payments by Razorpay · UPI · Cards · NetBanking');
		await expect(page.locator('[data-wf-trust] a[data-wf-whatsapp]')).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+\?text=/);
	});

	test('marketing consent is sent only when ticked', async ({ page }) => {
		const b = await open(page);
		await fillForm(page);
		await page.check('#wf-co-consent');
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(b.last('/store/checkout').body.consent).toEqual({ marketing: true });
	});

	test('S1: unticked stores nothing; ticked saves; reload prefills; "Forget me" clears', async ({ page }) => {
		const b = await open(page);
		await fillForm(page);
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(await readLS(page, 'wefeasto_checkout')).toBeNull();

		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 1 })));
		await page.goto('/checkout');
		await checkoutReady(page);
		await expect(page.locator('#wf-co-name')).toHaveValue('');
		await fillForm(page);
		await page.check('#wf-co-save');
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await payButton(page).click();
		await expectConfirmed(page, 'WF-10002');
		expect(await readLS(page, 'wefeasto_checkout')).toEqual({ ...FORM });

		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 1 })));
		await page.goto('/checkout');
		await checkoutReady(page);
		for (const [id, v] of [['#wf-co-name', FORM.name], ['#wf-co-phone', FORM.phone], ['#wf-co-email', FORM.email], ['#wf-co-address', FORM.address], ['#wf-co-pin', FORM.pin], ['#wf-co-city', FORM.city], ['#wf-co-state', FORM.state]]) {
			await expect(page.locator(id)).toHaveValue(v);
		}
		await expect(page.locator('#wf-co-save')).toBeChecked();
		await page.locator('[data-wf-forget]').click();
		expect(await readLS(page, 'wefeasto_checkout')).toBeNull();
		await expect(page.locator('#wf-co-name')).toHaveValue('');
		await expect(page.locator('#wf-co-name')).toBeFocused();
		await expect(page.locator('#wf-co-save')).not.toBeChecked();
		expect(b.orders.size).toBe(2);
	});

	test('S1 with storage throwing: no prefill, no crash, order still placed', async ({ page }) => {
		const errors = pageErrors(page);
		await open(page, { variant: 'storage' });
		await fillForm(page);
		await page.check('#wf-co-save');
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(errors).toEqual([]);
	});

	test('S5: a PIN fills city and state (editable, credited); a typed city is never overwritten', async ({ page }) => {
		await open(page);
		await page.fill('#wf-co-pin', '560001');
		await expect(page.locator('#wf-co-city')).toHaveValue('Bengaluru');
		await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
		await expect(page.locator('[data-wf-pin-hint]')).toContainText('GeoNames');
		await page.fill('#wf-co-pin', '400001'); // autofilled values follow the PIN
		await expect(page.locator('#wf-co-city')).toHaveValue('Mumbai');
		await expect(page.locator('#wf-co-state')).toHaveValue('Maharashtra');
		await page.fill('#wf-co-city', 'Bombay'); // typed by the customer
		await page.fill('#wf-co-pin', '560001');
		await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
		await expect(page.locator('#wf-co-city')).toHaveValue('Bombay');
	});

	test('S5: the fill is announced (only what changed) and the hint describes the filled fields (WCAG 4.1.3)', async ({ page }) => {
		await open(page);
		const live = page.locator('[data-wf-co-live]');
		await page.locator('#wf-co-pin').focus();
		await page.keyboard.type('560001', { delay: 20 });
		await expect(page.locator('#wf-co-city')).toHaveValue('Bengaluru');
		await expect(live).toContainText('City and state filled in from your PIN: Bengaluru, Karnataka. Change them if they’re not right.');
		await expect(page.locator('#wf-co-city')).toHaveAttribute('aria-describedby', 'wf-co-pin-hint');
		await expect(page.locator('#wf-co-state')).toHaveAttribute('aria-describedby', 'wf-co-pin-hint');
		await page.fill('#wf-co-city', 'Bangalore'); // theirs now: no longer described as filled from the PIN
		await expect(page.locator('#wf-co-city')).not.toHaveAttribute('aria-describedby', /wf-co-pin-hint/);
		const before = await live.textContent();
		await page.fill('#wf-co-pin', '560100'); // same state, the typed city kept: nothing changed → nothing new said
		await expect(page.locator('#wf-co-city')).toHaveValue('Bangalore');
		await page.waitForTimeout(800);
		await expect(live).toHaveText(before);
	});

	/**
	 * W2V2-3: the shard for the PIN lands after the customer tapped City. Held until the
	 * shard is released, so the order of events is exact.
	 */
	async function slowShard(page) {
		let release;
		const gate = new Promise((r) => (release = r));
		await page.route('**/pin/*.json', async (r) => {
			await gate;
			await r.fallback();
		});
		return async () => {
			const landed = page.waitForResponse((r) => r.url().includes('/pin/570.json'));
			release();
			await landed;
		};
	}

	test('S5 race: the shard lands after the customer tapped City — what they type is exactly what stays', async ({ page }) => {
		await open(page);
		const land = await slowShard(page);
		await page.fill('#wf-co-pin', '570001');
		await page.locator('#wf-co-city').click();
		await land();
		// State (not focused) proves the answer arrived; City, where the caret is, was left alone.
		await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
		await expect(page.locator('#wf-co-city')).toHaveValue('');
		await expect(page.locator('#wf-co-city')).toBeFocused();
		await page.keyboard.type('Mysore', { delay: 30 });
		await expect(page.locator('#wf-co-city')).toHaveValue('Mysore'); // was "MysuruMysore"
		await page.locator('#wf-co-name').click(); // leaving City: nothing held back overwrites it
		await expect(page.locator('#wf-co-city')).toHaveValue('Mysore');
		await page.fill('#wf-co-pin', '560001'); // the typed city stays theirs
		await expect(page.locator('#wf-co-city')).toHaveValue('Mysore');
	});

	test('S5 race: City tapped while the shard loads, then left untouched → filled on the way out', async ({ page }) => {
		await open(page);
		const land = await slowShard(page);
		await page.fill('#wf-co-pin', '570001');
		await page.locator('#wf-co-city').click();
		await land();
		await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
		await expect(page.locator('#wf-co-city')).toHaveValue('');
		await page.locator('#wf-co-address').click();
		await expect(page.locator('#wf-co-city')).toHaveValue('Mysuru');
		await expect(page.locator('[data-wf-pin-hint]')).toBeVisible();
	});

	test('S5 race: State focused while the shard lands → City fills, State waits for the customer to leave', async ({ page }) => {
		await open(page);
		const land = await slowShard(page);
		await page.fill('#wf-co-pin', '570001');
		await page.locator('#wf-co-state').focus();
		await land();
		await expect(page.locator('#wf-co-city')).toHaveValue('Mysuru');
		await expect(page.locator('#wf-co-state')).toHaveValue('');
		await page.locator('#wf-co-name').focus();
		await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
	});

	test('S5 race: typing starts before the shard lands → the typed city stays', async ({ page }) => {
		await open(page);
		const land = await slowShard(page);
		await page.fill('#wf-co-pin', '570001');
		await page.locator('#wf-co-city').click();
		await page.keyboard.type('Mys');
		await land();
		await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
		await page.keyboard.type('ore');
		await expect(page.locator('#wf-co-city')).toHaveValue('Mysore');
	});

	test('S5: an answer for a PIN that has since changed is dropped', async ({ page }) => {
		await open(page);
		const land = await slowShard(page);
		await page.fill('#wf-co-pin', '570001');
		await page.fill('#wf-co-pin', '57000'); // not a PIN any more
		await land();
		await page.waitForTimeout(150);
		await expect(page.locator('#wf-co-city')).toHaveValue('');
		await expect(page.locator('#wf-co-state')).toHaveValue('');
	});

	test('S5: an unknown PIN or a missing shard never blocks checkout', async ({ page }) => {
		await page.route('**/pin/**', (r) => r.abort());
		const b = await open(page);
		await fillForm(page, { ...FORM, pin: '560001', city: 'Bengaluru', state: 'Karnataka' });
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(b.orders.size).toBe(1);
	});
});

test.describe('summary', () => {
	test('COD above ₹2,000: pill disabled with the reason; ?pay=cod falls back to UPI', async ({ page }) => {
		await open(page, { bag: { 'health-mix': 10 }, url: '/checkout?pay=cod' });
		await quoteSettled(page);
		await expect(page.locator('input[value="cod"]')).toBeDisabled();
		await expect(page.locator('input[value="upi"]')).toBeChecked();
		await expect(page.locator('[data-wf-cod-reason]')).toHaveText('Cash on delivery is available on orders up to ₹2,000 — please pay online.');
		await expect(page.locator('[data-wf-delivery]')).toHaveText('FREE');
	});

	test('link offer: discount row + chip from the server quote; an invalid code explains itself and can be removed', async ({ page }) => {
		const b = mockBackend({ coupons: { WELCOME10: { code: 'WELCOME10', type: 'percent', value: 10, maxDiscountPaise: 7500, active: true } } });
		await open(page, { backend: b, extra: { wefeasto_offer: { code: 'WELCOME10', at: Date.now() } } });
		await fillForm(page);
		await quoteSettled(page);
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹42');
		await expect(page.locator('[data-wf-offer="WELCOME10"]')).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(page.locator('[data-wf-total]')).toHaveText('₹432');
		await expect(payButton(page)).toHaveText('Pay ₹432 securely');
		expect(b.last('/store/quote').body.couponCode).toBe('WELCOME10');
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await payButton(page).click();
		await expectConfirmed(page);
		expect(b.firstOrder().couponCode).toBe('WELCOME10');
	});

	test('an unknown offer code: reason shown, removable', async ({ page }) => {
		await open(page, { extra: { wefeasto_offer: { code: 'BOGUS10', at: Date.now() } } });
		await quoteSettled(page);
		const chip = page.locator('[data-wf-offer="BOGUS10"]');
		await expect(chip).toHaveAttribute('data-wf-offer-state', 'invalid');
		await expect(chip).toContainText('That offer code isn’t valid.');
		await chip.locator('.wf-offer-remove').click();
		await expect(chip).toHaveCount(0);
		expect(await readLS(page, 'wefeasto_offer')).toBeNull();
	});

	test('W2V2-4: an offer for another email → refused with a note; the right email → offer applied and the note gone', async ({ page }) => {
		const b = mockBackend({ coupons: { ASHA10: { code: 'ASHA10', type: 'percent', value: 10, maxDiscountPaise: 7500, active: true, boundEmail: FORM.email } } });
		await open(page, { backend: b, extra: { wefeasto_offer: { code: 'ASHA10', at: Date.now() } } });
		await fillForm(page, { ...FORM, email: 'someone@example.com' });
		await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).click();
		await quoteSettled(page);
		const chip = page.locator('[data-wf-offer="ASHA10"]');
		await expect(chip).toHaveAttribute('data-wf-offer-state', 'invalid');
		await payButton(page).click();
		const refusal = page.locator('.wf-co-note[data-wf-co-note="COUPON_INVALID"]');
		await expect(refusal).toContainText('That offer belongs to a different email address.');
		await expect(refusal.locator('[data-wf-action="remove-offer"]')).toBeVisible();
		expect(b.orders.size).toBe(0);
		// Still wrong (the same ask, then another wrong email): the note stays.
		await quoteSettled(page);
		await expect(refusal).toBeVisible();
		await page.fill('#wf-co-email', 'someone.else@example.com');
		await quoteSettled(page);
		await expect(chip).toHaveAttribute('data-wf-offer-state', 'invalid');
		await expect(refusal).toBeVisible();
		// The email the offer was sent to: applied, and the refusal note is gone.
		await page.fill('#wf-co-email', FORM.email);
		await quoteSettled(page);
		await expect(chip).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹42');
		await expect(note(page)).toHaveCount(0);
		await expect(payButton(page)).toHaveText('Place order · Pay ₹432 on delivery');
		await payButton(page).click();
		await expectConfirmed(page);
		expect(b.firstOrder().couponCode).toBe('ASHA10');
		expect(b.firstOrder().q.discountPaise).toBe(4200);
	});

	test('meter + one-tap top-up live in the summary; adding re-quotes', async ({ page }) => {
		const b = await open(page);
		await quoteSettled(page);
		await expect(page.locator('#wf-co-summary .wf-meter')).toBeVisible();
		const add = page.locator('#wf-co-summary .wf-topup-add');
		await expect(add).toBeVisible();
		const before = b.count('/store/quote');
		await add.click();
		await quoteSettled(page);
		await expect(page.locator('[data-wf-delivery]')).toHaveText('FREE');
		expect(b.count('/store/quote')).toBeGreaterThan(before);
	});

	test('the server quote is what shows (a stale snapshot price never does)', async ({ page }) => {
		const b = mockBackend({ catalog: { muesli: { pricePaise: 30000 } } });
		await open(page, { backend: b });
		await quoteSettled(page);
		await expect(page.locator('[data-wf-co-line="muesli"]')).toContainText('₹300');
		await expect(page.locator('[data-wf-total]')).toHaveText('₹524');
	});

	test('quote endpoint down: the local quote stands in and checkout still works', async ({ page }) => {
		const b = mockBackend({ hooks: { '/store/quote': () => ({ status: 500, contentType: 'application/json', body: '{}' }) } });
		await open(page, { backend: b });
		await fillForm(page);
		await quoteSettled(page);
		await expect(page.locator('[data-wf-total]')).toHaveText('₹474');
		await payButton(page).click();
		await expectConfirmed(page);
	});
});

test.describe('pending-order banner on /checkout', () => {
	test('stuck on a failed payment, same bag: "Pay on delivery instead" switches this form to COD and the banner steps aside', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await open(page, { backend: b, bag: { muesli: 1 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		await banner.locator('[data-wf-action="pay-on-delivery"]').click();
		await expect(banner).toHaveCount(0);
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		await expect(note(page)).toContainText('Switched to Cash on Delivery');
		await expect(payButton(page)).toBeFocused();
		await fillForm(page);
		await payButton(page).click();
		await expectConfirmed(page, 'WF-10002');
		expect(b.last('/store/checkout').body.method).toBe('cod');
	});

	test('COD unavailable for the bag: the banner offers no "Pay on delivery instead" (and no link back to this page)', async ({ page }) => {
		const b = mockBackend({ settings: { codEnabled: false } });
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await open(page, { backend: b, bag: { muesli: 1 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		await quoteSettled(page);
		await expect(page.locator('input[value="cod"]')).toBeDisabled();
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		await expect(banner.locator('[data-wf-action="retry-payment"]')).toBeVisible();
		await expect(banner.locator('[data-wf-action="pay-on-delivery"]')).toHaveCount(0);
		await expect(page.locator('a[href="/checkout?pay=cod"]')).toHaveCount(0);
	});

	test('shows the waiting order; "Check status" → paid → /order', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 } });
		b.statusSeq.set(o.number, ['pending_payment', 'paid']);
		await open(page, { backend: b, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await expect(banner).toContainText(`Your order ${o.number} is waiting for payment`);
		await banner.locator('[data-wf-pending-check]').click();
		await page.waitForURL(new RegExp(`/order\\?no=${o.number}&t=`));
		await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
	});
});

test.describe('phone (390 px)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('no sideways scroll; one in-flow total above the button', async ({ page }) => {
		await open(page);
		await fillForm(page);
		await quoteSettled(page);
		const line = page.locator('[data-wf-mobile-total]');
		await expect(line).toBeVisible();
		await expect(line).toHaveText('Total ₹474 (incl. ₹49 delivery)');
		const [lb, bb] = await Promise.all([line.boundingBox(), payButton(page).boundingBox()]);
		expect(lb.y).toBeLessThan(bb.y);
		await expectNoHorizontalOverflow(page);
		await payButton(page).click();
		await expectConfirmed(page);
		await expectNoHorizontalOverflow(page);
	});

	test.describe('touch', () => {
		test.use({ hasTouch: true, isMobile: true });

		test('W2V2-3: PIN typed, City tapped, the shard lands, then typing — the city is exactly what was typed; the order carries it', async ({ page }) => {
			const b = await open(page);
			let release;
			const gate = new Promise((r) => (release = r));
			await page.route('**/pin/*.json', async (r) => {
				await gate;
				await r.fallback();
			});
			await page.fill('#wf-co-name', FORM.name);
			await page.fill('#wf-co-phone', FORM.phone);
			await page.fill('#wf-co-email', FORM.email);
			await page.fill('#wf-co-address', FORM.address);
			await page.locator('#wf-co-pin').tap();
			await page.keyboard.type('570001', { delay: 40 });
			await page.locator('#wf-co-city').tap();
			const landed = page.waitForResponse((r) => r.url().includes('/pin/570.json'));
			release();
			await landed;
			await expect(page.locator('#wf-co-state')).toHaveValue('Karnataka');
			await page.keyboard.type('Mysore', { delay: 60 });
			await expect(page.locator('#wf-co-city')).toHaveValue('Mysore');
			await page.locator('.wf-pay-pill', { hasText: 'Cash on Delivery' }).tap();
			await quoteSettled(page);
			await payButton(page).tap();
			await expectConfirmed(page);
			expect(b.last('/store/checkout').body.address).toMatchObject({ city: 'Mysore', state: 'Karnataka', pin: '570001' });
		});
	});

	test('desktop hides the in-flow total', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await open(page);
		await expect(page.locator('[data-wf-mobile-total]')).toBeHidden();
	});
});

test.describe('W2V2-5: before hydration / without JS', () => {
	test.use({ javaScriptEnabled: false });

	test('the prerendered Pay button reads "Pay securely" — never "Pay ₹0"', async ({ page }) => {
		await page.goto('/checkout');
		await expect(payButton(page)).toHaveText('Pay securely');
		await expect(payButton(page)).toBeDisabled();
		await expect(page.locator('body')).not.toContainText('₹0');
	});
});

/*
 * Wave 3 round 1 (PI-SF-1 storefront half, PI-PAY-3): the quote names the unpaid order a checkout of this bag
 * would supersede; Try again refused for the bag re-quotes it (Reduce to N, Pay off) and the next tap places a
 * NEW order instead of replaying the dead one.
 */
test.describe('superseding and refused retries', () => {
	const quoteCalls = (b) => b.calls.filter((c) => c.path === '/store/quote');
	const lastQuote = (b) => quoteCalls(b).at(-1)?.body;

	test('PI-SF-1: after a dismiss the quote names the pending order (also for COD); a changed bag re-quotes without it', async ({ page }) => {
		const b = await open(page, { scenarios: ['dismiss'] });
		await fillForm(page);
		await quoteSettled(page);
		expect(quoteCalls(b).every((c) => !('supersede' in c.body)), 'nothing to supersede before an order exists').toBe(true);
		await payButton(page).click();
		await expect(note(page)).toBeVisible();
		const pending = await readLS(page, 'wefeasto_pending');
		await expect.poll(() => lastQuote(b)?.supersede).toEqual({ number: pending.no, token: pending.t });

		await note(page).locator('[data-wf-action="pay-on-delivery"]').click();
		await quoteSettled(page);
		expect(lastQuote(b)).toMatchObject({ method: 'cod', supersede: { number: pending.no, token: pending.t } });

		await page.evaluate(() => window.WefeastoCart.add('health-mix', 1));
		await quoteSettled(page);
		expect(lastQuote(b).items).toContainEqual({ slug: 'health-mix', qty: 1 });
		expect(lastQuote(b)).not.toHaveProperty('supersede');
	});

	test('PI-PAY-3: Try again refused as sold out (reservation lapsed) → re-quoted: Reduce to 1, Pay off → a NEW order (new key), never the dead one', async ({ page }) => {
		const b = mockBackend({
			hooks: {
				'/store/checkout/retry': () => ({
					status: 409,
					contentType: 'application/json',
					body: JSON.stringify({ error: { code: 'OUT_OF_STOCK', message: 'x', details: { issues: [{ slug: 'muesli', name: 'Muesli', code: 'OUT_OF_STOCK', available: 1, suggestedQty: 1 }] } } })
				})
			}
		});
		await open(page, { backend: b, bag: { muesli: 2 }, scenarios: ['dismiss', 'success'] });
		await fillForm(page);
		await quoteSettled(page);
		await payButton(page).click();
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'DISMISSED');
		await quoteSettled(page); // the re-quote naming the new order (supersede) lands first: this is later
		b.catalogOver.muesli = { stock: 1 }; // the reservation lapsed and someone bought the rest

		await note(page).locator('[data-wf-action="try-again"]').click();
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'OUT_OF_STOCK');
		await expect(note(page)).toBeFocused();
		await expect(page.locator('[data-wf-co-issue="OUT_OF_STOCK"][data-wf-co-line="muesli"] [data-wf-reduce="muesli"]')).toHaveText('Reduce to 1');
		await expect(payButton(page)).toBeDisabled();
		expect(await readLS(page, 'wefeasto_idem'), 'the dead order’s key is gone').toBeNull();

		await page.locator('[data-wf-reduce="muesli"]').click();
		await quoteSettled(page);
		await expect(payButton(page)).toBeEnabled();
		await payButton(page).click();
		await expectConfirmed(page, 'WF-10002');
		const checkouts = b.calls.filter((c) => c.path === '/store/checkout');
		expect(checkouts.map((c) => c.body.items)).toEqual([[{ slug: 'muesli', qty: 2 }], [{ slug: 'muesli', qty: 1 }]]);
		expect(checkouts[1].headers['idempotency-key']).not.toBe(checkouts[0].headers['idempotency-key']);
		expect(b.count('/store/checkout/retry')).toBe(1);
	});

	test('SUP-PHONE-1: dismissed → Pay on delivery with a changed phone: the checkout names the pending order, which is cancelled and forgotten', async ({ page }) => {
		const b = await open(page, { scenarios: ['dismiss'] });
		await fillForm(page);
		await quoteSettled(page);
		await payButton(page).click();
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'DISMISSED');
		const pending = await readLS(page, 'wefeasto_pending');
		expect(pending.no).toBe('WF-10001');
		expect(b.last('/store/checkout').body, 'nothing to supersede on the first order').not.toHaveProperty('supersede');

		await note(page).locator('[data-wf-action="pay-on-delivery"]').click();
		await page.fill('#wf-co-phone', '98450 00001');
		await page.locator('#wf-co-phone').blur();
		await quoteSettled(page);
		await payButton(page).click();
		await expectConfirmed(page, 'WF-10002');
		const cod = b.last('/store/checkout');
		expect(cod.body).toMatchObject({ method: 'cod', contact: { phone: '+919845000001' }, supersede: { number: pending.no, token: pending.t } });
		expect(b.orders.get('WF-10001')).toMatchObject({ status: 'cancelled', supersededBy: 'WF-10002' });
		expect(await readLS(page, 'wefeasto_pending')).toBeNull();
	});
});
