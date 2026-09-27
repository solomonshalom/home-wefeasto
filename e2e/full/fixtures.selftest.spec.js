/*
 * Self-test of the full-stack fixtures: every fixture and helper once, against the real
 * stack. If this file fails, fix the harness before trusting any domain spec.
 *
 *   E2E_SLOT=0 npx playwright test --project=full e2e/full/fixtures.selftest.spec.js
 */
import { test, expect, SLOT, readCart } from './fixtures.js';
import { AdminClient } from './support/admin.js';

const poll = (fn, message, timeout = 20_000) => expect.poll(fn, { message, timeout });
/** What the admin test leaves changed for the fixture to restore (checked by the next test). */
const leftBehind = {};

test.describe('stack, api, unique', () => {
	test('stack state, store api and unique data', async ({ stack, api, unique }) => {
		expect(stack).toMatchObject({ slot: SLOT, status: 'ready', cmsUrl: `http://localhost:${3700 + SLOT}`, sfUrl: `http://localhost:${4700 + SLOT}` });
		expect(stack.dbUri).toContain(`/wefeasto_e2e_${SLOT}`);
		expect(stack.admin.email).toBe('e2e-admin@wefeasto.test');

		const e1 = unique.email('a b');
		const e2 = unique.email('a b');
		expect(e1).not.toBe(e2);
		expect(e1).toMatch(new RegExp(`^a-b-[a-z0-9]+-s${SLOT}@e2e\\.wefeasto\\.test$`));
		expect(unique.phone()).toMatch(/^9\d{9}$/);
		expect(unique.phone({ e164: true })).toMatch(/^\+919\d{9}$/);
		expect(unique.pin()).toBe('560001');
		expect(unique.code()).toMatch(new RegExp(`^E2E${SLOT}[0-9A-F]{8}$`));

		const q = await api.quote({ items: [{ slug: 'muesli', qty: 2 }], pin: unique.pin(), method: 'cod' });
		expect(q.status).toBe(200);
		expect(q.json.quote.subtotalPaise).toBeGreaterThan(0);
	});
});

test.describe('admin', () => {
	test('setStock / setPrice / restoreProduct, and restoreAll puts everything back', async ({ admin, adminSession, db, api }) => {
		const before = await admin.getProduct('rolled-oats');
		expect(await db.stock('rolled-oats')).toBe(before.stock);

		await admin.setStock('rolled-oats', 3);
		expect(await db.stock('rolled-oats')).toBe(3);
		await admin.setPrice('rolled-oats', before.pricePaise + 1000);
		const q = await api.quote({ items: [{ slug: 'rolled-oats', qty: 1 }] });
		expect(q.json.quote.subtotalPaise).toBe(before.pricePaise + 1000);

		const restored = await admin.restoreProduct('rolled-oats');
		expect(restored).toMatchObject({ stock: before.stock, pricePaise: before.pricePaise });
		expect(await db.stock('rolled-oats')).toBe(before.stock);
		expect((await admin.adjustStock('rolled-oats', -2)).stock).toBe(before.stock - 2);
		await admin.restoreProduct('rolled-oats');
		expect(await db.stock('rolled-oats')).toBe(before.stock);

		// restoreAll (what the fixture runs after every test), on a private client.
		const other = new AdminClient(adminSession);
		const settings = await other.getSettings();
		await other.setStock('health-mix', 1);
		await other.updateSettings({ codEnabled: !settings.codEnabled, shippingPromiseText: 'selftest promise' });
		const coupon = await other.createCoupon({ value: 15 });
		expect(coupon.code).toMatch(/^E2E/);
		expect((await other.getCoupon(coupon.code))?.value).toBe(15);
		await other.restoreAll();
		expect((await admin.getProduct('health-mix')).stock).toBe((await db.stock('health-mix')));
		expect(await db.stock('health-mix')).not.toBe(1);
		const after = await admin.getSettings();
		expect({ codEnabled: after.codEnabled, shippingPromiseText: after.shippingPromiseText }).toEqual({
			codEnabled: settings.codEnabled,
			shippingPromiseText: settings.shippingPromiseText
		});
		expect(await admin.getCoupon(coupon.code)).toBeNull();

		// And the fixture's own client restores what this test leaves changed.
		leftBehind.stock = await db.stock('steel-cut-oats');
		leftBehind.promise = (await admin.getSettings()).shippingPromiseText;
		await admin.setStock('steel-cut-oats', 2);
		await admin.updateSettings({ shippingPromiseText: 'left for the fixture' });
	});

	test('the previous test left nothing changed', async ({ admin, db }) => {
		test.skip(leftBehind.stock === undefined, 'runs after the restoreAll test');
		expect(await db.stock('steel-cut-oats')).toBe(leftBehind.stock);
		expect((await admin.getSettings()).shippingPromiseText).toBe(leftBehind.promise);
	});

	test('orders: findOrder, ship, deliver, cancel; subscribers and customers', async ({ admin, api, db, unique }) => {
		const a = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
		expect(a.number).toMatch(/^WF-\d+$/);
		expect(await admin.findOrder(a.number)).toMatchObject({ status: 'cod_pending', fulfilmentStatus: 'unfulfilled' });
		expect((await admin.ordersByEmail(a.form.email)).map((o) => o.number)).toEqual([a.number]);
		expect(await admin.shipOrder(a.number)).toMatchObject({ status: 'cod_confirmed', fulfilmentStatus: 'shipped' });
		expect(await admin.deliverOrder(a.number)).toMatchObject({ fulfilmentStatus: 'delivered' });

		const stock0 = await db.stock('choco-flakes');
		const b = await api.placeOrder({ items: { 'choco-flakes': 2 }, method: 'cod' });
		expect(await db.stock('choco-flakes')).toBe(stock0 - 2);
		const c = await admin.cancelOrder(b.number);
		expect(c.status).toBe(200);
		expect(c.doc.status).toBe('cancelled');
		expect(await db.stock('choco-flakes')).toBe(stock0);
		const bad = await admin.updateOrder(b.number, { status: 'cod_confirmed' });
		expect(bad.status).toBe(400);

		const email = unique.email('sub');
		expect((await api.newsletter(email)).status).toBe(200);
		// The endpoint stores the row after answering (Next after()): poll.
		await poll(async () => (await admin.findSubscriber(email))?.status, 'subscriber row').toBe('pending');
		expect((await admin.listSubscribers()).length).toBeGreaterThan(0);
		expect(await admin.findCustomer(email)).toBeNull();
	});
});

