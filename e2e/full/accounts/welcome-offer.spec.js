/*
 * Welcome offer applied by link (roadmap S6; retention-backend.md §3; cart.md offer
 * link): the HELLO- code from the welcome email → /cart?offer=CODE → /checkout with the
 * subscriber's email applies 10% (max ₹75, free delivery judged before the discount);
 * another email, a second use, an expired code are refused with copy; an address that
 * already ordered gets the welcome without a code.
 */
import { test, expect, addToCart, gotoCheckout, fillCheckout, waitHydrated } from '../fixtures.js';
import { subscribeAndConfirm } from './helpers.js';

const COPY = {
	EMAIL_MISMATCH: 'That offer belongs to a different email address.',
	EXPIRED: 'That offer has expired.',
	USED: /That offer has been fully claimed\.|That offer is for your first order only\.|You’ve already used that offer\./
};

/** /cart?offer=CODE with `bag` → the cart shows the offer chip and strips the param. */
async function openOfferLink(page, shop, code, bag) {
	await shop.setCart(bag);
	await shop.visit(`/cart?offer=${code}`);
	const chip = page.locator(`#wf-cart-summary [data-wf-offer="${code}"]`);
	await expect(chip).toContainText(`Offer ${code}`);
	await expect(chip).toContainText('will be applied at checkout');
	await expect.poll(() => new URL(page.url()).searchParams.has('offer'), { message: 'offer param stripped' }).toBe(false);
}

/** /checkout filled with `email`; resolves the offer state once the server quote settled. */
async function checkoutWith(page, shop, code, email) {
	await shop.gotoCheckout();
	const form = await shop.fillCheckout({ method: 'cod', email });
	const chip = page.locator(`[data-wf-offer="${code}"][data-wf-offer-state]`);
	await expect(chip).not.toHaveAttribute('data-wf-offer-state', 'pending', { timeout: 15_000 });
	return { form, chip, state: await chip.getAttribute('data-wf-offer-state') };
}

