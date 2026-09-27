/*
 * Order emails (roadmap M3, checkout-backend.md §5) through the real mail path (Mailpit):
 * confirmation content (lines, totals, delivery, discount, COD copy, promise, address), its
 * /order link on a fresh device, "on its way" exactly once when an admin ships, and the COD
 * lifecycle cod_pending → cod_confirmed → shipped → delivered (two emails, no more).
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/orders/emails.spec.js
 */
import { test, expect, waitOrderView, waitHydrated } from '../fixtures.js';
import {
	apiOnlineOrder,
	apiCodOrder,
	mockPay,
	waitOrder,
	formatPaise,
	recordOrderPage,
	viewsSeen,
	SUBJECT,
	subjectsTo,
	orderLinkIn,
	cartLinkIn,
	receiptLines,
	htmlText,
	squash,
	logKeys
} from './helpers.js';

const ADDRESS = 'Delivering to: Flat 4B, 12 MG Road, Ashok Nagar, Bengaluru, Karnataka 560001';

/** Every piece of the receipt, in the text part and (as visible text) in the HTML part. */
function expectReceipt(msg, doc) {
	const text = squash(msg.Text);
	const html = htmlText(msg.HTML);
	for (const line of receiptLines(doc)) expect(text, `text part: ${line}`).toContain(squash(line));
	for (const it of doc.items) {
		expect(html).toContain(`${it.name} × ${it.qty} ${formatPaise(it.lineTotalPaise)}`);
	}
	expect(html).toContain(`Subtotal ${formatPaise(doc.subtotalPaise)}`);
	expect(html).toContain(`Delivery ${doc.deliveryPaise > 0 ? formatPaise(doc.deliveryPaise) : 'Free'}`);
	expect(html).toContain(`Total ${formatPaise(doc.totalPaise)}`);
	if (doc.discountPaise > 0) expect(html).toContain(`Discount (${doc.coupon.code}) −${formatPaise(doc.discountPaise)}`);
	for (const part of [text, html]) {
		expect(part).toContain(ADDRESS);
		expect(part).toContain('Ships in 1–2 days · delivered in 3–7 days');
	}
}

/** Open an emailed /order link on a fresh device: confirmed, with this order's lines and total. */
async function expectOrderLinkOpens(newContext, link, doc) {
	const ctx = await newContext();
	const p = await ctx.newPage();
	await p.goto(link);
	await waitHydrated(p);
	expect(await waitOrderView(p, ['confirmed'])).toBe('confirmed');
	await expect(p.locator('#wf-co-order-no')).toContainText(doc.number);
	await expect(p.locator('[data-wf-order-total]')).toHaveText(formatPaise(doc.totalPaise));
	for (const it of doc.items) await expect(p.locator(`[data-wf-order-line="${it.slug}"]`)).toContainText(`× ${it.qty}`);
	await ctx.close();
}

