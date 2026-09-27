/*
 * /order?no=&t= (roadmap M3) and the pending-order banner on /cart, against
 * the stubbed /api of e2e/ui/checkout-fixtures.js: lost payment handler →
 * polling pending ×3 → paid, side effects exactly once across reloads,
 * redirect-mode arrivals, Try again, COD, not-found parity, the 2-minute
 * "still confirming", a failed payment authorised late (the failed page
 * keeps looking; W2V-4), "no money was taken" only where certain, "Pay on
 * delivery instead" only where a COD order supersedes this one, household
 * pills, buy again, recipe cards, the guest account CTA, ?nofx=1, storage
 * throwing and the phone layout.
 */
import { test, expect } from '@playwright/test';
import { mockBackend, stubRazorpay, setScenarios, seedBag, readLS, breakStorage, checkoutReady, hydrated, fillForm, payButton, pageErrors, rzpInstances, note, quoteSettled, FORM } from './checkout-fixtures.js';
import { strip, alphaSum, expectNoHorizontalOverflow } from './helpers.js';

const view = (page) => page.locator('[data-wf-order-view]');

async function setup(page, { backend = mockBackend(), scenarios = ['success'], bag = null, extra = {}, storage = true } = {}) {
	if (!storage) await page.addInitScript(breakStorage);
	await page.addInitScript(() => {
		window.dataLayer = [];
	});
	await backend.install(page);
	await stubRazorpay(page, scenarios);
	if (storage && (bag || Object.keys(extra).length)) await seedBag(page, bag || {}, extra);
	return backend;
}

const orderLink = (o, extra = '') => `/order?no=${o.number}&t=${o.token}${extra}`;
const statusCalls = (b) => b.count('/store/orders/status');
const UNSURE = 'Payment didn’t go through. If any money left your account, we’ll confirm your order or refund it automatically.';

/** Leave the tab and come back (document.hidden + visibilitychange, as a trip to the UPI app does). */
async function leaveAndReturn(page) {
	await page.evaluate(() => {
		const set = (hidden) => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
			document.dispatchEvent(new Event('visibilitychange'));
		};
		set(true);
		set(false);
	});
}