test.describe('welcome offer', () => {
	test('/cart?offer=HELLO-… → checkout with the subscriber email: 10% capped at ₹75 → the order carries it; a second use is refused', async ({ page, shop, admin, api, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer' });
		expect(code).toMatch(/^HELLO-/);
		await openOfferLink(page, shop, code, { muesli: 4 }); // ₹1,000 → 10% = ₹100 → capped at ₹75

		const { chip } = await checkoutWith(page, shop, code, email);
		await expect(chip).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹75');
		const quote = (await api.quote({ items: [{ slug: 'muesli', qty: 4 }], couponCode: code, email, method: 'cod', pin: '560001' })).json.quote;
		expect(quote).toMatchObject({ subtotalPaise: 100000, discountPaise: 7500, deliveryPaise: 0 });

		await page.locator('#wf-place-order').click();
		await shop.waitOrderView(['confirmed']);
		const { number } = shop.orderFromUrl();
		const order = await admin.findOrder(number);
		expect(order.discountPaise).toBe(7500);
		expect(order.totalPaise).toBe(quote.totalPaise);
		expect(JSON.stringify(order)).toContain(code);
		// COD: the use is reserved now (usedCount goes up when the order is paid; limits count both).
		const redemptions = async () => (await admin.ok('GET', `coupon-redemptions?where[code][equals]=${code}&depth=0&limit=10`)).docs;
		expect((await redemptions()).map((r) => ({ order: r.order, status: r.status, discountPaise: r.discountPaise }))).toEqual([
			{ order: order.id, status: 'reserved', discountPaise: 7500 }
		]);

		// Second use by the same address (new bag, same device offer): refused with copy.
		await openOfferLink(page, shop, code, { cornflakes: 1 });
		const again = await checkoutWith(page, shop, code, email);
		expect(again.state).toBe('invalid');
		await expect(again.chip).toContainText(COPY.USED);
		await expect(page.locator('[data-wf-discount]')).toHaveCount(0);
		// The server refuses it too (a client that ignores the chip).
		const direct = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', couponCode: code, form: { email } }).then(
			(o) => o,
			(e) => e
		);
		expect(direct).toBeInstanceOf(Error);
		expect(direct.message).toMatch(/checkout → 4\d\d .*COUPON_INVALID/);
		expect(await redemptions()).toHaveLength(1);
	});

	test('the real journey: the email button in a fresh browser with an empty bag → shop → the offer is waiting at checkout', async ({ stack, api, mailpit, unique, newContext }) => {
		const { email, code, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-journey' });
		const cta = mailpit.extractLinks(welcome).find((l) => l.startsWith(`${stack.sfUrl}/cart?offer=`));
		expect(cta).toBe(`${stack.sfUrl}/cart?offer=${code}`);

		const ctx = await newContext();
		const p = await ctx.newPage();
		
		await p.goto(cta);
		await waitHydrated(p);
		await expect(p.locator('[data-wf-offer-note]')).toHaveCount(0); // a well-formed code: no complaint
		await expect.poll(() => new URL(p.url()).searchParams.has('offer')).toBe(false);
		await addToCart(p, 'choco-flakes', 1);
		await p.goto('/cart');
		await waitHydrated(p);
		await expect(p.locator(`#wf-cart-summary [data-wf-offer="${code}"]`)).toBeVisible();
		await gotoCheckout(p);
		await fillCheckout(p, { method: 'cod', email });
		await expect(p.locator(`[data-wf-offer="${code}"]`)).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(p.locator('[data-wf-discount]')).toHaveText('−₹20'); // 10% of ₹200
	});

	test('a small bag: 10% of ₹250 = ₹25 off, and delivery is still charged on the pre-discount subtotal', async ({ page, shop, api, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-small' });
		await openOfferLink(page, shop, code, { muesli: 1 });
		const { chip } = await checkoutWith(page, shop, code, email);
		await expect(chip).toHaveAttribute('data-wf-offer-state', 'applied');
		await expect(page.locator('[data-wf-discount]')).toHaveText('−₹25');
		const quote = (await api.quote({ items: [{ slug: 'muesli', qty: 1 }], couponCode: code, email, method: 'cod', pin: '560001' })).json.quote;
		expect(quote).toMatchObject({ subtotalPaise: 25000, discountPaise: 2500, deliveryPaise: 4900, totalPaise: 25000 - 2500 + 4900 });
	});

	test('the code is bound to its address: another email at checkout is refused with copy', async ({ page, shop, api, mailpit, unique }) => {
		const { code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-bound' });
		await openOfferLink(page, shop, code, { 'rolled-oats': 2 });
		const other = unique.email('offer-other');
		const { chip, state } = await checkoutWith(page, shop, code, other);
		expect(state).toBe('invalid');
		await expect(chip).toContainText(COPY.EMAIL_MISMATCH);
		await expect(page.locator('[data-wf-discount]')).toHaveCount(0);
		// Removing the offer lets the order go through at full price.
		await chip.locator('.wf-offer-remove').click();
		await expect(page.locator('[data-wf-offer]')).toHaveCount(0);
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		expect(await shop.waitOrderView(['confirmed'])).toBe('confirmed');
	});

	test('first order only, keyed on the phone too: an earlier order from the same mobile → refused at Place order with copy', async ({ page, shop, api, admin, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-phone' });
		const phone = unique.phone();
		const earlier = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', form: { phone } }); // other email, same mobile
		expect(earlier.status).toBe('cod_pending');

		await openOfferLink(page, shop, code, { muesli: 1 });
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'cod', email, phone });
		const res = page.waitForResponse((r) => r.url().endsWith('/api/store/checkout') && r.request().method() === 'POST');
		await page.locator('#wf-place-order').click();
		const r = await res;
		expect(r.status()).toBe(422);
		expect(await r.json()).toMatchObject({ error: { code: 'COUPON_INVALID', details: { reason: 'FIRST_ORDER_ONLY' } } });
		await expect(page.locator('.wf-co-note').first()).toContainText('That offer is for your first order only.');
		await expect(page.locator('.wf-co-note [data-wf-action="remove-offer"]').first()).toBeVisible();
		expect((await admin.ordersByEmail(email)).length, 'no order was created').toBe(0);
	});

	test('the same code in two tabs at once: exactly one order gets it', { tag: '@serial' }, async ({ api, admin, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-race' });
		const tries = await Promise.allSettled(
			[1, 2].map(() => api.placeOrder({ items: { muesli: 1 }, method: 'cod', couponCode: code, form: { email } }))
		);
		const won = tries.filter((t) => t.status === 'fulfilled');
		const lost = tries.filter((t) => t.status === 'rejected');
		expect(won, JSON.stringify(tries.map((t) => t.reason?.message ?? t.value?.number))).toHaveLength(1);
		expect(lost[0].reason.message).toMatch(/checkout → (422|409) .*(COUPON_INVALID|PRICE_CHANGED)/);
		const rows = (await admin.ok('GET', `coupon-redemptions?where[code][equals]=${code}&depth=0&limit=10`)).docs;
		expect(rows.filter((r) => r.status !== 'released')).toHaveLength(1);
	});

	test('the code comes back when its order never completes: an abandoned online order (expired) or a cancelled COD order', async ({ api, admin, db, cron, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-release' });
		const redemption = async (orderId) =>
			(await admin.ok('GET', `coupon-redemptions?where[order][equals]=${orderId}&depth=0&limit=1`)).docs[0]?.status;
		const discount = async () =>
			(await api.quote({ items: [{ slug: 'muesli', qty: 1 }], couponCode: code, email, method: 'cod', pin: '560001' })).json.quote;

		// Online, never paid → expired by the reconcile cron → released.
		const online = await api.placeOrder({ items: { muesli: 1 }, method: 'upi', couponCode: code, form: { email } });
		expect(online.status).toBe('pending_payment');
		const onlineId = (await admin.findOrder(online.number)).id;
		expect(await redemption(onlineId)).toBe('reserved');
		expect((await discount()).couponError?.reason).toBe('USAGE_LIMIT');
		await db.expireReservation(online.number, { minutesAgo: 5 });
		const run = await cron.runReconcile({ order: online.number });
		expect(run.status).toBe(200);
		await expect.poll(async () => (await admin.findOrder(online.number)).status).toBe('expired');
		expect(await redemption(onlineId)).toBe('released');
		expect(await discount()).toMatchObject({ discountPaise: 2500, couponError: null });

		// COD with the code, cancelled by staff → released again.
		const cod = await api.placeOrder({ items: { muesli: 1 }, method: 'cod', couponCode: code, form: { email } });
		const codId = (await admin.findOrder(cod.number)).id;
		expect(await redemption(codId)).toBe('reserved');
		expect((await admin.cancelOrder(cod.number)).status).toBe(200);
		expect(await redemption(codId)).toBe('released');
		expect(await discount()).toMatchObject({ discountPaise: 2500, couponError: null });
	});

	test('an expired code (30 days) is refused with copy', async ({ page, shop, api, db, mailpit, unique }) => {
		const { email, code } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'offer-expired' });
		await db.query("update coupons set ends_at = now() - interval '1 minute' where code = $1", [code]);
		await openOfferLink(page, shop, code, { cornflakes: 1 });
		const { chip, state } = await checkoutWith(page, shop, code, email);
		expect(state).toBe('invalid');
		await expect(chip).toContainText(COPY.EXPIRED);
	});

	test('an address that already has an order gets the welcome email without a code', async ({ api, admin, mailpit, unique }) => {
		const email = unique.email('offer-returning');
		const order = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod', form: { email } });
		await mailpit.waitForMessage({ to: email, subjectIncludes: `Order ${order.number} placed` });
		const { welcome, code } = await subscribeAndConfirm({ api, mailpit, unique }, { email });
		expect(welcome.Subject).toBe("You're in — breakfast ideas inside");
		expect(code).toBeNull();
		expect((await admin.findSubscriber(email)).welcomeCoupon ?? null).toBeNull();
	});
});