test.describe('confirmation email', { tag: ['@orders', '@emails'] }, () => {
	test('online: one "confirmed" email with lines, discount, delivery fee, total, promise, address, a working /order link and Buy again', async ({
		api,
		mock,
		admin,
		mailpit,
		stack,
		newContext
	}) => {
		const coupon = await admin.createCoupon({ type: 'fixed', value: 5000 });
		const o = await apiOnlineOrder(api, { items: { cornflakes: 2 }, couponCode: coupon.code });
		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		const doc = await waitOrder(admin, o.number, { status: 'paid' });
		expect(doc).toMatchObject({ subtotalPaise: 35000, discountPaise: 5000, deliveryPaise: 4900, totalPaise: 34900, coupon: { code: coupon.code } });

		const msg = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });
		expect(msg.Subject).toBe(SUBJECT.confirmed(o.number));
		expect(await subjectsTo(mailpit, o.form.email)).toEqual([msg.Subject]);
		expect(squash(msg.Text)).toContain(`We've received your payment of ${formatPaise(doc.totalPaise)} for order ${o.number}.`);
		expectReceipt(msg, doc);

		const link = orderLinkIn(mailpit, msg, stack.sfUrl, o.number);
		expect(new URL(link).searchParams.get('t')).toBe(o.token);
		await expectOrderLinkOpens(newContext, link, doc);
		expect(new URL(cartLinkIn(mailpit, msg, stack.sfUrl, 'email')).searchParams.get('add')).toBe('cornflakes:2');
		expect(mailpit.extractLinks(msg).some((l) => l.startsWith('https://wa.me/919845262777?text='))).toBe(true);
		expect(await logKeys(admin, o.number)).toContain(`confirm:${o.number}`);
	});

	test('COD placed through the UI: straight to confirmed, then one "placed — pay on delivery" email with the pay-on-delivery copy', async ({
		page,
		context,
		shop,
		admin,
		mailpit,
		stack,
		newContext
	}) => {
		await recordOrderPage(context);
		const { number, form } = await shop.placeCodOrder({ items: { 'health-mix': 1, 'choco-flakes': 1 } });
		expect((await viewsSeen(page)).filter((v) => v !== 'loading'), 'COD never shows "confirming"').toEqual(['confirmed']);
		const doc = await waitOrder(admin, number, { status: 'cod_pending', paymentMethod: 'cod', stockState: 'committed' });
		const total = formatPaise(doc.totalPaise);
		await expect(page.locator('[data-wf-order-method]')).toHaveAttribute('data-wf-order-method', 'cod');
		await expect(page.locator('[data-wf-order-method]')).toContainText(`Pay ${total} on delivery — cash or UPI`);

		const msg = await mailpit.waitForMessage({ to: form.email, subjectIncludes: SUBJECT.codPlaced(number) });
		expect(await subjectsTo(mailpit, form.email)).toEqual([SUBJECT.codPlaced(number)]);
		for (const part of [squash(msg.Text), htmlText(msg.HTML)]) {
			expect(part).toContain(`Please keep ${total} ready (cash or UPI) when it arrives.`);
			expect(part).not.toContain('received your payment');
		}
		expectReceipt(msg, doc);
		await expectOrderLinkOpens(newContext, orderLinkIn(mailpit, msg, stack.sfUrl, number), doc);
	});
});

test.describe('fulfilment emails', { tag: ['@orders', '@emails', '@stateful'] }, () => {
	test('admin marks a paid order shipped → exactly one "on its way" email; saving again or delivering sends nothing more', async ({
		api,
		mock,
		admin,
		mailpit,
		stack
	}) => {
		const o = await apiOnlineOrder(api, { items: { muesli: 1 } });

		// Not paid yet: it can't be shipped, and nothing is sent.
		const early = await admin.updateOrder(o.number, { fulfilmentStatus: 'shipped' });
		expect(early.status, `shipping an unpaid order: ${JSON.stringify(early.error)}`).toBe(400);

		await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
		await waitOrder(admin, o.number, { status: 'paid' });
		await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.confirmed(o.number) });

		await admin.shipOrder(o.number);
		const shipped = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.shipped(o.number) });
		expect(shipped.Subject).toBe(SUBJECT.shipped(o.number));
		expect(squash(shipped.Text)).toContain(`Order ${o.number} has left our kitchen and is heading to Bengaluru.`);
		expect(squash(shipped.Text)).not.toContain('ready (cash or UPI)');
		orderLinkIn(mailpit, shipped, stack.sfUrl, o.number);

		// Saved again (same status, another field), then delivered.
		expect((await admin.updateOrder(o.number, { fulfilmentStatus: 'shipped' })).status).toBe(200);
		expect((await admin.updateOrder(o.number, { reviewReason: 'e2e: re-saved while shipped' })).status).toBe(200);
		await admin.deliverOrder(o.number);
		await waitOrder(admin, o.number, { fulfilmentStatus: 'delivered', status: 'paid' });

		expect(await subjectsTo(mailpit, o.form.email)).toEqual([SUBJECT.confirmed(o.number), SUBJECT.shipped(o.number)]);
		expect(await logKeys(admin, o.number)).toEqual(expect.arrayContaining([`confirm:${o.number}`, `ship:${o.number}`]));
		const dto = (await api.status(o.number, o.token)).json;
		expect(dto).toMatchObject({ status: 'paid', fulfilmentStatus: 'delivered', isConfirmed: true });
	});

	test('COD lifecycle: cod_pending → admin confirms → ships → delivers: placed + on-its-way (keep ₹X ready) emails only', async ({
		page,
		shop,
		admin,
		api,
		mailpit
	}) => {
		const { number, token, form } = await shop.placeCodOrder({ items: { 'steel-cut-oats': 2 } });
		const doc = await waitOrder(admin, number, { status: 'cod_pending' });
		const total = formatPaise(doc.totalPaise);
		await mailpit.waitForMessage({ to: form.email, subjectIncludes: SUBJECT.codPlaced(number) });

		// Not confirmed by phone yet: can't ship.
		expect((await admin.updateOrder(number, { fulfilmentStatus: 'shipped' })).status).toBe(400);

		const confirmed = await admin.updateOrder(number, { status: 'cod_confirmed' });
		expect(confirmed.status).toBe(200);
		expect((await api.status(number, token)).json).toMatchObject({ status: 'cod_confirmed', isConfirmed: true });

		await admin.shipOrder(number);
		const shipped = await mailpit.waitForMessage({ to: form.email, subjectIncludes: SUBJECT.shipped(number) });
		for (const part of [squash(shipped.Text), htmlText(shipped.HTML)]) {
			expect(part).toContain(`Please keep ${total} ready (cash or UPI) for the delivery partner.`);
		}

		await admin.deliverOrder(number);
		await waitOrder(admin, number, { status: 'cod_confirmed', fulfilmentStatus: 'delivered' });
		expect(await subjectsTo(mailpit, form.email)).toEqual([SUBJECT.codPlaced(number), SUBJECT.shipped(number)]);

		// The customer's /order page follows the server state.
		await shop.visit(`/order?no=${number}&t=${token}`);
		expect(await waitOrderView(page, ['confirmed'])).toBe('confirmed');
		await expect(page.locator('[data-wf-order-method]')).toContainText(`Pay ${total} on delivery — cash or UPI`);
		expect((await api.status(number, token)).json).toMatchObject({ status: 'cod_confirmed', fulfilmentStatus: 'delivered' });
	});
});