test.describe('confirming → confirmed', () => {
	test('payment handler lost (tab died): /order polls pending ×3, then paid; celebration + side effects once', async ({ page }) => {
		const errors = pageErrors(page);
		const b = await setup(page, { bag: { muesli: 1, cornflakes: 1 }, scenarios: ['lost_callback'] });
		await page.goto('/checkout');
		await checkoutReady(page);
		await fillForm(page);
		await payButton(page).click();
		await expect.poll(async () => (await rzpInstances(page)).length).toBe(1);
		expect(await readLS(page, 'wefeasto_pending')).toMatchObject({ no: 'WF-10001' });
		// The customer paid in their UPI app; the tab never heard back. Later they open the link.
		const o = b.order('WF-10001');
		b.statusSeq.set(o.number, ['pending_payment', 'pending_payment', 'pending_payment', 'paid']);
		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 1, cornflakes: 1, 'health-mix': 1 }))); // + something added since
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirming');
		await expect(page.locator('[data-wf-confirming]')).toContainText('Confirming with your bank… please don’t pay again.');
		await expect(page.locator('[data-wf-confirming] svg.wf-spinner')).toBeVisible();
		await expect(strip(page)).toHaveAttribute('data-ready', '', { timeout: 10_000 });
		expect(await alphaSum(page)).toBeGreaterThan(0);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed', { timeout: 15_000 });
		expect(statusCalls(b)).toBe(4);
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'first');
		await expect(page.locator('#wf-co-thanks h2')).toHaveText('Order confirmed');
		await expect(page.locator('.wf-squiggle')).toBeVisible();
		await expect(page.locator('#wf-co-order-no')).toHaveText('Order WF-10001');
		await expect(page.locator('[data-wf-order-method="online"]')).toHaveText('Paid ₹474 online.');
		await expect(page.locator('[data-wf-promise]')).toHaveText(b.settings().shippingPromiseText);
		expect(await readLS(page, 'wefeasto_cart')).toEqual({ 'health-mix': 1 }); // only the ordered quantities left
		expect(await readLS(page, 'wefeasto_pending')).toBeNull();
		expect(await readLS(page, 'wefeasto_last_order')).toMatchObject({ no: 'WF-10001', t: o.token, items: { muesli: 1, cornflakes: 1 } });
		expect(await page.evaluate(() => window.dataLayer.filter((e) => e.event === 'purchase').length)).toBe(1);

		// Refresh (and a later add): no second subtraction, no second celebration, no second purchase.
		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 2 })));
		await page.reload();
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'again');
		expect(await readLS(page, 'wefeasto_cart')).toEqual({ muesli: 2 });
		expect(await page.evaluate(() => window.dataLayer.filter((e) => e.event === 'purchase').length)).toBe(0);
		expect(errors).toEqual([]);
	});

	test('one live region, the status line only: confirming → confirmed is announced without the receipt or its buttons', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		b.statusSeq.set(o.number, ['pending_payment', 'paid']);
		await page.addInitScript(() => {
			window.__wfSaid = [];
			new MutationObserver(() => {
				const l = document.querySelector('[data-wf-order-status-line]');
				const t = l?.textContent.trim();
				if (t && window.__wfSaid.at(-1) !== t) window.__wfSaid.push(t);
			}).observe(document, { subtree: true, childList: true, characterData: true });
		});
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed', { timeout: 15_000 });
		const live = page.locator('.page-wrapper [aria-live]:not([aria-live="off"])');
		await expect(live).toHaveCount(1);
		await expect(live).toHaveText('Order confirmed');
		await expect(live.locator('a, button, .wf-order-receipt')).toHaveCount(0);
		await expect(view(page)).not.toHaveAttribute('aria-live', /.*/);
		expect(await page.evaluate(() => window.__wfSaid)).toEqual(expect.arrayContaining(['Confirming your payment. Please don’t pay again.', 'Order confirmed']));
	});

	test('COD goes straight to confirmed (never "confirming")', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 2 }, method: 'cod', status: 'cod_pending' });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect(page.locator('[data-wf-order-method="cod"]')).toHaveText('Pay ₹500 on delivery — cash or UPI.');
		expect(statusCalls(b)).toBe(1);
	});

	test('confirmed page: buy again link, two recipes for the ordered SKUs, household pills, guest CTA', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 1, cornflakes: 2 }, status: 'paid' });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect(page.locator('[data-wf-buy-again]')).toHaveAttribute('href', '/cart?add=muesli:1,cornflakes:2');
		const cards = page.locator('.wf-order-recipe-grid .wf-card-cover');
		await expect(cards).toHaveCount(2);
		for (const href of await cards.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href).toMatch(/^\/recipes\/wf-/);
		await expect(page.locator('a[href="/recipes"]', { hasText: 'Browse recipes' })).toBeVisible();

		// From the keyboard: the pressed pill keeps focus while it saves (aria-disabled, never disabled).
		await page.locator('[data-wf-household="3"]').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-wf-household-saved]')).toBeVisible();
		await expect(page.locator('[data-wf-household="3"]')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('[data-wf-household="3"]')).toBeFocused();
		expect(b.last('/store/orders/household').body).toEqual({ number: o.number, token: o.token, size: 3 });

		// The account CTA opens Sign Up and promises only what an account does (guest orders are never back-linked).
		await expect(page.locator('[data-wf-account-cta] a')).toHaveAttribute('href', '/login?next=/account&signup=1');
		await expect(page.locator('[data-wf-account-cta]')).toContainText('your next orders are kept in one place');
		await expect(page.locator('[data-wf-account-cta]')).not.toContainText(/see your orders/i);
		expect(b.count('/customers/me')).toBe(0); // a browser that never logged in doesn't ask
	});

	test('a logged-in customer sees no create-account CTA', async ({ page }) => {
		const b = await setup(page, { backend: mockBackend({ user: { id: 7, email: 'asha@example.com', name: 'Asha Kumar' } }), extra: { wefeasto_signed_in: 1 } });
		const o = b.seedOrder({ status: 'paid' });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect.poll(() => b.count('/customers/me')).toBeGreaterThan(0);
		await page.waitForTimeout(300);
		await expect(page.locator('[data-wf-account-cta]')).toHaveCount(0);
	});

	test('still pending after 2 minutes: "Still confirming — we’ll email you at a•••@…"', async ({ page }) => {
		test.setTimeout(90_000);
		await page.clock.install();
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		// ?nofx=1: a still crowd, so the fake clock isn't busy painting frames.
		await page.goto(orderLink(o, '&nofx=1'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirming');
		for (let i = 0; i < 60; i++) {
			if ((await view(page).getAttribute('data-wf-order-view')) === 'slow') break;
			await page.clock.fastForward(5000);
			await page.waitForTimeout(40);
		}
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'slow');
		await expect(page.locator('[data-wf-still-confirming]')).toHaveText('We’ll email you at a•••@example.com the moment it lands — no need to pay again.');
		const calls = statusCalls(b);
		expect(calls).toBeGreaterThanOrEqual(30);
		expect(calls).toBeLessThanOrEqual(35);
		await page.clock.fastForward(60000);
		await page.waitForTimeout(100);
		expect(statusCalls(b)).toBe(calls); // polling stopped
	});
});

