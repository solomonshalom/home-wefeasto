/*
 * /order (roadmap M3) against the real stack: confirming → confirmed by polling while the payment
 * evidence is late, the celebration and its side effects exactly once per device, and the
 * not-found answer that never tells a wrong token from an unknown order.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/orders/order-page.spec.js
 */
import { test, expect, waitOrderView, waitHydrated, addToCart } from '../fixtures.js';
import {
	apiOnlineOrder,
	apiCodOrder,
	mockPay,
	waitOrder,
	formatPaise,
	recordOrderPage,
	viewsSeen,
	tracked,
	readLocal,
	nextStatusPoll,
	expectCanvasPainted,
	bagOf,
	SUBJECT,
	orderLinkIn
} from './helpers.js';

test.describe('/order confirming → confirmed', { tag: ['@orders', '@stateful'] }, () => {
	test('webhook arrives late: /order keeps confirming (never "confirmed" early), then turns confirmed by itself', async ({ page, context, api, mock, admin }) => {
		await recordOrderPage(context);
		const o = await apiOnlineOrder(api, { items: { cornflakes: 1 } });

		await page.goto(`/order?no=${o.number}&t=${o.token}`);
		await waitHydrated(page);
		expect(await waitOrderView(page, ['confirming'])).toBe('confirming');
		await expect(page.locator('[data-wf-confirming]')).toContainText('please don’t pay again');
		await expect(page.locator('#wf-co-order-no')).toContainText(o.number);

		// Two more polls while the server still says pending_payment: still confirming, no thanks block.
		for (let i = 0; i < 2; i++) {
			const r = await nextStatusPoll(page, o.number);
			expect((await r.json()).status).toBe('pending_payment');
			await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', 'confirming');
			await expect(page.locator('#wf-co-thanks')).toHaveCount(0);
		}

		// The customer's bank confirms; the webhook follows ~300 ms later (E2E_MOCK_WEBHOOK_DELAY_MS).
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		expect(await waitOrderView(page, ['confirmed'], { timeout: 20_000 })).toBe('confirmed');
		expect((await viewsSeen(page)).filter((v) => v !== 'loading')).toEqual(['confirming', 'confirmed']);

		const doc = await waitOrder(admin, o.number, { status: 'paid', paymentStatus: 'captured', paidVia: 'webhook' });
		await expect(page.locator('[data-wf-order-line="cornflakes"]')).toContainText('Cornflakes × 1');
		await expect(page.locator('[data-wf-order-total]')).toHaveText(formatPaise(doc.totalPaise));
		await expect(page.locator('[data-wf-order-method]')).toHaveAttribute('data-wf-order-method', 'online');
	});

	test('webhook never arrives: the status pull asks the gateway and /order confirms without a reload', async ({ page, context, api, mock, admin }) => {
		test.slow(); // the status pull only asks about attempts older than 20 s (checkout-backend.md §1.7)
		await recordOrderPage(context);
		const o = await apiOnlineOrder(api, { items: { 'rolled-oats': 1 } });
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: false });

		await page.goto(`/order?no=${o.number}&t=${o.token}`);
		await waitHydrated(page);
		expect(await waitOrderView(page, ['confirming'])).toBe('confirming');
		// Captured at Razorpay, but nobody told us yet: the server still says pending.
		expect((await admin.findOrder(o.number)).status).toBe('pending_payment');

		expect(await waitOrderView(page, ['confirmed'], { timeout: 60_000 })).toBe('confirmed');
		expect((await viewsSeen(page)).filter((v) => v !== 'loading')).toEqual(['confirming', 'confirmed']);
		await waitOrder(admin, o.number, { status: 'paid', paidVia: 'reconcile' });
	});
});

