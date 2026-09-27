/*
 * Prices and stock move under the customer (razorpay.md §13 A.8, A.10, F.52; roadmap M2 edge cases):
 * the admin changes a price after the quote (PRICE_CHANGED → confirm the new total, never charged
 * silently), two shoppers race for the last pack (exactly one order), and a line above the stock or
 * the per-order limit shows inline with "Reduce to N".
 * These tests change shared product records through `admin` (restored after each test): @stateful.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/stock-price.spec.js
 */
import { test, expect, setCart, gotoCheckout, fillCheckout, setMockAuto, waitOrderView } from '../fixtures.js';
import { COPY, coNote, modal, orderPage, recordCheckoutCalls, quoteSettled, answered } from './helpers.js';

test.describe('price and stock races @stateful', () => {
	test('admin raises the price after the quote → PRICE_CHANGED shows the new total → one more tap pays it', async ({ page, shop, admin, mock }) => {
		await shop.setCart({ muesli: 1 });
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		await expect(page.locator('[data-wf-total]')).toHaveText('₹299');
		await expect(page.locator('#wf-place-order')).toContainText('Pay ₹299');

		await admin.setPrice('muesli', 26_000);
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		const note = coNote(page, 'PRICE_CHANGED');
		await expect(note).toBeVisible();
		await expect(note).toContainText(COPY.priceChanged);
		await answered(calls);
		expect(calls[0].status).toBe(409);
		await expect(page.locator('[data-wf-total]')).toHaveText('₹309');
		await expect(page.locator('#wf-place-order')).toContainText('Pay ₹309');
		await expect(modal.root(page)).toHaveCount(0);
		expect(await admin.ordersByEmail(form.email), 'never charged at a price the customer did not see').toHaveLength(0);

		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();
		expect((await mock.instances(page))[0].options.amount).toBe(30_900);
		await modal.pay(page).click();
		const { number } = await orderPage(page);
		const o = await admin.findOrder(number);
		expect(o.totalPaise).toBe(30_900);
		expect(o.items[0].unitPaise).toBe(26_000);
	});

	test('two shoppers, one pack left: both tap Pay at once → exactly one order; the other sees it sold out', async ({ page, shop, admin, db, newContext }) => {
		const slug = 'rolled-oats';
		await admin.setStock(slug, 1);
		const ctxB = await newContext();
		const pageB = await ctxB.newPage();
		const forms = [];
		for (const p of [page, pageB]) {
			await setCart(p, { [slug]: 1 });
			await setMockAuto(p, { auto: 'success' });
			await gotoCheckout(p);
			forms.push(await fillCheckout(p, { method: 'upi' }));
		}
		const calls = [recordCheckoutCalls(page), recordCheckoutCalls(pageB)];
		await Promise.all([page.locator('#wf-place-order').click(), pageB.locator('#wf-place-order').click()]);
		await expect.poll(() => calls.map((c) => c[0]?.status ?? null).sort(), { message: 'one 201, one 409' }).toEqual([201, 409]);
		const [winner, loser] = calls[0][0].status === 201 ? [page, pageB] : [pageB, page];
		const loserCall = (calls[0][0].status === 201 ? calls[1] : calls[0])[0];
		expect(loserCall.json.error.code).toBe('OUT_OF_STOCK');

		expect(await waitOrderView(winner, ['confirmed'])).toBe('confirmed');
		const issue = loser.locator(`[data-wf-co-issue="OUT_OF_STOCK"][data-wf-co-line="${slug}"]`);
		await expect(issue).toBeVisible();
		await expect(issue).toContainText('Rolled Oats just sold out — remove it to continue.');
		await expect(loser.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'disabled');
		await expect(loser.locator('[data-wf-blocked]')).toBeVisible();

		const orders = [...(await admin.ordersByEmail(forms[0].email)), ...(await admin.ordersByEmail(forms[1].email))];
		expect(orders).toHaveLength(1);
		expect(orders[0].status).toBe('paid');
		expect(await db.stock(slug)).toBe(0);
	});

	test('fewer packs in stock than in the bag → "Only 2 packs left" + Reduce to 2 → pays for 2', async ({ page, shop, admin }) => {
		await admin.setStock('health-mix', 2);
		await shop.setCart({ 'health-mix': 3 });
		await setMockAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		const issue = page.locator('[data-wf-co-issue="OUT_OF_STOCK"][data-wf-co-line="health-mix"]');
		await expect(issue).toContainText('Only 2 packs of Health Mix left — reduce the quantity to continue.');
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'disabled');
		await expect(page.locator('#wf-place-order')).toHaveText(/^\s*Pay securely\s*$/);
		await issue.locator('[data-wf-reduce="health-mix"]').click();
		await expect(page.locator('[data-wf-co-issue]')).toHaveCount(0);
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).items.map((i) => [i.slug, i.qty])).toEqual([['health-mix', 2]]);
	});

	test('per-order limit lowered to 2 → the line says so + Reduce to 2 → pays for 2 (the stock depth is never revealed)', async ({ page, shop, admin, api }) => {
		await admin.updateProduct('cornflakes', { maxPerOrder: 2 });
		const q = await api.quote({ items: [{ slug: 'cornflakes', qty: 3 }] });
		expect(q.json.quote.issues).toEqual([expect.objectContaining({ slug: 'cornflakes', code: 'QTY_LIMIT', max: 2, suggestedQty: 2 })]);
		expect(q.json.quote.issues[0].available, 'stock depth hidden').toBeUndefined();

		await shop.setCart({ cornflakes: 3 });
		await setMockAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		await quoteSettled(page);
		const issue = page.locator('[data-wf-co-issue="QTY_LIMIT"][data-wf-co-line="cornflakes"]');
		await expect(issue).toContainText('You can order up to 2 packs of Cornflakes at a time.');
		await expect(page.locator('#wf-place-order')).toHaveAttribute('data-wf-pay-state', 'disabled');
		await issue.locator('[data-wf-reduce="cornflakes"]').click();
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).items.map((i) => [i.slug, i.qty])).toEqual([['cornflakes', 2]]);
		expect((await admin.findOrder(number)).totalPaise, '2 × ₹175 + ₹49 delivery').toBe(39_900);
	});
});