test.describe('failed payments', () => {
	test('redirect-mode arrival (&payment=failed): failed state → Try again → Razorpay → confirmed on the same page', async ({ page }) => {
		const b = await setup(page, { scenarios: ['success'] });
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await page.goto(orderLink(o, '&payment=failed&reason=payment_cancelled'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect(page.locator('[data-wf-failed]')).toContainText('Payment didn’t go through — no money was taken.');
		await expect(page.locator('[data-wf-fail-reason]')).toHaveCount(0);
		await expect(page.locator('[data-wf-failed] [data-wf-whatsapp]')).toHaveAttribute('href', new RegExp(`wa\\.me/\\d+\\?text=.*${o.number}`));
		await page.locator('[data-wf-action="try-again"]').click();
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(b.count('/store/checkout/retry')).toBe(1);
		expect(b.count('/store/checkout/verify')).toBe(1);
		const [rzp] = await rzpInstances(page);
		expect(rzp.options.order_id).toBe(`order_E2E${o.number.slice(3)}_a2`);
	});

	test('W2V-4: the webhook says failed, then the bank authorises late → the failed page keeps looking and turns confirmed', async ({ page }) => {
		test.setTimeout(60_000);
		await page.clock.install();
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		// Placed on this device (its wefeasto_pending): the purchase is tracked here once it confirms (PI-ORD-3).
		await seedBag(page, { muesli: 1 }, { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } });
		b.statusSeq.set(o.number, ['pending_payment', 'payment_failed', 'payment_failed', 'paid']);
		await page.goto(orderLink(o, '&nofx=1'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirming');
		await page.clock.fastForward(2000);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		const failed = page.locator('[data-wf-failed]');
		await expect(failed.locator('[data-wf-fail-copy]')).toHaveText(UNSURE); // no reason on the page: never "no money was taken"
		await expect(failed).not.toContainText('no money was taken');
		await expect(page.locator('[data-wf-late-watch]')).toHaveText('Watching for a late confirmation from your bank — this page updates by itself.');
		await expect(failed.locator('[data-wf-action="try-again"]')).toBeVisible();
		await page.clock.fastForward(8000);
		await expect.poll(() => statusCalls(b)).toBe(3);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await page.clock.fastForward(8000);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(statusCalls(b)).toBe(4);
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'first');
		expect(await page.evaluate(() => window.dataLayer.filter((e) => e.event === 'purchase').length)).toBe(1);
		await page.clock.fastForward(60000);
		await page.waitForTimeout(100);
		expect(statusCalls(b)).toBe(4); // confirmed is final
	});

	test('redirect-mode payment_timed_out: failed, never "no money was taken"; the late payment turns it confirmed', async ({ page }) => {
		await page.clock.install();
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		b.statusSeq.set(o.number, ['pending_payment', 'paid']);
		await page.goto(orderLink(o, '&payment=failed&reason=payment_timed_out&nofx=1'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect.poll(() => statusCalls(b)).toBe(1);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed'); // still pending on the server: not "Confirming…"
		await expect(page.locator('[data-wf-fail-copy]')).toHaveText(UNSURE);
		await expect(page.locator('[data-wf-late-watch]')).toBeVisible();
		await page.clock.fastForward(8000);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(statusCalls(b)).toBe(2);
	});

	test('the failed look stops after 2 minutes, and looks again on coming back to the tab', async ({ page }) => {
		test.setTimeout(90_000);
		await page.clock.install();
		const b = await setup(page);
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await page.goto(orderLink(o, '&nofx=1'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		for (let i = 1; i <= 15; i++) {
			await page.clock.fastForward(8000);
			await expect.poll(() => statusCalls(b)).toBe(1 + i);
		}
		await page.clock.fastForward(60000);
		await page.waitForTimeout(200);
		expect(statusCalls(b)).toBe(16); // every 8 s for 2 minutes, then it rests
		// Back from the UPI app, where it went through after all.
		b.statusSeq.set(o.number, ['paid']);
		await leaveAndReturn(page);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(statusCalls(b)).toBe(17);
	});

	test('a cancelled payment keeps "no money was taken" and shows no "watching" line', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ status: 'payment_failed' });
		await page.goto(orderLink(o, '&payment=failed&reason=payment_cancelled'));
		await expect(page.locator('[data-wf-fail-copy="certain"]')).toHaveText('Payment didn’t go through — no money was taken.');
		await expect(page.locator('[data-wf-late-watch]')).toHaveCount(0);
	});

	test('"Pay on delivery instead" only where a COD order supersedes this one (same bag, recent unpaid online, or expired)', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		const old = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		old.createdAt = new Date(Date.now() - 30 * 60000).toISOString(); // past the supersede window
		const expired = b.seedOrder({ items: { muesli: 1 }, status: 'expired' });
		await setup(page, { backend: b, bag: { muesli: 1 } });
		const cod = page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]');

		await page.goto(orderLink(old));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect(cod).toHaveCount(0);
		await page.goto(orderLink(expired));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect(page.locator('[data-wf-fail-copy="certain"]')).toBeVisible(); // expired: the server found no payment
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod'); // nothing left to supersede: the same bag again, on delivery

		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod');
		await page.evaluate(() => window.WefeastoCart.add('cornflakes', 1)); // the bag no longer matches the order
		await expect(cod).toHaveCount(0);
		await page.evaluate(() => window.WefeastoCart.remove('cornflakes'));
		await expect(cod).toBeVisible();
		await cod.click();
		await page.waitForURL(/\/checkout\?pay=cod$/);
		await checkoutReady(page);
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		await expect(payButton(page)).toHaveText('Place order · Pay ₹299 on delivery');
	});

	test('a declined card explains itself', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ status: 'payment_failed' });
		await page.goto(orderLink(o, '&payment=failed&reason=card_declined'));
		await expect(page.locator('[data-wf-fail-reason]')).toHaveText('That payment didn’t go through. Try another card or UPI.');
	});

	test('redirect said failed but the server says paid (late success) → confirmed wins', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ status: 'paid' });
		await page.goto(orderLink(o, '&payment=failed&reason=payment_cancelled'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
	});

	test('a pending reason in the redirect keeps confirming (never "no money was taken")', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ status: 'pending_payment' });
		await page.goto(orderLink(o, '&payment=failed&reason=payment_pending'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirming');
		await expect(page.getByText('no money was taken')).toHaveCount(0);
	});

	test('expired order: Try again refused as sold out → the note says so', async ({ page }) => {
		const b = mockBackend({
			hooks: {
				'/store/checkout/retry': () => ({
					status: 409,
					contentType: 'application/json',
					body: JSON.stringify({ error: { code: 'OUT_OF_STOCK', message: 'x', details: { issues: [{ slug: 'muesli', name: 'Muesli', code: 'OUT_OF_STOCK', available: 0 }] } } })
				})
			}
		});
		await setup(page, { backend: b });
		const o = b.seedOrder({ status: 'expired' });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await page.locator('[data-wf-action="try-again"]').click();
		await expect(page.locator('.wf-co-note')).toContainText('Muesli just sold out — remove it to continue.');
	});

	test('cancelled / needs review show their own copy', async ({ page }) => {
		const b = await setup(page);
		const c = b.seedOrder({ status: 'cancelled' });
		await page.goto(orderLink(c));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'cancelled');
		await expect(page.locator('[data-wf-order-status="cancelled"] h2')).toHaveText('Cancelled');
		const r = b.seedOrder({ status: 'needs_review' });
		await page.goto(orderLink(r));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'review');
		await expect(page.locator('h2')).toHaveText('We’re checking your order');
	});
});