test.describe('db time travel + cron', () => {
	test('expireReservation + cron.runReconcile expires an unpaid online order and releases its stock', async ({ api, db, cron, admin }) => {
		const stock0 = await db.stock('muesli');
		const o = await api.placeOrder({ items: { muesli: 2 }, method: 'upi' });
		expect(o.status).toBe('pending_payment');
		expect(o.payment?.razorpayOrderId).toMatch(/^order_/);
		expect(await db.stock('muesli')).toBe(stock0 - 2);

		// Not due yet: a targeted reconcile leaves it alone.
		const early = await cron.runReconcile({ order: o.number });
		expect(early.status).toBe(200);
		expect(early.json).toMatchObject({ ok: true, expired: 0 });
		expect((await db.order(o.number)).status).toBe('pending_payment');

		const until = await db.expireReservation(o.number, { minutesAgo: 5 });
		expect(new Date(until).getTime()).toBeLessThan(Date.now());
		const r = await cron.runReconcile({ order: o.number });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, expired: 1 });
		expect(await admin.findOrder(o.number)).toMatchObject({ status: 'expired' });
		expect(await db.stock('muesli')).toBe(stock0);

		expect((await cron.runReconcile({ order: 'WF-99999999' })).status).toBe(404);
		const created = await db.backdateOrder(o.number, { minutes: 60 });
		expect(new Date(created).getTime()).toBeLessThan(Date.now() - 59 * 60_000);
	});

	test('cron.runJobs + db.jobs / makeJobsDue', async ({ cron, db }) => {
		const r = await cron.runJobs();
		expect(r.status, r.text.slice(0, 200)).toBe(200);
		const jobs = await db.jobs();
		expect(Array.isArray(jobs)).toBe(true);
		expect(await db.makeJobsDue({ orderNumber: 'WF-NOPE' })).toEqual([]);
		const unauth = await fetch(`${cron.cmsUrl}/api/payments/reconcile`);
		expect(unauth.status).toBe(401);
	});
});

test.describe('mailpit', () => {
	test('waitForMessage, messages, extractLinks, headers, settle, cleanup', async ({ api, mailpit, unique }) => {
		const email = unique.email('mp');
		expect(await mailpit.messages(email)).toEqual([]);
		expect((await api.newsletter(email)).status).toBe(200);
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: /confirm your wefeasto/i });
		expect(msg.To[0].Address).toBe(email);
		const links = mailpit.extractLinks(msg);
		expect(links.some((l) => l.includes('/newsletter/confirm?t='))).toBe(true);
		expect(links.every((l) => !l.includes('&amp;'))).toBe(true);
		expect(Object.keys(await mailpit.headers(msg.ID))).toContain('Subject');
		expect((await mailpit.settle(email, { quietMs: 1000 })).length).toBe(1);
		await expect(mailpit.waitForMessage({ to: email, subjectIncludes: 'never sent', timeout: 600 })).rejects.toThrow(/expected 1 message/);
		expect(await mailpit.cleanup(email)).toBe(1);
		expect(await mailpit.messages(email)).toEqual([]);
	});
});