test.describe('email safety', { tag: ['@orders', '@emails'] }, () => {
	test('customer-typed name and address are escaped in the order email (no markup injection)', async ({ api, mailpit, unique }) => {
		const email = unique.email('xss');
		const o = await api.placeOrder({
			items: { muesli: 1 },
			method: 'cod',
			form: { email, name: `Zoë <img src=x onerror=alert(1)> O'Brien`, address: `Flat <b>9</b> & Co, "Rose" Villa` }
		});
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.codPlaced(o.number) });
		expect(msg.HTML).not.toContain('<img src=x');
		expect(msg.HTML).not.toContain('<b>9</b>');
		expect(msg.HTML).toContain('Flat &lt;b&gt;9&lt;/b&gt; &amp; Co, &quot;Rose&quot; Villa');
		expect(htmlText(msg.HTML)).toContain('Delivering to: Flat <b>9</b> & Co, "Rose" Villa, Bengaluru, Karnataka 560001');
		expect(squash(msg.Text)).toContain('Delivering to: Flat <b>9</b> & Co, "Rose" Villa, Bengaluru, Karnataka 560001');
	});
});

test.describe('PI-ORD-2 "on its way" email content', { tag: ['@orders', '@emails'] }, () => {
	// Roadmap M3: the confirmation AND the shipped email "both include the /order?no&t link and a /cart?add=
	// 'Buy again' link"; checkout-backend.md §5: "every order email contains the receipt, the shipping
	// promise and the delivery address, a View your order link, Buy these again, WhatsApp help".
	test('PI-ORD-2: the shipped email carries View your order, Buy these again, the receipt, promise and delivery address', async ({ api, admin, mailpit, stack }) => {
		const o = await apiCodOrder(api, { items: { cornflakes: 1, muesli: 1 } });
		await admin.shipOrder(o.number);
		const msg = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.shipped(o.number) });
		const doc = await admin.findOrder(o.number);
		const text = squash(msg.Text);
		const got = {
			orderLink: mailpit.extractLinks(msg).some((l) => l.startsWith(`${stack.sfUrl}/order?`)),
			buyAgain: mailpit.extractLinks(msg).some((l) => l.startsWith(`${stack.sfUrl}/cart?add=`) && l.includes('src=email')),
			receipt: receiptLines(doc).every((line) => text.includes(squash(line))),
			promise: text.includes('Ships in 1–2 days · delivered in 3–7 days'),
			address: text.includes(ADDRESS),
			whatsapp: mailpit.extractLinks(msg).some((l) => l.startsWith('https://wa.me/'))
		};
		expect(got).toEqual({ orderLink: true, buyAgain: true, receipt: true, promise: true, address: true, whatsapp: true });
	});
});