test.describe('/order failed → confirmed (late authorisation)', { tag: ['@orders', '@stateful'] }, () => {
	test('redirect-mode timeout lands on the failed page ("money unsure"); the bank authorises late, no webhook: the page confirms by itself', async ({
		page,
		context,
		api,
		mock,
		admin
	}) => {
		test.slow(); // the status pull asks the gateway only about attempts older than 20 s
		await recordOrderPage(context);
		const o = await apiOnlineOrder(api, { items: { 'health-mix': 1 } });
		const late = await mockPay(mock, o.rzpOrderId, 'late', { webhook: false, lateAuthDelayMs: 1000 });
		expect(late.ok).toBe(false);
		// This browser is the one that placed it: the storefront writes wefeasto_pending before any payment
		// window opens (redirect mode included), and /order tracks the purchase only there (PI-ORD-3).
		await page.goto('/shop');
		await waitHydrated(page);
		await page.evaluate(({ no, t }) => localStorage.setItem('wefeasto_pending', JSON.stringify({ no, t, at: Date.now(), cartSig: 'health-mix:1' })), {
			no: o.number,
			t: o.token
		});

		await page.goto(`/order?no=${o.number}&t=${o.token}&payment=failed&reason=payment_timed_out`);
		await waitHydrated(page);
		expect(await waitOrderView(page, ['failed'])).toBe('failed');
		await expect(page.locator('[data-wf-fail-copy]')).toHaveAttribute('data-wf-fail-copy', 'unsure');
		await expect(page.locator('[data-wf-late-watch]')).toBeVisible();
		await expect(page.locator('[data-wf-failed]')).not.toContainText('no money was taken');

		expect(await waitOrderView(page, ['confirmed'], { timeout: 60_000 })).toBe('confirmed');
		expect((await viewsSeen(page)).filter((v) => v !== 'loading')).toEqual(['failed', 'confirmed']);
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'first');
		await waitOrder(admin, o.number, { status: 'paid', paidVia: 'reconcile' });
		expect(await tracked(page, 'purchase')).toHaveLength(1);
	});
});

