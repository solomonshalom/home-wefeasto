/*
 * HUNT data-cms (wave 5): Products list → Edit (bulk edit) moves stock even when the save is refused.
 *
 * "Adjust stock by (±N)" is applied by the Products beforeChange hook (productStockBeforeChange: an atomic
 * UPDATE … stock = stock + N inside the save's transaction), which Payload runs BEFORE it validates the
 * fields. A single-product save that then fails validation rolls the adjustment back with its transaction.
 * Payload's bulk update (the list's "Edit" drawer, PATCH /api/products?where=…) runs every selected
 * product in ONE shared transaction, catches each product's validation error, answers 400 "Unable to
 * update 2 out of 2 Products" — and COMMITS: every product's stock moved by N anyway. The owner fixes the
 * other field, saves again, and the stock moves a second time (+2N).
 *
 * Correct behaviour: a refused bulk edit changes no stock (as the single-product save does).
 */
import { test, expect } from '../../fixtures.js';

const SLUGS = ['rolled-oats', 'muesli'];

test('control: a single product save with an invalid price and "Adjust stock by +5" changes no stock', async ({ admin, adminSession, db }) => {
	const p = await admin.getProduct(SLUGS[0]);
	await admin.adjustStock(SLUGS[0], 0); // remembered: restored after the test
	const before = await db.stock(SLUGS[0]);
	const r = await adminSession.request('PATCH', `products/${p.id}?depth=0`, { body: { stockAdjust: 5, pricePaise: 50 } });
	expect(r.status, r.text.slice(0, 300)).toBe(400);
	expect(await db.stock(SLUGS[0])).toBe(before);
});

test('bulk edit (Products list → Edit: Adjust stock by +5, Price 50) is refused and changes no stock', async ({ admin, adminSession, db }) => {
	const before = {};
	for (const slug of SLUGS) {
		await admin.adjustStock(slug, 0); // remembered: restored after the test
		before[slug] = await db.stock(slug);
	}
	const r = await adminSession.request('PATCH', `products?where[slug][in]=${SLUGS.join(',')}&depth=0`, {
		body: { stockAdjust: 5, pricePaise: 50 }
	});
	expect(r.status, r.text.slice(0, 300)).toBe(400);
	expect(r.json?.docs ?? [], 'no product was reported as updated').toEqual([]);
	const after = {};
	for (const slug of SLUGS) after[slug] = await db.stock(slug);
	expect(after, 'the refused bulk edit must not move any stock').toEqual(before);
});
