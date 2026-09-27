/*
 * Reordering (roadmap M5): wefeasto_last_order → "Your usual" on /shop, in the empty /cart and on
 * home, priced at TODAY's prices; and the confirmation email's "Buy these again" link
 * (/cart?add=…&src=email), which tops the bag up once however often it is opened and attributes
 * the next order to the email.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/orders/reorder.spec.js
 */
import { test, expect, waitHydrated, placeCodOrder } from '../fixtures.js';
import { apiCodOrder, waitOrder, formatPaise, recordOrderPage, cartAdds, readLocal, bagOf, SUBJECT, cartLinkIn } from './helpers.js';

const usualBox = (page, variant) => page.locator(`[data-wf-usual="${variant}"]`);

/** Tap "Add all"/"Add the rest" and check the one merged add (source 'usual'). */
async function tapUsual(page, variant, { label, bag, added }) {
	const box = usualBox(page, variant);
	await expect(box.locator('[data-wf-usual-add]')).toHaveText(label);
	const before = (await cartAdds(page)).length;
	await box.locator('[data-wf-usual-add]').click();
	await expect.poll(() => bagOf(page), { message: `bag after "${label}" (${variant})` }).toEqual(bag);
	const adds = (await cartAdds(page)).slice(before);
	expect(adds, 'one wf:cart-add for the whole usual').toHaveLength(1);
	expect(adds[0]).toMatchObject({ source: 'usual', qty: added });
	await expect(box, 'the usual is in the bag now: the card goes').toHaveCount(0);
}

test.describe('Your usual', { tag: ['@orders', '@stateful'] }, () => {
	test('after a paid order: /shop, the empty /cart and home offer the usual at today’s prices; Add all adds exactly it', async ({ page, context, shop, admin, api }) => {
		await recordOrderPage(context);
		const { number, token } = await shop.placeOnlineOrder({ items: { cornflakes: 2, muesli: 1 }, auto: 'success' });
		await waitOrder(admin, number, { status: 'paid' });
		expect(await readLocal(page, 'wefeasto_last_order')).toMatchObject({ no: number, t: token, items: { cornflakes: 2, muesli: 1 } });
		expect(await bagOf(page)).toEqual({});

		// Muesli costs more today than when it was ordered: the usual shows the current total.
		const muesli = await admin.getProduct('muesli');
		const corn = await admin.getProduct('cornflakes');
		const newMuesli = muesli.pricePaise + 1000;
		await admin.setPrice('muesli', newMuesli);
		await expect.poll(async () => (await api.get('store/catalog')).json?.products?.find((p) => p.slug === 'muesli')?.pricePaise).toBe(newMuesli);
		await context.route('**/api/store/catalog*', (r) => r.continue()); // routing disables the HTTP cache (max-age=15)

		const full = formatPaise(2 * corn.pricePaise + newMuesli);

		// /shop
		await shop.visit('/shop');
		await expect(usualBox(page, 'shop')).toContainText('Your usual: Cornflakes ×2 · Muesli ×1');
		await tapUsual(page, 'shop', { label: `Add all · ${full}`, bag: { cornflakes: 2, muesli: 1 }, added: 3 });
		await expect(page.locator('.div-block-79 .wf-cart-count')).toHaveText('3');

		// The bag already holds part of the usual: only the rest is offered and added.
		await page.evaluate(() => {
			window.WefeastoCart.clear();
			window.WefeastoCart.add('cornflakes', 1);
		});
		await shop.visit('/shop');
		await tapUsual(page, 'shop', { label: `Add the rest · ${formatPaise(corn.pricePaise + newMuesli)}`, bag: { cornflakes: 2, muesli: 1 }, added: 2 });

		// The empty bag.
		await page.evaluate(() => window.WefeastoCart.clear());
		await shop.visit('/cart');
		await expect(page.locator('.wf-cart-empty')).toBeVisible();
		await expect(usualBox(page, 'cart')).toContainText('Cornflakes ×2 · Muesli ×1');
		await tapUsual(page, 'cart', { label: `Add all · ${full}`, bag: { cornflakes: 2, muesli: 1 }, added: 3 });
		await expect(page.locator('.wf-cart-row[data-wf-row]')).toHaveCount(2);
		await expect(page.locator('#wf-qty-cornflakes')).toHaveValue('2');
		await expect(page.locator('#wf-qty-muesli')).toHaveValue('1');

		// Home, inside "Shop Bestsellers" (never above the hero).
		await page.evaluate(() => window.WefeastoCart.clear());
		await shop.visit('/');
		await expect(page.locator('#bestsellers [data-wf-usual="home"]')).toBeVisible();
		await tapUsual(page, 'home', { label: `Add all · ${full}`, bag: { cornflakes: 2, muesli: 1 }, added: 3 });
	});
});