test.describe('/order celebration and side effects, once per device', { tag: ['@orders', '@stateful'] }, () => {
	test('first visit celebrates and writes the side effects; a reload or a second tab replays nothing', async ({ page, context, shop, admin }) => {
		await recordOrderPage(context);
		const { number, token } = await shop.placeOnlineOrder({ items: { muesli: 2 }, auto: 'success' });
		const doc = await waitOrder(admin, number, { status: 'paid' });

		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'first');
		await expect(page.locator('#wf-co-thanks')).toContainText('Order confirmed');
		await expect(page.locator('.wf-order-squiggle svg')).toBeVisible();
		await expectCanvasPainted(page);
		expect(await readLocal(page, `wefeasto_seen_${number}`)).toBeTruthy();
		expect(await readLocal(page, 'wefeasto_pending')).toBeNull();
		const last = await readLocal(page, 'wefeasto_last_order');
		expect(last).toMatchObject({ no: number, t: token, items: { muesli: 2 } });
		expect(await bagOf(page)).toEqual({}); // exactly what was ordered came out of the bag
		const purchases = await tracked(page, 'purchase');
		expect(purchases).toEqual([{ event: 'purchase', number, value: doc.totalPaise / 100, currency: 'INR', method: 'online' }]);

		// Something new goes in the bag after the order; a reload must not touch it again.
		await page.evaluate(() => window.WefeastoCart.add('muesli', 1));
		await page.reload();
		await waitHydrated(page);
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
		await expect(page.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'again');
		expect(await tracked(page, 'purchase')).toEqual([]);
		expect(await bagOf(page)).toEqual({ muesli: 1 });
		expect((await readLocal(page, 'wefeasto_last_order')).at).toBe(last.at);

		// Same device, another tab (e.g. the email link): no celebration, no second subtraction.
		const tab = await context.newPage();
		await tab.goto(`/order?no=${number}&t=${token}`);
		await waitHydrated(tab);
		expect(await waitOrderView(tab, ['confirmed'])).toBe('confirmed');
		await expect(tab.locator('#wf-co-thanks')).toHaveAttribute('data-wf-confirmed', 'again');
		expect(await tracked(tab, 'purchase')).toEqual([]);
		expect(await bagOf(tab)).toEqual({ muesli: 1 });
	});

	test('cart subtraction happens exactly once, keeping what another tab added while the payment was pending', async ({ page, context, shop, admin, mock }) => {
		await recordOrderPage(context);
		// Online payment dismissed: the order is pending, the bag is untouched.
		await shop.placeOnlineOrder({ items: { muesli: 2, cornflakes: 1 }, auto: 'dismiss', expect: null });
		await expect(page.locator('.wf-co-note[data-wf-co-note="DISMISSED"]')).toBeVisible({ timeout: 20_000 });
		const pending = await readLocal(page, 'wefeasto_pending');
		expect(pending?.no).toMatch(/^WF-\d+$/);

		// /order for that number, token from wefeasto_pending. The window was dismissed ("no money was
		// taken"), so this device knows nothing is paying it: "Waiting for payment", never "confirming"
		// (hunt round 4). It keeps a slow look, so a payment made meanwhile still turns it confirmed.
		await page.goto(`/order?no=${pending.no}`);
		await waitHydrated(page);
		expect(await waitOrderView(page, ['waiting', 'confirming'])).toBe('waiting');

		// Meanwhile, in another tab: one more Muesli and a Rolled Oats.
		const other = await context.newPage();
		await addToCart(other, 'muesli', 1);
		await addToCart(other, 'rolled-oats', 1);
		expect(await bagOf(other)).toEqual({ muesli: 3, cornflakes: 1, 'rolled-oats': 1 });

		// The payment lands (the customer finished paying in their UPI app).
		const doc = await admin.findOrder(pending.no);
		await mockPay(mock, doc.razorpay.attempts.at(-1).orderId, 'success', { webhook: true });
		expect(await waitOrderView(page, ['confirmed'], { timeout: 20_000 })).toBe('confirmed');

		const want = { muesli: 1, 'rolled-oats': 1 };
		expect(await bagOf(page)).toEqual(want);
		await expect.poll(() => bagOf(other), { message: 'the other tab sees the subtraction (storage event)' }).toEqual(want);
		await expect(other.locator('.div-block-79 .wf-cart-count')).toHaveText('2');

		await page.reload();
		await waitHydrated(page);
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
		expect(await bagOf(page)).toEqual(want);
	});
});