test.describe('mock gateway over HTTP', () => {
	test('mock.pay: fail, then success settles the order through the webhook', async ({ api, mock }) => {
		const o = await api.placeOrder({ items: { 'steel-cut-oats': 1 }, method: 'upi' });
		const rzp = o.payment.razorpayOrderId;
		const f = await mock.pay(rzp, 'fail', { reason: 'insufficient_funds', webhook: false });
		expect(f.status).toBe(200);
		expect(f.json).toMatchObject({ ok: false, error: { reason: 'insufficient_funds' } });
		const s = await mock.pay(rzp, 'success', { method: 'upi' });
		expect(s.json).toMatchObject({ ok: true, response: { razorpay_order_id: rzp } });
		await poll(async () => (await api.status(o.number, o.token)).json?.status, 'status after the webhook').toBe('paid');
		expect((await mock.pay('order_MockNOPE000000', 'success')).status).toBe(404);
	});

	test('fault injection hook (POST /api/payments/mock/fault)', async ({ mock, api }) => {
		const available = await mock.faultsAvailable();
		test.info().annotations.push({ type: 'gap', description: `mock fault endpoint available: ${available}` });
		test.skip(!available, 'MockGateway.failNext has no HTTP hook yet (reported to cms-checkout; see e2e-harness.md)');
		await mock.failNext('createOrder', 'network');
		// Consume the armed fault: the checkout answers 503 and keeps the order for a retry.
		await expect(api.placeOrder({ items: { cornflakes: 1 }, method: 'upi' })).rejects.toThrow(/→ 503/);
	});
});

/** The online order the checkout remembered before opening the payment window. */
const pendingOrder = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_pending') || 'null'));
const note = (page) => page.locator('.wf-co-note[data-wf-co-note]');

test.describe('mock checkout auto modes (UI)', () => {
	test('success (card) → /order confirmed', async ({ shop, admin }) => {
		const r = await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'success', method: 'card' });
		expect(r.view).toBe('confirmed');
		expect(await admin.findOrder(r.number)).toMatchObject({ status: 'paid', requestedMethod: 'card', razorpay: { method: 'card' } });
	});

	test('fail → FAILED note on /checkout, order stays unpaid', async ({ page, shop, mock, db }) => {
		await shop.placeOnlineOrder({ items: { cornflakes: 1 }, auto: 'fail', reason: 'card_declined', expect: null });
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'FAILED');
		const [inst] = await mock.instances(page);
		expect(inst.events).toEqual(expect.arrayContaining(['open', 'payment.failed', 'ondismiss']));
		expect(inst.options.key).toMatch(/^rzp_test_/);
		const p = await pendingOrder(page);
		expect(inst.options.order_id).toMatch(/^order_Mock/);
		await poll(async () => (await db.order(p.no))?.status, 'order after a failed attempt').toBe('payment_failed');
	});

	test('fail_then_success → /order confirmed after an in-modal retry', async ({ page, shop, admin }) => {
		const r = await shop.placeOnlineOrder({ items: { 'rolled-oats': 1 }, auto: 'fail_then_success' });
		expect(r.view).toBe('confirmed');
		const o = await admin.findOrder(r.number);
		expect(o.status).toBe('paid');
		expect(o.razorpay.payments.map((p) => p.status).sort()).toEqual(['captured', 'failed']);
	});

	test('dismiss → DISMISSED note, order pending_payment', async ({ page, shop, mock, db }) => {
		await shop.placeOnlineOrder({ items: { cornflakes: 1 }, auto: 'dismiss', expect: null });
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'DISMISSED');
		expect((await mock.instances(page))[0].events).toEqual(expect.arrayContaining(['open', 'dismiss', 'ondismiss']));
		const p = await pendingOrder(page);
		expect((await db.order(p.no)).status).toBe('pending_payment');
	});

	test('lost → no handler, the webhook confirms and the page lands on /order confirmed', async ({ page, shop, mock }) => {
		await shop.placeOnlineOrder({ items: { 'health-mix': 1 }, auto: 'lost', expect: null });
		const { events } = await mock.waitForEvent(page, 'lost');
		expect(events).not.toContain('handler');
		expect(await shop.waitOrderView(['confirmed'], { timeout: 30_000 })).toBe('confirmed');
	});

	test('silent → OPEN_FAILED note from the 15 s watchdog', async ({ page, shop, mock }) => {
		test.setTimeout(60_000);
		await shop.placeOnlineOrder({ items: { cornflakes: 1 }, auto: 'silent', expect: null });
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'OPEN_FAILED', { timeout: 25_000 });
		const [inst] = await mock.instances(page);
		expect(inst.silent).toBeTruthy();
		expect(inst.events).toContain('open');
	});

	test('late → FAILED (money unsure), then /order turns confirmed without a reload', async ({ page, shop, stack }) => {
		test.setTimeout(90_000);
		await shop.placeOnlineOrder({ items: { 'choco-flakes': 1 }, auto: 'late', expect: null });
		await expect(note(page)).toHaveAttribute('data-wf-co-note', 'FAILED');
		await expect(note(page)).toContainText('If any money left your account');
		const p = await pendingOrder(page);
		await page.goto(`/order?no=${p.no}&t=${encodeURIComponent(p.t)}`);
		// Webhooks after MOCK_LATE_AUTH_DELAY_MS (stack.mock.lateAuthDelayMs) turn it paid; /order keeps looking.
		expect(await shop.waitOrderView(['confirmed'], { timeout: stack.mock.lateAuthDelayMs + 30_000 })).toBe('confirmed');
	});
});