test.describe('not found', () => {
	test('wrong token and unknown order look exactly the same', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ status: 'paid' });
		await page.goto(`/order?no=${o.number}&t=${'x'.repeat(43)}`);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'notfound');
		const wrongToken = await page.locator('[data-wf-notfound]').innerText();
		await page.goto(`/order?no=WF-99999&t=${o.token}`);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'notfound');
		const unknown = await page.locator('[data-wf-notfound]').innerText();
		expect(unknown).toBe(wrongToken);
		expect(unknown).toContain('We couldn’t find that order');
		expect(unknown).not.toContain(o.number);
		await expect(page.locator('[data-wf-notfound] [data-wf-whatsapp]')).toHaveAttribute('href', /^https:\/\/wa\.me\//);
	});

	test('no token and nothing on this device → "Open the link from your order email"', async ({ page }) => {
		const b = await setup(page);
		await page.goto('/order?no=WF-10001');
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'notfound');
		await expect(page.locator('[data-wf-notfound]')).toContainText('Open the link from your order email');
		expect(statusCalls(b)).toBe(0);
	});

	test('no token in the link, but this device has it in wefeasto_pending → loads', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ status: 'paid' });
		await setup(page, { backend: b, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: '' } } });
		await page.goto(`/order?no=${o.number}`);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
	});

	test('no mini-bag toast on /order (an add there only updates the bag)', async ({ page }) => {
		await setup(page);
		await page.goto('/order');
		await hydrated(page);
		await page.waitForTimeout(3000); // the layout loads the toast at idle
		await page.evaluate(() => window.WefeastoCart.add('muesli', 1, { source: 'card' }));
		await page.waitForTimeout(400);
		await expect(page.locator('[data-wf-toast]')).toHaveCount(0);
		expect(await readLS(page, 'wefeasto_cart')).toEqual({ muesli: 1 });
	});

	test('the prerendered shell sets no-referrer (the token never leaks via Referer)', async ({ page }) => {
		await setup(page);
		await page.goto('/order');
		await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
	});
});