test.describe('Buy these again (email link)', { tag: ['@orders', '@stateful'] }, () => {
	test('the confirmation email’s /cart?add=…&src=email link adds the order once, even opened twice, and attributes the next order', async ({
		api,
		mailpit,
		stack,
		admin,
		newContext
	}) => {
		const o = await apiCodOrder(api, { items: { cornflakes: 2, muesli: 1 } });
		const msg = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.codPlaced(o.number) });
		const link = cartLinkIn(mailpit, msg, stack.sfUrl, 'email');
		const u = new URL(link);
		expect(u.pathname).toBe('/cart');
		expect(u.searchParams.get('add')).toBe('cornflakes:2,muesli:1');

		// A fresh device (email app → browser).
		const ctx = await newContext();
		const p = await ctx.newPage();
		await p.goto(link);
		await waitHydrated(p);
		await expect.poll(() => bagOf(p)).toEqual({ cornflakes: 2, muesli: 1 });
		await expect.poll(() => new URL(p.url()).search, { message: 'add/src stripped from the URL' }).toBe('');
		expect(await p.evaluate(() => JSON.parse(sessionStorage.getItem('wefeasto_src'))?.src)).toBe('email');
		await expect(p.locator('.wf-cart-row[data-wf-row]')).toHaveCount(2);

		// Opened again (same tab), refreshed, and opened in a second tab: nothing more is added.
		await p.goto(link);
		await waitHydrated(p);
		await expect.poll(() => new URL(p.url()).search).toBe('');
		expect(await bagOf(p)).toEqual({ cornflakes: 2, muesli: 1 });
		await p.reload();
		await waitHydrated(p);
		expect(await bagOf(p)).toEqual({ cornflakes: 2, muesli: 1 });
		const p2 = await ctx.newPage();
		await p2.goto(link);
		await waitHydrated(p2);
		await expect.poll(() => new URL(p2.url()).search).toBe('');
		expect(await bagOf(p2)).toEqual({ cornflakes: 2, muesli: 1 });
		await p2.close();

		// The reorder carries src=email to the order's source.
		const again = await placeCodOrder(p, {});
		expect(again.number).not.toBe(o.number);
		const doc = await waitOrder(admin, again.number, { status: 'cod_pending' });
		expect(doc.source).toBe('email');
		expect(doc.items.map((i) => [i.slug, i.qty])).toEqual([
			['cornflakes', 2],
			['muesli', 1]
		]);
	});
});

test.describe('reordering something that sold out since', { tag: ['@orders', '@stateful'] }, () => {
	test('Your usual leaves a sold-out line out (live stock) and adds only the rest', async ({ page, context, shop, admin }) => {
		await recordOrderPage(context);
		const { number } = await shop.placeOnlineOrder({ items: { cornflakes: 2, 'rolled-oats': 1 }, auto: 'success' });
		await waitOrder(admin, number, { status: 'paid' });
		const corn = await admin.getProduct('cornflakes');
		await admin.setStock('rolled-oats', 0);
		await context.route('**/api/store/catalog*', (r) => r.continue()); // no HTTP cache: see today's stock

		const live = page.waitForResponse((r) => r.url().includes('/api/store/catalog') && r.status() === 200);
		await shop.visit('/shop');
		const body = await (await live).json();
		expect(body.products.find((p) => p.slug === 'rolled-oats')?.inStock, 'the live catalog says sold out').toBe(false);
		await expect(usualBox(page, 'shop')).toContainText('Your usual: Cornflakes ×2');
		await expect(usualBox(page, 'shop')).not.toContainText('Rolled Oats');
		await tapUsual(page, 'shop', { label: `Add all · ${formatPaise(2 * corn.pricePaise)}`, bag: { cornflakes: 2 }, added: 2 });
	});

	test('an emailed Buy again link with a sold-out product: the bag never charges for it (dropped, or flagged and left out of the total)', async ({
		api,
		admin,
		mailpit,
		stack,
		newContext
	}) => {
		const o = await apiCodOrder(api, { items: { 'rolled-oats': 1, muesli: 1 } });
		const msg = await mailpit.waitForMessage({ to: o.form.email, subjectIncludes: SUBJECT.codPlaced(o.number) });
		const link = cartLinkIn(mailpit, msg, stack.sfUrl, 'email');
		const muesli = await admin.getProduct('muesli');
		await admin.setStock('rolled-oats', 0);

		const ctx = await newContext();
		await ctx.route('**/api/store/catalog*', (r) => r.continue());
		const p = await ctx.newPage();
		await p.goto(link);
		await waitHydrated(p);
		await expect(p.locator('.wf-cart-row[data-wf-row="muesli"]')).toBeVisible();
		// Subtotal = muesli only; below the free-delivery threshold → the fee applies.
		await expect(p.locator('[data-wf-subtotal]')).toHaveText(formatPaise(muesli.pricePaise));
		await expect(p.locator('[data-wf-total]')).toHaveText(formatPaise(muesli.pricePaise + 4900));
		const oats = p.locator('.wf-cart-row[data-wf-row="rolled-oats"]');
		if (await oats.count()) {
			await expect(oats.locator('[data-wf-issue]')).toHaveAttribute('data-wf-issue', /OUT_OF_STOCK|UNAVAILABLE/);
		} else {
			await expect(p.locator('[data-wf-link-dropped]')).toContainText('Rolled Oats is out of stock right now');
		}
	});
});

