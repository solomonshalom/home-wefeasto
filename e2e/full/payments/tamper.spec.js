/*
 * The server price wins (roadmap M2 acceptance "Tampered localStorage cannot change the price";
 * razorpay.md §13 A.1–A.6, A.13): a hand-edited bag is sanitised by the page, and a hand-edited
 * checkout request can't change what is charged — price fields are ignored, a wrong expected total is
 * a 409 PRICE_CHANGED with the real quote, bad slugs / quantities are refused before any stock moves.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/tamper.spec.js
 */
import { test, expect } from '../fixtures.js';
import { COPY, coNote, modal, recordCheckoutCalls, orderPage, serverTotal, rupees, answered } from './helpers.js';

/** Write a raw JSON string as the bag before the next navigation (JSON.stringify can't express __proto__ keys). */
async function rawBag(page, json) {
	await page.addInitScript((raw) => {
		try {
			if (sessionStorage.getItem('__wf_raw_bag')) return;
			sessionStorage.setItem('__wf_raw_bag', '1');
			localStorage.setItem('wefeasto_cart', raw);
		} catch {
			/* storage unavailable */
		}
	}, json);
}

/** Rewrite the body of the next POST /api/store/checkout (once). */
async function tamperNextCheckout(page, edit) {
	let done = false;
	await page.route('**/api/store/checkout', async (route) => {
		const req = route.request();
		if (done || req.method() !== 'POST') return route.continue();
		done = true;
		const body = edit(req.postDataJSON());
		await route.continue({ postData: JSON.stringify(body), headers: { ...req.headers(), 'content-type': 'application/json' } });
	});
}