test.describe('variants', () => {
	test('?nofx=1: still crowd, no squiggle draw, same content', async ({ page }) => {
		const b = await setup(page);
		const o = b.seedOrder({ status: 'paid' });
		await page.goto(orderLink(o, '&nofx=1'));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'first');
		await expect(strip(page)).toHaveAttribute('data-mode', 'still');
		expect(await page.locator('.wf-squiggle path').evaluate((p) => p.style.strokeDasharray)).toBe('');
	});

	test('storage throwing: confirmed still renders, nothing crashes', async ({ page }) => {
		const errors = pageErrors(page);
		const b = await setup(page, { storage: false });
		const o = b.seedOrder({ status: 'paid' });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect(page.locator('#wf-co-order-no')).toHaveText(`Order ${o.number}`);
		expect(errors).toEqual([]);
	});

	test.describe('phone (390 px)', () => {
		test.use({ viewport: { width: 390, height: 844 } });
		for (const status of ['paid', 'payment_failed', 'pending_payment']) {
			test(`${status}: no sideways scroll`, async ({ page }) => {
				const items = { muesli: 1, cornflakes: 2, 'health-mix': 1 };
				const b = await setup(page, { bag: items }); // the bag matches: failed also shows "Pay on delivery instead"
				const o = b.seedOrder({ items, status });
				await page.goto(orderLink(o));
				await expect(view(page)).not.toHaveAttribute('data-wf-order-view', 'loading');
				if (status === 'payment_failed') await expect(page.locator('[data-wf-failed] [data-wf-action]')).toHaveCount(2); // Try again + Pay on delivery instead
				await expectNoHorizontalOverflow(page);
			});
		}
	});
});