test.describe('page helpers + variants', () => {
	test('normal: setCart (localStorage) → /cart, addToCart via the PDP', async ({ page, shop }) => {
		await shop.setCart({ muesli: 1, 'rolled-oats': 2 });
		await shop.gotoCart();
		expect(await shop.readCart()).toEqual({ muesli: 1, 'rolled-oats': 2 });
		await shop.addToCart('cornflakes', 3);
		expect(await shop.cartCount()).toBe(6);
		expect(await readCart(page)).toEqual({ muesli: 1, 'rolled-oats': 2, cornflakes: 3 });
		expect(shop.variant()).toBe('normal');
	});

	test.describe('storage-throws', () => {
		test.use({ variant: 'storage-throws' });

		test('Storage throws; bag in memory via the PDP; COD order through the UI', async ({ page, shop, admin }) => {
			await page.goto('/');
			await shop.waitHydrated();
			const probe = await page.evaluate(() => {
				try {
					localStorage.setItem('x', '1');
					return 'wrote';
				} catch (e) {
					return String(e.message);
				}
			});
			expect(probe).toMatch(/quota/i);
			await shop.addToCart('muesli', 2);
			await shop.addToCart('cornflakes');
			expect(await shop.readCart()).toEqual({ muesli: 2, cornflakes: 1 });
			const r = await shop.placeCodOrder();
			expect(r.view).toBe('confirmed');
			const o = await admin.findOrder(r.number);
			expect(o.items.map((i) => [i.slug, i.qty]).sort()).toEqual([
				['cornflakes', 1],
				['muesli', 2]
			]);
		});

		test('setCart via the /cart?add= deep link, online order', async ({ shop }) => {
			await shop.setCart({ 'steel-cut-oats': 2 });
			expect(await shop.readCart()).toEqual({ 'steel-cut-oats': 2 });
			const r = await shop.placeOnlineOrder({ auto: 'success' });
			expect(r.view).toBe('confirmed');
		});
	});

	test.describe('nofx', () => {
		test.use({ variant: 'nofx' });

		test('every storefront goto carries ?nofx=1', async ({ page, shop, newContext, stack }) => {
			await page.goto('/shop');
			expect(new URL(page.url()).searchParams.get('nofx')).toBe('1');
			await shop.addToCart('health-mix');
			expect(new URL(page.url()).searchParams.get('nofx')).toBe('1');
			// newContext() applies the variant too (and its own override).
			const ctx = await newContext();
			const p2 = await ctx.newPage();
			await p2.goto(`${stack.sfUrl}/recipes`);
			expect(new URL(p2.url()).searchParams.get('nofx')).toBe('1');
			const plain = await (await newContext({ variant: 'normal' })).newPage();
			await plain.goto('/recipes');
			expect(new URL(plain.url()).searchParams.has('nofx')).toBe(false);
		});
	});
});

test.describe('console error collector', () => {
	test('collects page errors and console.error; /api 4xx and allow() patterns are ignored', async ({ page, shop, consoleErrors, newContext }) => {
		consoleErrors.allow('selftest: allowed noise');
		await shop.visit('/');
		await page.evaluate(async () => {
			console.error('selftest: allowed noise');
			await fetch('/api/store/orders/status?no=WF-1&t=nope');
			setTimeout(() => {
				throw new Error('selftest boom');
			});
		});
		await expect.poll(() => consoleErrors.list().map((e) => e.text).join('\n')).toContain('selftest boom');
		expect(consoleErrors.list()).toHaveLength(1);
		expect(consoleErrors.ignoredCount).toBeGreaterThanOrEqual(2);

		// Extra contexts report to the same collector; a failed static asset counts.
		const p2 = await (await newContext()).newPage();
		await p2.goto('/');
		await p2.evaluate(() => {
			const img = document.createElement('img');
			img.src = '/selftest-missing.png';
			document.body.appendChild(img);
		});
		await expect.poll(() => consoleErrors.list().length).toBe(2);
		consoleErrors.clear(); // otherwise the gate would (rightly) fail this test
	});
});