test.describe('tampered bag / request → the server price wins', () => {
	test('hand-edited localStorage bag (strings, junk qty, over the cap, unknown + prototype keys) is sanitised; the order is priced by the server', async ({
		page,
		shop,
		admin,
		api,
		mock
	}) => {
		await rawBag(
			page,
			'{"__proto__":{"polluted":1},"constructor":1,"toString":3,"muesli":"2","cornflakes":15,"ghost":5,"rolled-oats":-3,"health-mix":"1e3","choco-flakes":2.5,"steel-cut-oats":" 3"}'
		);
		const expected = await serverTotal(api, { muesli: 2, cornflakes: 10 });
		await mock.setAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		await expect(page.locator('[data-wf-co-line]')).toHaveCount(2);
		await expect(page.locator('[data-wf-co-line="muesli"]')).toContainText('× 2');
		await expect(page.locator('[data-wf-co-line="cornflakes"]')).toContainText('× 10');
		await shop.fillCheckout({ method: 'card' });
		await expect(page.locator('[data-wf-total]')).toHaveText(rupees(expected.totalPaise));
		expect(await page.evaluate(() => ({}).polluted), 'no prototype pollution').toBeUndefined();
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect(calls[0].body.items).toEqual(expect.arrayContaining([{ slug: 'muesli', qty: 2 }, { slug: 'cornflakes', qty: 10 }]));
		expect(calls[0].body.items).toHaveLength(2);
		const o = await admin.findOrder(number);
		expect(o.totalPaise).toBe(expected.totalPaise);
		expect(o.items.map((i) => [i.slug, i.qty]).sort()).toEqual([['cornflakes', 10], ['muesli', 2]]);
	});

	test('price / total / currency / discount fields injected into the request are ignored: charged the server total in INR', async ({
		page,
		shop,
		admin,
		api,
		mock
	}) => {
		const items = { muesli: 1, cornflakes: 1 };
		const { totalPaise } = await serverTotal(api, items);
		await tamperNextCheckout(page, (b) => ({
			...b,
			items: b.items.map((i) => ({ ...i, price: 1, pricePaise: 100, unitPaise: 100, lineTotalPaise: 100 })),
			total: 100,
			totalPaise: 100,
			subtotalPaise: 100,
			discountPaise: 99_999,
			deliveryPaise: 0,
			currency: 'USD'
		}));
		await shop.setCart(items);
		await mock.clearAuto(page);
		await shop.gotoCheckout();
		await shop.fillCheckout({ method: 'upi' });
		await page.locator('#wf-place-order').click();
		await expect(modal.root(page)).toBeVisible();
		const [inst] = await mock.instances(page);
		expect(inst.options.amount, 'Razorpay is asked for the server total').toBe(totalPaise);
		await expect(modal.root(page)).toContainText(rupees(totalPaise));
		await modal.pay(page).click();
		const { number } = await orderPage(page);
		const o = await admin.findOrder(number);
		expect(o).toMatchObject({ status: 'paid', totalPaise, currency: 'INR', discountPaise: 0 });
		expect(o.razorpay.attempts[0].amount).toBe(totalPaise);
		expect(o.items.find((i) => i.slug === 'muesli').unitPaise).toBe(25_000);
	});

	test('a lowered expectedTotalPaise → 409 PRICE_CHANGED with the real quote → one more tap pays the real total', async ({ page, shop, admin, api, mock }) => {
		const items = { 'health-mix': 1 };
		const { totalPaise } = await serverTotal(api, items);
		await tamperNextCheckout(page, (b) => ({ ...b, expectedTotalPaise: 100 }));
		await shop.setCart(items);
		await mock.setAuto(page, { auto: 'success' });
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'upi' });
		const calls = recordCheckoutCalls(page);
		await page.locator('#wf-place-order').click();
		const note = coNote(page, 'PRICE_CHANGED');
		await expect(note).toBeVisible();
		await expect(note).toContainText(COPY.priceChanged);
		await answered(calls);
		expect(calls[0].status).toBe(409);
		expect(calls[0].json.error.details.quote.totalPaise).toBe(totalPaise);
		expect(await admin.ordersByEmail(form.email), 'nothing was ordered').toHaveLength(0);
		await expect(page.locator('[data-wf-total]')).toHaveText(rupees(totalPaise));

		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).totalPaise).toBe(totalPaise);
		expect(await admin.ordersByEmail(form.email)).toHaveLength(1);
	});

	test('hand-made requests with unknown / prototype slugs or junk quantities are refused and reserve nothing', async ({ api, db, unique }) => {
		const stock = await db.stock('muesli');
		const quote = (await serverTotal(api, { muesli: 1 })).totalPaise;
		const f = unique.form();
		const base = {
			contact: { name: f.name, email: f.email, phone: `+91${f.phone}` },
			address: { line1: f.address, city: f.city, state: f.state, pin: f.pin },
			method: 'upi',
			expectedTotalPaise: quote,
			consent: { marketing: false },
			source: 'web'
		};
		for (const [items, codes] of [
			[[{ slug: 'muesli', qty: 1 }, { slug: 'ghost', qty: 1 }], ['UNAVAILABLE', 'BAD_SLUG']],
			[[{ slug: '__proto__', qty: 1 }], ['BAD_SLUG', 'UNAVAILABLE']],
			[[{ slug: 'constructor', qty: 1 }], ['BAD_SLUG', 'UNAVAILABLE']],
			[[{ slug: 'muesli', qty: 2.5 }], ['BAD_QTY']],
			[[{ slug: 'muesli', qty: '1e3' }], ['BAD_QTY']],
			[[{ slug: 'muesli', qty: -3 }], ['BAD_QTY']],
			[[{ slug: 'muesli', qty: 99_999 }], ['BAD_QTY', 'QTY_LIMIT']]
		]) {
			const r = await api.checkout({ ...base, items });
			expect([400, 409], JSON.stringify(items)).toContain(r.status);
			expect(codes, `${JSON.stringify(items)} → ${r.json?.error?.code}`).toContain(r.json?.error?.code);
		}
		expect(await db.stock('muesli'), 'no stock moved').toBe(stock);
	});
});