test.describe('pending-order banner on /cart', () => {
	test('"Check status": failed → Retry payment → Razorpay → /order confirmed', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await setup(page, { backend: b, bag: { muesli: 1 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await expect(banner).toContainText(`Your order ${o.number} is waiting for payment`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		await expect(banner).toContainText('If you already paid, we’ll email you');
		await banner.locator('[data-wf-action="retry-payment"]').click();
		await page.waitForURL(new RegExp(`/order\\?no=${o.number}&t=`));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(b.count('/store/checkout/retry')).toBe(1);
		expect(await readLS(page, 'wefeasto_cart')).toEqual({});
	});

	test('stuck on a failed payment with the same bag: "Pay on delivery instead" → /checkout with COD picked', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await setup(page, { backend: b, bag: { muesli: 1 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		const cod = banner.locator('[data-wf-action="pay-on-delivery"]');
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod');
		await cod.click();
		await page.waitForURL(/\/checkout\?pay=cod$/);
		await checkoutReady(page);
		await expect(page.locator('input[value="cod"]')).toBeChecked();
	});

	test('a different bag (or an old order): no "Pay on delivery instead" in the banner', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await setup(page, { backend: b, bag: { muesli: 2 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		await expect(banner.locator('[data-wf-action="retry-payment"]')).toBeVisible();
		await expect(banner.locator('[data-wf-action="pay-on-delivery"]')).toHaveCount(0);
	});

	test('keyboard: one live status line across idle → checking → stuck; focus stays on Check status, then moves to Retry payment', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		await setup(page, { backend: b, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: '' } } });
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await expect(banner.locator('[role="status"]')).toHaveCount(1);
		await page.evaluate(() => (window.__wfLive = document.querySelector('[data-wf-pending] [role="status"]')));
		const check = banner.locator('[data-wf-pending-check]');
		await check.focus();
		await page.keyboard.press('Enter');
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'checking');
		await expect(check).toBeFocused();
		await expect(check).toHaveAttribute('aria-disabled', 'true');
		await expect(banner.locator('[role="status"]')).toHaveText(`Checking order ${o.number}…`);
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck', { timeout: 20_000 });
		await expect(banner.locator('[data-wf-action="retry-payment"]')).toBeFocused();
		const live = await page.evaluate(() => ({ same: window.__wfLive?.isConnected && window.__wfLive === document.querySelector('[data-wf-pending] [role="status"]'), controls: window.__wfLive?.querySelectorAll('a, button').length, text: window.__wfLive?.textContent }));
		expect(live).toMatchObject({ same: true, controls: 0 });
		expect(live.text).toContain('hasn’t come through yet');
	});

	test('keyboard: an order the server doesn’t know goes away and focus lands on the page heading, not <body>', async ({ page }) => {
		await setup(page, { extra: { wefeasto_pending: { no: 'WF-12345', t: 'x'.repeat(43), at: Date.now(), cartSig: '' } } });
		await page.goto('/cart');
		await hydrated(page);
		const check = page.locator('[data-wf-pending="WF-12345"] [data-wf-pending-check]');
		await check.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
		await expect(page.locator('h1').first()).toBeFocused();
	});

	test('"Check status" polls every 3 s up to 5 times while pending, then offers Retry', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		await setup(page, { backend: b, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: '' } } });
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'checking');
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck', { timeout: 20_000 });
		expect(statusCalls(b)).toBe(5);
	});

	test('an order the server doesn’t know (or a wrong token) is forgotten', async ({ page }) => {
		await setup(page, { extra: { wefeasto_pending: { no: 'WF-12345', t: 'x'.repeat(43), at: Date.now(), cartSig: '' } } });
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator('[data-wf-pending="WF-12345"]');
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveCount(0);
		expect(await readLS(page, 'wefeasto_pending')).toBeNull();
	});

	test('× hides it on this device for good, keeping it (quiet) as the supersede ref; older than 7 days never shows', async ({ page }) => {
		await setup(page, { extra: { wefeasto_pending: { no: 'WF-12345', t: 'x'.repeat(43), at: Date.now(), cartSig: 'muesli:1' } } });
		await page.goto('/cart');
		await hydrated(page);
		await page.locator('.wf-pending-close').click();
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
		// Still this device's proof that the unpaid order is the customer's own (SUP-OWN-1): a checkout of the same bag names it.
		expect(await readLS(page, 'wefeasto_pending')).toMatchObject({ no: 'WF-12345', cartSig: 'muesli:1', quiet: true });
		await page.reload();
		await hydrated(page);
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
		await page.goto('/checkout');
		await checkoutReady(page);
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
		await page.evaluate(() => localStorage.setItem('wefeasto_pending', JSON.stringify({ no: 'WF-12345', t: 'x'.repeat(43), at: Date.now() - 8 * 86400000, cartSig: '' })));
		await page.reload();
		await hydrated(page);
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
	});
});

/*
 * "Pay on delivery instead" everywhere (banner on /cart, /order's failed view): the normal COD checkout,
 * prefilled with the details this tab placed the online order with (same phone), so the backend's
 * supersede cancels the unpaid online order (the mock backend implements the rule: same bag + phone,
 * unpaid online, last 30 minutes). Offered only when COD is available for the bag (the server quote).
 */