test.describe('/order not found', { tag: ['@orders'] }, () => {
	test('a wrong token and an unknown number get byte-identical 404s and an identical page', async ({ page, api, stack }) => {
		const o = await apiCodOrder(api, { items: { 'steel-cut-oats': 1 } });
		const wrongToken = o.token.slice(0, -1) + (o.token.endsWith('A') ? 'B' : 'A');
		const unknownNo = 'WF-99999999';

		// API, as the browser reaches it (storefront /api proxy) and straight at the CMS.
		const asks = [
			`store/orders/status?no=${o.number}&t=${wrongToken}`,
			`store/orders/status?no=${unknownNo}&t=${o.token}`,
			`store/orders/status?no=${unknownNo}&t=${wrongToken}`,
			`store/orders/status?no=${o.number}`,
			`store/orders/status?no=nope&t=${o.token}`
		];
		const bodies = [];
		for (const path of asks) {
			const r = await api.get(path);
			expect(r.status, path).toBe(404);
			expect(r.headers.get('content-type'), path).toMatch(/^application\/json/);
			bodies.push(r.text);
			const direct = await fetch(`${stack.cmsUrl}/api/${path}`);
			expect(direct.status, `cms ${path}`).toBe(404);
			bodies.push(await direct.text());
		}
		expect(new Set(bodies).size, `every 404 body is the same bytes: ${[...new Set(bodies)].join(' | ')}`).toBe(1);
		const body = JSON.parse(bodies[0]);
		expect(Object.keys(body)).toEqual(['error']);
		expect(body.error).toEqual({ code: 'NOT_FOUND', message: expect.stringMatching(/^We couldn.t find that order\.$/) });
		expect(bodies[0]).not.toContain(o.number);
		expect((await api.status(o.number, o.token)).status, 'the right token still works').toBe(200);

		// The page: same UI for both, nothing about the real order leaks.
		const texts = [];
		for (const [no, t] of [
			[o.number, wrongToken],
			[unknownNo, o.token]
		]) {
			await page.goto(`/order?no=${no}&t=${t}`);
			await waitHydrated(page);
			expect(await waitOrderView(page, ['notfound'])).toBe('notfound');
			const root = page.locator('[data-wf-order-view]');
			await expect(root.locator('[data-wf-notfound]')).toContainText('We couldn’t find that order');
			await expect(root.locator('[data-wf-whatsapp]')).toHaveAttribute('href', /^https:\/\/wa\.me\//);
			await expect(root.locator('[data-wf-order-line]')).toHaveCount(0);
			texts.push({ text: (await root.innerText()).trim(), html: await root.innerHTML() });
		}
		expect(texts[1].text).toBe(texts[0].text);
		expect(texts[0].text).not.toContain(o.number);
		expect(texts[1].html.replaceAll(unknownNo, '#').replaceAll(o.number, '#')).toBe(texts[0].html.replaceAll(o.number, '#').replaceAll(unknownNo, '#'));
	});
});

test.describe('/order links, token memory and privacy', { tag: ['@orders'] }, () => {
	test('confirmed page: status DTO carries no PII, token never leaks; the token is remembered on this device only', async ({
		page,
		shop,
		newContext
	}) => {
		const statusBodies = [];
		page.on('response', async (r) => {
			if (r.url().includes('/api/store/orders/status')) statusBodies.push({ text: await r.text().catch(() => '') });
		});
		const { number, token, form } = await shop.placeOnlineOrder({ items: { cornflakes: 1 }, auto: 'success' });
		await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
		expect(statusBodies.length).toBeGreaterThan(0);
		const digits = form.phone.replace(/\D/g, '').slice(-10);
		for (const { text } of statusBodies) {
			for (const secret of [form.email, digits, '12 MG Road', form.pin, token]) expect(text, `status DTO leaks ${secret}`).not.toContain(secret);
		}
		const dto = JSON.parse(statusBodies.at(-1).text);
		expect(dto.contact).toEqual({ firstName: 'Asha', emailMasked: expect.stringContaining('•'), phoneMasked: expect.stringMatching(/•/) });
		expect(dto.address).toEqual({ city: 'Bengaluru', state: 'Karnataka' });

		// Same device, link without the token (e.g. typed): remembered from wefeasto_last_order.
		await page.goto(`/order?no=${number}`);
		await waitHydrated(page);
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');

		// Another device without the token: the generic answer that points at the email.
		const ctx = await newContext();
		const p = await ctx.newPage();
		await p.goto(`/order?no=${number}`);
		await waitHydrated(p);
		expect(await waitOrderView(p, ['notfound'])).toBe('notfound');
		await expect(p.locator('[data-wf-notfound]')).toContainText('Open the link from your order email to see this order on this device.');
	});

	test('confirmed page: Buy again refills the bag with the order; the two recipe cards open real recipes', async ({ page, shop, stack }) => {
		const { number } = await shop.placeOnlineOrder({ items: { muesli: 1, 'rolled-oats': 2 }, auto: 'success' });
		expect(await bagOf(page)).toEqual({});
		const cards = page.locator('.wf-order-recipe-grid a.wf-card-cover');
		await expect(cards).toHaveCount(2);
		const hrefs = await cards.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
		for (const href of hrefs) {
			expect(href).toMatch(/^\/recipes\/wf-[a-z0-9-]+$/);
			const res = await fetch(`${stack.sfUrl}${href}`);
			expect(res.status, `${href} for order ${number}`).toBe(200);
		}

		const again = page.locator('[data-wf-buy-again]');
		await expect(again).toHaveAttribute('href', '/cart?add=muesli:1,rolled-oats:2');
		await again.click();
		await page.waitForURL((u) => u.pathname === '/cart');
		await waitHydrated(page);
		await expect.poll(() => bagOf(page)).toEqual({ muesli: 1, 'rolled-oats': 2 });
		await expect(page.locator('.wf-cart-row[data-wf-row]')).toHaveCount(2);

		await page.goto(hrefs[0]);
		await waitHydrated(page);
		await expect(page.locator('h1').first()).toBeVisible();
		await expect(page.locator('text=Page not found')).toHaveCount(0);
	});
});

test.describe('PI-ORD-1 token-bearing responses', { tag: ['@orders'] }, () => {
	// checkout-backend.md §1.5 / §1.7: the status answer and every callback 303 (whose Location carries the
	// guest token) are sent with Referrer-Policy: no-referrer. Under `next start` the cms/next.config.ts
	// headers() table replaces a handler's own value, so that table sets no-referrer for /api/**.
	test('PI-ORD-1: status answers and the redirect-mode callback 303 carry Referrer-Policy: no-referrer', async ({ api, stack }) => {
		const o = await apiCodOrder(api, { items: { cornflakes: 1 } });
		const seen = {};
		seen['status 200 (proxy)'] = (await api.status(o.number, o.token)).headers.get('referrer-policy');
		seen['status 200 (cms)'] = (await fetch(`${stack.cmsUrl}/api/store/orders/status?no=${o.number}&t=${o.token}`)).headers.get('referrer-policy');
		seen['status 404 (cms)'] = (await fetch(`${stack.cmsUrl}/api/store/orders/status?no=WF-99999999&t=${o.token}`)).headers.get('referrer-policy');
		const cb = await fetch(`${stack.cmsUrl}/api/payments/razorpay/callback?no=${o.number}&t=${o.token}`, {
			method: 'POST',
			redirect: 'manual',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'error%5Bcode%5D=BAD_REQUEST_ERROR&error%5Breason%5D=payment_cancelled'
		});
		expect(cb.status).toBe(303);
		expect(cb.headers.get('location')).toContain(`t=${o.token}`);
		seen['callback 303 (cms)'] = cb.headers.get('referrer-policy');
		expect(seen).toEqual(Object.fromEntries(Object.keys(seen).map((k) => [k, 'no-referrer'])));
	});
});

test.describe('PI-ORD-3 /order on a device that did not place the order', { tag: ['@orders'] }, () => {
	// M3's side effects exist to take what was just bought out of the bag it was bought from ("Don't wipe
	// it: items added later in another tab survive"). A device that only opens the emailed /order link
	// never held that bag: its own bag must survive, and the purchase must not be tracked a second time.
	test('PI-ORD-3: opening the emailed /order link on a second device leaves that device’s bag alone and does not re-track the purchase', async ({
		api,
		mailpit,
		stack,
		newContext
	}) => {
		const o = await apiCodOrder(api, { items: { muesli: 2 } });
		const msg = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.codPlaced(o.number) });
		const link = orderLinkIn(mailpit, msg, stack.sfUrl, o.number);

		const laptop = await newContext();
		await recordOrderPage(laptop);
		const p = await laptop.newPage();
		await p.goto('/shop');
		await waitHydrated(p);
		await p.evaluate(() => {
			window.WefeastoCart.add('muesli', 3);
			window.WefeastoCart.add('cornflakes', 1);
		});
		await p.goto(link);
		await waitHydrated(p);
		expect(await waitOrderView(p, ['confirmed'])).toBe('confirmed');
		expect(await readLocal(p, 'wefeasto_last_order'), '"Your usual" still learns the order').toMatchObject({ no: o.number });
		expect({ bag: await bagOf(p), purchases: (await tracked(p, 'purchase')).length }).toEqual({ bag: { muesli: 3, cornflakes: 1 }, purchases: 0 });
	});
});

