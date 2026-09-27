/*
 * HUNT data-cms (round 2): the documented REST stock adjustment takes a product off sale when it has
 * unpublished draft changes.
 *
 * cms-hardening.md §5: "REST / Local API: `stockAdjust: ±N` (staff)" is how stock is changed outside the
 * admin form. Products have drafts. When an editor has saved a draft (e.g. a price rise not yet
 * published), a plain `PATCH /api/products/:id {stockAdjust: 5}` is applied by Payload on top of the
 * LATEST VERSION (the draft) and written to the live document with that version's `_status: 'draft'`:
 *   - the product is unpublished: gone from /api/store/catalog (every bag with it → UNAVAILABLE at
 *     checkout), and the next storefront build drops its page;
 *   - the draft's content (the new price) is now the live row's content.
 * The same happens for any staff PATCH without `_status` (inStock, maxPerOrder, …).
 *
 * Correct behaviour: a stock adjustment leaves the published product as it is (still sold, at its
 * published price, stock +5), or the CMS refuses the ambiguous save (4xx) instead of unpublishing.
 */
import { test, expect } from '../../fixtures.js';
import { createProduct, deleteProduct } from './helpers.js';

test('PATCH {stockAdjust} on a product with a saved draft keeps it published at its published price', async ({ admin, api }) => {
	const product = await createProduct(admin, { pricePaise: 20000, stock: 20 });
	try {
		const draft = await admin.request('PATCH', `products/${product.id}?depth=0&draft=true`, { body: { pricePaise: 26000, _status: 'draft' } });
		expect(draft.status).toBe(200);
		const before = (await api.get('store/catalog')).json.products.find((p) => p.slug === product.slug);
		expect(before, 'published product is on sale before').toMatchObject({ pricePaise: 20000, inStock: true });

		const r = await admin.request('PATCH', `products/${product.id}?depth=0`, { body: { stockAdjust: 5 } });
		if (r.status >= 400 && r.status < 500) return; // refusing the ambiguous save is fine

		expect(r.status).toBe(200);
		const live = (await admin.request('GET', `products/${product.id}?depth=0`)).json;
		const onSale = (await api.get('store/catalog')).json.products.find((p) => p.slug === product.slug) ?? null;
		expect(
			{ status: live._status, livePrice: live.pricePaise, stock: live.stock, catalog: onSale && { pricePaise: onSale.pricePaise, inStock: onSale.inStock } },
			'after a +5 stock adjustment'
		).toEqual({ status: 'published', livePrice: 20000, stock: 25, catalog: { pricePaise: 20000, inStock: true } });
	} finally {
		await deleteProduct(admin, product.id);
	}
});