test.describe('pending-order banner: "Not now"', () => {
	test('hides the banner on this page only: the order stays on the device, and the same bag replaces it', async ({ page }) => {
		const b = mockBackend();
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'pending_payment' });
		await setup(page, { backend: b, bag: { muesli: 1 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		await page.clock.install();
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		for (let i = 0; i < 6 && (await banner.getAttribute('data-wf-pending-view')) !== 'stuck'; i++) await page.clock.runFor(3100);
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		await banner.locator('[data-wf-action="forget"]').focus();
		await page.keyboard.press('Enter');
		await expect(banner).toHaveCount(0);
		await expect(page.locator('h1')).toBeFocused(); // never dropped to <body>
		expect(await readLS(page, 'wefeasto_pending')).toEqual({ no: o.number, t: o.token, at: expect.any(Number), cartSig: 'muesli:1' });
		await page.goto('/checkout');
		await checkoutReady(page);
		await quoteSettled(page);
		expect(b.last('/store/quote').body.supersede).toEqual({ number: o.number, token: o.token });
	});
});

test.describe('Pay on delivery instead → a COD order that supersedes the online one', () => {
	const codQuoteCalls = (b) => b.calls.filter((c) => c.path === '/store/quote' && c.body?.method === 'cod');

	/** Place an online order for the bag in this tab (Save my details left unticked), then dismiss the payment. */
	async function placeOnlineAndDismiss(page, b) {
		await page.goto('/checkout');
		await checkoutReady(page);
		await fillForm(page);
		await expect(page.locator('#wf-co-save')).not.toBeChecked();
		await quoteSettled(page);
		await payButton(page).click();
		await expect(note(page)).toBeVisible();
		await expect(page.locator('[data-wf-action="try-again"]')).toBeVisible();
		const online = b.order('WF-10001');
		expect(online.status).toBe('pending_payment');
		expect(await readLS(page, 'wefeasto_checkout')).toBeNull(); // nothing saved on the device
		return online;
	}

	async function expectPrefilledCodCheckout(page, online) {
		await page.waitForURL(/\/checkout\?pay=cod$/);
		await checkoutReady(page);
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		for (const [id, v] of [['name', FORM.name], ['phone', FORM.phone], ['email', FORM.email], ['address', FORM.address], ['pin', FORM.pin], ['city', FORM.city], ['state', FORM.state]]) {
			await expect(page.locator(`#wf-co-${id}`)).toHaveValue(v);
		}
		await expect(page.locator('[data-wf-saved]')).toHaveCount(0); // not "saved details": this tab's own order
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'COD_SWITCH');
		await expect(note(page)).toContainText(`It replaces your unpaid order ${online.number}.`);
		await expect(page.locator(`[data-wf-pending="${online.number}"]`)).toHaveCount(0); // its banner steps aside
		await quoteSettled(page);
		await expect(payButton(page)).toHaveText(/^Place order · Pay ₹\d+ on delivery$/);
	}

	async function placeCodAndCheck(page, b, online) {
		await payButton(page).click();
		await page.waitForURL(/\/order\?no=WF-10002&t=/);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		await expect(page.locator('[data-wf-order-method="cod"]')).toBeVisible();
		const cod = b.last('/store/checkout').body;
		expect(cod.method).toBe('cod');
		expect(cod.contact.phone).toBe('+919845262777'); // the same phone → supersede matches
		expect(cod.items).toEqual([{ slug: 'muesli', qty: 1 }]);
		expect(b.order(online.number).status).toBe('cancelled');
		expect(b.order(online.number).supersededBy).toBe('WF-10002');
		expect(await readLS(page, 'wefeasto_pending')).toBeNull();
		await page.goto('/cart');
		await hydrated(page);
		await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
	}

	test('from the /cart banner: dismissed online payment → Pay on delivery instead → prefilled COD checkout → supersede', async ({ page }) => {
		const errors = pageErrors(page);
		const b = await setup(page, { bag: { muesli: 1 }, scenarios: ['dismiss'] });
		const online = await placeOnlineAndDismiss(page, b);
		online.status = 'payment_failed'; // the webhook recorded the failed attempt
		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${online.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		const cod = banner.locator('[data-wf-action="pay-on-delivery"]');
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod');
		expect(codQuoteCalls(b).at(-1).body).toEqual({ items: [{ slug: 'muesli', qty: 1 }], pin: '560001', method: 'cod' });
		await cod.click();
		await expectPrefilledCodCheckout(page, online);
		await placeCodAndCheck(page, b, online);
		expect(errors).toEqual([]);
	});

	test('from /order’s failed view: Pay on delivery instead → prefilled COD checkout → supersede', async ({ page }) => {
		const errors = pageErrors(page);
		const b = await setup(page, { bag: { muesli: 1 }, scenarios: ['dismiss'] });
		const online = await placeOnlineAndDismiss(page, b);
		online.status = 'payment_failed';
		await page.goto(orderLink(online));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		const cod = page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]');
		await expect(cod).toHaveAttribute('href', '/checkout?pay=cod');
		await cod.click();
		await expectPrefilledCodCheckout(page, online);
		await placeCodAndCheck(page, b, online);
		expect(errors).toEqual([]);
	});

	test('dismissed, still unpaid: /order says "Waiting for payment" (never "don’t pay again"), with Pay now and Pay on delivery instead', async ({ page }) => {
		const errors = pageErrors(page);
		const b = await setup(page, { bag: { muesli: 1 }, scenarios: ['dismiss'] });
		const online = await placeOnlineAndDismiss(page, b);
		expect(await readLS(page, 'wefeasto_pending')).toMatchObject({ no: online.number, unpaid: true });
		await page.goto(orderLink(online)); // e.g. /account → View
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'waiting');
		await setScenarios(page, ['success']);
		const w = page.locator('[data-wf-waiting]');
		await expect(w.locator('h2')).toHaveText('Waiting for payment');
		await expect(w).not.toContainText(/Confirming|don’t pay again/);
		await expect(w.locator('[data-wf-action="pay-on-delivery"]')).toHaveAttribute('href', '/checkout?pay=cod');
		const pay = w.locator('[data-wf-action="try-again"]');
		await expect(pay).toHaveText(/^Pay ₹\d+ now$/);
		await pay.click();
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(b.count('/store/checkout/retry')).toBe(1);
		expect(errors).toEqual([]);
	});

	test('from an expired order on /order: offered for the same bag; the COD order goes through', async ({ page }) => {
		const b = mockBackend();
		const expired = b.seedOrder({ items: { muesli: 1 }, status: 'expired' });
		expired.createdAt = new Date(Date.now() - 3 * 3600_000).toISOString();
		await setup(page, { backend: b, bag: { muesli: 1 } });
		await page.goto(orderLink(expired));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		const cod = page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]');
		await cod.click();
		await page.waitForURL(/\/checkout\?pay=cod$/);
		await checkoutReady(page);
		await expect(page.locator('input[value="cod"]')).toBeChecked();
		await expect(page.locator('#wf-co-phone')).toHaveValue(''); // placed elsewhere: nothing in this tab to prefill
		await fillForm(page);
		await quoteSettled(page);
		await payButton(page).click();
		await page.waitForURL(/\/order\?no=WF-10002&t=/);
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'confirmed');
		expect(b.order(expired.number).status).toBe('expired'); // nothing to supersede
	});

	test('COD not available for the bag (server says so) → not offered on /order or in the /cart banner', async ({ page }) => {
		const b = mockBackend({
			hooks: {
				// A server-only refusal (e.g. a blocked PIN): the local quote would say yes.
				'/store/quote': ({ body }) =>
					body?.method === 'cod'
						? { status: 200, contentType: 'application/json', body: JSON.stringify({ quote: { lines: [], issues: [], totalPaise: 29900, codAvailable: false, codUnavailableReason: 'PIN_BLOCKED' } }) }
						: undefined
			}
		});
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await setup(page, { backend: b, bag: { muesli: 1 }, extra: { wefeasto_pending: { no: o.number, t: o.token, at: Date.now(), cartSig: 'muesli:1' } } });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect.poll(() => codQuoteCalls(b).length).toBeGreaterThan(0);
		await expect(page.locator('[data-wf-failed] [data-wf-action="try-again"]')).toBeVisible();
		await expect(page.locator('[data-wf-action="pay-on-delivery"]')).toHaveCount(0);

		await page.goto('/cart');
		await hydrated(page);
		const banner = page.locator(`[data-wf-pending="${o.number}"]`);
		await banner.locator('[data-wf-pending-check]').click();
		await expect(banner).toHaveAttribute('data-wf-pending-view', 'stuck');
		await expect.poll(() => codQuoteCalls(b).length).toBeGreaterThan(1);
		await expect(banner.locator('[data-wf-action="retry-payment"]')).toBeVisible();
		await expect(banner.locator('[data-wf-action="pay-on-delivery"]')).toHaveCount(0);
	});

	test('COD disabled in settings → not offered, and /api down falls back to the local rules', async ({ page }) => {
		const b = mockBackend({
			settings: { codEnabled: false },
			hooks: {
				// the quote can't answer; the live catalog (the local rules' settings) says COD is off
				'/store/quote': ({ body }) => (body?.method === 'cod' ? { status: 503, contentType: 'application/json', body: '{}' } : undefined),
				'/store/catalog': ({ b: be }) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ products: be.catalog(), settings: be.settings() }) })
			}
		});
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await setup(page, { backend: b, bag: { muesli: 1 } });
		await page.goto(orderLink(o));
		await expect(view(page)).toHaveAttribute('data-wf-order-view', 'failed');
		await expect.poll(() => codQuoteCalls(b).length).toBeGreaterThan(0);
		await expect.poll(() => b.count('/store/catalog')).toBeGreaterThan(0); // the fallback read the live settings
		await expect(page.locator('[data-wf-failed] [data-wf-action="try-again"]')).toBeVisible();
		await expect(page.locator('[data-wf-action="pay-on-delivery"]')).toHaveCount(0);
	});

	test('control: /api quote down, COD on in the live settings → the local rules offer it', async ({ page }) => {
		const b = mockBackend({
			hooks: { '/store/quote': ({ body }) => (body?.method === 'cod' ? { status: 503, contentType: 'application/json', body: '{}' } : undefined) }
		});
		const o = b.seedOrder({ items: { muesli: 1 }, status: 'payment_failed' });
		await setup(page, { backend: b, bag: { muesli: 1 } });
		await page.goto(orderLink(o));
		await expect(page.locator('[data-wf-failed] [data-wf-action="pay-on-delivery"]')).toHaveAttribute('href', '/checkout?pay=cod');
	});
});
